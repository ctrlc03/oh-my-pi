import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DISK_GB, DISK_ROUTE, type DiskGuardSettings } from "@oh-my-pi/pi-wire/disk";
import {
	type DiskFile,
	type DiskGuard,
	type DiskNotice,
	createDiskGuard,
	loadDiskFile,
	parseDiskFile,
	saveDiskFile,
} from "../scripts/companion-disk";
import type { DiskSession, FreeSpace, ProcessProbe } from "../scripts/companion-disk-fs";
import { createWorktree } from "../scripts/companion-gitflow";

const GB = DISK_GB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmp: string;
let repo: string;
let trees: string;
let home: string;
let stateFile: string;
/** The device the temp folder is on: the guard matches a volume to the worktrees on it by this. */
let devKey: string;
const spawned: Bun.Subprocess[] = [];

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
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await run(dir, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(dir, "git", "config", key, value);
	}
	await fs.writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
	await fs.writeFile(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
	await fs.writeFile(path.join(dir, ".gitignore"), "target/\n");
	await run(dir, "git", "add", ".");
	await run(dir, "git", "commit", "-q", "-m", "init");
}

async function put(file: string, bytes = 1): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, Buffer.alloc(bytes, 97));
}

const exists = (target: string): Promise<boolean> =>
	fs.lstat(target).then(
		() => true,
		() => false,
	);

async function makeTree(branch: string, base = trees): Promise<string> {
	const created = await createWorktree(repo, base, branch);
	const tree = await fs.realpath(created.path);
	await put(path.join(tree, "target", "CACHEDIR.TAG"));
	await put(path.join(tree, "target", "debug", "out.bin"), 20_000);
	return tree;
}

interface Harness {
	guard: DiskGuard;
	notices: DiskNotice[];
	errors: unknown[];
	changes: { count: number };
	/** Free space before anything is cleaned; the harness adds the size of every `target` that is gone. */
	free: { bytes: number };
	/** The size each worktree's `target` is taken to have (the measurement is a seam; the deletion is real). */
	sizes: Map<string, number>;
	sessions: DiskSession[];
	/** Session ids that work in a worktree, and when each was last active. */
	sessionsIn: Map<string, string[]>;
	activity: Map<string, number>;
	clock: { offset: number };
}

interface HarnessOptions {
	settings?: Partial<DiskGuardSettings>;
	probe?: ProcessProbe;
	dirs?: string[];
	readFree?: (folder: string, h: Harness) => Promise<FreeSpace | null>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
	const h: Harness = {
		notices: [],
		errors: [],
		changes: { count: 0 },
		free: { bytes: 5 * GB },
		sizes: new Map(),
		sessions: [],
		sessionsIn: new Map(),
		activity: new Map(),
		clock: { offset: 3 * DAY },
		guard: undefined as unknown as DiskGuard,
	};
	const initial: DiskFile = {
		settings: { limitGb: 40, autoClean: false, idleHours: 6, ...options.settings },
		cleans: [],
		alerted: [],
	};
	const freed = async (): Promise<number> => {
		let total = 0;
		for (const [tree, size] of h.sizes) if (!(await exists(path.join(tree, "target")))) total += size;
		return total;
	};
	h.guard = createDiskGuard({
		initial,
		save: file => saveDiskFile(stateFile, file),
		machine: "Test Mac",
		home,
		dirs: () => options.dirs ?? [trees],
		sessions: async () => h.sessions,
		sessionsIn: tree => h.sessionsIn.get(tree) ?? [],
		activity: id => h.activity.get(id),
		ignorePids: () => new Set(),
		alert: notice => h.notices.push(notice),
		onChange: () => {
			h.changes.count++;
		},
		onError: err => h.errors.push(err),
		now: () => Date.now() + h.clock.offset,
		probe: options.probe ?? (async () => new Map()),
		measure: async dir => h.sizes.get(path.dirname(dir)) ?? 1000,
		readFree:
			options.readFree === undefined
				? async () => ({ key: devKey, freeBytes: h.free.bytes + (await freed()), totalBytes: 500 * GB })
				: folder => options.readFree!(folder, h),
	});
	return h;
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-disk-")));
	repo = path.join(tmp, "repo");
	trees = path.join(tmp, "trees");
	home = path.join(tmp, "home");
	stateFile = path.join(tmp, "state", "disk.json");
	await initRepo(repo);
	await fs.mkdir(trees, { recursive: true });
	await fs.mkdir(home, { recursive: true });
	devKey = String((await fs.stat(tmp)).dev);
});

afterEach(async () => {
	for (const proc of spawned.splice(0)) proc.kill();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("warning", () => {
	test("one notification per drop below the limit, again only after recovering past limit plus margin", async () => {
		const h = makeHarness();
		const steps: [number, number][] = [
			[5, 1],
			[5, 1],
			[41, 1],
			[39, 1],
			[45, 1],
			[39, 2],
			[38, 2],
		];
		for (const [free, notices] of steps) {
			h.free.bytes = free * GB;
			await h.guard.check();
			expect(h.notices).toHaveLength(notices);
		}
		const [notice] = h.notices;
		expect(notice?.title).toContain("Test Mac");
		expect(notice?.open).toBe(DISK_ROUTE);
		expect(notice?.tag).toBe("disk-low");
		expect(notice?.body).toContain("5.0 GB free");
		expect(h.errors).toEqual([]);
	});

	test("what was warned is saved before anyone is told, so a restart does not warn again", async () => {
		const first = makeHarness();
		await first.guard.check();
		expect(first.notices).toHaveLength(1);
		const reloaded = await loadDiskFile(stateFile);
		expect(reloaded.alerted).toHaveLength(1);
		const second = makeHarness();
		second.guard = createDiskGuard({
			initial: reloaded,
			save: file => saveDiskFile(stateFile, file),
			machine: "Test Mac",
			home,
			dirs: () => [trees],
			sessions: async () => [],
			sessionsIn: () => [],
			activity: () => undefined,
			ignorePids: () => new Set(),
			alert: notice => second.notices.push(notice),
			onChange: () => {},
			onError: err => second.errors.push(err),
			readFree: async () => ({ key: devKey, freeBytes: 5 * GB, totalBytes: 500 * GB }),
		});
		await second.guard.check();
		expect(second.notices).toEqual([]);
	});

	test("the app is told when the warning appears, and when it clears", async () => {
		const h = makeHarness();
		await h.guard.check();
		expect(h.changes.count).toBe(1);
		expect(h.guard.health()).toEqual({ path: trees, freeBytes: 5 * GB, limitBytes: 40 * GB });
		h.free.bytes = 90 * GB;
		await h.guard.check();
		expect(h.changes.count).toBe(2);
		expect(h.guard.health()).toBeNull();
	});

	test("the reported free space is rounded down to 100 MB so small writes do not broadcast", async () => {
		const h = makeHarness();
		h.free.bytes = 5_000_000_000 + 99_000_000;
		await h.guard.check();
		expect(h.guard.health()?.freeBytes).toBe(5 * GB);
		h.free.bytes = 5_000_000_000 + 40_000_000;
		await h.guard.check();
		expect(h.changes.count).toBe(1);
	});

	test("the worktrees folder and the home folder on one disk are one volume; on two disks, two warnings", async () => {
		const one = makeHarness();
		expect((await one.guard.state()).volumes).toEqual([
			{ path: trees, holds: "worktrees-and-home", freeBytes: 5 * GB, totalBytes: 500 * GB, low: true },
		]);
		const two = makeHarness({
			readFree: async folder => ({
				key: folder === home ? "home-disk" : "trees-disk",
				freeBytes: (folder === home ? 20 : 300) * GB,
				totalBytes: 500 * GB,
			}),
		});
		await two.guard.check();
		const state = await two.guard.state();
		expect(state.volumes.map(volume => [volume.holds, volume.low])).toEqual([
			["worktrees", false],
			["home", true],
		]);
		expect(two.notices).toHaveLength(1);
		expect(two.notices[0]?.body).toContain("Home folder");
	});
});

describe("auto-clean", () => {
	test("is off by default: a low disk is warned about and nothing is deleted", async () => {
		const h = makeHarness();
		const a = await makeTree("feature-a");
		h.sizes.set(a, 30 * GB);
		await h.guard.check();
		expect(h.notices).toHaveLength(1);
		expect(await exists(path.join(a, "target"))).toBe(true);
		expect((await h.guard.state()).cleans).toEqual([]);
	});

	test("deletes the biggest first and stops once free space is back above limit plus margin", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const [small, big, mid] = [await makeTree("small"), await makeTree("big"), await makeTree("mid")];
		h.sizes.set(small, 4 * GB);
		h.sizes.set(big, 30 * GB);
		h.sizes.set(mid, 12 * GB);
		await h.guard.check();
		// 5 GB free + 30 = 35 (< 44) + 12 = 47: stops there.
		expect(await exists(path.join(big, "target"))).toBe(false);
		expect(await exists(path.join(mid, "target"))).toBe(false);
		expect(await exists(path.join(small, "target"))).toBe(true);
		const { cleans } = await h.guard.state();
		expect(cleans.map(clean => [clean.name, clean.bytes, clean.trigger, clean.kinds])).toEqual([
			["mid", 12 * GB, "auto", ["target"]],
			["big", 30 * GB, "auto", ["target"]],
		]);
		expect(cleans[1]).toMatchObject({ path: big, repo: "repo", freeBeforeBytes: 5 * GB, limitBytes: 40 * GB });
		expect(cleans[0]?.freeBeforeBytes).toBe(35 * GB);
		expect(h.errors).toEqual([]);
	});

	test("the record is in the file on disk, and one notification went out for the whole episode", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const a = await makeTree("feature-a");
		h.sizes.set(a, 45 * GB);
		await h.guard.check();
		const saved = await loadDiskFile(stateFile);
		expect(saved.cleans).toHaveLength(1);
		expect(saved.cleans[0]).toMatchObject({ path: a, bytes: 45 * GB, trigger: "auto" });
		expect(saved.alerted).toEqual([]);
		expect(h.notices).toHaveLength(1);
		// The clean lifted free space to 50 GB (above limit plus margin), which re-armed the warning; it then falls to 39 GB.
		h.free.bytes = -6 * GB;
		h.clock.offset += 20 * 60_000;
		await h.guard.check();
		expect(h.notices).toHaveLength(2);
	});

	test("never deletes source: only build output goes, and git sees the same tree", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const a = await makeTree("feature-a");
		await put(path.join(a, "notes", "todo.txt"));
		h.sizes.set(a, 40 * GB);
		await h.guard.check();
		expect(await exists(path.join(a, "target"))).toBe(false);
		expect(await Bun.file(path.join(a, "src", "main.rs")).text()).toBe("fn main() {}\n");
		expect(await exists(path.join(a, "Cargo.toml"))).toBe(true);
		expect(await run(a, "git", "status", "--porcelain")).toBe("?? notes/");
	});

	test("skips a worktree a session works in, and one whose session did not settle but is busy", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const [working, asking, free] = [await makeTree("working"), await makeTree("asking"), await makeTree("free")];
		for (const tree of [working, asking, free]) h.sizes.set(tree, 30 * GB);
		h.sessions = [
			{ sessionId: "s1", name: "refactor", cwd: path.join(working, "src"), busy: true, inputRequired: false },
			{ sessionId: "s2", name: "review", cwd: asking, busy: false, inputRequired: true },
		];
		await h.guard.check();
		expect(await exists(path.join(working, "target"))).toBe(true);
		expect(await exists(path.join(asking, "target"))).toBe(true);
		expect(await exists(path.join(free, "target"))).toBe(false);
	});

	test("an idle session that never settled does not protect its worktree: this is what filled the disk", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const tree = await makeTree("idle-for-days");
		h.sizes.set(tree, 50 * GB);
		h.sessions = [{ sessionId: "s1", name: "refactor", cwd: tree, busy: false, inputRequired: false }];
		h.sessionsIn.set(tree, ["s1"]);
		h.activity.set("s1", Date.now() - 2 * DAY);
		await h.guard.check();
		expect(await exists(path.join(tree, "target"))).toBe(false);
	});

	test("skips a worktree whose session was active within the idle hours", async () => {
		const h = makeHarness({ settings: { autoClean: true, idleHours: 6 } });
		const [recent, old] = [await makeTree("recent"), await makeTree("old")];
		h.sizes.set(recent, 30 * GB);
		h.sizes.set(old, 30 * GB);
		h.sessionsIn.set(recent, ["s1"]);
		h.activity.set("s1", Date.now() + h.clock.offset - 2 * HOUR);
		await h.guard.check();
		expect(await exists(path.join(recent, "target"))).toBe(true);
		expect(await exists(path.join(old, "target"))).toBe(false);
	});

	test("a build in progress (fresh files in target) counts as recent use", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const tree = await makeTree("building");
		h.sizes.set(tree, 30 * GB);
		h.clock.offset = 0;
		await h.guard.check();
		expect(await exists(path.join(tree, "target"))).toBe(true);
	});

	test("skips a worktree a process runs in, found with the real probe", async () => {
		const h = makeHarness();
		const [busy, idle] = [await makeTree("busy"), await makeTree("idle")];
		h.sizes.set(busy, 30 * GB);
		h.sizes.set(idle, 30 * GB);
		const sleeper = Bun.spawn(["sleep", "60"], { cwd: path.join(busy, "src"), stdout: "ignore", stderr: "ignore" });
		spawned.push(sleeper);
		const real = createDiskGuardWithRealProbe(h);
		await real.check();
		expect(await exists(path.join(busy, "target"))).toBe(true);
		expect(await exists(path.join(idle, "target"))).toBe(false);
	});

	test("when the processes cannot be listed, every worktree counts as busy and nothing is deleted", async () => {
		const h = makeHarness({ settings: { autoClean: true }, probe: async () => null });
		const a = await makeTree("feature-a");
		h.sizes.set(a, 50 * GB);
		await h.guard.check();
		expect(await exists(path.join(a, "target"))).toBe(true);
		const scan = await h.guard.scan();
		expect(scan.candidates[0]).toMatchObject({ skip: "busy", why: "the running processes could not be checked" });
	});

	test("looks again just before deleting: a worktree that became busy after the scan is left alone", async () => {
		let calls = 0;
		const h = makeHarness({
			settings: { autoClean: true },
			// The first probe (the scan) sees nothing; the second (the look before deleting) finds a process.
			probe: async trees => {
				calls++;
				return calls === 1 ? new Map() : new Map(trees.map(tree => [tree, { pid: 99, name: "cargo" }]));
			},
		});
		const a = await makeTree("feature-a");
		h.sizes.set(a, 50 * GB);
		await h.guard.check();
		expect(calls).toBeGreaterThan(1);
		expect(await exists(path.join(a, "target"))).toBe(true);
	});

	test("never touches a main checkout, a clone or a worktree made outside the worktrees folder", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		await put(path.join(repo, "target", "CACHEDIR.TAG"));
		const clone = path.join(trees, "other", "clone");
		await fs.mkdir(path.dirname(clone), { recursive: true });
		await run(tmp, "git", "clone", "-q", repo, clone);
		await put(path.join(clone, "target", "CACHEDIR.TAG"));
		const foreign = await makeTree("foreign", path.join(tmp, "elsewhere"));
		const mine = await makeTree("mine");
		for (const tree of [repo, clone, foreign, mine]) h.sizes.set(tree, 30 * GB);
		await h.guard.check();
		expect(await exists(path.join(repo, "target"))).toBe(true);
		expect(await exists(path.join(clone, "target"))).toBe(true);
		expect(await exists(path.join(foreign, "target"))).toBe(true);
		expect(await exists(path.join(mine, "target"))).toBe(false);
	});

	test("a worktree that a sandboxed session worked in is still cleaned, and nothing in it is run", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const tree = await makeTree("sandboxed");
		const marker = path.join(tmp, "ran-repo-code");
		await fs.writeFile(
			path.join(tree, "package.json"),
			JSON.stringify({
				scripts: { postinstall: `touch ${marker}`, prepare: `touch ${marker}`, clean: `touch ${marker}` },
			}),
		);
		await fs.writeFile(path.join(tree, "Makefile"), `clean:\n\ttouch ${marker}\n`);
		await fs.writeFile(path.join(tree, ".gitattributes"), `* filter=evil\n`);
		await put(path.join(tree, "node_modules", "pkg", "index.js"));
		h.sizes.set(tree, 50 * GB);
		await h.guard.check();
		expect(await exists(path.join(tree, "target"))).toBe(false);
		expect(await exists(path.join(tree, "node_modules"))).toBe(false);
		expect(await exists(marker)).toBe(false);
	});

	test("does not retry a clean that just ran: a gap of ten minutes between tries", async () => {
		const h = makeHarness({ settings: { autoClean: true } });
		const a = await makeTree("feature-a");
		h.sizes.set(a, 1 * GB);
		await h.guard.check();
		expect((await h.guard.state()).cleans).toHaveLength(1);
		const b = await makeTree("feature-b");
		h.sizes.set(b, 1 * GB);
		await h.guard.check();
		expect(await exists(path.join(b, "target"))).toBe(true);
		h.clock.offset += 11 * 60_000;
		await h.guard.check();
		expect(await exists(path.join(b, "target"))).toBe(false);
	});
});

describe("Clean now", () => {
	test("lists the candidates biggest first with size, idle time and why one is skipped", async () => {
		const h = makeHarness();
		const [small, big, busy, recent] = [
			await makeTree("small"),
			await makeTree("big"),
			await makeTree("busy"),
			await makeTree("recent"),
		];
		h.sizes.set(small, 2 * GB);
		h.sizes.set(big, 9 * GB);
		h.sizes.set(busy, 20 * GB);
		h.sizes.set(recent, 7 * GB);
		h.sessions = [{ sessionId: "s1", name: "refactor", cwd: busy, busy: true, inputRequired: false }];
		h.sessionsIn.set(recent, ["s2"]);
		h.activity.set("s2", Date.now() + h.clock.offset - HOUR);
		const scan = await h.guard.scan();
		expect(scan.candidates.map(candidate => [candidate.name, candidate.skip])).toEqual([
			["busy", "busy"],
			["big", null],
			["recent", "recent"],
			["small", null],
		]);
		const big1 = scan.candidates.find(candidate => candidate.name === "big");
		expect(big1).toMatchObject({ path: big, repo: "repo", bytes: 9 * GB, sized: true });
		expect(big1?.idleMs).toBeGreaterThan(2 * DAY);
		expect(big1?.artifacts).toEqual([{ path: path.join(big, "target"), kind: "target", bytes: 9 * GB }]);
		expect(scan.candidates[0]?.why).toContain("refactor");
		expect(scan.candidates[2]?.why).toContain("6 h");
	});

	test("cleans what was picked, with auto-clean off and free space fine, and records it as manual", async () => {
		const h = makeHarness();
		h.free.bytes = 300 * GB;
		const [a, b] = [await makeTree("feature-a"), await makeTree("feature-b")];
		h.sizes.set(a, 3 * GB);
		h.sizes.set(b, 4 * GB);
		const done = await h.guard.clean([a]);
		expect(done.refused).toEqual([]);
		expect(done.cleans).toHaveLength(1);
		expect(done.cleans[0]).toMatchObject({ path: a, bytes: 3 * GB, trigger: "manual", kinds: ["target"] });
		expect(await exists(path.join(a, "target"))).toBe(false);
		expect(await exists(path.join(b, "target"))).toBe(true);
		expect((await loadDiskFile(stateFile)).cleans[0]?.trigger).toBe("manual");
	});

	test("refuses a busy worktree; one used recently may be cleaned because the user chose it", async () => {
		const h = makeHarness();
		const [busy, recent] = [await makeTree("busy"), await makeTree("recent")];
		h.sizes.set(busy, 3 * GB);
		h.sizes.set(recent, 3 * GB);
		h.sessions = [{ sessionId: "s1", name: "refactor", cwd: busy, busy: true, inputRequired: false }];
		h.sessionsIn.set(recent, ["s2"]);
		h.activity.set("s2", Date.now() + h.clock.offset - HOUR);
		const done = await h.guard.clean([busy, recent]);
		expect(done.refused).toEqual([{ path: busy, reason: "refactor is working in it" }]);
		expect(done.cleans.map(clean => clean.path)).toEqual([recent]);
		expect(await exists(path.join(busy, "target"))).toBe(true);
		expect(await exists(path.join(recent, "target"))).toBe(false);
	});

	test("refuses paths that are not worktrees the companion made, however they are written", async () => {
		const h = makeHarness();
		const mine = await makeTree("mine");
		const foreign = await makeTree("foreign", path.join(tmp, "elsewhere"));
		await put(path.join(home, "Documents", "target", "keep.txt"));
		const link = path.join(trees, "repo", "sneaky");
		await fs.symlink(foreign, link);
		const picked = [
			repo,
			foreign,
			link,
			path.join(mine, "target"),
			path.join(mine, "src"),
			`${mine}/../../../home/Documents`,
			path.join(trees, "repo"),
			trees,
			home,
			"relative/path",
			"",
			"/",
		];
		const done = await h.guard.clean(picked);
		expect(done.cleans).toEqual([]);
		expect(done.refused).toHaveLength(picked.length);
		expect(await exists(path.join(repo, "src", "main.rs"))).toBe(true);
		expect(await exists(path.join(foreign, "target"))).toBe(true);
		expect(await exists(path.join(mine, "target"))).toBe(true);
		expect(await exists(path.join(home, "Documents", "target", "keep.txt"))).toBe(true);
	});

	test("a worktree named twice is cleaned once; one with nothing left to clean is reported", async () => {
		const h = makeHarness();
		const a = await makeTree("feature-a");
		h.sizes.set(a, 3 * GB);
		const first = await h.guard.clean([a, a]);
		expect(first.cleans).toHaveLength(1);
		const second = await h.guard.clean([a]);
		expect(second.cleans).toEqual([]);
		expect(second.refused).toEqual([{ path: a, reason: "no build output left to clean" }]);
	});

	test("a size that could not be measured is counted from the free space that came back", async () => {
		const h = makeHarness();
		const a = await makeTree("feature-a");
		h.sizes.set(a, 8 * GB);
		const guard = createDiskGuard({
			initial: { settings: { limitGb: 40, autoClean: false, idleHours: 6 }, cleans: [], alerted: [] },
			save: async () => {},
			machine: "Test Mac",
			home,
			dirs: () => [trees],
			sessions: async () => [],
			sessionsIn: () => [],
			activity: () => undefined,
			ignorePids: () => new Set(),
			alert: () => {},
			onChange: () => {},
			onError: () => {},
			now: () => Date.now() + 3 * DAY,
			probe: async () => new Map(),
			measure: async () => null,
			readFree: async () => ({
				key: devKey,
				freeBytes: 5 * GB + ((await exists(path.join(a, "target"))) ? 0 : 8 * GB),
				totalBytes: 500 * GB,
			}),
		});
		const scan = await guard.scan();
		expect(scan.candidates[0]).toMatchObject({ sized: false, bytes: 0 });
		const done = await guard.clean([a]);
		expect(done.cleans[0]?.bytes).toBe(8 * GB);
	});
});

describe("settings", () => {
	test("start at 40 GB, auto-clean off, 6 hours", async () => {
		const guard = createDiskGuard({
			initial: await loadDiskFile(stateFile),
			save: file => saveDiskFile(stateFile, file),
			machine: "Test Mac",
			home,
			dirs: () => [trees],
			sessions: async () => [],
			sessionsIn: () => [],
			activity: () => undefined,
			ignorePids: () => new Set(),
			alert: () => {},
			onChange: () => {},
			onError: () => {},
			readFree: async () => ({ key: devKey, freeBytes: 100 * GB, totalBytes: 500 * GB }),
		});
		const state = await guard.state();
		expect(state.settings).toEqual({ limitGb: 40, autoClean: false, idleHours: 6 });
		expect(state.limitBytes).toBe(40 * GB);
		expect(state.marginBytes).toBe(4 * GB);
	});

	test("a valid edit is kept in the file and applies at once; an invalid one changes nothing", async () => {
		const h = makeHarness();
		h.free.bytes = 60 * GB;
		await h.guard.check();
		expect(h.notices).toEqual([]);
		const state = await h.guard.setSettings({ limitGb: 80, autoClean: true, idleHours: 12 });
		expect(state.settings).toEqual({ limitGb: 80, autoClean: true, idleHours: 12 });
		expect(state.volumes[0]?.low).toBe(true);
		expect((await loadDiskFile(stateFile)).settings).toEqual({ limitGb: 80, autoClean: true, idleHours: 12 });
		for (const bad of [
			{ limitGb: 0, autoClean: true, idleHours: 12 },
			{ limitGb: 80, autoClean: 1, idleHours: 12 },
			{ limitGb: 80, autoClean: true, idleHours: 0.5 },
			null,
			"x",
		]) {
			await expect(h.guard.setSettings(bad)).rejects.toThrow();
		}
		expect((await h.guard.state()).settings).toEqual({ limitGb: 80, autoClean: true, idleHours: 12 });
		expect((await loadDiskFile(stateFile)).settings.limitGb).toBe(80);
	});

	test("turning auto-clean on while the disk is already low cleans without waiting for the next check", async () => {
		const h = makeHarness();
		const a = await makeTree("feature-a");
		h.sizes.set(a, 45 * GB);
		await h.guard.state();
		await h.guard.setSettings({ limitGb: 40, autoClean: true, idleHours: 6 });
		await h.guard.check();
		expect(await exists(path.join(a, "target"))).toBe(false);
	});
});

describe("the file", () => {
	test("a missing or damaged file is the defaults; the recent cleans are capped", async () => {
		expect(await loadDiskFile(path.join(tmp, "missing.json"))).toEqual({
			settings: { limitGb: 40, autoClean: false, idleHours: 6 },
			cleans: [],
			alerted: [],
		});
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await fs.writeFile(stateFile, "{not json");
		expect((await loadDiskFile(stateFile)).settings.limitGb).toBe(40);
		const parsed = parseDiskFile({
			settings: { limitGb: 55, autoClean: true, idleHours: 9 },
			cleans: [{ nonsense: true }, null],
			alerted: ["a", 3, "b"],
		});
		expect(parsed.settings).toEqual({ limitGb: 55, autoClean: true, idleHours: 9 });
		expect(parsed.cleans).toEqual([]);
		expect(parsed.alerted).toEqual(["a", "b"]);
	});
});

/** The harness's guard, with the real process probe. */
function createDiskGuardWithRealProbe(h: Harness): DiskGuard {
	return createDiskGuard({
		initial: { settings: { limitGb: 40, autoClean: true, idleHours: 6 }, cleans: [], alerted: [] },
		save: file => saveDiskFile(stateFile, file),
		machine: "Test Mac",
		home,
		dirs: () => [trees],
		sessions: async () => [],
		sessionsIn: () => [],
		activity: () => undefined,
		ignorePids: () => new Set(),
		alert: notice => h.notices.push(notice),
		onChange: () => {},
		onError: err => h.errors.push(err),
		now: () => Date.now() + h.clock.offset,
		measure: async dir => h.sizes.get(path.dirname(dir)) ?? 1000,
		readFree: async () => {
			let total = 0;
			for (const [tree, size] of h.sizes) if (!(await exists(path.join(tree, "target")))) total += size;
			return { key: devKey, freeBytes: h.free.bytes + total, totalBytes: 500 * GB };
		},
	});
}
