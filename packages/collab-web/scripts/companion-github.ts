/**
 * Read-only GitHub for the companion: the issues and pull requests of a
 * session's repository, listed and opened through the user's signed-in `gh`.
 * Nothing here writes to GitHub.
 */

import type {
	GithubCheck,
	GithubCheckState,
	GithubComment,
	GithubFilter,
	GithubItem,
	GithubItemDetail,
	GithubKind,
} from "../src/lib/companion";
import { repoRoot } from "./companion-git";
import { gh } from "./companion-gitflow";

const GH_TIMEOUT_MS = 20_000;
const LIST_LIMIT = 50;
const MAX_COMMENTS = 30;
const MAX_BODY_CHARS = 20_000;
const MAX_ERROR_CHARS = 800;

const LIST_FIELDS: Record<GithubKind, string> = {
	issue: "number,title,state,author,labels,updatedAt,url",
	pr: "number,title,state,isDraft,author,labels,updatedAt,url,reviewDecision,statusCheckRollup",
};
const DETAIL_FIELDS: Record<GithubKind, string> = {
	issue: `${LIST_FIELDS.issue},body,comments`,
	pr: `${LIST_FIELDS.pr},body,comments,headRefName,baseRefName,additions,deletions,changedFiles`,
};

/** `gh … list` flags per filter; issues have no review filter. */
const FILTER_ARGS: Record<GithubKind, Partial<Record<GithubFilter, string[]>>> = {
	issue: { open: [], mine: ["--assignee", "@me"] },
	pr: { open: [], mine: ["--author", "@me"], review: ["--search", "review-requested:@me"] },
};

const KINDS: Record<string, GithubKind> = { issue: "issue", pr: "pr" };

/** `table[key]` for the table's own keys only, so a device sending `"constructor"` never reaches Object.prototype. */
function lookup<T>(table: Partial<Record<string, T>>, key: unknown): T | undefined {
	return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** What `gh --json` prints for the fields above; every field is optional to tolerate older `gh`. */
interface RawItem {
	number?: number;
	title?: string;
	state?: string;
	isDraft?: boolean;
	author?: { login?: string } | null;
	labels?: { name?: string }[];
	updatedAt?: string;
	url?: string;
	reviewDecision?: string;
	statusCheckRollup?: RawCheck[];
	body?: string;
	comments?: { author?: { login?: string } | null; body?: string; createdAt?: string }[];
	headRefName?: string;
	baseRefName?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}

/** A check run (GitHub Actions and apps: `status`, `conclusion`) or a commit status context (`state`). */
interface RawCheck {
	name?: string;
	workflowName?: string;
	detailsUrl?: string;
	status?: string;
	conclusion?: string;
	context?: string;
	targetUrl?: string;
	state?: string;
}

const REVIEW: Record<string, GithubItem["review"]> = {
	APPROVED: "approved",
	CHANGES_REQUESTED: "changes",
	REVIEW_REQUIRED: "required",
};
const STATE: Record<string, GithubItem["state"]> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
/** Finished check-run conclusions that do not fail the pull request. */
const PASSING_CONCLUSION: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };
const CHECK_ORDER: Record<GithubCheckState, number> = { fail: 0, pending: 1, pass: 2 };

function checkState(check: RawCheck): GithubCheckState {
	if (check.state !== undefined) {
		if (check.state === "SUCCESS") return "pass";
		return check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "fail";
	}
	if (check.status !== "COMPLETED") return "pending";
	return lookup(PASSING_CONCLUSION, check.conclusion) ? "pass" : "fail";
}

/** All checks combined: any failure fails, else any pending is pending; null when there are none. */
function rollup(checks: RawCheck[] | undefined): GithubItem["checks"] {
	if (!checks?.length) return null;
	let pending = false;
	for (const check of checks) {
		const state = checkState(check);
		if (state === "fail") return "fail";
		if (state === "pending") pending = true;
	}
	return pending ? "pending" : "pass";
}

function toCheck(check: RawCheck): GithubCheck {
	const job = check.name ?? check.context ?? "check";
	return {
		name: check.workflowName ? `${check.workflowName} / ${job}` : job,
		state: checkState(check),
		url: check.detailsUrl ?? check.targetUrl ?? "",
	};
}

function time(iso: string | undefined): number {
	const ms = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(ms) ? 0 : ms;
}

function login(author: { login?: string } | null | undefined): string {
	return author?.login || "ghost";
}

function toItem(kind: GithubKind, raw: RawItem): GithubItem {
	return {
		kind,
		number: raw.number ?? 0,
		title: raw.title ?? "",
		state: lookup(STATE, raw.state) ?? "open",
		draft: raw.isDraft === true,
		author: login(raw.author),
		labels: (raw.labels ?? []).flatMap(label => (label.name ? [label.name] : [])),
		updatedAt: time(raw.updatedAt),
		url: raw.url ?? "",
		review: kind === "pr" ? (lookup(REVIEW, raw.reviewDecision) ?? null) : null,
		checks: kind === "pr" ? rollup(raw.statusCheckRollup) : null,
	};
}

/** A description or comment without its HTML comments (template hints, bot markers), capped. */
function clip(text: string | undefined): string {
	const body = (text ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
	return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…` : body;
}

/** Run a `gh` read in `root` and parse its JSON; a failure carries what gh printed. */
async function ghJson<T>(root: string, args: string[]): Promise<T> {
	const result = await gh(root, args, GH_TIMEOUT_MS);
	if (result.code !== 0) {
		const lines = (result.err || result.out).split("\n").filter(line => line.trim());
		throw new Error(lines.slice(0, 4).join("\n").slice(0, MAX_ERROR_CHARS) || `gh ${args[0]} failed`);
	}
	return JSON.parse(result.out) as T;
}

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (root === null) throw new Error("not a git repository");
	return root;
}

function checkKind(kind: unknown): GithubKind {
	const found = lookup(KINDS, kind);
	if (!found) throw new Error("invalid kind");
	return found;
}

/** Open issues or pull requests of `cwd`'s GitHub repository matching `filter`, most recently updated first. */
export async function githubList(
	cwd: string,
	kind: unknown,
	filter: unknown,
): Promise<{ repo: string; items: GithubItem[] }> {
	const k = checkKind(kind);
	const flags = lookup(FILTER_ARGS[k], filter);
	if (!flags) throw new Error("invalid filter");
	const root = await requireRoot(cwd);
	const listArgs = [k, "list", "--state", "open", "--limit", String(LIST_LIMIT), ...flags, "--json", LIST_FIELDS[k]];
	const [repo, raw] = await Promise.all([
		ghJson<{ nameWithOwner?: string }>(root, ["repo", "view", "--json", "nameWithOwner"]),
		ghJson<RawItem[]>(root, listArgs),
	]);
	const items = raw.map(item => toItem(k, item)).sort((a, b) => b.updatedAt - a.updatedAt);
	return { repo: repo.nameWithOwner ?? "", items };
}

/** One issue or pull request with its description, checks and latest comments. */
export async function githubItem(cwd: string, kind: unknown, number: unknown): Promise<GithubItemDetail> {
	const k = checkKind(kind);
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error("invalid number");
	const raw = await ghJson<RawItem>(await requireRoot(cwd), [k, "view", String(number), "--json", DETAIL_FIELDS[k]]);
	const all = raw.comments ?? [];
	const comments: GithubComment[] = all.slice(-MAX_COMMENTS).map(comment => ({
		author: login(comment.author),
		body: clip(comment.body),
		createdAt: time(comment.createdAt),
	}));
	const pr = k === "pr";
	return {
		...toItem(k, raw),
		body: clip(raw.body),
		checkList: (raw.statusCheckRollup ?? [])
			.map(toCheck)
			.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name)),
		comments,
		olderComments: all.length - comments.length,
		branch: pr ? { head: raw.headRefName ?? "", base: raw.baseRefName ?? "" } : null,
		size: pr ? { additions: raw.additions ?? 0, deletions: raw.deletions ?? 0, files: raw.changedFiles ?? 0 } : null,
	};
}
