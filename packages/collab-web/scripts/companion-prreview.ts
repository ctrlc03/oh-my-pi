/**
 * Pull request review for the companion: the changed files of a pull request, one file's diff at a time,
 * a review posted with inline comments, and the merge. Everything goes through the user's signed-in `gh`.
 *
 * Reads are cached briefly. Writes are exact: the review is posted against the commit the device was
 * looking at, and the merge is pinned to the head it checked (`--match-head-commit`), so a push in the
 * meantime fails the write instead of landing something nobody saw. `gh pr merge` runs outside any
 * repository (with `--repo`), so it never checks out, pulls, or deletes a local branch or runs hooks.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	GithubItem,
	PrFile,
	PrFileStatus,
	PrFiles,
	PrMergeMethod,
	PrReviewComment,
	PrReviewEvent,
	PrReviewInput,
} from "../src/lib/companion";
import { repoRoot } from "./companion-git";
import { gh } from "./companion-gitflow";
import { type RawCheck, rollup } from "./companion-github";

const GH_TIMEOUT_MS = 30_000;
const GH_DIFF_TIMEOUT_MS = 60_000;
const GH_WRITE_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 800;
/** GitHub lists at most 3000 files of a pull request. */
const MAX_FILES = 3000;
const MAX_FILE_DIFF_CHARS = 500_000;
const MAX_BODY_CHARS = 65_000;
const MAX_REVIEW_COMMENTS = 100;
const MAX_PATH_CHARS = 1024;
/** How long a pull request's diff is reused: a burst of file taps costs one `gh pr diff`. */
export const DIFF_TTL_MS = 60_000;
const MAX_CACHED_DIFFS = 8;
const REPO_TTL_MS = 5 * 60_000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const MOVED_HEAD = "New commits were pushed since you opened this pull request; reload it.";
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const EVENTS: Record<string, PrReviewEvent> = {
	COMMENT: "COMMENT",
	APPROVE: "APPROVE",
	REQUEST_CHANGES: "REQUEST_CHANGES",
};
const METHOD_FLAGS: Record<PrMergeMethod, string> = { squash: "--squash", merge: "--merge", rebase: "--rebase" };
const FILE_STATUSES: Record<string, PrFileStatus> = {
	added: "added",
	removed: "removed",
	modified: "modified",
	renamed: "renamed",
	copied: "copied",
};

/** `table[key]` for the table's own keys only. */
function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
	return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

// ── diff splitting ───────────────────────────────────────────────────────────

const decoder = new TextDecoder();

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };

/** A path as git prints it: plain, or in double quotes with C escapes (`\t`, `\"`, `\303\251` for UTF-8 bytes). */
export function unquoteGitPath(raw: string): string {
	if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
	const bytes: number[] = [];
	const inner = raw.slice(1, -1);
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i] as string;
		if (ch !== "\\") {
			bytes.push(...new TextEncoder().encode(ch));
			continue;
		}
		const octal = /^[0-3][0-7]{2}/.exec(inner.slice(i + 1, i + 4));
		if (octal !== null) {
			bytes.push(Number.parseInt(octal[0], 8));
			i += 3;
			continue;
		}
		const escaped = inner[++i] ?? "";
		const code = lookup(C_ESCAPES, escaped);
		if (code !== undefined) bytes.push(code);
		else bytes.push(...new TextEncoder().encode(escaped));
	}
	return decoder.decode(new Uint8Array(bytes));
}

/** `a/x` / `b/x` → `x`; `/dev/null` and anything else without the prefix → null. */
function stripSide(raw: string, side: "a" | "b"): string | null {
	const tab = raw.indexOf("\t");
	const name = unquoteGitPath(raw.startsWith('"') ? raw : tab === -1 ? raw : raw.slice(0, tab));
	return name.startsWith(`${side}/`) ? name.slice(2) : null;
}

/** The path a file's diff section is about: its new name, or its old name for a deletion. */
function sectionPath(lines: readonly string[]): string | null {
	let oldPath: string | null = null;
	let newPath: string | null = null;
	let renamed: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("@@")) break;
		if (line.startsWith("rename to ") || line.startsWith("copy to "))
			renamed = unquoteGitPath(line.slice(line.indexOf(" to ") + 4));
		else if (line.startsWith("--- ")) oldPath = stripSide(line.slice(4), "a");
		else if (line.startsWith("+++ ")) newPath = stripSide(line.slice(4), "b");
	}
	if (renamed !== null) return renamed;
	if (newPath !== null) return newPath;
	if (oldPath !== null) return oldPath;
	// Binary and mode-only changes have no ---/+++ lines: read the `diff --git a/x b/x` header.
	const head = (lines[0] as string).slice("diff --git ".length);
	const quoted = head.lastIndexOf(' "b/');
	if (quoted !== -1) return stripSide(head.slice(quoted + 1), "b");
	const at = head.lastIndexOf(" b/");
	return at === -1 ? null : head.slice(at + 3);
}

/**
 * Split the diff `gh pr diff` prints into one section per changed file, in order. A section keeps its
 * `diff --git` header so a binary notice or a mode change still shows; sections whose path cannot be
 * read are dropped.
 */
export function splitPrDiff(diff: string): Array<{ path: string; diff: string }> {
	const sections: string[][] = [];
	for (const line of diff.replace(/\n$/, "").split("\n")) {
		if (line.startsWith("diff --git ")) sections.push([line]);
		else sections[sections.length - 1]?.push(line);
	}
	const out: Array<{ path: string; diff: string }> = [];
	for (const lines of sections) {
		const file = sectionPath(lines);
		if (file !== null) out.push({ path: file, diff: `${lines.join("\n")}\n` });
	}
	return out;
}

// ── validation ───────────────────────────────────────────────────────────────

function checkNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalid number");
	return value;
}

function checkHead(value: unknown): string {
	if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error("invalid commit");
	return value;
}

function checkLine(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error("invalid review comment");
	return value;
}

function checkComment(value: unknown): PrReviewComment {
	if (typeof value !== "object" || value === null) throw new Error("invalid review comment");
	const c = value as Record<string, unknown>;
	if (typeof c.path !== "string" || c.path === "" || c.path.length > MAX_PATH_CHARS || c.path.includes("\0")) {
		throw new Error("invalid review comment");
	}
	if (c.side !== "LEFT" && c.side !== "RIGHT") throw new Error("invalid review comment");
	if (typeof c.body !== "string" || c.body.trim() === "" || c.body.length > MAX_BODY_CHARS) {
		throw new Error("invalid review comment");
	}
	const line = checkLine(c.line);
	const comment: PrReviewComment = { path: c.path, line, side: c.side, body: c.body };
	if (c.startLine !== undefined) {
		const startLine = checkLine(c.startLine);
		if (startLine >= line) throw new Error("invalid review comment");
		comment.startLine = startLine;
	}
	return comment;
}

/** A review from a device, checked: GitHub refuses a comment or change request that says nothing. */
export function checkReview(value: unknown): PrReviewInput {
	if (typeof value !== "object" || value === null) throw new Error("invalid review");
	const r = value as Record<string, unknown>;
	const event = lookup(EVENTS, r.event);
	if (event === undefined) throw new Error("invalid review");
	if (typeof r.body !== "string" || r.body.length > MAX_BODY_CHARS) throw new Error("invalid review");
	if (!Array.isArray(r.comments) || r.comments.length > MAX_REVIEW_COMMENTS) throw new Error("invalid review");
	const body = r.body.trim();
	const comments = r.comments.map(checkComment);
	if (event !== "APPROVE" && body === "") throw new Error("A summary is required for this kind of review.");
	const review: PrReviewInput = { event, body, comments };
	if (r.commit !== undefined) review.commit = checkHead(r.commit);
	return review;
}

/** The body of `POST /repos/{o}/{r}/pulls/{n}/reviews`: a multi-line comment sends `start_line` with the same side. */
export function reviewPayload(review: PrReviewInput): Record<string, unknown> {
	const payload: Record<string, unknown> = { event: review.event, body: review.body };
	if (review.commit !== undefined) payload.commit_id = review.commit;
	if (review.comments.length > 0) {
		payload.comments = review.comments.map(c => ({
			path: c.path,
			body: c.body,
			line: c.line,
			side: c.side,
			...(c.startLine !== undefined && { start_line: c.startLine, start_side: c.side }),
		}));
	}
	return payload;
}

/** What a merge request asks for. */
export interface MergeRequest {
	method: PrMergeMethod;
	deleteBranch: boolean;
	/** The head commit the user was looking at; the merge happens only if the pull request is still there. */
	head: string;
	/** The user chose to merge a draft anyway: it is marked ready first. */
	allowDraft: boolean;
	/** The user chose to merge with failing checks. */
	allowFailing: boolean;
	/** The user chose to merge while checks are still running. */
	allowPending: boolean;
}

export function checkMerge(value: unknown): MergeRequest {
	if (typeof value !== "object" || value === null) throw new Error("invalid merge");
	const m = value as Record<string, unknown>;
	const method = lookup<PrMergeMethod>({ squash: "squash", merge: "merge", rebase: "rebase" }, m.method);
	if (method === undefined || typeof m.deleteBranch !== "boolean") throw new Error("invalid merge");
	for (const flag of [m.allowDraft, m.allowFailing, m.allowPending]) {
		if (flag !== undefined && typeof flag !== "boolean") throw new Error("invalid merge");
	}
	return {
		method,
		deleteBranch: m.deleteBranch,
		head: checkHead(m.head),
		allowDraft: m.allowDraft === true,
		allowFailing: m.allowFailing === true,
		allowPending: m.allowPending === true,
	};
}

/** What the merge guard reads off the pull request right before merging. */
export interface MergeState {
	state: string;
	isDraft: boolean;
	checks: GithubItem["checks"];
}

/** Why the merge must not run, or null. A draft, failing checks and running checks each need the user's explicit choice. */
export function mergeBlocker(
	pr: MergeState,
	request: Pick<MergeRequest, "allowDraft" | "allowFailing" | "allowPending">,
): string | null {
	if (pr.state !== "OPEN") return "This pull request is not open.";
	if (pr.isDraft && !request.allowDraft) return "This pull request is a draft.";
	if (pr.checks === "fail" && !request.allowFailing) return "Checks are failing on this pull request.";
	if (pr.checks === "pending" && !request.allowPending) return "Checks are still running on this pull request.";
	return null;
}

// ── gh ───────────────────────────────────────────────────────────────────────

/** How the module talks to the world; tests replace it. */
export interface PrDeps {
	run(cwd: string, args: string[], timeout: number): Promise<{ code: number; out: string; err: string }>;
	/** `owner/name` of the GitHub repository `cwd` belongs to. */
	repo(cwd: string): Promise<string>;
	now(): number;
}

function failure(result: { out: string; err: string }, what: string): Error {
	const lines = (result.err || result.out).split("\n").filter(line => line.trim());
	return new Error(lines.slice(0, 4).join("\n").slice(0, MAX_ERROR_CHARS) || `${what} failed`);
}

async function ok(deps: PrDeps, cwd: string, args: string[], timeout: number): Promise<string> {
	const result = await deps.run(cwd, args, timeout);
	if (result.code !== 0) throw failure(result, `gh ${args[0]}`);
	return result.out;
}

/** The repository `cwd` belongs to, asked of `gh` (it follows `gh repo set-default`). */
async function ghRepo(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (root === null) throw new Error("not a git repository");
	const result = await gh(root, ["repo", "view", "--json", "nameWithOwner"], GH_TIMEOUT_MS);
	if (result.code !== 0) throw failure(result, "gh repo view");
	const name = (JSON.parse(result.out) as { nameWithOwner?: string }).nameWithOwner ?? "";
	if (!REPO_RE.test(name)) throw new Error("this repository is not on GitHub");
	return name;
}

const defaultDeps: PrDeps = { run: gh, repo: ghRepo, now: Date.now };

interface RawView {
	headRefOid?: string;
	state?: string;
	isDraft?: boolean;
	statusCheckRollup?: RawCheck[];
}

/** What a review screen reads: files, one file's diff, and the writes. */
export interface PrReview {
	files(cwd: string, number: unknown): Promise<PrFiles>;
	diff(cwd: string, number: unknown, head: unknown, file: unknown): Promise<{ diff: string; truncated: boolean }>;
	/** Post a review; resolves with its URL. */
	review(cwd: string, number: unknown, review: unknown): Promise<string>;
	merge(cwd: string, number: unknown, request: unknown): Promise<void>;
}

export function createPrReview(deps: PrDeps = defaultDeps): PrReview {
	const repos = new Map<string, { at: number; name: Promise<string> }>();
	const diffs = new Map<string, { at: number; files: Promise<Map<string, string>> }>();

	function repoOf(cwd: string): Promise<string> {
		const hit = repos.get(cwd);
		if (hit !== undefined && deps.now() - hit.at < REPO_TTL_MS) return hit.name;
		const name = deps.repo(cwd);
		repos.set(cwd, { at: deps.now(), name });
		// A failure is not remembered: the next request asks again.
		name.catch(() => repos.delete(cwd));
		return name;
	}

	async function view(repo: string, n: number, fields: string): Promise<RawView> {
		return JSON.parse(
			await ok(deps, os.tmpdir(), ["pr", "view", String(n), "--repo", repo, "--json", fields], GH_TIMEOUT_MS),
		) as RawView;
	}

	async function head(repo: string, n: number): Promise<string> {
		return checkHead((await view(repo, n, "headRefOid")).headRefOid);
	}

	async function fetchDiff(repo: string, n: number, seen: string): Promise<Map<string, string>> {
		const text = await ok(deps, os.tmpdir(), ["pr", "diff", String(n), "--repo", repo], GH_DIFF_TIMEOUT_MS);
		// The line numbers of a diff are only good for the commit it was taken at.
		if ((await head(repo, n)) !== seen) throw new Error("This pull request has new commits. Reload to review them.");
		const files = new Map<string, string>();
		for (const part of splitPrDiff(text)) files.set(part.path, part.diff);
		return files;
	}

	return {
		async files(cwd, number) {
			const n = checkNumber(number);
			const repo = await repoOf(cwd);
			const listing = ok(
				deps,
				os.tmpdir(),
				[
					"api",
					"--paginate",
					`repos/${repo}/pulls/${n}/files?per_page=100`,
					"--jq",
					".[] | {path: .filename, status, additions, deletions, from: .previous_filename}",
				],
				GH_DIFF_TIMEOUT_MS,
			);
			const [raw, sha] = await Promise.all([listing, head(repo, n)]);
			const files: PrFile[] = [];
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				const f = JSON.parse(line) as {
					path?: string;
					status?: string;
					additions?: number;
					deletions?: number;
					from?: string | null;
				};
				if (typeof f.path !== "string") continue;
				const file: PrFile = {
					path: f.path,
					status: lookup(FILE_STATUSES, f.status) ?? "changed",
					additions: f.additions ?? 0,
					deletions: f.deletions ?? 0,
				};
				if (typeof f.from === "string") file.from = f.from;
				files.push(file);
				if (files.length >= MAX_FILES) break;
			}
			return { head: sha, files };
		},

		async diff(cwd, number, seen, file) {
			const n = checkNumber(number);
			const sha = checkHead(seen);
			if (typeof file !== "string" || file === "") throw new Error("invalid path");
			const repo = await repoOf(cwd);
			const key = `${repo}#${n}@${sha}`;
			const now = deps.now();
			for (const [k, entry] of diffs) if (now - entry.at >= DIFF_TTL_MS) diffs.delete(k);
			let entry = diffs.get(key);
			if (entry === undefined) {
				const files = fetchDiff(repo, n, sha);
				entry = { at: now, files };
				diffs.set(key, entry);
				files.catch(() => diffs.delete(key));
				while (diffs.size > MAX_CACHED_DIFFS) diffs.delete(diffs.keys().next().value as string);
			}
			const text = (await entry.files).get(file) ?? "";
			if (text.length <= MAX_FILE_DIFF_CHARS) return { diff: text, truncated: false };
			const cut = text.lastIndexOf("\n", MAX_FILE_DIFF_CHARS);
			return { diff: text.slice(0, cut === -1 ? MAX_FILE_DIFF_CHARS : cut + 1), truncated: true };
		},

		async review(cwd, number, input) {
			const n = checkNumber(number);
			const review = checkReview(input);
			const repo = await repoOf(cwd);
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pr-review-"));
			try {
				// `gh` runs with stdin closed, so the payload goes through a private file.
				const file = path.join(dir, "review.json");
				await fs.writeFile(file, JSON.stringify(reviewPayload(review)), { mode: 0o600 });
				const out = await ok(
					deps,
					os.tmpdir(),
					["api", `repos/${repo}/pulls/${n}/reviews`, "-X", "POST", "--input", file],
					GH_WRITE_TIMEOUT_MS,
				);
				return (JSON.parse(out) as { html_url?: string }).html_url ?? "";
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},

		async merge(cwd, number, input) {
			const n = checkNumber(number);
			const request = checkMerge(input);
			const repo = await repoOf(cwd);
			const pr = await view(repo, n, "state,isDraft,statusCheckRollup,headRefOid");
			// What the user confirmed is the commit they saw: anything pushed since must be looked at first.
			if (checkHead(pr.headRefOid) !== request.head) throw new Error(MOVED_HEAD);
			const blocker = mergeBlocker(
				{ state: pr.state ?? "", isDraft: pr.isDraft === true, checks: rollup(pr.statusCheckRollup) },
				request,
			);
			if (blocker !== null) throw new Error(blocker);
			if (pr.isDraft) await ok(deps, os.tmpdir(), ["pr", "ready", String(n), "--repo", repo], GH_WRITE_TIMEOUT_MS);
			const args = [
				"pr",
				"merge",
				String(n),
				"--repo",
				repo,
				METHOD_FLAGS[request.method],
				"--match-head-commit",
				request.head,
			];
			if (request.deleteBranch) args.push("--delete-branch");
			await ok(deps, os.tmpdir(), args, GH_WRITE_TIMEOUT_MS);
		},
	};
}
