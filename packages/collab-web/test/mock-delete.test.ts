import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanionHost, CompanionIdleSession, SessionDeletePlan, SessionDeleteResult } from "../src/lib/companion";
import { createHiddenMessages, loadHiddenFile } from "../scripts/companion-hidden";
import { createSessionOrg, loadOrgFile } from "../scripts/companion-sessionorg";
import { createMockDelete, deleteSampleIds } from "../scripts/mock-delete";

const NOW = 1_800_000_000_000;
const PREFIX = "mac-";
const ids = deleteSampleIds(PREFIX);

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-delete-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function liveHost(n: number, over: Partial<CompanionHost>): CompanionHost {
	return {
		instanceId: `inst-${n}`,
		sessionId: `extra-${n}`,
		sessionName: `extra ${n}`,
		cwd: `/work/extra-${n}`,
		model: null,
		startedAt: NOW,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

async function setup(samples = true) {
	const hosts: CompanionHost[] = [
		liveHost(90, { sessionId: "personal-1", personal: true }),
		liveHost(91, { sessionId: "vendor-1", agent: { id: "claude", name: "Claude Code" } }),
		liveHost(92, { sessionId: "plain-live" }),
	];
	const idle: CompanionIdleSession[] = [
		{
			instanceId: "inst-93",
			sessionId: "in-terminal",
			sessionName: "in a terminal",
			cwd: "/work/terminal",
			model: null,
			startedAt: NOW,
			busy: false,
		},
	];
	const ended: CompanionHost[] = [];
	const sessionOrg = createSessionOrg({
		now: () => NOW,
		initial: await loadOrgFile(path.join(dir, "missing-org.json")),
		save: async () => {},
		readPrDone: async () => null,
		prAvailable: () => false,
		onChange: () => {},
		endSession: async () => true,
		onError: err => {
			throw err;
		},
	});
	const changed: number[] = [];
	const hidden = createHiddenMessages({
		now: () => NOW,
		initial: await loadHiddenFile(path.join(dir, "missing-hidden.json")),
		save: async () => {},
		onChange: () => changed.push(1),
	});
	const mock = createMockDelete({ hosts, idle, ended, sessionOrg, hidden, prefix: PREFIX, samples, now: () => NOW });
	await sessionOrg.sync(mock.sampleOrg(NOW));
	let reqId = 0;
	const plan = async (...sessionIds: string[]): Promise<SessionDeletePlan[]> => {
		const reply = await mock.answer({ t: "session-delete-plan", reqId: ++reqId, sessionIds });
		if (reply.t !== "session-delete-plan") throw new Error("not a plan");
		return reply.plans;
	};
	const del = async (sessionIds: string[], removeWorktree?: boolean): Promise<SessionDeleteResult[]> => {
		const reply = await mock.answer({ t: "session-delete", reqId: ++reqId, sessionIds, removeWorktree });
		if (reply.t !== "session-delete") throw new Error("not a delete");
		return reply.results;
	};
	const restore = async (trashId: string): Promise<string> => {
		const reply = await mock.answer({ t: "session-restore", reqId: ++reqId, trashId });
		if (reply.t !== "session-restore") throw new Error("not a restore");
		return reply.sessionId;
	};
	return { mock, hosts, idle, ended, sessionOrg, hidden, changed, plan, del, restore };
}

describe("mock delete: what it answers to", () => {
	it("advertises the capability and handles exactly the three requests", async () => {
		const { mock } = await setup();
		expect(mock.capabilities).toEqual({ canDeleteSessions: true });
		expect(mock.handles({ t: "session-delete-plan", reqId: 1, sessionIds: [] })).toBe(true);
		expect(mock.handles({ t: "session-delete", reqId: 1, sessionIds: [] })).toBe(true);
		expect(mock.handles({ t: "session-restore", reqId: 1, trashId: "x" })).toBe(true);
		expect(mock.handles({ t: "folders", reqId: 1 })).toBe(false);
	});

	it("adds the samples only when asked, so the other mock states keep their sessions", async () => {
		const { hosts, mock } = await setup(false);
		expect(hosts.map(h => h.sessionId)).toEqual(["personal-1", "vendor-1", "plain-live"]);
		expect(mock.listed()).toEqual([]);
	});

	it("covers each answer in its samples: five settled ones for the bulk delete, among them ended history rows", async () => {
		const { hosts, mock } = await setup();
		const settled = Object.entries(mock.sampleOrg(NOW).entries)
			.filter(([, entry]) => entry.status === "settled")
			.map(([id]) => id);
		expect(settled.sort()).toEqual([...ids.settled].sort());
		expect(hosts.map(h => h.sessionId)).toContain(ids.running[0]!);
		expect(mock.listed().map(h => h.overview.sessionId)).toContain(ids.plain[0]!);
	});
});

describe("mock delete: the plan", () => {
	it("is empty for a plain ended session, and says what is running and what has a worktree", async () => {
		const { plan } = await setup();
		expect(await plan(ids.plain[0]!, ids.running[0]!, ids.wtClean[0]!)).toEqual([
			{ sessionId: ids.plain[0]! },
			{ sessionId: ids.running[0]!, running: true },
			{ sessionId: ids.wtClean[0]!, running: true, worktree: "/work/.worktrees/wt-clean-feature" },
		]);
	});

	it("refuses a session started in a terminal, live or idle, in the plain words", async () => {
		const { plan } = await setup();
		const answers = await plan(ids.terminal[0]!, "in-terminal");
		expect(answers.map(a => a.refused)).toEqual([
			"It is running in a terminal. End it there first.",
			"It is running in a terminal. End it there first.",
		]);
	});

	it("refuses the Personal agent's session, a vendor agent's, and one it does not know", async () => {
		const { plan } = await setup();
		const answers = await plan("personal-1", "vendor-1", "nope");
		expect(answers.map(a => a.refused)).toEqual([
			"The Personal agent's session can't be deleted here.",
			"Only omp sessions can be deleted here.",
			"That session wasn't found. It may be deleted already.",
		]);
	});
});

describe("mock delete: deleting", () => {
	it("takes the session out of the live list and the all-sessions list, with a trash id each", async () => {
		const { del, hosts, mock } = await setup();
		const results = await del([ids.running[0]!, ids.plain[0]!]);
		expect(results).toEqual([
			{ sessionId: ids.running[0]!, status: "deleted", trashId: "trash-1" },
			{ sessionId: ids.plain[0]!, status: "deleted", trashId: "trash-2" },
		]);
		expect(hosts.map(h => h.sessionId)).not.toContain(ids.running[0]!);
		expect(mock.listed().map(h => h.overview.sessionId)).not.toContain(ids.plain[0]!);
	});

	it("refuses what the plan refused and deletes the rest of the same request", async () => {
		const { del, hosts } = await setup();
		const results = await del([ids.terminal[0]!, "plain-live"]);
		expect(results[0]).toEqual({
			sessionId: ids.terminal[0]!,
			status: "refused",
			reason: "It is running in a terminal. End it there first.",
		});
		expect(results[1]?.status).toBe("deleted");
		expect(hosts.map(h => h.sessionId)).toContain(ids.terminal[0]!);
		expect(hosts.map(h => h.sessionId)).not.toContain("plain-live");
	});

	it("keeps the worktree folder unless asked to remove it", async () => {
		const { del, plan, restore } = await setup();
		const [result] = await del([ids.wtClean[0]!], false);
		if (result?.status !== "deleted") throw new Error("not deleted");
		expect("worktree" in result).toBe(false);
		await restore(result.trashId);
		expect((await plan(ids.wtClean[0]!))[0]?.worktree).toBe("/work/.worktrees/wt-clean-feature");
	});

	it("removes a clean worktree when asked, and says so", async () => {
		const { del, restore } = await setup();
		const [result] = await del([ids.wtClean[0]!], true);
		expect(result).toEqual({
			sessionId: ids.wtClean[0]!,
			status: "deleted",
			trashId: "trash-1",
			worktree: "removed",
		});
		await restore("trash-1");
	});

	it("keeps a dirty worktree and says why, though the session is deleted", async () => {
		const { del, hosts } = await setup();
		const [result] = await del([ids.wtDirty[0]!], true);
		expect(result).toEqual({
			sessionId: ids.wtDirty[0]!,
			status: "worktreeKept",
			trashId: "trash-1",
			reason: "the worktree has uncommitted changes",
		});
		expect(hosts.map(h => h.sessionId)).not.toContain(ids.wtDirty[0]!);
	});

	it("tombstones the sidebar entry through the organiser, so every device refetches, and drops hidden marks", async () => {
		const { del, sessionOrg, hidden, changed } = await setup();
		const settledId = ids.settled[2]!;
		await hidden.sync(settledId, { entries: { "msg-1": { at: NOW, hidden: true } } });
		const before = sessionOrg.file();
		expect(before.doc.entries[settledId]?.status).toBe("settled");
		const hiddenChanges = changed.length;
		await del([settledId]);
		const after = sessionOrg.file();
		expect(after.rev).toBeGreaterThan(before.rev);
		expect(after.doc.entries[settledId]?.status).toBe("active");
		expect(hidden.doc(settledId)).toBeNull();
		expect(changed.length).toBeGreaterThan(hiddenChanges);
	});
});

describe("mock delete: restoring", () => {
	it("puts the files, the sidebar entry and the hidden marks back; a session that was running comes back as history", async () => {
		const { del, restore, sessionOrg, hidden, mock, hosts } = await setup();
		const sessionId = ids.settled[0]!;
		await hidden.sync(sessionId, { entries: { "msg-1": { at: NOW, hidden: true } } });
		const [result] = await del([sessionId]);
		if (result?.status !== "deleted") throw new Error("not deleted");
		expect(await restore(result.trashId)).toBe(sessionId);
		expect(hosts.map(h => h.sessionId)).not.toContain(sessionId);
		expect(mock.listed().map(h => h.overview.sessionId)).toContain(sessionId);
		expect(sessionOrg.file().doc.entries[sessionId]?.status).toBe("settled");
		expect(hidden.doc(sessionId)?.entries["msg-1"]?.hidden).toBe(true);
	});

	it("is refused, plainly, when a session with the same id is back", async () => {
		const { del, restore, hosts } = await setup();
		const [result] = await del([ids.running[0]!]);
		if (result?.status !== "deleted") throw new Error("not deleted");
		hosts.push(liveHost(99, { sessionId: ids.running[0]! }));
		await expect(restore(result.trashId)).rejects.toThrow(
			"A session with the same id is back, so the deleted one cannot be put back.",
		);
	});

	it("is refused for a trash id it does not have, and a trash entry can only come back once", async () => {
		const { del, restore } = await setup();
		await expect(restore("trash-404")).rejects.toThrow("That session is not in the trash any more.");
		const [result] = await del([ids.plain[0]!]);
		if (result?.status !== "deleted") throw new Error("not deleted");
		await restore(result.trashId);
		await expect(restore(result.trashId)).rejects.toThrow("That session is not in the trash any more.");
	});
});
