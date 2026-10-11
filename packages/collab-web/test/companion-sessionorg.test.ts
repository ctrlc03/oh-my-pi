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
	parsePrDone,
	saveOrgFile,
} from "../scripts/companion-sessionorg";
import { applyOrg, DAY_MS, emptyOrg, statusOf, withSettings } from "../src/lib/session-org";

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
	let changes = 0;
	const org = createSessionOrg({
		now: () => clock.now,
		initial: initial ?? { doc: emptyOrg(), rev: 0, activity: {} },
		save: async file => {
			saved.push(file);
		},
		readPrDone: async cwd => prDone[cwd] ?? null,
		prAvailable: () => true,
		onChange: () => {
			changes++;
		},
		onError: err => {
			throw err;
		},
	});
	return { org, clock, saved, changes: () => changes };
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
		expect(await loadOrgFile(file)).toEqual({ doc: emptyOrg(), rev: 0, activity: {} });
		expect((await loadOrgFile(`${file}.missing`)).rev).toBe(0);
	});
});

describe("auto-settle on the computer", () => {
	const idleAfter = (days: number): OrgFile => ({
		doc: withSettings(emptyOrg(), { idleDays: days }, T0 - 100 * DAY_MS),
		rev: 0,
		activity: {},
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
			initial: { doc: emptyOrg(), rev: 0, activity: {} },
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
