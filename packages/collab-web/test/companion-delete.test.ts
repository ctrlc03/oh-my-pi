import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSessionDelete,
	type LiveInstance,
	MAX_DELETE_IDS,
	type SessionDelete,
	type SessionDeleteDeps,
	TRASH_KEEP_MS,
} from "../scripts/companion-delete";
import { createHiddenMessages, type HiddenFile } from "../scripts/companion-hidden";
import { createWorktree, removeWorktree } from "../scripts/companion-gitflow";
import { createSessionOrg, type OrgFile, settleTransitions } from "../scripts/companion-sessionorg";
import { companionWorktree, createSettleCleanup, type SettleCleanup } from "../scripts/companion-settle";
import { createKeyedLock } from "../scripts/companion-start";
import { createSessionSearch } from "../scripts/companion-search";
import { parseGitFlowFile } from "../scripts/companion-worktrees";
import type { HiddenDoc } from "../src/lib/hidden-messages";
import { emptyOrg, mergeOrg, type OrgDoc } from "../src/lib/session-org";

const T0 = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 60 * 60 * 1000;
const STAMP = "2026-10-10T10-00-00-000Z";
const A = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const B = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const C = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";

let tmp: string;
let sessionsDir: string;
let trashDir: string;
let prWatchDir: string;
let outside: string;
let repo: string;
let trees: string;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err);
	return out.trim();
}

async function initRepo(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await run(dir, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const)
		await run(dir, "git", "config", key, value);
	await fs.writeFile(path.join(dir, "a.txt"), "one\n");
	await run(dir, "git", "add", ".");
	await run(dir, "git", "commit", "-q", "-m", "init");
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-delete-")));
	sessionsDir = path.join(tmp, "agent", "sessions");
	trashDir = path.join(tmp, "agent", "collab-trash");
	prWatchDir = path.join(tmp, "run", "pr-watch");
	outside = path.join(tmp, "outside");
	repo = path.join(tmp, "repo");
	trees = path.join(tmp, "trees");
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.mkdir(outside);
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

interface MadeSession {
	file: string;
	dir: string;
}

/** A session as omp writes it: the transcript, and beside it the folder of its subagents and artifacts. */
async function makeSession(project: string, id: string, artifacts = true): Promise<MadeSession> {
	const folder = path.join(sessionsDir, project);
	await fs.mkdir(folder, { recursive: true });
	const file = path.join(folder, `${STAMP}_${id}.jsonl`);
	await fs.writeFile(
		file,
		`{"type":"session","id":"${id}","cwd":"/work/${project}"}\n{"type":"message","text":"secret ${id}"}\n`,
	);
	const dir = file.slice(0, -".jsonl".length);
	if (artifacts) {
		await fs.mkdir(path.join(dir, "nested"), { recursive: true });
		await fs.writeFile(path.join(dir, "0-Explore.jsonl"), `{"type":"session","id":"sub-${id}"}\n`);
		await fs.writeFile(path.join(dir, "nested", "artifact.txt"), "artifact\n");
	}
	return { file, dir };
}

/** Every path under `root` with what it is, for comparing a tree before and after a round trip; links are not followed. */
async function snapshot(root: string): Promise<Record<string, string>> {
	const seen: Record<string, string> = {};
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			if (entry.isSymbolicLink()) seen[rel] = `link:${await fs.readlink(full)}`;
			else if (entry.isDirectory()) {
				seen[rel] = "dir";
				await walk(full);
			} else seen[rel] = `file:${await fs.readFile(full, "utf8")}`;
		}
	};
	await walk(root);
	return seen;
}

const exists = async (target: string): Promise<boolean> => (await fs.lstat(target).catch(() => null)) !== null;

const hiddenDoc = (): HiddenDoc => ({ entries: { m1: { at: T0, hidden: true } } });

interface Harness {
	del: SessionDelete;
	deps: SessionDeleteDeps;
	org: ReturnType<typeof createSessionOrg>;
	orgFile(): OrgFile;
	hidden: ReturnType<typeof createHiddenMessages>;
	settle: SettleCleanup;
	/** The omp processes listed now. */
	live: LiveInstance[];
	/** Processes the companion did not start (a terminal's omp). */
	foreign: Set<string>;
	stopped: string[];
	errors: unknown[];
	changes: { count: number };
	clock: { now: number };
	personal: Set<string>;
	protectedDirs: string[];
	holders: Map<string, number>;
	/** Called when a process is ended, before it leaves the listing. */
	onStop: ((instanceId: string) => Promise<void>) | null;
	/** Whether ending a process makes it leave. */
	stopLeaves: boolean;
	savedHidden: HiddenFile[];
}

function harness(over: Partial<SessionDeleteDeps> = {}): Harness {
	const clock = { now: T0 };
	const changes = { count: 0 };
	const orgDoc: OrgDoc = emptyOrg();
	const initial: OrgFile = { doc: orgDoc, rev: 0, activity: {}, settled: {}, ending: {} };
	const h = {
		live: [] as LiveInstance[],
		foreign: new Set<string>(),
		stopped: [] as string[],
		errors: [] as unknown[],
		changes,
		clock,
		personal: new Set<string>(),
		protectedDirs: [] as string[],
		holders: new Map<string, number>(),
		onStop: null as ((instanceId: string) => Promise<void>) | null,
		stopLeaves: true,
		savedHidden: [] as HiddenFile[],
	};
	let orgFile = initial;
	const org = createSessionOrg({
		now: () => clock.now,
		initial,
		save: async file => {
			orgFile = file;
		},
		readPrDone: async () => null,
		prAvailable: () => false,
		onChange: () => void changes.count++,
		endSession: async () => true,
		onError: err => h.errors.push(err),
	});
	const hidden = createHiddenMessages({
		now: () => clock.now,
		initial: { rev: 0, sessions: {} },
		save: async file => void h.savedHidden.push(file),
		onChange: () => void changes.count++,
	});
	const settle = createSettleCleanup({
		initial: { results: [], sessions: {}, sandboxed: [] },
		save: async () => {},
		flow: () => parseGitFlowFile(null),
		dirs: () => [trees],
		listing: async () => [],
		onUnapproved: () => {},
		onError: err => h.errors.push(err),
	});
	const deps: SessionDeleteDeps = {
		sessionsDir,
		trashDir,
		prWatchDir,
		protectedDirs: () => h.protectedDirs,
		now: () => clock.now,
		lock: createKeyedLock(),
		isPersonal: id => h.personal.has(id),
		live: async () => [...h.live],
		startedHere: async instanceId => !h.foreign.has(instanceId),
		stop: async instanceId => {
			h.stopped.push(instanceId);
			await h.onStop?.(instanceId);
			if (h.stopLeaves) h.live = h.live.filter(instance => instance.instanceId !== instanceId);
		},
		holders: async sessionId => h.holders.get(sessionId) ?? 0,
		org,
		hidden,
		settle,
		worktree: async id => {
			const folder = settle.worktreeOf(id);
			return folder === null ? null : ((await companionWorktree(folder, [trees]))?.path ?? null);
		},
		removeWorktree: tree => removeWorktree(tree, [trees], []),
		forgetSearch: () => {},
		onError: err => h.errors.push(err),
		sleep: async ms => {
			clock.now += ms;
		},
		...over,
	};
	return Object.assign(h, { del: createSessionDelete(deps), deps, org, orgFile: () => orgFile, hidden, settle });
}

/** Give a session the records the companion keeps: a settled sidebar entry, hidden marks, activity, a pull request watch. */
async function keepRecords(h: Harness, id: string): Promise<void> {
	await h.org.sync({
		entries: { [id]: { at: T0, status: "settled", reason: "user" } },
		settings: emptyOrg().settings,
	});
	await h.hidden.sync(id, hiddenDoc());
	await fs.mkdir(path.join(prWatchDir, "watches"), { recursive: true });
	await fs.writeFile(path.join(prWatchDir, "watches", `${id}.json`), `{"sessionId":"${id}"}\n`);
	await fs.mkdir(path.join(prWatchDir, "inbox", id), { recursive: true });
	await fs.writeFile(path.join(prWatchDir, "inbox", id, "pr-1.json"), "{}\n");
}

async function trashed(): Promise<string[]> {
	return (await fs.readdir(trashDir).catch(() => [])).sort();
}

describe("deleting a session", () => {
	it("moves the transcript, its folder and the pull request watch to the trash and clears the companion's records", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		await keepRecords(h, A);
		await h.settle.restore(A, { worktree: null, results: [] });
		const other = await makeSession("--work-app--", B);

		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error(`not deleted: ${JSON.stringify(result)}`);

		// Gone from where omp keeps it; the neighbour is untouched.
		expect(await exists(made.file)).toBe(false);
		expect(await exists(made.dir)).toBe(false);
		expect(await exists(other.file)).toBe(true);
		expect(await exists(other.dir)).toBe(true);
		expect(await exists(path.join(prWatchDir, "watches", `${A}.json`))).toBe(false);
		expect(await exists(path.join(prWatchDir, "inbox", A))).toBe(false);

		// In the trash, in a private folder, with a manifest.
		expect(await trashed()).toEqual([result.trashId]);
		expect((await fs.stat(trashDir)).mode & 0o777).toBe(0o700);
		const entry = path.join(trashDir, result.trashId);
		expect((await fs.stat(entry)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(entry, "manifest.json"))).mode & 0o777).toBe(0o600);
		expect(await Bun.file(path.join(entry, "transcript.jsonl")).text()).toContain(`secret ${A}`);
		expect(await Bun.file(path.join(entry, "artifacts", "nested", "artifact.txt")).text()).toBe("artifact\n");
		const manifest = JSON.parse(await Bun.file(path.join(entry, "manifest.json")).text());
		expect(manifest).toMatchObject({
			sessionId: A,
			deletedAt: T0,
			projectDir: "--work-app--",
			name: `${STAMP}_${A}.jsonl`,
			artifacts: true,
			prWatch: { watch: true, inbox: true },
			org: { entry: { status: "settled" } },
			hidden: { entries: { m1: { hidden: true } } },
		});

		// The companion's records are gone: sidebar entry (a tombstone every device merges), hidden marks, bookkeeping.
		const file = h.orgFile();
		expect(file.doc.entries[A]?.status).toBe("active");
		expect(file.settled[A]).toBeUndefined();
		expect(file.rev).toBeGreaterThan(1);
		expect(h.hidden.doc(A)).toBeNull();
		expect(h.changes.count).toBeGreaterThan(0);
	});

	it("tells every device: a device that still has the settled entry merges the tombstone in", async () => {
		const h = harness();
		await makeSession("--work-app--", A);
		await keepRecords(h, A);
		const device = {
			entries: { [A]: { at: T0, status: "settled" as const, reason: "user" as const } },
			settings: emptyOrg().settings,
		};
		h.clock.now = T0 + 1000;
		await h.del.delete([A], undefined);
		expect(mergeOrg(device, h.orgFile().doc).entries[A]?.status).toBe("active");
	});

	it("clears the settle record and the search cache entry", async () => {
		const forgotten: string[] = [];
		const h = harness({ forgetSearch: file => void forgotten.push(file) });
		const made = await makeSession("--work-app--", A);
		const tree = await createWorktree(repo, trees, "wt-record");
		await h.settle.recordSession(A, tree.path);
		expect(h.settle.worktreeOf(A)).toBe(tree.path);
		await h.del.delete([A], undefined);
		expect(h.settle.worktreeOf(A)).toBeNull();
		expect(h.settle.sessionsIn(tree.path)).toEqual([]);
		expect(forgotten).toEqual([made.file]);
	});

	it("answers each session in order, deleting the ones it can and naming why not for the rest", async () => {
		const h = harness();
		await makeSession("--work-app--", A);
		await makeSession("--work-app--", C);
		const results = await h.del.delete([A, B, C, A], undefined);
		expect(results.map(result => [result.sessionId, result.status])).toEqual([
			[A, "deleted"],
			[B, "refused"],
			[C, "deleted"],
		]);
		const refused = results[1];
		expect(refused?.status === "refused" && refused.reason).toContain("not found");
	});

	it("deletes a session without a folder of artifacts", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A, false);
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status).toBe("deleted");
		expect(await exists(made.file)).toBe(false);
		const manifest = JSON.parse(
			await Bun.file(
				path.join(trashDir, result!.status === "deleted" ? result.trashId : "", "manifest.json"),
			).text(),
		);
		expect(manifest.artifacts).toBe(false);
	});

	it("moves across file systems by copying without following links", async () => {
		let failed = 0;
		const h = harness({
			rename: async (from, to) => {
				if (failed++ < 2) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
				await fs.rename(from, to);
			},
		});
		const made = await makeSession("--work-app--", A);
		// A link inside the artifacts is moved as a link: what it points at is never read or removed.
		await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");
		await fs.symlink(outside, path.join(made.dir, "escape"));
		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error("not deleted");
		expect(await exists(made.file)).toBe(false);
		expect(await exists(made.dir)).toBe(false);
		expect(await fs.readlink(path.join(trashDir, result.trashId, "artifacts", "escape"))).toBe(outside);
		expect(await Bun.file(path.join(outside, "keep.txt")).text()).toBe("keep\n");
	});
});

describe("restoring a session", () => {
	it("puts the files and the companion's records back exactly", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		await fs.symlink("0-Explore.jsonl", path.join(made.dir, "alias"));
		await keepRecords(h, A);
		const before = {
			transcript: await Bun.file(made.file).text(),
			artifacts: await snapshot(made.dir),
			stat: (await fs.stat(made.file)).mtimeMs,
			watch: await Bun.file(path.join(prWatchDir, "watches", `${A}.json`)).text(),
			inbox: await snapshot(path.join(prWatchDir, "inbox", A)),
		};
		const entryBefore = h.orgFile().doc.entries[A]!;

		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error("not deleted");
		h.clock.now = T0 + 5000;
		expect(await h.del.restore(result.trashId)).toBe(A);

		expect(await Bun.file(made.file).text()).toBe(before.transcript);
		expect((await fs.stat(made.file)).mtimeMs).toBe(before.stat);
		expect(await snapshot(made.dir)).toEqual(before.artifacts);
		expect(await Bun.file(path.join(prWatchDir, "watches", `${A}.json`)).text()).toBe(before.watch);
		expect(await snapshot(path.join(prWatchDir, "inbox", A))).toEqual(before.inbox);
		// Nothing is left in the trash.
		expect(await trashed()).toEqual([]);
		// The sidebar entry is back (newer than the tombstone, so it wins on every device) and so are the hidden marks.
		const file = h.orgFile();
		expect(file.doc.entries[A]).toMatchObject({ status: "settled", reason: "user" });
		expect(file.doc.entries[A]!.at).toBeGreaterThan(entryBefore.at);
		expect(h.hidden.doc(A)).toEqual(hiddenDoc());
		// A settle that was already handled is not news again: no cleanup runs for the restored session.
		expect(settleTransitions(file.doc, file.settled).events).toEqual([]);
	});

	it("is refused, with everything left where it was, when the original place is taken", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error("not deleted");

		// A new transcript of the same name.
		await fs.writeFile(made.file, "someone else's\n");
		await expect(h.del.restore(result.trashId)).rejects.toThrow(/already where/);
		expect(await Bun.file(made.file).text()).toBe("someone else's\n");
		expect(await trashed()).toEqual([result.trashId]);
		expect(await exists(path.join(trashDir, result.trashId, "transcript.jsonl"))).toBe(true);

		// A folder in the place of the artifacts.
		await fs.rm(made.file);
		await fs.mkdir(made.dir);
		await expect(h.del.restore(result.trashId)).rejects.toThrow(/already where/);
		expect(await exists(made.file)).toBe(false);
		expect(await fs.readdir(made.dir)).toEqual([]);
		expect(await exists(path.join(trashDir, result.trashId, "artifacts", "0-Explore.jsonl"))).toBe(true);

		// Free again: it restores.
		await fs.rmdir(made.dir);
		expect(await h.del.restore(result.trashId)).toBe(A);
		expect(await exists(made.file)).toBe(true);
	});

	it("recreates the project folder when it is gone", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error("not deleted");
		await fs.rm(path.dirname(made.file), { recursive: true });
		await h.del.restore(result.trashId);
		expect(await exists(made.file)).toBe(true);
	});

	it("refuses a damaged or forged trash entry and an unknown or unsafe trash id", async () => {
		const h = harness();
		await makeSession("--work-app--", A);
		const [result] = await h.del.delete([A], undefined);
		if (result?.status !== "deleted") throw new Error("not deleted");
		const manifestFile = path.join(trashDir, result.trashId, "manifest.json");
		const original = await Bun.file(manifestFile).text();

		// A manifest naming a folder that climbs out of the sessions folder is not trusted.
		for (const projectDir of ["..", "../outside", "a/b", ""]) {
			await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(original), projectDir }));
			await expect(h.del.restore(result.trashId)).rejects.toThrow(/damaged/);
		}
		await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(original), name: "../../evil.jsonl" }));
		await expect(h.del.restore(result.trashId)).rejects.toThrow(/damaged/);
		await fs.writeFile(manifestFile, "not json");
		await expect(h.del.restore(result.trashId)).rejects.toThrow(/damaged/);
		expect(await Bun.file(path.join(outside, "evil.jsonl")).exists()).toBe(false);

		for (const id of ["../agent", "a/b", "", "-x", 7, null])
			await expect(h.del.restore(id)).rejects.toThrow(/invalid trash id/);
		await expect(h.del.restore("nothere")).rejects.toThrow(/no longer in the trash/);
	});
});

describe("the trash", () => {
	it("is emptied of what is older than seven days, and only of that", async () => {
		const h = harness();
		await makeSession("--work-app--", A);
		await makeSession("--work-app--", B);
		const results = await h.del.delete([A], undefined);
		h.clock.now = T0 + 3 * DAY;
		results.push(...(await h.del.delete([B], undefined)));
		const [first, second] = results.map(result => (result.status === "refused" ? "" : result.trashId));

		expect(await h.del.purge()).toBe(0);
		h.clock.now = T0 + TRASH_KEEP_MS - 1;
		expect(await h.del.purge()).toBe(0);
		expect(await trashed()).toEqual([first, second].sort());

		h.clock.now = T0 + TRASH_KEEP_MS;
		expect(await h.del.purge()).toBe(1);
		expect(await trashed()).toEqual([second]);
		await expect(h.del.restore(first)).rejects.toThrow(/no longer in the trash/);

		h.clock.now = T0 + 3 * DAY + TRASH_KEEP_MS;
		expect(await h.del.purge()).toBe(1);
		expect(await trashed()).toEqual([]);
	});

	it("goes by the folder's age without a readable manifest, never removes through a link, and leaves strays alone", async () => {
		const h = harness();
		await fs.mkdir(path.join(trashDir, "orphan"), { recursive: true });
		await fs.writeFile(path.join(trashDir, "orphan", "transcript.jsonl"), "x\n");
		await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");
		await fs.symlink(outside, path.join(trashDir, "link"));
		await fs.writeFile(path.join(trashDir, "stray.txt"), "stray\n");
		const old = new Date(T0 - 30 * DAY);
		await fs.utimes(path.join(trashDir, "orphan"), old, old);

		h.clock.now = T0;
		expect(await h.del.purge()).toBe(1);
		expect(await trashed()).toEqual(["link", "stray.txt"]);
		expect(await Bun.file(path.join(outside, "keep.txt")).text()).toBe("keep\n");
	});

	it("does nothing when there is no trash yet", async () => {
		expect(await harness().del.purge()).toBe(0);
	});
});

describe("path safety", () => {
	it("refuses ids that are not plain session ids, deleting and moving nothing", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		await fs.writeFile(path.join(outside, `${STAMP}_x.jsonl`), "outside\n");
		const bad = [
			"..",
			"../outside",
			"../../agent/sessions/--work-app--",
			"a/b",
			"",
			"-A",
			"A B",
			"a\0b",
			"x".repeat(65),
			`${STAMP}_${A}.jsonl`,
		];
		const results = await h.del.delete(bad, undefined);
		expect(results.every(result => result.status === "refused")).toBe(true);
		expect(results).toHaveLength(bad.length);
		expect(await exists(made.file)).toBe(true);
		expect(await exists(path.join(outside, `${STAMP}_x.jsonl`))).toBe(true);
		expect(await trashed()).toEqual([]);
		const plans = await h.del.plan(bad);
		expect(plans.every(plan => plan.refused !== undefined)).toBe(true);
	});

	it("refuses a malformed request", async () => {
		const h = harness();
		for (const ids of [
			undefined,
			"A",
			[],
			[1],
			[A, {}],
			Array.from({ length: MAX_DELETE_IDS + 1 }, (_, i) => `s${i}`),
		]) {
			await expect(h.del.delete(ids, undefined)).rejects.toThrow();
			await expect(h.del.plan(ids)).rejects.toThrow();
		}
		await expect(h.del.delete([A], "yes")).rejects.toThrow(/invalid request/);
	});

	it("never finds a file outside the session folders", async () => {
		const h = harness();
		await fs.writeFile(path.join(outside, `${STAMP}_${A}.jsonl`), "outside\n");
		await fs.mkdir(path.join(tmp, "agent", "elsewhere"), { recursive: true });
		await fs.writeFile(path.join(tmp, "agent", "elsewhere", `${STAMP}_${A}.jsonl`), "elsewhere\n");
		// Directly in the sessions folder, not in a project folder: not where omp keeps a session.
		await fs.writeFile(path.join(sessionsDir, `${STAMP}_${A}.jsonl`), "flat\n");
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status === "refused" && result.reason).toContain("not found");
		for (const file of [
			path.join(outside, `${STAMP}_${A}.jsonl`),
			path.join(tmp, "agent", "elsewhere", `${STAMP}_${A}.jsonl`),
			path.join(sessionsDir, `${STAMP}_${A}.jsonl`),
		])
			expect(await exists(file)).toBe(true);
	});

	it("refuses a project folder that is a link out of the sessions folder", async () => {
		const h = harness();
		await fs.writeFile(path.join(outside, `${STAMP}_${A}.jsonl`), "outside\n");
		await fs.mkdir(path.join(outside, `${STAMP}_${A}`));
		await fs.symlink(outside, path.join(sessionsDir, "--linked--"));
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status).toBe("refused");
		expect((await fs.readdir(outside)).sort()).toEqual([`${STAMP}_${A}`, `${STAMP}_${A}.jsonl`].sort());
		expect(await trashed()).toEqual([]);
	});

	it("refuses an artifacts folder that is a link, and a transcript that is a link", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A, false);
		await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");
		await fs.symlink(outside, made.dir);
		const [linkedDir] = await h.del.delete([A], undefined);
		expect(linkedDir?.status).toBe("refused");
		expect(await exists(made.file)).toBe(true);
		expect((await fs.lstat(made.dir)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(outside, "keep.txt")).text()).toBe("keep\n");

		const other = await makeSession("--work-app--", B, false);
		await fs.rm(other.file);
		await fs.writeFile(path.join(outside, "target.jsonl"), "target\n");
		await fs.symlink(path.join(outside, "target.jsonl"), other.file);
		const [linkedFile] = await h.del.delete([B], undefined);
		expect(linkedFile?.status).toBe("refused");
		expect((await fs.lstat(other.file)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(outside, "target.jsonl")).text()).toBe("target\n");
		expect(await trashed()).toEqual([]);
	});

	it("refuses a session that is in more than one folder", async () => {
		const h = harness();
		await makeSession("--work-app--", A, false);
		await makeSession("--work-other--", A, false);
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status === "refused" && result.reason).toContain("more than one folder");
	});

	it("uses nothing a session file says: its header cwd and ids inside it change no path", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A, false);
		await fs.writeFile(made.file, `{"type":"session","id":"../../outside","cwd":"${outside}"}\n`);
		await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");
		const [result] = await h.del.delete([A], true);
		expect(result?.status).toBe("deleted");
		expect(await Bun.file(path.join(outside, "keep.txt")).text()).toBe("keep\n");
		expect(await exists(outside)).toBe(true);
	});
});

describe("the Personal agent's session", () => {
	it("is refused, by id and by where it is kept", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A, false);
		h.personal.add(A);
		const [byId] = await h.del.delete([A], undefined);
		expect(byId?.status === "refused" && byId.reason).toContain("Personal");
		expect(await exists(made.file)).toBe(true);

		// Its profile's sessions (a folder the companion never deletes from), even when found under the sessions folder.
		const own = await makeSession("--personal--", B, false);
		h.protectedDirs.push(path.join(sessionsDir, "--personal--"));
		const [byPlace] = await h.del.delete([B], undefined);
		expect(byPlace?.status === "refused" && byPlace.reason).toContain("Personal");
		expect(await exists(own.file)).toBe(true);
		expect(await trashed()).toEqual([]);
		expect((await h.del.plan([A, B])).map(plan => plan.refused?.includes("Personal"))).toEqual([true, true]);
	});
});

describe("a running session", () => {
	it("started in a terminal is refused with a plain message and left alone", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		h.live.push({ instanceId: "i-hand", sessionId: A });
		h.foreign.add("i-hand");
		const [result] = await h.del.delete([A], undefined);
		expect(result).toEqual({
			sessionId: A,
			status: "refused",
			reason: "It is running in a terminal. End it there first.",
		});
		expect(h.stopped).toEqual([]);
		expect(await exists(made.file)).toBe(true);
		expect(await exists(made.dir)).toBe(true);
		expect(await h.del.plan([A])).toEqual([
			{ sessionId: A, refused: "It is running in a terminal. End it there first." },
		]);
	});

	it("that another omp has open is refused", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		h.holders.set(A, 1);
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status === "refused" && result.reason).toContain("Another omp has it open");
		expect(await exists(made.file)).toBe(true);
	});

	it("the companion started is ended first, and its files move only after it let go", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		h.live.push({ instanceId: "i-mine", sessionId: A });
		const seen: boolean[] = [];
		h.onStop = async () => {
			// While it is being ended its files are still where omp keeps them.
			seen.push(await exists(made.file));
		};
		expect(await h.del.plan([A])).toEqual([{ sessionId: A, running: true }]);
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status).toBe("deleted");
		expect(h.stopped).toEqual(["i-mine"]);
		expect(seen).toEqual([true]);
		expect(await exists(made.file)).toBe(false);
	});

	it("waits for the ended process to leave the listing, then goes on", async () => {
		const h = harness();
		await makeSession("--work-app--", A);
		h.live.push({ instanceId: "i-mine", sessionId: A });
		h.stopLeaves = false;
		let polls = 0;
		h.deps.sleep = async ms => {
			h.clock.now += ms;
			if (++polls === 3) h.live = [];
		};
		const del = createSessionDelete(h.deps);
		const [result] = await del.delete([A], undefined);
		expect(result?.status).toBe("deleted");
		expect(polls).toBe(3);
	});

	it("that does not stop in time is refused, and nothing moves", async () => {
		const h = harness();
		const made = await makeSession("--work-app--", A);
		h.live.push({ instanceId: "i-mine", sessionId: A });
		h.stopLeaves = false;
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status === "refused" && result.reason).toContain("did not stop in time");
		expect(await exists(made.file)).toBe(true);
		expect(await trashed()).toEqual([]);
	});

	it("whose ending fails is refused with the reason", async () => {
		const h = harness({
			stop: async () => {
				throw new Error("only sessions the companion started can be ended from here");
			},
		});
		const made = await makeSession("--work-app--", A);
		h.live.push({ instanceId: "i-mine", sessionId: A });
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status === "refused" && result.reason).toBe(
			"Only sessions the companion started can be ended from here.",
		);
		expect(await exists(made.file)).toBe(true);
	});

	it("waits its turn behind the settle or end of the same session, not behind another session's", async () => {
		const inner = createKeyedLock();
		const queued = Promise.withResolvers<void>();
		// Tells when the deletion of A has asked for its turn.
		const lock: SessionDeleteDeps["lock"] = (key, work) => {
			if (key === A) queued.resolve();
			return inner(key, work);
		};
		const h = harness({ lock });
		await makeSession("--work-app--", A, false);
		await makeSession("--work-app--", B, false);
		const release = Promise.withResolvers<void>();
		const holding = inner(A, () => release.promise);
		let finished = false;
		const deleting = h.del.delete([A], undefined).then(results => {
			finished = true;
			return results;
		});
		const [other] = await h.del.delete([B], undefined);
		expect(other?.status).toBe("deleted");
		await queued.promise;
		expect(finished).toBe(false);
		release.resolve();
		await holding;
		const [result] = await deleting;
		expect(result?.status).toBe("deleted");
	});
});

describe("a worktree", () => {
	/** A session that ran in a worktree the companion made. */
	async function inWorktree(h: Harness, id: string, branch: string): Promise<{ path: string }> {
		await makeSession("--work-app--", id, false);
		const tree = await createWorktree(repo, trees, branch);
		await h.settle.recordSession(id, tree.path);
		return tree;
	}

	it("stays unless it was asked to go", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-stay");
		expect(await h.del.plan([A])).toEqual([{ sessionId: A, worktree: tree.path }]);
		const [result] = await h.del.delete([A], undefined);
		expect(result?.status).toBe("deleted");
		expect(result?.status === "deleted" && result.worktree).toBeUndefined();
		expect(await exists(tree.path)).toBe(true);
	});

	it("is removed when asked and clean, and its branch stays", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-gone");
		const [result] = await h.del.delete([A], true);
		expect(result).toMatchObject({ sessionId: A, status: "deleted", worktree: "removed" });
		expect(await exists(tree.path)).toBe(false);
		expect(await run(repo, "git", "branch", "--list", "wt-gone")).toContain("wt-gone");
		expect(await run(repo, "git", "worktree", "list")).not.toContain("wt-gone");
	});

	it("is kept, with the reason, when it has uncommitted changes", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-dirty");
		await fs.writeFile(path.join(tree.path, "a.txt"), "changed\n");
		const [result] = await h.del.delete([A], true);
		expect(result).toMatchObject({
			sessionId: A,
			status: "worktreeKept",
			reason: "The worktree has uncommitted changes.",
		});
		// The session is deleted all the same, and the tree and its change are untouched.
		expect(await Bun.file(path.join(tree.path, "a.txt")).text()).toBe("changed\n");
		expect(await trashed()).toHaveLength(1);
		expect(await exists(path.join(sessionsDir, "--work-app--", `${STAMP}_${A}.jsonl`))).toBe(false);
	});

	it("is kept when another session also worked in it, and goes once the last of them is deleted together", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-shared");
		await makeSession("--work-app--", B, false);
		await h.settle.recordSession(B, tree.path);

		const [first] = await h.del.delete([A], true);
		expect(first).toMatchObject({ status: "worktreeKept", reason: "Another session also worked in this worktree." });
		expect(await exists(tree.path)).toBe(true);

		// Both together: nothing else remains in it.
		await makeSession("--work-app--", A, false);
		await h.settle.recordSession(A, tree.path);
		const both = await h.del.delete([A, B], true);
		expect(both.map(result => result.status === "deleted" && result.worktree)).toEqual(["removed", "removed"]);
		expect(await exists(tree.path)).toBe(false);
	});

	it("is kept while a cleanup command runs in it, or a session still runs in it", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-busy");
		const busy = createSessionDelete({ ...h.deps, settle: { ...h.settle, cleaning: () => true } as SettleCleanup });
		const [cleaning] = await busy.delete([A], true);
		expect(cleaning).toMatchObject({ status: "worktreeKept", reason: "A cleanup command is still running in it." });
		expect(await exists(tree.path)).toBe(true);

		await makeSession("--work-app--", B, false);
		await h.settle.recordSession(B, tree.path);
		const occupied = createSessionDelete({
			...h.deps,
			removeWorktree: folder => removeWorktree(folder, [trees], [tree.path]),
		});
		const [running] = await occupied.delete([B], true);
		expect(running).toMatchObject({ status: "worktreeKept" });
		expect(running?.status === "worktreeKept" && running.reason).toContain("still running");
		expect(await exists(tree.path)).toBe(true);
	});

	it("is never removed for a session the companion did not start there, or one whose folder is no worktree it made", async () => {
		const h = harness();
		await makeSession("--work-app--", A, false);
		// No record: the session may have run anywhere.
		const [unrecorded] = await h.del.delete([A], true);
		expect(unrecorded).toMatchObject({ status: "deleted" });
		expect(unrecorded?.status === "deleted" && unrecorded.worktree).toBeUndefined();

		// A record that points at the main checkout, or at a worktree outside the companion's folders, is no worktree of the companion's.
		await makeSession("--work-app--", B, false);
		await h.settle.restore(B, { worktree: repo, results: [] });
		expect(await h.del.plan([B])).toEqual([{ sessionId: B }]);
		const [main] = await h.del.delete([B], true);
		expect(main?.status === "deleted" && main.worktree).toBeUndefined();
		expect(await exists(path.join(repo, "a.txt"))).toBe(true);
	});

	it("is not undone by Undo: the session comes back, the removed worktree does not", async () => {
		const h = harness();
		const tree = await inWorktree(h, A, "wt-undo");
		const [result] = await h.del.delete([A], true);
		if (result?.status !== "deleted") throw new Error("not deleted");
		expect(await exists(tree.path)).toBe(false);
		expect(await h.del.restore(result.trashId)).toBe(A);
		expect(await exists(tree.path)).toBe(false);
		expect(await exists(path.join(sessionsDir, "--work-app--", `${STAMP}_${A}.jsonl`))).toBe(true);
	});
});

describe("message search", () => {
	it("no longer finds a deleted session's text", async () => {
		const search = createSessionSearch({ sessionsDir });
		const h = harness({ forgetSearch: file => search.forget(file) });
		const made = await fs
			.mkdir(path.join(sessionsDir, "--work-app--"), { recursive: true })
			.then(() => path.join(sessionsDir, "--work-app--", `${STAMP}_${A}.jsonl`));
		await fs.writeFile(
			made,
			[
				JSON.stringify({ type: "session", id: A, cwd: "/work/app", timestamp: "2026-10-10T10:00:00.000Z" }),
				JSON.stringify({
					type: "message",
					id: "e1",
					timestamp: "2026-10-10T10:00:01.000Z",
					message: { role: "user", content: "pineapple deployment" },
				}),
			].join("\n"),
		);
		expect((await search.search("pineapple")).results).toHaveLength(1);
		await h.del.delete([A], undefined);
		expect((await search.search("pineapple")).results).toHaveLength(0);
		// Restored, it is found again.
		const [entry] = await trashed();
		await h.del.restore(entry!);
		expect((await search.search("pineapple")).results).toHaveLength(1);
	});
});
