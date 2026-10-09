/**
 * The companion's git workflow: a worktree per task, branch review against the
 * base branch, commit, push and pull request. These are the only places the
 * companion changes a repository, and only on a branch other than the base
 * branch. The caller refuses them while the session's agent is working.
 * Commands run with GIT_TERMINAL_PROMPT=0 (git) and GH_PROMPT_DISABLED=1 (gh),
 * so a missing credential fails instead of waiting for input.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GitFileChange, GitReview } from "../src/lib/companion";
import {
	countLines,
	diffBase,
	git,
	type GitResult,
	gitDiff,
	gitFailure,
	isInside,
	parseNumstat,
	recentCommits,
	repoRoot,
} from "./companion-git";

const REVIEW_COMMITS = 50;
const MAX_FILES = 500;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_BRANCH_CHARS = 100;
const GH_TIMEOUT_MS = 15_000;
const GH_CREATE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
/** How long a `gh auth status` answer is trusted. */
const GH_CHECK_TTL_MS = 5 * 60_000;
const MAX_ERROR_CHARS = 800;

const decoder = new TextDecoder();

function text(result: GitResult): string {
	return decoder.decode(result.out).trim();
}

/** The first lines of what a failed write printed, so a hook's complaint reaches the device. */
function writeFailure(result: GitResult, what: string): Error {
	const lines = (result.err || text(result)).split("\n").filter(line => line.trim());
	return new Error(lines.slice(0, 6).join("\n").slice(0, MAX_ERROR_CHARS) || `${what} failed`);
}

// ── gh ───────────────────────────────────────────────────────────────────────

/** `gh`: GH_BIN when set, else the one on PATH; null when neither exists. */
function ghBin(): string | null {
	return process.env.GH_BIN || Bun.which("gh");
}

async function gh(cwd: string, args: string[], timeout: number): Promise<{ code: number; out: string; err: string }> {
	const bin = ghBin();
	if (!bin) throw new Error("gh is not installed on this computer");
	const proc = Bun.spawn([bin, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
		timeout,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
}

let ghCheck: { at: number; ok: Promise<boolean> } | null = null;

/** True when `gh` is installed and signed in; the answer is cached for five minutes. */
export function canCreatePr(): Promise<boolean> {
	if (ghCheck && Date.now() - ghCheck.at < GH_CHECK_TTL_MS) return ghCheck.ok;
	const ok = gh(os.homedir(), ["auth", "status"], GH_TIMEOUT_MS).then(
		result => result.code === 0,
		() => false,
	);
	ghCheck = { at: Date.now(), ok };
	return ok;
}

// ── repository state ─────────────────────────────────────────────────────────

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (root === null) throw new Error("not a git repository");
	return root;
}

async function refExists(root: string, ref: string): Promise<boolean> {
	return (await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).code === 0;
}

/** The branch a pull request targets: origin's default branch, else main or master. */
async function resolveBase(root: string): Promise<string | null> {
	const origin = await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	const candidates = [origin.code === 0 ? text(origin) : "", "origin/main", "origin/master", "main", "master"];
	for (const candidate of candidates) if (candidate && (await refExists(root, candidate))) return candidate;
	return null;
}

/** `origin/main` → `main`. */
function baseBranchName(base: string): string {
	return base.startsWith("origin/") ? base.slice("origin/".length) : base;
}

interface BranchState {
	branch: string | null;
	base: string | null;
	mergeBase: string | null;
	isDefaultBranch: boolean;
}

async function branchState(root: string): Promise<BranchState> {
	const [head, base] = await Promise.all([git(root, ["symbolic-ref", "--short", "-q", "HEAD"]), resolveBase(root)]);
	const branch = head.code === 0 ? text(head) : null;
	let mergeBase: string | null = null;
	if (base !== null) {
		const found = await git(root, ["merge-base", base, "HEAD"]);
		if (found.code === 0) mergeBase = text(found);
	}
	return {
		branch,
		base,
		mergeBase,
		isDefaultBranch: branch !== null && base !== null && branch === baseBranchName(base),
	};
}

async function isDirty(root: string): Promise<boolean> {
	const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.code !== 0) throw gitFailure(status, "git status");
	return status.out.length > 0;
}

/** Absolute `--git-dir` and `--git-common-dir` of the checkout at `root`, symlinks resolved. */
async function gitDirs(root: string): Promise<{ gitDir: string; commonDir: string }> {
	const result = await git(root, ["rev-parse", "--git-dir", "--git-common-dir"]);
	if (result.code !== 0) throw gitFailure(result, "git rev-parse");
	const [gitDir, commonDir] = text(result).split("\n");
	return {
		gitDir: await fs.realpath(path.resolve(root, gitDir ?? "")),
		commonDir: await fs.realpath(path.resolve(root, commonDir ?? "")),
	};
}

/** Origin's URL without credentials (`https://user:token@host/x` → `https://host/x`). */
export function stripCredentials(url: string): string {
	return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i, (whole, scheme: string, userinfo: string) =>
		userinfo.includes(":") || /^https?:\/\//i.test(scheme) ? scheme : whole,
	);
}

/** The open pull request whose head is `branch`, looked up by branch (never by a numeric name). */
async function pullRequest(root: string, branch: string): Promise<GitReview["pr"]> {
	try {
		const result = await gh(
			root,
			["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,state,title", "--limit", "1"],
			GH_TIMEOUT_MS,
		);
		if (result.code !== 0) return null;
		const pr = (JSON.parse(result.out) as Partial<NonNullable<GitReview["pr"]>>[])[0];
		if (typeof pr?.number !== "number" || typeof pr.url !== "string") return null;
		return { number: pr.number, url: pr.url, state: String(pr.state ?? ""), title: String(pr.title ?? "") };
	} catch {
		return null;
	}
}

/** Tracked changes from `ref` to the working tree, then untracked files. */
async function changedFiles(root: string, ref: string): Promise<GitFileChange[]> {
	const diffArgs = ["diff", "--no-renames", "--no-ext-diff", "-z"];
	const [numstat, names, untracked] = await Promise.all([
		git(root, [...diffArgs, "--numstat", ref, "--"]),
		git(root, [...diffArgs, "--name-status", ref, "--"]),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	if (names.code !== 0) throw gitFailure(names, "git diff");
	const counts = numstat.code === 0 ? parseNumstat(numstat.out) : {};
	const files: GitFileChange[] = [];
	const records = decoder.decode(names.out).split("\0");
	for (let i = 0; i + 1 < records.length && files.length < MAX_FILES; i += 2) {
		const file = records[i + 1]!;
		const count = counts[file] ?? { added: 0, removed: 0 };
		files.push({ path: file, status: `${records[i]!.slice(0, 1)} `, ...count });
	}
	for (const file of decoder.decode(untracked.out).split("\0")) {
		if (!file || files.length >= MAX_FILES) continue;
		const added = await countLines(path.join(root, file));
		files.push({ path: file, status: "??", added, removed: added === null ? null : 0 });
	}
	return files;
}

/** Everything the review screen shows about the branch the session is on. */
export async function gitReview(cwd: string, canPr: boolean): Promise<GitReview> {
	const root = await requireRoot(cwd);
	const { branch, base, mergeBase, isDefaultBranch } = await branchState(root);
	const [files, commits, remote, head, upstream, dirty, dirs] = await Promise.all([
		changedFiles(root, mergeBase ?? (await diffBase(root))),
		mergeBase ? recentCommits(root, REVIEW_COMMITS, `${mergeBase}..HEAD`) : [],
		git(root, ["remote", "get-url", "origin"]),
		git(root, ["rev-parse", "--verify", "-q", "HEAD"]),
		git(root, ["rev-parse", "--verify", "-q", "@{upstream}"]),
		isDirty(root),
		gitDirs(root),
	]);
	return {
		root,
		branch,
		base,
		mergeBase,
		isDefaultBranch,
		dirty,
		files,
		commits,
		remote: remote.code === 0 && text(remote) ? stripCredentials(text(remote)) : null,
		pushed: head.code === 0 && upstream.code === 0 && text(head) === text(upstream),
		pr: canPr && branch !== null && !isDefaultBranch ? await pullRequest(root, branch) : null,
		worktree: dirs.gitDir !== dirs.commonDir,
	};
}

/** Diff of one path from the review's merge-base to the working tree. */
export async function reviewDiff(cwd: string, file: string): Promise<{ diff: string; truncated: boolean }> {
	const root = await requireRoot(cwd);
	const { mergeBase } = await branchState(root);
	return gitDiff(cwd, file, mergeBase ?? undefined);
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Repository root of `cwd` on a branch the app may change (not detached, not the base branch). */
async function writableBranch(cwd: string): Promise<{ root: string } & BranchState> {
	const root = await requireRoot(cwd);
	const state = await branchState(root);
	if (state.branch === null) throw new Error("HEAD is detached; switch to a branch first");
	if (state.isDefaultBranch) throw new Error(`"${state.branch}" is the base branch; work on another branch`);
	return { root, ...state };
}

/** `git add -A` and commit everything in the working tree. */
export async function gitCommit(cwd: string, message: string): Promise<void> {
	const subject = message.trim();
	if (!subject) throw new Error("commit message is empty");
	if (subject.length > MAX_MESSAGE_CHARS) throw new Error("commit message is too long");
	const { root } = await writableBranch(cwd);
	const add = await git(root, ["add", "-A"], { write: true });
	if (add.code !== 0) throw writeFailure(add, "git add");
	// Exit 0: nothing staged.
	if ((await git(root, ["diff", "--cached", "--quiet", "--no-ext-diff"])).code === 0) {
		throw new Error("nothing to commit");
	}
	const commit = await git(root, ["commit", "-m", subject], { write: true });
	if (commit.code !== 0) throw writeFailure(commit, "git commit");
}

/** `git push -u origin HEAD`. */
export async function gitPush(cwd: string): Promise<void> {
	const { root } = await writableBranch(cwd);
	const push = await git(root, ["push", "-u", "origin", "HEAD"], { write: true, timeoutMs: PUSH_TIMEOUT_MS });
	if (push.code !== 0) throw writeFailure(push, "git push");
}

/** Open a pull request for the pushed branch against the base branch; resolves with its URL. */
export async function createPullRequest(
	cwd: string,
	request: { title: string; body: string; draft: boolean },
): Promise<string> {
	const title = request.title.trim();
	if (!title) throw new Error("pull request title is empty");
	if (title.length > MAX_MESSAGE_CHARS || request.body.length > MAX_MESSAGE_CHARS * 4) {
		throw new Error("pull request text is too long");
	}
	const { root, branch, base } = await writableBranch(cwd);
	if (base === null) throw new Error("no base branch found (origin/HEAD, main or master)");
	const [head, upstream] = await Promise.all([
		git(root, ["rev-parse", "--verify", "-q", "HEAD"]),
		git(root, ["rev-parse", "--verify", "-q", "@{upstream}"]),
	]);
	if (head.code !== 0 || upstream.code !== 0 || text(head) !== text(upstream)) {
		throw new Error("push the branch before opening a pull request");
	}
	const args = [
		"pr",
		"create",
		"--base",
		baseBranchName(base),
		"--head",
		branch!,
		"--title",
		title,
		"--body",
		request.body,
	];
	if (request.draft) args.push("--draft");
	const result = await gh(root, args, GH_CREATE_TIMEOUT_MS);
	if (result.code !== 0) {
		throw new Error(
			result.err.split("\n").filter(Boolean).slice(0, 4).join("\n").slice(0, MAX_ERROR_CHARS) ||
				"gh pr create failed",
		);
	}
	// gh prints the pull request URL last.
	const url = result.out
		.split("\n")
		.reverse()
		.find(line => /^https?:\/\/\S+$/.test(line.trim()));
	if (!url) throw new Error("gh did not print the pull request URL");
	return url.trim();
}

// ── worktrees ────────────────────────────────────────────────────────────────

function defaultBranchName(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	return `omp/${stamp}-${crypto.randomUUID().slice(0, 4)}`;
}

/**
 * A new branch (default `omp/<YYYYMMDD-HHmm>-<4 hex>`) from HEAD in its own
 * worktree at `<worktreesRoot>/<repo>/<branch, / as ->`, so a session can work
 * without touching the checkout it started from.
 */
export async function createWorktree(
	cwd: string,
	worktreesRoot: string,
	branch?: string,
	now = new Date(),
): Promise<{ root: string; path: string; branch: string }> {
	const root = await requireRoot(cwd);
	const name = branch?.trim() || defaultBranchName(now);
	const check = await git(root, ["check-ref-format", "--branch", name]);
	// `--branch` also expands `@{-1}`; only a name that comes back unchanged is a plain branch name.
	if (name.length > MAX_BRANCH_CHARS || name.startsWith("-") || check.code !== 0 || text(check) !== name) {
		throw new Error(`invalid branch name: ${name.slice(0, MAX_BRANCH_CHARS)}`);
	}
	const target = path.join(worktreesRoot, path.basename(root), name.replaceAll("/", "-"));
	if (!isInside(worktreesRoot, target) || target === worktreesRoot) throw new Error("invalid branch name");
	await fs.mkdir(path.dirname(target), { recursive: true });
	const added = await git(root, ["worktree", "add", "-b", name, target, "HEAD"], { write: true });
	if (added.code !== 0) throw writeFailure(added, "git worktree add");
	return { root, path: target, branch: name };
}

/** Undo {@link createWorktree} after the session failed to start: the tree and branch are brand new. */
export async function discardWorktree(created: { root: string; path: string; branch: string }): Promise<void> {
	await git(created.root, ["worktree", "remove", "--force", created.path], { write: true });
	await git(created.root, ["branch", "-D", created.branch], { write: true });
}

/**
 * Remove the linked worktree at `target`, which must be under `worktreesRoot`
 * (where the companion creates them), and keep its branch. Refused while any
 * of `runningCwds` (working directories of running omp processes) is inside it,
 * or while it has uncommitted changes.
 */
export async function removeWorktree(target: string, worktreesRoot: string, runningCwds: string[]): Promise<void> {
	if (!path.isAbsolute(target) || target.includes("\0")) throw new Error("invalid worktree path");
	const base = await fs.realpath(worktreesRoot).catch(() => null);
	const resolved = await fs.realpath(target).catch(() => null);
	if (resolved === null) throw new Error("worktree not found");
	if (base === null || resolved === base || !isInside(base, resolved)) {
		throw new Error("only worktrees created by the companion can be removed");
	}
	// `target` itself, not a repository somewhere beneath it.
	const root = await requireRoot(resolved);
	if (root !== resolved) throw new Error("not a worktree root");
	for (const cwd of runningCwds) {
		const running = await fs.realpath(cwd).catch(() => cwd);
		if (isInside(root, running)) throw new Error("a session is still running in this worktree; end it first");
	}
	const { gitDir, commonDir } = await gitDirs(root);
	if (gitDir === commonDir) throw new Error("not a linked worktree");
	if (await isDirty(root)) throw new Error("the worktree has uncommitted changes");
	// A linked worktree cannot remove itself from inside: run from the main checkout.
	const main = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	const removed = await git(main, ["worktree", "remove", root], { write: true });
	if (removed.code !== 0) throw writeFailure(removed, "git worktree remove");
}
