/**
 * Git side of the companion's architecture maps (./companion-blueprint): turning what the user picked (a branch, a
 * pull request, "the working tree") into commits, checking commits out for a run, and reading files and diffs at
 * those commits. Nothing here touches the user's checkout, branches or index: a pull request is fetched into a
 * private ref (`refs/omp-blueprint/pr/<n>`), the working tree is snapshotted through a throw-away index file into a
 * commit object, and a run reads a detached `git worktree` under the companion's cache folder that is removed after.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlueprintChange, BlueprintCommit, BlueprintRefsAnswer } from "@oh-my-pi/pi-wire/blueprint";
import { git, type GitOptions, type GitResult, gitFailure, hasNul, repoRoot } from "./companion-git";
import { canCreatePr, gh } from "./companion-gitflow";

/** Where the companion keeps what it fetches or creates in a repository: invisible to `git branch` and `git log`. */
export const PRIVATE_REF_PREFIX = "refs/omp-blueprint";

const FETCH_TIMEOUT_MS = 120_000;
/** A checkout of a large repository can take a while. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 30_000;
/** Largest file read from a commit for citations and excerpts. */
export const BLOB_BYTES = 2 * 1024 * 1024;
const TREE_BYTES = 64 * 1024 * 1024;
const DIFF_BYTES = 16 * 1024 * 1024;
const MAX_BRANCHES = 200;
const MAX_PRS = 30;
const MAX_REF_CHARS = 200;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const PR_REF_RE = /^pr\/([1-9][0-9]{0,8})$/;

/** The ref of a pull request in {@link PRIVATE_REF_PREFIX}. */
export function prRef(number: number): string {
	return `${PRIVATE_REF_PREFIX}/pr/${number}`;
}

const decoder = new TextDecoder();

function text(result: GitResult): string {
	return decoder.decode(result.out).trim();
}

/** Run git and return its trimmed output; a failure becomes an error with git's first line. */
async function gitOut(cwd: string, args: string[], what: string, options?: GitOptions): Promise<string> {
	const result = await git(cwd, args, options);
	if (result.code !== 0) throw gitFailure(result, what);
	return text(result);
}

/** Like {@link gitOut}, null when git exits non-zero. */
async function gitMaybe(cwd: string, args: string[], options?: GitOptions): Promise<string | null> {
	const result = await git(cwd, args, options);
	return result.code === 0 ? text(result) : null;
}

/** A ref name from a device: no flags, no whitespace or control characters. */
export function checkRefName(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REF_CHARS || value.startsWith("-"))
		throw new Error(`invalid ${what}`);
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code <= 0x20 || code === 0x7f) throw new Error(`invalid ${what}`);
	}
	return value;
}

/** The commit `rev` names, or null. */
export async function resolveCommit(root: string, rev: string): Promise<string | null> {
	checkRefName(rev, "ref");
	const out = await gitMaybe(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	return out !== null && COMMIT_RE.test(out) ? out : null;
}

async function commitSubject(root: string, commit: string): Promise<string | undefined> {
	const out = await gitMaybe(root, ["log", "-1", "--format=%s", commit]);
	return out || undefined;
}

/** `owner/name` of a GitHub remote URL, or undefined for any other host. */
export function githubSlug(url: string): string | undefined {
	const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface RepoInfo {
	root: string;
	name: string;
	github?: string;
}

/** The repository containing `cwd`: its primary checkout (a linked worktree resolves to the main one). */
export async function repoInfo(cwd: string): Promise<RepoInfo> {
	const top = await repoRoot(cwd);
	if (top === null) throw new Error("not a git repository");
	// A linked worktree's common git dir sits inside the primary checkout.
	const common = await gitMaybe(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const root = common !== null && path.basename(common) === ".git" ? await fs.realpath(path.dirname(common)) : top;
	const remote = await gitMaybe(root, ["remote", "get-url", "origin"]);
	return { root, name: path.basename(root), github: remote ? githubSlug(remote) : undefined };
}

async function currentBranch(root: string): Promise<string | undefined> {
	return (await gitMaybe(root, ["branch", "--show-current"])) || undefined;
}

/** The remote pull requests and base branches are fetched from: `origin`, else the first one. */
async function pickRemote(root: string): Promise<string> {
	const remotes = (await gitOut(root, ["remote"], "git remote")).split("\n").filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes[0];
	if (remote === undefined) throw new Error("This repository has no remote to fetch the pull request from.");
	return remote;
}

/** The repository's default branch: its short name and a ref that resolves to it. */
export async function defaultBranch(root: string): Promise<{ name: string; rev: string }> {
	const head = await gitMaybe(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	const candidates: { name: string; rev: string }[] = [];
	if (head?.startsWith("refs/remotes/origin/")) {
		const name = head.slice("refs/remotes/origin/".length);
		candidates.push({ name, rev: `origin/${name}` });
	}
	for (const name of ["main", "master"]) candidates.push({ name, rev: `origin/${name}` }, { name, rev: name });
	for (const candidate of candidates) if ((await resolveCommit(root, candidate.rev)) !== null) return candidate;
	throw new Error("Could not find the default branch (main or master) to compare with.");
}

/** Full commit of the merge base of two commits, or null when they share no history. */
async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
	const out = await gitMaybe(root, ["merge-base", a, b]);
	return out !== null && COMMIT_RE.test(out) ? out : null;
}

/**
 * Snapshot the working tree (tracked changes and untracked, unignored files) as a commit on top of HEAD,
 * without changing the checkout, the index or any ref: the files are staged into a copy of the index, the tree
 * written, and a commit object created that nothing points to. HEAD itself when nothing differs.
 */
export async function snapshotWorkingTree(root: string): Promise<string> {
	const head = await resolveCommit(root, "HEAD");
	if (head === null) throw new Error("This repository has no commits yet.");
	const indexFile = path.resolve(root, await gitOut(root, ["rev-parse", "--git-path", "index"], "git rev-parse"));
	// Beside the real index, so a split index finds its shared part.
	const scratch = path.join(path.dirname(indexFile), `omp-blueprint-index-${crypto.randomUUID()}`);
	const env = { GIT_INDEX_FILE: scratch };
	try {
		await fs.copyFile(indexFile, scratch).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== "ENOENT") throw err;
		});
		await gitOut(root, ["add", "-A"], "git add", { write: true, env });
		const tree = await gitOut(root, ["write-tree"], "git write-tree", { write: true, env });
		const headTree = await gitOut(root, ["rev-parse", `${head}^{tree}`], "git rev-parse");
		if (tree === headTree) return head;
		const identity = {
			...env,
			GIT_AUTHOR_NAME: "omp",
			GIT_AUTHOR_EMAIL: "omp@localhost",
			GIT_COMMITTER_NAME: "omp",
			GIT_COMMITTER_EMAIL: "omp@localhost",
		};
		return await gitOut(
			root,
			["commit-tree", tree, "-p", head, "-m", "Working tree snapshot for an architecture map"],
			"git commit-tree",
			{ write: true, env: identity },
		);
	} finally {
		await fs.rm(scratch, { force: true });
		await fs.rm(`${scratch}.lock`, { force: true });
	}
}

interface PullRequestInfo {
	title?: string;
	base?: string;
}

/** Title and base branch of a pull request from `gh`; empty when gh is missing, signed out, or has no such PR. */
async function pullRequestInfo(root: string, number: number): Promise<PullRequestInfo> {
	try {
		if (!(await canCreatePr())) return {};
		const result = await gh(root, ["pr", "view", String(number), "--json", "baseRefName,title"], GH_TIMEOUT_MS);
		if (result.code !== 0) return {};
		const parsed = JSON.parse(result.out) as { baseRefName?: unknown; title?: unknown };
		return {
			title: typeof parsed.title === "string" ? parsed.title : undefined,
			base: typeof parsed.baseRefName === "string" ? parsed.baseRefName : undefined,
		};
	} catch {
		return {};
	}
}

/** What the user picked, resolved to commits. `refLabel` names the head in a title. */
export interface ResolvedTarget {
	head: BlueprintCommit;
	base?: BlueprintCommit;
	/** Short display name of the head: the branch, `PR #12`, `worktree`, or an abbreviated commit. */
	label: string;
}

export interface TargetRequest {
	ref?: string;
	base?: string;
}

/** Fetch `refs/pull/<n>/head` (and its base branch, when named) into private refs; resolves the PR head and, if fetched, base commit. */
async function fetchPullRequest(
	root: string,
	number: number,
	baseBranch: string | undefined,
): Promise<{ head: string; base: string | null }> {
	const remote = await pickRemote(root);
	const headSpec = `+refs/pull/${number}/head:${prRef(number)}`;
	const baseSpec = baseBranch ? `+refs/heads/${baseBranch}:${PRIVATE_REF_PREFIX}/prbase/${number}` : undefined;
	let fetched = false;
	if (baseSpec) {
		const both = await git(root, ["fetch", "--no-tags", "--quiet", remote, headSpec, baseSpec], {
			write: true,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		fetched = both.code === 0;
	}
	if (!fetched) {
		const only = await git(root, ["fetch", "--no-tags", "--quiet", remote, headSpec], {
			write: true,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		if (only.code !== 0)
			throw new Error(
				`Could not fetch pull request #${number} from ${remote}: ${only.err.split("\n")[0] || "git fetch failed"}`,
			);
	}
	const head = await resolveCommit(root, prRef(number));
	if (head === null) throw new Error(`Pull request #${number} was not found on ${remote}.`);
	return {
		head,
		base: baseSpec && fetched ? await resolveCommit(root, `${PRIVATE_REF_PREFIX}/prbase/${number}`) : null,
	};
}

/**
 * Resolve the head (and base, for a diff map) of a request to commits.
 * @throws Error with a plain message when a ref does not exist or there is nothing to compare.
 */
export async function resolveTarget(root: string, request: TargetRequest): Promise<ResolvedTarget> {
	const requested = request.ref === undefined ? undefined : checkRefName(request.ref, "ref");
	let head: BlueprintCommit;
	let label: string;
	let prBase: { name?: string; rev?: string } = {};
	const pr = requested === undefined ? null : PR_REF_RE.exec(requested);
	if (requested === undefined) {
		const commit = await resolveCommit(root, "HEAD");
		if (commit === null) throw new Error("This repository has no commits yet.");
		const branch = await currentBranch(root);
		head = { commit, ref: branch, subject: await commitSubject(root, commit) };
		label = branch ?? commit.slice(0, 8);
	} else if (requested === "@worktree") {
		const commit = await snapshotWorkingTree(root);
		head = { commit, ref: "@worktree", subject: "Working tree" };
		label = "worktree";
	} else if (pr) {
		const number = Number(pr[1]);
		const info = await pullRequestInfo(root, number);
		const baseName = request.base === undefined ? info.base : undefined;
		const fetched = await fetchPullRequest(root, number, baseName);
		head = { commit: fetched.head, ref: requested, subject: info.title ?? (await commitSubject(root, fetched.head)) };
		label = `PR #${number}`;
		if (request.base === undefined) {
			const fallback = info.base === undefined ? await defaultBranch(root) : null;
			prBase = {
				name: info.base ?? fallback?.name,
				rev:
					fetched.base ??
					fallback?.rev ??
					(info.base ? await firstResolving(root, [`origin/${info.base}`, info.base]) : undefined),
			};
		}
	} else {
		const commit = await resolveCommit(root, requested);
		if (commit === null)
			throw new Error(`There is no branch, tag or commit named "${requested}" in this repository.`);
		head = { commit, ref: requested, subject: await commitSubject(root, commit) };
		label = requested;
	}

	let baseName: string | undefined;
	let baseRev: string | undefined;
	if (request.base !== undefined) {
		const wanted = checkRefName(request.base, "base");
		if (wanted === "@default") {
			const fallback = await defaultBranch(root);
			({ name: baseName, rev: baseRev } = fallback);
		} else if (wanted === "@worktree") {
			throw new Error("The working tree can only be the head of a map, not its base.");
		} else if (PR_REF_RE.test(wanted)) {
			throw new Error("A pull request cannot be the base of a map.");
		} else {
			baseName = wanted;
			baseRev = wanted;
		}
	} else if (prBase.rev !== undefined) {
		baseName = prBase.name;
		baseRev = prBase.rev;
	}
	if (baseRev === undefined) return { head, label };
	const target = await resolveCommit(root, baseRev);
	if (target === null) throw new Error(`There is no branch, tag or commit named "${baseName}" to compare with.`);
	const common = (await mergeBase(root, head.commit, target)) ?? target;
	if (common === head.commit)
		throw new Error(`There is nothing to compare: ${label} has no changes beyond ${baseName ?? "the base"}.`);
	return {
		head,
		base: { commit: common, ref: baseName, subject: await commitSubject(root, common) },
		label,
	};
}

async function firstResolving(root: string, revs: string[]): Promise<string | undefined> {
	for (const rev of revs) if ((await resolveCommit(root, rev)) !== null) return rev;
	return undefined;
}

/** Keep `commit` reachable for the life of a map (its excerpts read it from git), under a ref git tools never list. */
export async function holdCommit(root: string, mapId: string, side: "head" | "base", commit: string): Promise<void> {
	await gitOut(root, ["update-ref", `${PRIVATE_REF_PREFIX}/maps/${mapId}/${side}`, commit], "git update-ref", {
		write: true,
	});
}

/** Drop what {@link holdCommit} kept; the refs of a map that never finished are not an error. */
export async function releaseCommits(root: string, mapId: string): Promise<void> {
	for (const side of ["head", "base"])
		await git(root, ["update-ref", "-d", `${PRIVATE_REF_PREFIX}/maps/${mapId}/${side}`], { write: true });
}

/** True when `head.ref` names something that moved on from `head.commit`. */
export async function isStale(root: string, head: BlueprintCommit): Promise<boolean> {
	if (head.ref === undefined || head.ref === "@worktree" || PR_REF_RE.test(head.ref) || head.ref.startsWith("-"))
		return false;
	const now = await resolveCommit(root, head.ref).catch(() => null);
	return now !== null && now !== head.commit;
}

// ── checkouts ────────────────────────────────────────────────────────────────

/** Check `commit` out at `dir` as a detached worktree of the repository at `root`; hooks and filters do not run. */
export async function addWorktree(root: string, dir: string, commit: string): Promise<void> {
	await fs.mkdir(path.dirname(dir), { recursive: true });
	await gitOut(
		root,
		["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--force", dir, commit],
		"git worktree add",
		{ write: true, timeoutMs: CHECKOUT_TIMEOUT_MS },
	);
}

/** Remove a worktree {@link addWorktree} made; never throws (a leftover is pruned at the next start). */
export async function removeWorktreeDir(root: string, dir: string): Promise<void> {
	await git(root, ["worktree", "remove", "--force", dir], { write: true, timeoutMs: CHECKOUT_TIMEOUT_MS }).catch(
		() => undefined,
	);
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	await git(root, ["worktree", "prune"], { write: true }).catch(() => undefined);
}

/** The common git dir a leftover worktree folder belongs to, from its `.git` file. */
async function commonDirOf(dir: string): Promise<string | null> {
	try {
		const pointer = (await fs.readFile(path.join(dir, ".git"), "utf8")).trim();
		const match = /^gitdir:\s*(.+)$/m.exec(pointer);
		if (!match) return null;
		const gitDir = path.resolve(dir, match[1]!.trim());
		// <repo>/.git/worktrees/<name>
		return path.basename(path.dirname(gitDir)) === "worktrees" ? path.dirname(path.dirname(gitDir)) : null;
	} catch {
		return null;
	}
}

/** Delete every checkout under `workDir` that a run left behind (the companion stopped mid-run) and prune the repositories they belonged to. */
export async function pruneLeftoverWorktrees(workDir: string): Promise<void> {
	const runs = await fs.readdir(workDir, { withFileTypes: true }).catch(() => []);
	const commons = new Set<string>();
	for (const run of runs) {
		const runDir = path.join(workDir, run.name);
		for (const entry of await fs.readdir(runDir, { withFileTypes: true }).catch(() => [])) {
			const common = await commonDirOf(path.join(runDir, entry.name));
			if (common !== null) commons.add(common);
		}
		await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
	}
	for (const common of commons)
		await git(workDir, [`--git-dir=${common}`, "worktree", "prune"], { write: true }).catch(() => undefined);
}

// ── reading commits ──────────────────────────────────────────────────────────

/** Text of `rel` at `commit`, or null when it is missing, binary, or larger than {@link BLOB_BYTES}. */
export async function readBlob(root: string, commit: string, rel: string): Promise<string | null> {
	if (!COMMIT_RE.test(commit) || rel.startsWith("-") || rel.includes("\0")) return null;
	const result = await git(root, ["cat-file", "blob", `${commit}:${rel}`], { maxBytes: BLOB_BYTES });
	if (result.code !== 0 || result.truncated || hasNul(result.out)) return null;
	return decoder.decode(result.out);
}

/** Every file path at `commit`. */
export async function listFiles(root: string, commit: string): Promise<string[]> {
	const result = await git(root, ["ls-tree", "-r", "--name-only", "-z", commit], { maxBytes: TREE_BYTES });
	if (result.code !== 0) throw gitFailure(result, "git ls-tree");
	return decoder.decode(result.out).split("\0").filter(Boolean);
}

export interface ChangedFile {
	/** Path at head (the new path of a rename). */
	path: string;
	change: BlueprintChange;
	/** Path at base, for a rename. */
	oldPath?: string;
}

/** Parse `git diff --name-status -z` output. A rename counts as a change of the new path; a copy as an addition. */
export function parseNameStatus(raw: string): ChangedFile[] {
	const parts = raw.split("\0");
	const files: ChangedFile[] = [];
	for (let i = 0; i < parts.length;) {
		const status = parts[i++];
		if (!status) continue;
		const kind = status[0];
		if (kind === "R" || kind === "C") {
			const oldPath = parts[i++];
			const newPath = parts[i++];
			if (oldPath && newPath)
				files.push(
					kind === "R" ? { path: newPath, change: "modified", oldPath } : { path: newPath, change: "added" },
				);
			continue;
		}
		const file = parts[i++];
		if (!file) continue;
		files.push({ path: file, change: kind === "A" ? "added" : kind === "D" ? "removed" : "modified" });
	}
	return files;
}

/** Files changed between two commits. */
export async function changedFiles(root: string, base: string, head: string): Promise<ChangedFile[]> {
	const result = await git(root, ["diff", "--name-status", "-M", "-z", "--no-color", base, head], {
		maxBytes: TREE_BYTES,
	});
	if (result.code !== 0) throw gitFailure(result, "git diff");
	return parseNameStatus(decoder.decode(result.out));
}

/** `git diff --stat` of two commits, shortened to `maxChars`. */
export async function diffStat(root: string, base: string, head: string, maxChars: number): Promise<string> {
	const result = await git(root, ["diff", "--stat=120,70", "-M", "--no-color", base, head], {
		maxBytes: maxChars * 4,
	});
	if (result.code !== 0) throw gitFailure(result, "git diff");
	const out = decoder.decode(result.out).trimEnd();
	if (out.length <= maxChars) return out;
	const cut = out.slice(0, maxChars);
	return `${cut.slice(0, cut.lastIndexOf("\n"))}\n… (stat shortened)`;
}

/** Changed line ranges (1-based, inclusive) of one file. */
export interface FileHunks {
	/** Ranges of lines at head that were added or edited. */
	head: [number, number][];
	/** Ranges of lines at base that were deleted or edited. */
	base: [number, number][];
}

/** Parse `git diff -U0` output into the changed line ranges of each file, keyed by head path. */
export function parseHunks(raw: string): Map<string, FileHunks> {
	const files = new Map<string, FileHunks>();
	let current: FileHunks | null = null;
	for (const line of raw.split("\n")) {
		if (line.startsWith("+++ ")) {
			const target = line.slice(4).replace(/\t.*$/, "");
			current = null;
			if (target.startsWith("b/")) {
				current = { head: [], base: [] };
				files.set(target.slice(2), current);
			}
		} else if (line.startsWith("@@") && current) {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!match) continue;
			const baseStart = Number(match[1]);
			const baseLen = match[2] === undefined ? 1 : Number(match[2]);
			const headStart = Number(match[3]);
			const headLen = match[4] === undefined ? 1 : Number(match[4]);
			if (baseLen > 0) current.base.push([baseStart, baseStart + baseLen - 1]);
			if (headLen > 0) current.head.push([headStart, headStart + headLen - 1]);
		}
	}
	return files;
}

/** The changed line ranges between two commits for every modified file. */
export async function diffHunks(root: string, base: string, head: string): Promise<Map<string, FileHunks>> {
	const result = await git(root, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", base, head], {
		maxBytes: DIFF_BYTES,
	});
	if (result.code !== 0 && !result.truncated) throw gitFailure(result, "git diff");
	return parseHunks(decoder.decode(result.out));
}

// ── picking what to map ──────────────────────────────────────────────────────

/** Branches (local and remote), the current one, and open pull requests, for the app's picker. */
export async function listRefs(cwd: string, query: string | undefined): Promise<BlueprintRefsAnswer> {
	const { root } = await repoInfo(cwd);
	const q = query?.trim().toLowerCase() ?? "";
	const out = await gitOut(
		root,
		["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
		"git for-each-ref",
	);
	const seen = new Set<string>();
	const branches: string[] = [];
	for (const name of out.split("\n")) {
		// `origin` alone is a remote's HEAD pointer, not a branch.
		if (!name || name.endsWith("/HEAD") || name === "origin" || seen.has(name)) continue;
		if (q && !name.toLowerCase().includes(q)) continue;
		seen.add(name);
		branches.push(name);
		if (branches.length >= MAX_BRANCHES) break;
	}
	const answer: BlueprintRefsAnswer = { branches, current: await currentBranch(root) };
	try {
		if (await canCreatePr()) {
			const result = await gh(
				root,
				[
					"pr",
					"list",
					"--state",
					"open",
					"--limit",
					String(MAX_PRS),
					"--json",
					"number,title,headRefName,baseRefName",
					...(q ? ["--search", query!.trim()] : []),
				],
				GH_TIMEOUT_MS,
			);
			if (result.code === 0) {
				const rows = JSON.parse(result.out) as {
					number: number;
					title: string;
					headRefName: string;
					baseRefName: string;
				}[];
				answer.prs = rows.map(row => ({
					number: row.number,
					title: row.title,
					head: row.headRefName,
					base: row.baseRefName,
				}));
			}
		}
	} catch {
		// Without gh (or without a GitHub remote) the picker lists branches only.
	}
	return answer;
}
