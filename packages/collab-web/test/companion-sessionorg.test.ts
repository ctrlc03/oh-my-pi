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

const emptyFile = (doc: OrgDoc = emptyOrg()): OrgFile => ({ doc, rev: 0, activity: {}, settled: {}, ending: {} });

const session = (id: string, over: Partial<OrgSession> = {}): OrgSession => ({
	instanceId: `inst-${id}`,
	sessionId: id,
	cwd: `/work/${id}`,
	startedAt: T0 - DAY_MS,
	busy: false,
	inputRequired: false,
	...over,
});

/** `canEnd`: instance ids the companion started (it leaves any other alone, as the real one does). */
function harness(initial?: OrgFile, prDone: Record<string, number> = {}, canEnd: readonly string[] = []) {
	const clock = { now: T0 };
	const saved: OrgFile[] = [];
	const settled: SettledSession[] = [];
	/** Instance ids ended, in order. */
	const ended: string[] = [];
	/** What happened, in order: `end <instance>` and `report <sessions>` (the cleanup is offered). */
	const order: string[] = [];
	let changes = 0;
	/** What happens while the end awaits (recording the session, tmux), and whether a fresh listing then shows it busy. */
	const race: { during?: () => Promise<void>; busy: boolean } = { busy: false };
	const org = createSessionOrg({
		now: () => clock.now,
		initial: initial ?? emptyFile(),
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
			order.push(`report ${sessions.map(s => s.sessionId).join(",")}`);
		},
		// Like the companion: whatever was awaited before the kill (`race.during`) may change the world, so it looks again.
		endSession: async (s, stillWanted) => {
			if (!canEnd.includes(s.instanceId)) return true;
			await race.during?.();
			if (race.busy || !stillWanted()) return false;
			ended.push(s.instanceId);
			order.push(`end ${s.instanceId}`);
			return true;
		},
		onError: err => {
			throw err;
		},
	});
	return { org, clock, saved, settled, ended, order, race, changes: () => changes };
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
		expect(await loadOrgFile(file)).toEqual({ doc: emptyOrg(), rev: 0, activity: {}, settled: {}, ending: {} });
		expect((await loadOrgFile(`${file}.missing`)).rev).toBe(0);
	});
});

describe("auto-settle on the computer", () => {
	const idleAfter = (days: number): OrgFile => ({
		doc: withSettings(emptyOrg(), { idleDays: days }, T0 - 100 * DAY_MS),
		rev: 0,
		activity: {},
		settled: {},
		ending: {},
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
		ending: {},
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
			initial: { doc: emptyOrg(), rev: 0, activity: {}, settled: {}, ending: {} },
			save: async () => {},
			readPrDone: async () => {
				reads++;
				return T0;
			},
			prAvailable: () => true,
			onChange: () => {},
			endSession: async () => true,
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
			ending: {},
		});
		await idle.org.tick([session("quiet")]);
		idle.clock.now += 4 * DAY_MS;
		await idle.org.tick([session("quiet")]);
		expect(idle.settled).toEqual([{ sessionId: "quiet", at: idle.clock.now }]);

		const pr = harness(
			{
				doc: withSettings(emptyOrg(), { settleOnPr: true }, T0 - 100 * DAY_MS),
				rev: 0,
				activity: {},
				settled: {},
				ending: {},
			},
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

describe("ending sessions when they settle", () => {
	const on = (): OrgFile => emptyFile(withSettings(emptyOrg(), { endOnSettle: true }, T0 - 100 * DAY_MS));
	const settleA = (doc: OrgDoc, at = T0, key = "a"): OrgDoc => applyOrg(doc, key, { type: "settle" }, at);
	const live = (key: string, over: Partial<OrgSession> = {}): OrgSession => session(key, over);

	it("ends a session the companion started once it settles, then offers its cleanup", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		// Nothing is ended or cleaned until a listing says the session is live and idle.
		expect(h.order).toEqual([]);
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["end inst-a", "report a"]);
		expect(h.org.file().ending).toEqual({});
		// The same listing again does nothing more.
		await h.org.tick([live("a")]);
		expect(h.order).toHaveLength(2);
	});

	it("leaves a session the companion did not start alone, but still offers its cleanup", async () => {
		const h = harness(on(), {}, []);
		await h.org.sync(settleA(h.org.file().doc));
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
		expect(h.settled).toEqual([{ sessionId: "a", at: T0 }]);
	});

	it("ends only the settled one of several, and ends a vendor agent's host like any other", async () => {
		const h = harness(on(), {}, ["inst-a", "inst-b", "inst-claude"]);
		await h.org.sync(settleA(settleA(h.org.file().doc, T0, "claude"), T0 + 1, "a"));
		const vendor = { ...live("claude"), agent: { id: "claude", name: "Claude Code" } };
		await h.org.tick([live("a"), live("b"), vendor]);
		expect(h.ended.sort()).toEqual(["inst-a", "inst-claude"]);
	});

	it("does nothing while the option is off, and turning it on later does not end what is settled already", async () => {
		const h = harness(undefined, {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		// Reported at once, as before the option existed.
		expect(h.settled).toEqual([{ sessionId: "a", at: T0 }]);
		await h.org.tick([live("a")]);
		await h.org.sync(withSettings(h.org.file().doc, { endOnSettle: true }, T0 + 5));
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
	});

	it("waits for a session that is working, asking or of unknown state, then ends it once idle", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		await h.org.tick([live("a", { busy: true })]);
		await h.org.tick([live("a", { inputRequired: true })]);
		await h.org.tick([live("a", { busy: null })]);
		expect(h.order).toEqual([]);
		expect(h.org.file().ending).toEqual({ a: T0 });
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["end inst-a", "report a"]);
	});

	it("does not end a session the user moved back first, and a fresh settle of it starts over", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		const settled = settleA(h.org.file().doc);
		await h.org.sync(settled);
		await h.org.tick([live("a", { busy: true })]);
		await h.org.sync(applyOrg(settled, "a", { type: "unsettle" }, T0 + 10));
		await h.org.tick([live("a")]);
		// Un-settled: not ended, and no cleanup for a settle that was undone.
		expect(h.order).toEqual([]);
		expect(h.org.file().ending).toEqual({});

		await h.org.sync(applyOrg(h.org.file().doc, "a", { type: "settle" }, T0 + 20));
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["end inst-a", "report a"]);
		expect(h.settled).toEqual([{ sessionId: "a", at: T0 + 20 }]);
	});

	it("a settle replaced by another action while it waited is dropped", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		await h.org.tick([live("a", { busy: true })]);
		await h.org.sync(applyOrg(h.org.file().doc, "a", { type: "pin" }, T0 + 10));
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
	});

	it("does not end again after a restart, and still ends one that settled while working", async () => {
		const file = await tempFile();
		const first = harness(on(), {}, ["inst-a", "inst-b"]);
		await first.org.sync(settleA(settleA(first.org.file().doc, T0, "a"), T0 + 1, "b"));
		await first.org.tick([live("a"), live("b", { busy: true })]);
		expect(first.ended).toEqual(["inst-a"]);
		await saveOrgFile(file, first.saved.at(-1) as OrgFile);

		// The restarted companion: "a" was resumed by the user (still settled), "b" went idle meanwhile.
		const second = harness(await loadOrgFile(file), {}, ["inst-a", "inst-b"]);
		await second.org.sync(first.org.file().doc);
		await second.org.tick([live("a"), live("b")]);
		expect(second.ended).toEqual(["inst-b"]);
		await second.org.tick([live("a"), live("b")]);
		expect(second.ended).toEqual(["inst-b"]);
	});

	it("forgets a waiting session that is no longer listed, so resuming it later does not end it", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		await h.org.tick([]);
		expect(h.settled).toEqual([{ sessionId: "a", at: T0 }]);
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
	});

	it("ends sessions settled by the idle rule and by the pull request rule", async () => {
		const doc = withSettings(emptyOrg(), { idleDays: 3, settleOnPr: true, endOnSettle: true }, T0 - 100 * DAY_MS);
		const h = harness(emptyFile(doc), { "/work/done": T0 - 1000 }, ["inst-quiet", "inst-done"]);
		await h.org.tick([live("quiet"), live("done")]);
		h.clock.now += 4 * DAY_MS;
		await h.org.tick([live("quiet"), live("done")]);
		expect(h.ended.sort()).toEqual(["inst-done", "inst-quiet"]);
	});

	it("stops waiting when the option is turned off, offering the cleanup as before", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		await h.org.tick([live("a", { busy: true })]);
		await h.org.sync(withSettings(h.org.file().doc, { endOnSettle: false }, T0 + 5));
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["report a"]);
	});

	it("does not end a session whose settle was undone while the end awaited, and ends it on a later settle", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		const settled = settleA(h.org.file().doc);
		await h.org.sync(settled);
		h.race.during = async () => {
			await h.org.sync(applyOrg(settled, "a", { type: "unsettle" }, T0 + 10));
		};
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
		// Not reported either: nothing settled, so no cleanup; the next listing forgets it.
		expect(h.order).toEqual([]);
		await h.org.tick([live("a")]);
		expect(h.org.file().ending).toEqual({});
		expect(h.order).toEqual([]);
		h.race.during = undefined;
		await h.org.sync(applyOrg(h.org.file().doc, "a", { type: "settle" }, T0 + 20));
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["end inst-a", "report a"]);
	});

	it("does not end a session a prompt reached while the end awaited, and ends it once idle again", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		h.race.during = async () => {
			h.race.busy = true;
		};
		await h.org.tick([live("a")]);
		expect(h.order).toEqual([]);
		expect(h.org.file().ending).toEqual({ a: T0 });
		h.race.during = undefined;
		h.race.busy = false;
		await h.org.tick([live("a")]);
		expect(h.order).toEqual(["end inst-a", "report a"]);
	});

	it("does not end a session when the option was turned off while the end awaited, and offers the cleanup as before", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		h.race.during = async () => {
			await h.org.sync(withSettings(h.org.file().doc, { endOnSettle: false }, T0 + 5));
		};
		await h.org.tick([live("a")]);
		h.race.during = undefined;
		await h.org.tick([live("a")]);
		expect(h.ended).toEqual([]);
		expect(h.order).toEqual(["report a"]);
	});

	it("reports a failed end, offers the cleanup and does not retry", async () => {
		const errors: unknown[] = [];
		let attempts = 0;
		const settled: SettledSession[] = [];
		const org = createSessionOrg({
			now: () => T0,
			initial: on(),
			save: async () => {},
			readPrDone: async () => null,
			prAvailable: () => false,
			onChange: () => {},
			onSettled: sessions => settled.push(...sessions),
			endSession: async () => {
				attempts++;
				throw new Error("tmux is gone");
			},
			onError: err => errors.push(err),
		});
		await org.sync(settleA(emptyOrg()));
		await org.tick([live("a")]);
		await org.tick([live("a")]);
		expect(attempts).toBe(1);
		expect(errors).toHaveLength(1);
		expect(settled).toEqual([{ sessionId: "a", at: T0 }]);
	});

	it("keeps what waits in the persisted file, and a file without it loads as nothing waiting", async () => {
		const h = harness(on(), {}, ["inst-a"]);
		await h.org.sync(settleA(h.org.file().doc));
		const saved = JSON.parse(JSON.stringify(h.saved.at(-1)));
		expect(parseOrgFile(saved).ending).toEqual({ a: T0 });
		expect(parseOrgFile({ ...saved, ending: { "bad id": 1, b: "x", c: 2 } }).ending).toEqual({ c: 2 });
		expect(parseOrgFile({ doc: saved.doc, rev: 1, activity: {}, settled: {} }).ending).toEqual({});
	});
});
