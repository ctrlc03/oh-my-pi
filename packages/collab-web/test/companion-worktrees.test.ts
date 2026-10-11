import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktree, discardWorktree } from "../scripts/companion-gitflow";
import {
	applySetupTrust,
	branchPrState,
	createWorktreeSweeper,
	DEFAULT_GIT_FLOW_SETTINGS,
	type GitFlowFile,
	parseGitFlowFile,
	parseGitFlowSettings,
	projectSetupStatuses,
	replaceSettings,
	runWorktreeSetup,
	setupHash,
	sweepWorktrees,
	worktreeLocations,
} from "../scripts/companion-worktrees";

let tmp: string;
let repo: string;
let trees: string;
let savedGhBin: string | undefined;
let ghState: string;

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

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-worktrees-")));
	repo = path.join(tmp, "repo");
	trees = path.join(tmp, "trees");
	await fs.mkdir(repo);
	await run(repo, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(repo, "git", "config", key, value);
	}
	await fs.writeFile(path.join(repo, "a.txt"), "one\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "init");

	// gh stand-in: `pr list --head <branch>` answers from the file `ghState` points at, per branch.
	ghState = path.join(tmp, "gh-state");
	await fs.mkdir(ghState);
	const stub = path.join(tmp, "gh");
	await fs.writeFile(
		stub,
		`#!/bin/sh
head=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--head" ]; then head="$2"; fi
  shift
done
f="${ghState}/$(printf '%s' "$head" | tr '/' '-')"
if [ -f "$f" ]; then cat "$f"; exit $(cat "$f.code" 2>/dev/null || echo 0); fi
echo '[]'
`,
		{ mode: 0o755 },
	);
	savedGhBin = process.env.GH_BIN;
	process.env.GH_BIN = stub;
});

afterAll(async () => {
	if (savedGhBin === undefined) delete process.env.GH_BIN;
	else process.env.GH_BIN = savedGhBin;
	await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
	await fs.rm(trees, { recursive: true, force: true });
});

afterEach(async () => {
	for (const entry of await fs.readdir(ghState)) await fs.rm(path.join(ghState, entry));
	// Leave the repo as found: no stale worktrees or branches.
	await fs.rm(trees, { recursive: true, force: true });
	await run(repo, "git", "worktree", "prune");
	const branches = (await run(repo, "git", "branch", "--format=%(refname:short)")).split("\n");
	for (const branch of branches) if (branch !== "main") await run(repo, "git", "branch", "-D", branch);
});

const setPr = (branch: string, states: string[]) =>
	fs.writeFile(path.join(ghState, branch.replaceAll("/", "-")), JSON.stringify(states.map(state => ({ state }))));

describe("parseGitFlowSettings", () => {
	it("defaults every field when the file is missing or damaged", () => {
		expect(parseGitFlowFile(null).settings).toEqual(DEFAULT_GIT_FLOW_SETTINGS);
		expect(
			parseGitFlowFile({ settings: { branchPrefix: 5, cleanup: "x", worktreesDir: "relative" } }).settings,
		).toEqual(DEFAULT_GIT_FLOW_SETTINGS);
		expect(DEFAULT_GIT_FLOW_SETTINGS).toMatchObject({ branchPrefix: "omp/", cleanup: { mode: "off" } });
	});

	it("accepts a device's edit and normalises it", () => {
		const settings = parseGitFlowSettings(
			{
				branchPrefix: "feature",
				worktreesDir: `~/wt/../trees`,
				setupScript: "  bun install  ",
				cleanup: { mode: "inactive", days: 30 },
				messageModel: "",
			},
			true,
		);
		expect(settings).toEqual({
			branchPrefix: "feature/",
			worktreesDir: path.join(os.homedir(), "trees"),
			setupScript: "bun install",
			cleanup: { mode: "inactive", days: 30 },
			messageModel: DEFAULT_GIT_FLOW_SETTINGS.messageModel,
		});
	});

	it("refuses invalid edits instead of storing them", () => {
		const good = { ...DEFAULT_GIT_FLOW_SETTINGS };
		for (const bad of [
			{ branchPrefix: "-x" },
			{ branchPrefix: "a..b" },
			{ branchPrefix: "has space" },
			{ worktreesDir: "relative/dir" },
			{ worktreesDir: "/" },
			{ worktreesDir: os.homedir() },
			{ cleanup: { mode: "always", days: 3 } },
			{ cleanup: { mode: "merged", days: 0 } },
			{ messageModel: "--thinking" },
			{ setupScript: "x".repeat(3_000) },
		]) {
			expect(() => parseGitFlowSettings({ ...good, ...bad }, true)).toThrow("invalid");
		}
	});
});

describe("worktree locations", () => {
	it("keeps the folder worktrees were made under removable after the location changes", () => {
		const defaultDir = path.join(tmp, "default");
		const first: GitFlowFile = { settings: DEFAULT_GIT_FLOW_SETTINGS, previousDirs: [], trustedSetups: {} };
		const moved = replaceSettings(
			first,
			{ ...DEFAULT_GIT_FLOW_SETTINGS, worktreesDir: path.join(tmp, "elsewhere") },
			defaultDir,
		);
		expect(worktreeLocations(moved, defaultDir)).toEqual([path.join(tmp, "elsewhere"), defaultDir]);
		const back = replaceSettings(moved, DEFAULT_GIT_FLOW_SETTINGS, defaultDir);
		expect(worktreeLocations(back, defaultDir)).toEqual([defaultDir, path.join(tmp, "elsewhere")]);
		// An unrelated edit does not touch the history.
		expect(
			replaceSettings(back, { ...DEFAULT_GIT_FLOW_SETTINGS, branchPrefix: "x/" }, defaultDir).previousDirs,
		).toEqual(back.previousDirs);
	});
});

describe("createWorktree prefix", () => {
	it("prefixes generated names only", async () => {
		const generated = await createWorktree(repo, trees, undefined, new Date(2026, 9, 9, 7, 5), {
			branchPrefix: "wip/",
		});
		expect(generated.branch).toMatch(/^wip\/20261009-0705-[0-9a-f]{4}$/);
		const bare = await createWorktree(repo, trees, undefined, new Date(2026, 9, 9, 7, 5), { branchPrefix: "" });
		expect(bare.branch).toMatch(/^20261009-0705-[0-9a-f]{4}$/);
		const named = await createWorktree(repo, trees, "mine", new Date(), { branchPrefix: "wip/" });
		expect(named.branch).toBe("mine");
		for (const created of [generated, bare, named]) await discardWorktree(created);
	});
});

describe("runWorktreeSetup", () => {
	const none = {};

	it("runs the command once, inside the new tree, with the worktree environment", async () => {
		const created = await createWorktree(repo, trees, "setup-once");
		const result = await runWorktreeSetup(created, {
			command: 'echo "$OMP_WORKTREE_BRANCH $PWD $OMP_REPO_ROOT" >> setup.log',
			allowProjectFile: true,
			trusted: none,
		});
		expect(result).toEqual({ ran: "settings", unapproved: null });
		const log = (await Bun.file(path.join(created.path, "setup.log")).text()).trim().split("\n");
		expect(log).toEqual([`setup-once ${created.path} ${repo}`]);
	});

	it("never runs a repository's .omp/worktree-setup the user has not approved, and falls back to the setting", async () => {
		const script = "echo project >> who.log\n";
		await fs.mkdir(path.join(repo, ".omp"));
		await fs.writeFile(path.join(repo, ".omp", "worktree-setup"), script);
		try {
			const first = await createWorktree(repo, trees, "setup-untrusted");
			const result = await runWorktreeSetup(first, {
				command: "echo settings >> who.log",
				allowProjectFile: true,
				trusted: none,
			});
			expect(result).toEqual({
				ran: "settings",
				unapproved: { root: repo, hash: setupHash(script), script },
			});
			expect((await Bun.file(path.join(first.path, "who.log")).text()).trim()).toBe("settings");

			const bare = await createWorktree(repo, trees, "setup-untrusted-bare");
			expect(await runWorktreeSetup(bare, { command: "", allowProjectFile: true, trusted: none })).toMatchObject({
				ran: null,
				unapproved: { root: repo },
			});
			expect(await Bun.file(path.join(bare.path, "who.log")).exists()).toBe(false);
		} finally {
			await fs.rm(path.join(repo, ".omp"), { recursive: true });
		}
	});

	it("runs the approved script in preference to the setting, but not once its content changed, nor for sandboxed sessions", async () => {
		const script = "echo project >> who.log\n";
		await fs.mkdir(path.join(repo, ".omp"));
		await fs.writeFile(path.join(repo, ".omp", "worktree-setup"), script);
		try {
			const trusted = { [repo]: setupHash(script) };
			const approved = await createWorktree(repo, trees, "setup-approved");
			expect(
				await runWorktreeSetup(approved, { command: "echo settings >> who.log", allowProjectFile: true, trusted }),
			).toEqual({ ran: "project", unapproved: null });
			expect((await Bun.file(path.join(approved.path, "who.log")).text()).trim()).toBe("project");

			const sandboxed = await createWorktree(repo, trees, "setup-sandboxed");
			expect(
				await runWorktreeSetup(sandboxed, {
					command: "echo settings >> who.log",
					allowProjectFile: false,
					trusted,
				}),
			).toEqual({ ran: "settings", unapproved: null });
			expect((await Bun.file(path.join(sandboxed.path, "who.log")).text()).trim()).toBe("settings");

			// Someone edits the approved script (a pull, an agent): the approval no longer applies.
			await fs.writeFile(path.join(repo, ".omp", "worktree-setup"), `${script}touch pwned\n`);
			const changed = await createWorktree(repo, trees, "setup-changed");
			const result = await runWorktreeSetup(changed, { command: "", allowProjectFile: true, trusted });
			expect(result.ran).toBeNull();
			expect(result.unapproved?.script).toContain("pwned");
			expect(await Bun.file(path.join(changed.path, "pwned")).exists()).toBe(false);
		} finally {
			await fs.rm(path.join(repo, ".omp"), { recursive: true });
		}
	});

	it("does nothing without a script, and reports a failing one with its output", async () => {
		const created = await createWorktree(repo, trees, "setup-none");
		expect(await runWorktreeSetup(created, { command: "", allowProjectFile: true, trusted: none })).toEqual({
			ran: null,
			unapproved: null,
		});
		await expect(
			runWorktreeSetup(created, {
				command: "echo installing; echo boom >&2; exit 4",
				allowProjectFile: true,
				trusted: none,
			}),
		).rejects.toThrow(/exit 4[\s\S]*boom/);
	});
});

describe("approving a repository's setup script", () => {
	const script = "echo hi\n";
	const base: GitFlowFile = { settings: DEFAULT_GIT_FLOW_SETTINGS, previousDirs: [], trustedSetups: {} };

	async function withScript<T>(body: string, use: () => Promise<T>): Promise<T> {
		await fs.mkdir(path.join(repo, ".omp"), { recursive: true });
		await fs.writeFile(path.join(repo, ".omp", "worktree-setup"), body);
		try {
			return await use();
		} finally {
			await fs.rm(path.join(repo, ".omp"), { recursive: true });
		}
	}

	it("approves only the content that was shown, for a repository a start reported", async () => {
		await withScript(script, async () => {
			const known = new Set([repo]);
			const approved = await applySetupTrust(base, known, { root: repo, hash: setupHash(script) });
			expect(approved.trustedSetups).toEqual({ [repo]: setupHash(script) });
			expect(await projectSetupStatuses(approved, [])).toEqual([
				{ root: repo, script, hash: setupHash(script), trusted: true, approved: true },
			]);

			await expect(
				applySetupTrust(base, known, { root: repo, hash: setupHash("something else\n") }),
			).rejects.toThrow("changed");
			// A repository nobody reported, a path that is not absolute, and a malformed request.
			await expect(applySetupTrust(base, new Set(), { root: repo, hash: setupHash(script) })).rejects.toThrow(
				"unknown",
			);
			await expect(applySetupTrust(base, known, { root: "relative", hash: setupHash(script) })).rejects.toThrow(
				"invalid",
			);
			await expect(applySetupTrust(base, known, { root: repo, hash: 5 })).rejects.toThrow("invalid");

			// Edited after approval: listed as approved but no longer trusted, until approved again.
			await fs.writeFile(path.join(repo, ".omp", "worktree-setup"), "echo changed\n");
			expect(await projectSetupStatuses(approved, [])).toMatchObject([{ trusted: false, approved: true }]);

			const withdrawn = await applySetupTrust(approved, known, { root: repo, hash: null });
			expect(withdrawn.trustedSetups).toEqual({});
		});
	});

	it("survives a round trip through the file and ignores damaged entries", () => {
		const hash = setupHash(script);
		const parsed = parseGitFlowFile({
			trustedSetups: { [repo]: hash, relative: hash, "/x": "not-a-hash", "/y": 5 },
		});
		expect(parsed.trustedSetups).toEqual({ [repo]: hash });
		expect(replaceSettings(parsed, DEFAULT_GIT_FLOW_SETTINGS, "/d").trustedSetups).toEqual({ [repo]: hash });
	});
});

describe("branchPrState", () => {
	it("reads the pull request state of a branch, an open one winning over a merged one", async () => {
		await setPr("a", ["MERGED"]);
		await setPr("b", ["CLOSED", "MERGED", "OPEN"]);
		await setPr("c", ["CLOSED"]);
		expect(await branchPrState(repo, "a")).toBe("MERGED");
		expect(await branchPrState(repo, "b")).toBe("OPEN");
		expect(await branchPrState(repo, "c")).toBe("CLOSED");
		expect(await branchPrState(repo, "none")).toBeNull();
	});

	it("is null (unknown, not merged) when gh fails", async () => {
		await setPr("broken", ["MERGED"]);
		await fs.writeFile(path.join(ghState, "broken.code"), "1");
		expect(await branchPrState(repo, "broken")).toBeNull();
	});
});

describe("sweepWorktrees", () => {
	const merged = async (_root: string, branch: string) =>
		branch.startsWith("done") ? ("MERGED" as const) : ("OPEN" as const);
	const sweep = (cleanup: GitFlowFile["settings"]["cleanup"], runningCwds: string[] = [], now = Date.now()) =>
		sweepWorktrees({ dirs: [trees], cleanup, runningCwds, now, prState: merged });
	const exists = (dir: string) =>
		fs.stat(dir).then(
			() => true,
			() => false,
		);

	it("removes a clean worktree whose pull request merged, and keeps its branch", async () => {
		const gone = await createWorktree(repo, trees, "done-clean");
		const open = await createWorktree(repo, trees, "wip-open");
		const result = await sweep({ mode: "merged", days: 14 });
		expect(result.removed).toEqual([{ path: gone.path, branch: "done-clean", reason: "merged" }]);
		expect(await exists(gone.path)).toBe(false);
		expect(await exists(open.path)).toBe(true);
		expect(await run(repo, "git", "branch", "--list", "done-clean")).toContain("done-clean");
	});

	it("never removes a worktree with uncommitted changes, tracked or untracked", async () => {
		const edited = await createWorktree(repo, trees, "done-edited");
		await fs.writeFile(path.join(edited.path, "a.txt"), "changed\n");
		const untracked = await createWorktree(repo, trees, "done-untracked");
		await fs.writeFile(path.join(untracked.path, "new.txt"), "work\n");
		const result = await sweep({ mode: "merged", days: 14 });
		expect(result.removed).toEqual([]);
		expect(await exists(edited.path)).toBe(true);
		expect(await exists(untracked.path)).toBe(true);
		expect(await Bun.file(path.join(untracked.path, "new.txt")).text()).toBe("work\n");
	});

	it("never removes a worktree an omp is running in", async () => {
		const busy = await createWorktree(repo, trees, "done-running");
		const result = await sweep({ mode: "merged", days: 14 }, [path.join(busy.path, "src")]);
		expect(result.removed).toEqual([]);
		expect(await exists(busy.path)).toBe(true);
	});

	it("does nothing when cleanup is off", async () => {
		const created = await createWorktree(repo, trees, "done-off");
		expect((await sweep({ mode: "off", days: 14 })).removed).toEqual([]);
		expect(await exists(created.path)).toBe(true);
	});

	it("inactive mode removes clean trees untouched for the period, not before, and not dirty ones", async () => {
		const idle = await createWorktree(repo, trees, "idle-clean");
		const dirty = await createWorktree(repo, trees, "idle-dirty");
		await fs.writeFile(path.join(dirty.path, "x.txt"), "work\n");
		const soon = await sweep({ mode: "inactive", days: 14 });
		expect(soon.removed).toEqual([]);
		const later = await sweep({ mode: "inactive", days: 14 }, [], Date.now() + 15 * 86_400_000);
		expect(later.removed.map(removed => removed.branch)).toEqual(["idle-clean"]);
		expect(later.removed[0]?.reason).toBe("inactive");
		expect(await exists(idle.path)).toBe(false);
		expect(await exists(dirty.path)).toBe(true);
	});

	it("only considers folders under the known worktree locations", async () => {
		const outside = path.join(tmp, "outside");
		const created = await createWorktree(repo, outside, "done-outside");
		const result = await sweep({ mode: "merged", days: 14 });
		expect(result.removed).toEqual([]);
		expect(await exists(created.path)).toBe(true);
		await discardWorktree(created);
	});
});

describe("createWorktreeSweeper", () => {
	it("is idle while cleanup is off and sweeps at most once per interval", async () => {
		const created = await createWorktree(repo, trees, "done-sweeper");
		let mode: GitFlowFile["settings"]["cleanup"]["mode"] = "off";
		let clock = 1_000_000;
		let listings = 0;
		await setPr("done-sweeper", ["MERGED"]);
		const sweeper = createWorktreeSweeper({
			settings: () => ({ mode, days: 14 }),
			dirs: () => [trees],
			runningCwds: async () => {
				listings++;
				return [];
			},
			now: () => clock,
		});
		expect(await sweeper.tick()).toBeNull();
		expect(listings).toBe(0);
		mode = "merged";
		const first = await sweeper.tick();
		expect(first?.removed.map(removed => removed.branch)).toEqual(["done-sweeper"]);
		clock += 60_000;
		expect(await sweeper.tick()).toBeNull();
		expect(listings).toBe(1);
		expect(await sweeper.tick(true)).not.toBeNull();
		await fs.stat(created.path).then(
			() => {
				throw new Error("worktree should be gone");
			},
			() => undefined,
		);
	});
});
