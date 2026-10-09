import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createPullRequest,
	createWorktree,
	discardWorktree,
	gitCommit,
	gitPush,
	gitReview,
	removeWorktree,
	reviewDiff,
	stripCredentials,
} from "../scripts/companion-gitflow";

let tmp: string;
let origin: string;
let repo: string;
let worktrees: string;
let ghArgv: string;
let ghListArgv: string;
let savedGhBin: string | undefined;

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

async function branches(): Promise<string[]> {
	return (await run(repo, "git", "branch", "--format=%(refname:short)")).split("\n");
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-gitflow-")));
	origin = path.join(tmp, "origin.git");
	repo = path.join(tmp, "repo");
	worktrees = path.join(tmp, "worktrees");
	ghArgv = path.join(tmp, "gh-argv.txt");
	ghListArgv = path.join(tmp, "gh-list-argv.txt");
	await fs.mkdir(repo);
	await run(tmp, "git", "init", "-q", "--bare", "-b", "main", origin);
	await run(repo, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(repo, "git", "config", key, value);
	}
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "init");
	await run(repo, "git", "remote", "add", "origin", origin);
	await run(repo, "git", "push", "-q", "-u", "origin", "main");
	await run(repo, "git", "remote", "set-head", "origin", "main");

	// A gh stand-in: records `pr create` and `pr list` arguments; `pr list` answers with one open pull request.
	const stub = path.join(tmp, "gh");
	await fs.writeFile(
		stub,
		`#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  printf '%s\\n' "$@" > "${ghListArgv}"
  echo '[{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","title":"T"}]'
  exit 0
fi
printf '%s\\n' "$@" > "${ghArgv}"
echo "https://github.com/o/r/pull/7"
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

describe("stripCredentials", () => {
	it("drops user and token from https remotes but keeps the ssh user", () => {
		expect(stripCredentials("https://user:ghp_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
		expect(stripCredentials("https://ghp_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
		expect(stripCredentials("ssh://git:pw@host/o/r.git")).toBe("ssh://host/o/r.git");
		expect(stripCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
		expect(stripCredentials("ssh://git@host/o/r.git")).toBe("ssh://git@host/o/r.git");
	});
});

describe("createWorktree", () => {
	it("creates the branch in <worktrees>/<repo>/<branch with / as ->", async () => {
		const created = await createWorktree(repo, worktrees, "feat/login");
		expect(created.path).toBe(path.join(worktrees, "repo", "feat-login"));
		expect(await run(created.path, "git", "symbolic-ref", "--short", "HEAD")).toBe("feat/login");
		expect(await run(created.path, "git", "rev-parse", "HEAD")).toBe(await run(repo, "git", "rev-parse", "main"));
		await discardWorktree(created);
	});

	it("names the branch omp/<YYYYMMDD-HHmm>-<4 hex> by default", async () => {
		const created = await createWorktree(repo, worktrees, undefined, new Date(2026, 9, 9, 7, 5));
		expect(created.branch).toMatch(/^omp\/20261009-0705-[0-9a-f]{4}$/);
		expect(created.path).toBe(path.join(worktrees, "repo", created.branch.replace("/", "-")));
		await discardWorktree(created);
	});

	it("rejects names that are not plain branch names, and existing branches", async () => {
		for (const name of ["-x", "a..b", "@{-1}", "has space", "x.lock"]) {
			await expect(createWorktree(repo, worktrees, name)).rejects.toThrow("invalid branch name");
		}
		await expect(createWorktree(repo, worktrees, "main")).rejects.toThrow();
		await expect(createWorktree(tmp, worktrees)).rejects.toThrow("not a git repository");
	});

	it("discardWorktree removes the tree and the branch", async () => {
		const created = await createWorktree(repo, worktrees, "scratch");
		await discardWorktree(created);
		expect(await fs.stat(created.path).catch(() => null)).toBeNull();
		expect(await branches()).not.toContain("scratch");
	});
});

describe("branch review, commit, push and pull request", () => {
	let work: string;
	const branch = "feat/review";

	beforeAll(async () => {
		work = (await createWorktree(repo, worktrees, branch)).path;
	});

	it("starts empty: not default, linked worktree, nothing pushed", async () => {
		const review = await gitReview(work, false);
		expect(review).toMatchObject({
			branch,
			base: "origin/main",
			isDefaultBranch: false,
			dirty: false,
			files: [],
			commits: [],
			pushed: false,
			pr: null,
			worktree: true,
			remote: origin,
		});
		expect(review.mergeBase).toBe(await run(repo, "git", "rev-parse", "main"));
	});

	it("the base branch itself is the default branch and not a worktree", async () => {
		const review = await gitReview(repo, false);
		expect(review).toMatchObject({ branch: "main", isDefaultBranch: true, worktree: false });
	});

	it("refuses to commit, push or open a pull request on the default branch", async () => {
		await fs.writeFile(path.join(repo, "main-change.txt"), "x\n");
		await expect(gitCommit(repo, "nope")).rejects.toThrow("base branch");
		await expect(gitPush(repo)).rejects.toThrow("base branch");
		await expect(createPullRequest(repo, { title: "t", body: "", draft: false })).rejects.toThrow("base branch");
		expect(await run(repo, "git", "status", "--porcelain")).toBe("?? main-change.txt");
		await fs.rm(path.join(repo, "main-change.txt"));
	});

	it("refuses an empty message and a clean tree", async () => {
		await expect(gitCommit(work, "  \n")).rejects.toThrow("empty");
		await expect(gitCommit(work, "nothing")).rejects.toThrow("nothing to commit");
	});

	it("lists changes from the merge-base to the working tree, untracked included", async () => {
		await fs.writeFile(path.join(work, "a.txt"), "one\nthree\nfour\n");
		await gitCommit(work, "edit a");
		await fs.writeFile(path.join(work, "b.txt"), "b1\nb2\n");
		const review = await gitReview(work, false);
		expect(review.dirty).toBe(true);
		expect(review.commits.map(commit => commit.subject)).toEqual(["edit a"]);
		const byPath = Object.fromEntries(review.files.map(file => [file.path, file]));
		// a.txt differs from main although it is committed on the branch; b.txt is untracked.
		expect(byPath["a.txt"]).toMatchObject({ status: "M ", added: 2, removed: 1 });
		expect(byPath["b.txt"]).toMatchObject({ status: "??", added: 2, removed: 0 });
		expect(Object.keys(byPath)).toHaveLength(2);
	});

	it("diffs a committed path against the merge-base, and an untracked one as added", async () => {
		expect((await reviewDiff(work, "a.txt")).diff).toContain("+three");
		expect((await reviewDiff(work, "b.txt")).diff).toContain("+b1");
	});

	it("commit stages everything; push publishes the branch", async () => {
		await gitCommit(work, "add b");
		expect((await gitReview(work, false)).dirty).toBe(false);
		expect((await gitReview(work, false)).pushed).toBe(false);
		await gitPush(work);
		expect((await gitReview(work, false)).pushed).toBe(true);
		expect(await run(origin, "git", "rev-parse", branch)).toBe(await run(work, "git", "rev-parse", "HEAD"));
		await fs.writeFile(path.join(work, "c.txt"), "c\n");
		await gitCommit(work, "add c");
		expect((await gitReview(work, false)).pushed).toBe(false);
	});

	it("refuses a pull request until the branch is pushed", async () => {
		await expect(createPullRequest(work, { title: "t", body: "", draft: false })).rejects.toThrow("push the branch");
		await expect(createPullRequest(work, { title: " ", body: "", draft: false })).rejects.toThrow("title is empty");
	});

	it("opens the pull request against the base branch and reads it back", async () => {
		await gitPush(work);
		const url = await createPullRequest(work, { title: "Add things", body: "Body text", draft: true });
		expect(url).toBe("https://github.com/o/r/pull/7");
		expect((await Bun.file(ghArgv).text()).trim().split("\n")).toEqual([
			"pr",
			"create",
			"--base",
			"main",
			"--head",
			branch,
			"--title",
			"Add things",
			"--body",
			"Body text",
			"--draft",
		]);
		const review = await gitReview(work, true);
		expect(review.pr).toEqual({
			number: 7,
			url: "https://github.com/o/r/pull/7",
			state: "OPEN",
			title: "T",
		});
		// Looked up by branch name among open pull requests, never as a PR number.
		expect((await Bun.file(ghListArgv).text()).trim().split("\n")).toEqual([
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number,url,state,title",
			"--limit",
			"1",
		]);
	});

	it("removes a clean linked worktree, keeps its branch, and refuses dirty, foreign or occupied ones", async () => {
		await expect(removeWorktree(repo, worktrees, [])).rejects.toThrow("only worktrees created by the companion");
		await expect(removeWorktree(path.join(work, "sub"), worktrees, [])).rejects.toThrow("worktree not found");
		await fs.writeFile(path.join(work, "dirty.txt"), "d\n");
		await expect(removeWorktree(work, worktrees, [])).rejects.toThrow("uncommitted");
		await fs.rm(path.join(work, "dirty.txt"));
		// An omp (hosting or not) whose cwd is the worktree, or beneath it, keeps it alive.
		await expect(removeWorktree(work, worktrees, [repo, work])).rejects.toThrow("still running");
		await fs.mkdir(path.join(work, "sub"));
		await expect(removeWorktree(work, worktrees, [path.join(work, "sub")])).rejects.toThrow("still running");
		await fs.rmdir(path.join(work, "sub"));
		await removeWorktree(work, worktrees, [repo]);
		expect(await fs.stat(work).catch(() => null)).toBeNull();
		expect(await branches()).toContain(branch);
	});
});
