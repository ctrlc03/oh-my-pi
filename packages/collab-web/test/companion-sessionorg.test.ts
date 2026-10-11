import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSessionOrg,
	loadOrgFile,
	type OrgFile,
	type OrgSession,
	ORG_PR_CHECK_MS,
	parseOrgFile,
	parsePrDone,
	type SettledSession,
	settleTransitions,
	saveOrgFile,
} from "../scripts/companion-sessionorg";
import { applyOrg, DAY_MS, emptyOrg, type OrgDoc, statusOf, withSettings } from "../src/lib/session-org";

const T0 = Date.UTC(2026, 9, 10, 12);
const dirs: string[] = [];

async function tempFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-org-"));
	dirs.push(dir);
	return path.join(dir, "org.json");
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const session = (id: string, over: Partial<OrgSession> = {}): OrgSession => ({
	sessionId: id,
	cwd: `/work/${id}`,
	startedAt: T0 - DAY_MS,
	busy: false,
	inputRequired: false,
	...over,
});

function harness(initial?: OrgFile, prDone: Record<string, number> = {}) {
	const clock = { now: T0 };
	const saved: OrgFile[] = [];
	const settled: SettledSession[] = [];
	let changes = 0;
	const org = createSessionOrg({
		now: () => clock.now,
		initial: initial ?? { doc: emptyOrg(), rev: 0, activity: {}, settled: {} },
		save: async file => {
			saved.push(file);
		},
		readPrDone: async cwd => prDone[cwd] ?? null,
		prAvailable: () => true,
		onChange: () => {
			changes++;
		},
		onSettled: sessions => {
			settled.push(...sessions);
		},
		onError: err => {
			throw err;
		},
	});
	return { org, clock, saved, settled, changes: () => changes };
}

describe("sync", () => {
	it("merges device documents last-writer-wins and bumps the revision only on a real change", async () => {
		const { org, saved } = harness();
		const phone = applyOrg(emptyOrg(), "a", { type: "pin" }, T0);
		const first = await org.sync(phone);
		expect(first.rev).toBe(1);
		expect(statusOf(first.doc, "a", T0)).toBe("pinned");

		// The same document again: nothing changed, nothing saved.
		expect((await org.sync(phone)).rev).toBe(1);
		expect(saved).toHaveLength(1);

		// A later action on another device wins; an older one does not.
		const laptop = applyOrg(phone, "a", { type: "settle" }, T0 + 10);
		expect(statusOf((await org.sync(laptop)).doc, "a", T0 + 20)).toBe("settled");
		const stale = applyOrg(emptyOrg(), "a", { type: "unpin" }, T0 + 5);
		const after = await org.sync(stale);
		expect(statusOf(after.doc, "a", T0 + 20)).toBe("settled");
		expect(after.rev).toBe(2);
	});

	it("an empty sync reads the document without changing it", async () => {
		const { org } = harness();
		await org.sync(applyOrg(emptyOrg(), "a", { type: "pin" }, T0));
		const read = await org.sync(emptyOrg());
		expect(read.rev).toBe(1);
		expect(statusOf(read.doc, "a", T0)).toBe("pinned");
	});

	it("survives a restart: the file round-trips and damage falls back to empty", async () => {
		const file = await tempFile();
		const first = harness();
		await first.org.sync(applyOrg(emptyOrg(), "a", { type: "pin" }, T0));
		await saveOrgFile(file, first.org.file());
		const loaded = await loadOrgFile(file);
		expect(loaded.rev).toBe(1);
		expect(statusOf(loaded.doc, "a", T0)).toBe("pinned");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

		await Bun.write(file, "{ not json");
		expect(await loadOrgFile(file)).toEqual({ doc: emptyOrg(), rev: 0, activity: {}, settled: {} });
		expect((await loadOrgFile(`${file}.missing`)).rev).toBe(0);
	});
});

describe("auto-settle on the computer", () => {
	const idleAfter = (days: number): OrgFile => ({
		doc: withSettings(emptyOrg(), { idleDays: days }, T0 - 100 * DAY_MS),
		rev: 0,
		activity: {},
		settled: {},
	});

	it("settles a session that has not worked for the configured days, but not one that works", async () => {
		const h = harness(idleAfter(3));
		const sessions = [session("quiet"), session("worker")];
		await h.org.tick(sessions);
		expect(statusOf(h.org.file().doc, "quiet", h.clock.now)).toBe("active");

		h.clock.now += 2 * DAY_MS;
		await h.org.tick([session("quiet"), session("worker", { busy: true })]);
		expect(statusOf(h.org.file().doc, "quiet", h.clock.now)).toBe("active");

		h.clock.now += 2 * DAY_MS;
		await h.org.tick([session("quiet"), session("worker", { busy: true })]);
		const doc = h.org.file().doc;
		expect(statusOf(doc, "quiet", h.clock.now)).toBe("settled");
		expect(doc.entries.quiet.reason).toBe("idle");
		expect(statusOf(doc, "worker", h.clock.now)).toBe("active");
		expect(h.org.file().rev).toBe(1);
		expect(h.changes()).toBe(1);
	});

	it("a session waiting on an answer counts as active", async () => {
		const h = harness(idleAfter(1));
		await h.org.tick([session("asking")]);
		h.clock.now += 5 * DAY_MS;
		await h.org.tick([session("asking", { inputRequired: true })]);
		expect(statusOf(h.org.file().doc, "asking", h.clock.now)).toBe("active");
	});

	it("a session moved back by hand stays active for the full period", async () => {
		const h = harness(idleAfter(3));
		await h.org.tick([session("a")]);
		h.clock.now += 4 * DAY_MS;
		await h.org.tick([session("a")]);
		expect(statusOf(h.org.file().doc, "a", h.clock.now)).toBe("settled");
		await h.org.sync(applyOrg(h.org.file().doc, "a", { type: "unsettle" }, h.clock.now));
		h.clock.now += 1 * DAY_MS;
		await h.org.tick([session("a")]);
		expect(statusOf(h.org.file().doc, "a", h.clock.now)).toBe("active");
	});

	it("forgets the activity of sessions gone for months", async () => {
		const h = harness();
		await h.org.tick([session("gone")]);
		h.clock.now += 100 * DAY_MS;
		await h.org.tick([session("other")]);
		expect(Object.keys(h.org.file().activity)).toEqual(["other"]);
	});

	const prOn = (): OrgFile => ({
		doc: withSettings(emptyOrg(), { settleOnPr: true }, T0 - 100 * DAY_MS),
		rev: 0,
		activity: {},
		settled: {},
	});

	it("settles a session whose pull request merged, once per check interval", async () => {
		const h = harness(prOn(), { "/work/done": T0 - 1000 });
		await h.org.tick([session("done"), session("open")]);
		const doc = h.org.file().doc;
		expect(statusOf(doc, "done", T0)).toBe("settled");
		expect(doc.entries.done.reason).toBe("pr");
		expect(statusOf(doc, "open", T0)).toBe("active");
		expect(h.changes()).toBe(1);

		// Moved back by hand: the next check (after the interval) does not settle it again.
		await h.org.sync(applyOrg(h.org.file().doc, "done", { type: "unsettle" }, T0 + 1));
		h.clock.now += ORG_PR_CHECK_MS + 1;
		await h.org.tick([session("done"), session("open")]);
		expect(statusOf(h.org.file().doc, "done", h.clock.now)).toBe("active");
	});

	it("skips sessions that are working, and pull requests older than the session", async () => {
		const h = harness(prOn(), { "/work/busy": T0 - 10, "/work/old": T0 - 2 * DAY_MS });
		await h.org.tick([session("busy", { busy: true }), session("old", { startedAt: T0 - DAY_MS })]);
		expect(h.org.file().doc.entries).toEqual({});
	});

	it("does not read pull requests when the rule is off", async () => {
		let reads = 0;
		const h = createSessionOrg({
			now: () => T0,
			initial: { doc: emptyOrg(), rev: 0, activity: {}, settled: {} },
			save: async () => {},
			readPrDone: async () => {
				reads++;
				return T0;
			},
			prAvailable: () => true,
			onChange: () => {},
			onError: () => {},
		});
		await h.tick([session("a")]);
		expect(reads).toBe(0);
	});
});

describe("parsePrDone", () => {
	it("reads the finish time of a merged or closed pull request", () => {
		expect(
			parsePrDone([{ state: "MERGED", mergedAt: "2026-10-10T10:00:00Z", closedAt: "2026-10-10T10:00:01Z" }]),
		).toBe(Date.parse("2026-10-10T10:00:00Z"));
		expect(parsePrDone([{ state: "CLOSED", mergedAt: null, closedAt: "2026-10-09T08:00:00Z" }])).toBe(
			Date.parse("2026-10-09T08:00:00Z"),
		);
	});

	it("is null for an open pull request, no pull request, or output it cannot read", () => {
		expect(parsePrDone([{ state: "OPEN", mergedAt: null, closedAt: null }])).toBeNull();
		expect(parsePrDone([])).toBeNull();
		expect(parsePrDone({})).toBeNull();
		expect(parsePrDone([{ state: "MERGED", mergedAt: "nonsense" }])).toBeNull();
	});
});

describe("settle transitions", () => {
	const settledBy = (doc = emptyOrg(), key = "a", at = T0): OrgDoc => applyOrg(doc, key, { type: "settle" }, at);

	it("reports a settle from a device once, not when the same document arrives again", async () => {
		const h = harness();
		const phone = settledBy();
		await h.org.sync(phone);
		await h.org.sync(phone);
		// Another device that already merged it sends the same entry back.
		await h.org.sync(applyOrg(phone, "b", { type: "pin" }, T0 + 1));
		expect(h.settled).toEqual([{ sessionId: "a", at: T0 }]);
	});

	it("reports a re-settle after an un-settle, and each session on its own", async () => {
		const h = harness();
		await h.org.sync(settledBy());
		const undone = applyOrg(h.org.file().doc, "a", { type: "unsettle" }, T0 + 10);
		await h.org.sync(undone);
		expect(h.settled).toHaveLength(1);
		await h.org.sync(applyOrg(undone, "a", { type: "settle" }, T0 + 20));
		await h.org.sync(applyOrg(h.org.file().doc, "b", { type: "settle" }, T0 + 30));
		expect(h.settled).toEqual([
			{ sessionId: "a", at: T0 },
			{ sessionId: "a", at: T0 + 20 },
			{ sessionId: "b", at: T0 + 30 },
		]);
	});

	it("reports the idle auto-settle and the pull request auto-settle", async () => {
		const idle = harness({
			doc: withSettings(emptyOrg(), { idleDays: 3 }, T0 - 100 * DAY_MS),
			rev: 0,
			activity: {},
			settled: {},
		});
		await idle.org.tick([session("quiet")]);
		idle.clock.now += 4 * DAY_MS;
		await idle.org.tick([session("quiet")]);
		expect(idle.settled).toEqual([{ sessionId: "quiet", at: idle.clock.now }]);

		const pr = harness(
			{ doc: withSettings(emptyOrg(), { settleOnPr: true }, T0 - 100 * DAY_MS), rev: 0, activity: {}, settled: {} },
			{ "/work/done": T0 - 1000 },
		);
		await pr.org.tick([session("done")]);
		await pr.org.tick([session("done")]);
		expect(pr.settled).toEqual([{ sessionId: "done", at: T0 }]);
	});

	it("does not report again after a restart: the handled marker is persisted with the document", async () => {
		const file = await tempFile();
		const first = harness();
		await first.org.sync(settledBy());
		await saveOrgFile(file, first.saved.at(-1) as OrgFile);

		const second = harness(await loadOrgFile(file));
		await second.org.sync(settledBy());
		await second.org.tick([session("a")]);
		expect(first.settled).toHaveLength(1);
		expect(second.settled).toEqual([]);
	});

	it("treats what is settled in a file from before settle cleanup as handled, and ignores rooms", () => {
		const doc = settledBy(settledBy(emptyOrg(), "old"), "room:abc", T0 + 1);
		expect(parseOrgFile({ doc, rev: 3, activity: {} }).settled).toEqual({ old: T0 });
		expect(settleTransitions(doc, {}).events).toEqual([{ sessionId: "old", at: T0 }]);
		// A marker for a session no longer settled is dropped, so settling it again is news.
		expect(settleTransitions(emptyOrg(), { old: T0 }).handled).toEqual({});
	});
});
