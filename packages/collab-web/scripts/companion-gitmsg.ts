/**
 * Generated commit messages and pull request text for the app's git flow.
 *
 * The companion asks the model through a headless `omp -p` run (a cheap role,
 * no session file, no tools, no project context) fed with the diff on stdin,
 * rather than through the session being committed: the agent may be mid-turn
 * elsewhere, an idle session may not host, and the run costs a fraction of a
 * main-model turn. The diff is capped, lockfiles are left out, and the prompt
 * carries the repository's recent commit subjects so the text follows its style.
 * When the run fails (omp missing, no model, a timeout, an unreadable answer) a
 * template built from the session title, commits and changed files is returned
 * instead, with the reason in `note`, so the confirm dialog always has text.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GitText } from "../src/lib/companion";
import { git } from "./companion-git";
import { branchState, requireRoot } from "./companion-gitflow";
import { headlessOmpArgs, headlessRunner, type RunOmp } from "./companion-headless";

/** Characters of diff handed to the model per section (uncommitted changes, whole branch). */
export const DIFF_CHARS = 14_000;
const STYLE_COMMITS = 15;
const BRANCH_COMMITS = 30;
const MAX_UNTRACKED = 40;
const GIT_DIFF_BYTES = 400 * 1024;
const TEMPLATE_CHARS = 3_000;
const RUN_TIMEOUT_MS = 90_000;
const MAX_COST_USD = 0.25;
/** What the model is asked to stay within; the answer is clipped to these as well. */
const MAX_SUBJECT_CHARS = 100;
const MAX_COMMIT_CHARS = 2_000;
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 8_000;
const MAX_NOTE_CHARS = 300;
/** Lockfiles and generated bundles add bytes, not meaning. */
const NOISE_FILE_RE =
	/(?:^|\/)(?:[^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]*\.min\.(?:js|css))$/;

/** The `smol` role, written `@smol` so it resolves to the role's default even when settings do not configure it. */
export const DEFAULT_MESSAGE_MODEL = "@smol";

export interface GitTextRequest {
	commit: boolean;
	pr: boolean;
}

export interface GitTextContext {
	branch: string | null;
	base: string | null;
	sessionTitle: string | null;
	sessionSummary: string | null;
	/** Recent subjects on HEAD, newest first: the repository's commit style. */
	styleSubjects: string[];
	/** Uncommitted changes (HEAD to the working tree); present when a commit message is wanted. */
	uncommitted: ChangeSet | null;
	/** The whole branch (merge-base to the working tree) and its commits; present when a pull request is wanted. */
	branchChanges: (ChangeSet & { commits: string[] }) | null;
	template: string | null;
}

export interface ChangeSet {
	stat: string;
	diff: string;
	untracked: string[];
}

const decoder = new TextDecoder();

/** Headless omp: cheap model, no session file, tools, extensions, skills, rules or LSP, and a hard spend cap. */
export function ompArgs(ompBin: string, model: string): string[] {
	return headlessOmpArgs({ ompBin, model, systemPrompt: SYSTEM_PROMPT, maxCostUsd: MAX_COST_USD });
}

const SYSTEM_PROMPT =
	"You write git commit messages and pull request descriptions from the changes you are given. " +
	"Reply with one JSON object and nothing else: no code fences, no commentary. Never invent changes the diff does not show.";

const defaultRun = headlessRunner(RUN_TIMEOUT_MS);

// ── context ──────────────────────────────────────────────────────────────────

function lines(bytes: Uint8Array): string[] {
	return decoder
		.decode(bytes)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

/** The sections of a unified diff, one per file. */
function diffSections(diff: string): string[] {
	return diff.split(/^(?=diff --git )/m).filter(section => section.startsWith("diff --git "));
}

function sectionPath(section: string): string {
	const header = section.slice(0, section.indexOf("\n") === -1 ? undefined : section.indexOf("\n"));
	const match = /^diff --git a\/(.*) b\/(.*)$/.exec(header);
	return match?.[2] ?? "";
}

/**
 * `diff` without lockfiles, generated bundles and binary files, cut to `limit`
 * characters with each file getting a fair share so one large file cannot crowd out the rest.
 */
export function capDiff(diff: string, limit: number): string {
	const sections = diffSections(diff).filter(
		section => !NOISE_FILE_RE.test(sectionPath(section)) && !/^Binary files /m.test(section),
	);
	if (sections.length === 0) return "";
	const share = Math.max(1_200, Math.floor(limit / sections.length));
	let total = 0;
	const kept: string[] = [];
	for (const section of sections) {
		let piece = section;
		if (piece.length > share) {
			const cut = piece.lastIndexOf("\n", share);
			piece = `${piece.slice(0, cut > 0 ? cut : share)}\n[… ${piece.length - (cut > 0 ? cut : share)} more characters of this file's diff omitted]\n`;
		}
		if (total + piece.length > limit) {
			kept.push(`[… ${sections.length - kept.length} more file diff(s) omitted]\n`);
			break;
		}
		kept.push(piece);
		total += piece.length;
	}
	return kept.join("");
}

async function changeSet(root: string, ref: string): Promise<ChangeSet> {
	const base = ["diff", "--no-ext-diff", "--no-color", "--no-renames"];
	const [stat, diff, untracked] = await Promise.all([
		git(root, [...base, "--stat=100", ref, "--"]),
		git(root, [...base, "-U2", ref, "--"], { maxBytes: GIT_DIFF_BYTES }),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return {
		stat: decoder.decode(stat.out).trim(),
		diff: capDiff(decoder.decode(diff.out), DIFF_CHARS),
		untracked: decoder
			.decode(untracked.out)
			.split("\0")
			.filter(file => file && !NOISE_FILE_RE.test(file))
			.slice(0, MAX_UNTRACKED),
	};
}

async function pullRequestTemplate(root: string): Promise<string | null> {
	for (const rel of [
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		"pull_request_template.md",
	]) {
		const text = await fs.readFile(path.join(root, rel), "utf8").catch(() => null);
		if (text?.trim()) return text.trim().slice(0, TEMPLATE_CHARS);
	}
	return null;
}

/** What the model (or the fallback) writes from: the changes a commit and a pull request would carry. */
export async function gatherContext(
	cwd: string,
	want: GitTextRequest,
	session: { title: string | null; summary: string | null },
): Promise<GitTextContext> {
	const root = await requireRoot(cwd);
	const { branch, base, mergeBase } = await branchState(root);
	const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
	const [style, uncommitted, branchChanges, commits, template] = await Promise.all([
		head ? git(root, ["log", `-n${STYLE_COMMITS}`, "--no-merges", "--format=%s"]) : null,
		want.commit ? changeSet(root, head ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbf2e32") : null,
		want.pr ? changeSet(root, mergeBase ?? (head ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbf2e32")) : null,
		want.pr && mergeBase
			? git(root, ["log", `-n${BRANCH_COMMITS}`, "--no-merges", "--format=%s", `${mergeBase}..HEAD`])
			: null,
		want.pr ? pullRequestTemplate(root) : null,
	]);
	return {
		branch,
		base,
		sessionTitle: session.title?.trim() || null,
		sessionSummary: session.summary?.trim() || null,
		styleSubjects: style ? lines(style.out) : [],
		uncommitted,
		branchChanges: branchChanges ? { ...branchChanges, commits: commits ? lines(commits.out) : [] } : null,
		template,
	};
}

// ── prompt and answer ────────────────────────────────────────────────────────

function changeSection(title: string, changes: ChangeSet): string {
	const parts = [`## ${title}`];
	if (changes.stat) parts.push(`Files:\n${changes.stat}`);
	if (changes.untracked.length > 0) parts.push(`New untracked files:\n${changes.untracked.join("\n")}`);
	if (changes.diff) parts.push(`Diff:\n${changes.diff}`);
	return parts.join("\n\n");
}

export function buildPrompt(context: GitTextContext, want: GitTextRequest): string {
	const keys = [
		...(want.commit ? ['"commit": the commit message for the uncommitted changes'] : []),
		...(want.pr ? ['"title": the pull request title', '"body": the pull request description in Markdown'] : []),
	];
	const parts = [
		`Write these fields as a JSON object:\n- ${keys.join("\n- ")}`,
		[
			"Rules:",
			...(want.commit
				? [
						"- The commit message is a subject line of at most 72 characters in the imperative mood, then if the change deserves it a blank line and a short body that says why. Follow the style of the recent commits below (prefixes, casing, tense).",
					]
				: []),
			...(want.pr
				? [
						"- The pull request title is one line of at most 80 characters.",
						"- The pull request description is a short summary of what changed and why, as bullets, then anything a reviewer should check. No headings the repository's template does not use; no filler; do not list every file.",
					]
				: []),
			"- Describe only what the changes show. The session title and summary tell what the author was trying to do.",
		].join("\n"),
	];
	if (context.sessionTitle) parts.push(`Session title: ${context.sessionTitle}`);
	if (context.sessionSummary) parts.push(`Author's last summary of the work: ${context.sessionSummary}`);
	if (context.branch) parts.push(`Branch: ${context.branch}${context.base ? ` (into ${context.base})` : ""}`);
	if (context.styleSubjects.length > 0) parts.push(`## Recent commit subjects\n${context.styleSubjects.join("\n")}`);
	if (context.uncommitted) parts.push(changeSection("Uncommitted changes (the commit)", context.uncommitted));
	if (context.branchChanges) {
		if (context.branchChanges.commits.length > 0) {
			parts.push(`## Commits already on the branch\n${context.branchChanges.commits.join("\n")}`);
		}
		parts.push(changeSection("Whole branch against its base (the pull request)", context.branchChanges));
	}
	if (context.template) parts.push(`## Pull request template to follow\n${context.template}`);
	return parts.join("\n\n");
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** The first JSON object in the model's answer, tolerating code fences and chatter around it. */
function jsonObject(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function textField(value: unknown): string {
	return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

/** The fields asked for, from the model's answer; null when it is unreadable or leaves one empty. */
export function parseAnswer(raw: string, want: GitTextRequest): Pick<GitText, "commit" | "prTitle" | "prBody"> | null {
	const object = jsonObject(raw);
	if (object === null) return null;
	const commit = want.commit ? clip(textField(object.commit), MAX_COMMIT_CHARS) : "";
	const prTitle = want.pr ? clip(textField(object.title).split("\n")[0] ?? "", MAX_TITLE_CHARS) : "";
	const prBody = want.pr ? clip(textField(object.body), MAX_BODY_CHARS) : "";
	if ((want.commit && !commit) || (want.pr && !prTitle)) return null;
	return { commit, prTitle, prBody };
}

// ── fallback ─────────────────────────────────────────────────────────────────

function oneLine(text: string, max: number): string {
	const line = (text.split("\n")[0] ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Most recent subjects use `type: …` or `type(scope): …`. */
function usesConventionalCommits(subjects: string[]): boolean {
	if (subjects.length === 0) return false;
	const matching = subjects.filter(subject => /^[a-z]+(?:\([^)]+\))?!?: \S/.test(subject)).length;
	return matching * 2 >= subjects.length;
}

function changedPaths(changes: ChangeSet): string[] {
	const tracked = changes.stat
		.split("\n")
		.map(line => /^\s*(.+?)\s+\|\s+\S/.exec(line)?.[1])
		.filter((file): file is string => file !== undefined && !NOISE_FILE_RE.test(file));
	return [...tracked, ...changes.untracked];
}

function describePaths(paths: string[]): string {
	if (paths.length === 1) return path.basename(paths[0]!);
	if (paths.length === 0) return "changes";
	return `${paths.length} files`;
}

/** Text built without a model: the session title first, then what changed. */
export function fallbackText(
	context: GitTextContext,
	want: GitTextRequest,
): Pick<GitText, "commit" | "prTitle" | "prBody"> {
	const sessionTitle = context.sessionTitle ? oneLine(context.sessionTitle, MAX_SUBJECT_CHARS) : "";
	let commit = "";
	if (want.commit) {
		const paths = context.uncommitted ? changedPaths(context.uncommitted) : [];
		let subject = sessionTitle || `Update ${describePaths(paths)}`;
		if (usesConventionalCommits(context.styleSubjects) && !/^[a-z]+(?:\([^)]+\))?!?: /.test(subject)) {
			subject = `chore: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
		}
		commit = subject;
		if (paths.length > 1)
			commit += `\n\n${paths
				.slice(0, 12)
				.map(file => `- ${file}`)
				.join("\n")}`;
	}
	let prTitle = "";
	let prBody = "";
	if (want.pr) {
		const commits = context.branchChanges?.commits ?? [];
		prTitle =
			sessionTitle ||
			(commits.length > 0 ? oneLine(commits[commits.length - 1]!, MAX_TITLE_CHARS) : "") ||
			oneLine(commit, MAX_TITLE_CHARS) ||
			(context.branch
				? oneLine(context.branch.replace(/^[^/]+\//, "").replaceAll(/[-_]/g, " "), MAX_TITLE_CHARS)
				: "") ||
			"Update";
		const body: string[] = [];
		if (context.sessionSummary) body.push(`## Summary\n\n${context.sessionSummary}`);
		if (commits.length > 0)
			body.push(
				`## Commits\n\n${[...commits]
					.reverse()
					.map(subject => `- ${subject}`)
					.join("\n")}`,
			);
		const stat = context.branchChanges?.stat;
		if (stat) body.push(`## Changed files\n\n\`\`\`\n${stat}\n\`\`\``);
		prBody = body.join("\n\n");
	}
	return { commit, prTitle, prBody };
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface GenerateOptions {
	cwd: string;
	want: GitTextRequest;
	session: { title: string | null; summary: string | null };
	ompBin: string;
	/** Model id or role (`smol`). */
	model: string;
	run?: RunOmp;
}

/** Commit message and / or pull request text for the repository at `cwd`; never rejects for a model failure. */
export async function generateGitText(options: GenerateOptions): Promise<GitText> {
	const { want, run = defaultRun } = options;
	if (!want.commit && !want.pr) throw new Error("nothing to generate");
	const context = await gatherContext(options.cwd, want, options.session);
	let note: string;
	try {
		// A neutral folder: the project's own context files and settings have no part in this.
		const result = await run(ompArgs(options.ompBin, options.model), buildPrompt(context, want), os.tmpdir());
		if (result.code === 0) {
			const answer = parseAnswer(result.out, want);
			if (answer !== null) return { ...answer, source: "model" };
			note = "the model's answer was not readable";
		} else {
			const reason =
				result.err
					.split("\n")
					.map(line => line.trim())
					.filter(Boolean)
					.pop() ?? `exit ${result.code}`;
			note = `omp exited with ${result.code}: ${reason}`;
		}
	} catch (err) {
		note = err instanceof Error ? err.message : String(err);
	}
	return { ...fallbackText(context, want), source: "fallback", note: clip(note, MAX_NOTE_CHARS) };
}
