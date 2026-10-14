/**
 * Detects the stack of pull requests a pull request belongs to, for "Quiz me" on a PR: a quiz of a stack has one
 * part per PR, bottom first. Two sources, tried in order:
 *
 * 1. the branch chain: PRs whose head branch is the base branch of the next one, walked down to the default branch
 *    and up to the top of the stack;
 * 2. the stack list in the PR body (`## Stack`, `Stacked on #12`, Graphite and Sapling footers, …), each PR resolved
 *    through `gh` and ordered by its branches.
 *
 * Everything reads through a {@link PrSource}, so the detection itself is pure; {@link ghPrSource} is the read-only
 * `gh` implementation. A lookup that fails while walking the chain shortens the stack instead of failing the quiz;
 * only the seed PR itself must be readable.
 */

import { QUIZ_MAX_PARTS, type QuizStackPr, type QuizStackSource } from "@oh-my-pi/pi-wire/quiz";
import { isRecord } from "../src/tool-render/util";
import { gh } from "./companion-gitflow";

export interface StackPr {
	number: number;
	title: string;
	/** Head branch. */
	head: string;
	/** Base branch. */
	base: string;
	url?: string;
	body?: string;
}

export interface PrSource {
	/** The pull request, or null when there is no such one. Rejects when the lookup itself fails. */
	view(number: number): Promise<StackPr | null>;
	/** Open pull requests whose head branch is `branch`. */
	byHead(branch: string): Promise<StackPr[]>;
	/** Open pull requests whose base branch is `branch`. */
	byBase(branch: string): Promise<StackPr[]>;
}

/** Most pull requests of one quiz. */
export const MAX_STACK = QUIZ_MAX_PARTS;

/** Pull requests of a stack named in a body are fetched up to this many, so a long list cannot flood `gh`. */
const MAX_LISTED = MAX_STACK * 3;
const GH_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 30;
const PR_FIELDS = "number,title,headRefName,baseRefName,url";
const MAX_BODY_SCAN_LINES = 2_000;

// ── stack lines of a PR body ─────────────────────────────────────────────────

/** A line that names a stack: "Stack:", "## Stack", "Stacked on", "Part of a stack", "PR stack", Graphite, Sapling. */
const STACK_WORD_RE = /\bstack(?:s|ed)?\b/i;
/** The line is a list item, a table row, or starts with a PR reference: a continuation of a stack list. */
const LIST_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)/;
const REF_START_RE = /^[\s*_`~[(→>-]*(?:#\d+|https?:\/\/\S*\/pull\/\d+|this (?:PR|pull request)\b)/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
/** The footer of a tool that lists the stack above it. */
const FOOTER_RE = /managed by graphite|stack created with sapling/i;
/** `#12`, `…/pull/12` or "this PR" (the PR whose body this is). */
const TOKEN_RE = /(?<![\w/&])#(\d+)\b|\/pull\/(\d+)\b|\bthis (?:PR|pull request)\b/gi;
/** Words before a number that make it something other than a member of the stack. */
const NOT_STACK_RE = /(?:\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs?|see|issues?|stack|part|step)\s+)$/i;

/** The text of a line as prose: no HTML tags, link targets, URLs or `{placeholders}`. */
function proseOf(line: string): string {
	return line
		.replace(/<[^>]*>/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\{\{?\s*[A-Za-z_]+\s*\}?\}/g, " ");
}

/** The references on a line; on a line of prose the targets of markdown links are not references (a footer links its tool). */
function tokensOf(rawLine: string, self: number | undefined, prose = false): number[] {
	const line = prose ? rawLine.replace(/\]\([^)]*\)/g, "]") : rawLine;
	const found: number[] = [];
	for (const match of line.matchAll(TOKEN_RE)) {
		const raw = match[1] ?? match[2];
		if (raw === undefined) {
			if (self !== undefined) found.push(self);
			continue;
		}
		if (match[1] !== undefined && NOT_STACK_RE.test(line.slice(0, match.index))) continue;
		const value = Number(raw);
		if (Number.isSafeInteger(value) && value > 0) found.push(value);
	}
	return found;
}

function isContinuation(line: string): boolean {
	return LIST_LINE_RE.test(line) || REF_START_RE.test(line);
}

/**
 * The pull request numbers listed in the stack section of a PR body, in listed order and without duplicates. A
 * section starts at a line that names a stack and covers the PR references on that line and the list lines under it
 * (a blank line directly under the heading is skipped); it ends at the next blank line, heading, or prose line. A
 * Graphite or Sapling footer also claims the list directly above it. When a body has several sections the one that
 * names the most pull requests wins. References outside a section (`Fixes #12`), in code fences and in HTML comments
 * are ignored, and so is a `{stack}` template that was never filled in. `self` is the number of the PR the body belongs
 * to: "this PR" in a list stands for it.
 */
export function parseStackLines(body: string, self?: number): number[] {
	const lines = body
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\r?\n/)
		.slice(0, MAX_BODY_SCAN_LINES)
		.map(line => line.replace(/^(?:\s*>)+ ?/, ""));
	const sections: number[][] = [];
	let current: number[] | null = null;
	let skippedBlank = false;
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced;
			current = null;
			continue;
		}
		if (fenced) continue;
		const prose = proseOf(line);
		const isBlank = line.trim() === "";
		if (current) {
			if (isBlank) {
				if (current.length === 0 && !skippedBlank) {
					skippedBlank = true;
					continue;
				}
				current = null;
			} else if (HEADING_RE.test(line) || !isContinuation(line)) {
				current = null;
			} else {
				current.push(...tokensOf(line, self));
				continue;
			}
		}
		if (isBlank || !STACK_WORD_RE.test(prose)) continue;
		current = HEADING_RE.test(line) ? [] : tokensOf(line, self, true);
		skippedBlank = false;
		sections.push(current);
		if (FOOTER_RE.test(prose)) sections.push(listAbove(lines, i, self));
	}
	let best: number[] = [];
	let bestCount = 0;
	for (const section of sections) {
		const unique = [...new Set(section)];
		if (unique.length > bestCount) {
			best = unique;
			bestCount = unique.length;
		}
	}
	return best;
}

/** The list directly above line `index` (one separator line may sit between), in listed order. */
function listAbove(lines: readonly string[], index: number, self: number | undefined): number[] {
	let end = index - 1;
	while (end >= 0 && /^\s*(?:-{3,}|\*{3,}|_{3,})?\s*$/.test(lines[end] ?? "")) end--;
	let start = end;
	while (start >= 0 && isContinuation(lines[start] ?? "") && !HEADING_RE.test(lines[start] ?? "")) start--;
	return lines.slice(start + 1, end + 1).flatMap(line => tokensOf(line, self));
}

// ── order ────────────────────────────────────────────────────────────────────

/** The topological order of `prs` (a PR whose base is another's head comes after it), uncapped. */
function orderAll(prs: readonly StackPr[]): StackPr[] {
	const seen = new Set<number>();
	const remaining = prs.filter(pr => !seen.has(pr.number) && seen.add(pr.number));
	const ordered: StackPr[] = [];
	while (remaining.length > 0) {
		// The first listed PR that no remaining PR is below; on a cycle, the first listed PR.
		let index = remaining.findIndex(pr => !remaining.some(other => other !== pr && other.head === pr.base));
		if (index === -1) index = 0;
		ordered.push(...remaining.splice(index, 1));
	}
	return ordered;
}

/**
 * `prs` bottom first: a PR whose base branch is another's head branch comes after it. PRs that are not chained keep
 * the order they were given in (pass them number-ascending, or in the order a body lists them); a duplicate number is
 * dropped and a cycle is broken at its first listed PR, never thrown. At most {@link MAX_STACK}.
 */
export function orderStack(prs: readonly StackPr[]): StackPr[] {
	return orderAll(prs).slice(0, MAX_STACK);
}

/** At most {@link MAX_STACK} of `list`: from the bottom, moved up just far enough to keep `index` in the window. */
function windowAround<T>(list: readonly T[], index: number): T[] {
	const start = Math.max(0, index - MAX_STACK + 1);
	return list.slice(start, start + MAX_STACK);
}

// ── detection ────────────────────────────────────────────────────────────────

function toQuizPr(pr: StackPr): QuizStackPr {
	const mapped: QuizStackPr = { number: pr.number, title: pr.title, head: pr.head, base: pr.base };
	if (pr.url) mapped.url = pr.url;
	return mapped;
}

function lowest(prs: readonly StackPr[], skip: (pr: StackPr) => boolean): StackPr | null {
	let best: StackPr | null = null;
	for (const pr of prs) if (!skip(pr) && (best === null || pr.number < best.number)) best = pr;
	return best;
}

async function quiet<T>(lookup: Promise<T[]>): Promise<T[]> {
	try {
		return await lookup;
	} catch {
		return [];
	}
}

/** The PRs below the seed (nearest first) and above it (nearest first) along the branch chain. */
async function walkBranches(
	seed: StackPr,
	source: PrSource,
	isDefault: (branch: string) => boolean,
): Promise<{ below: StackPr[]; above: StackPr[] }> {
	const visited = new Set([seed.number]);
	const below: StackPr[] = [];
	for (let current = seed; below.length < MAX_STACK && !isDefault(current.base);) {
		const candidates = await quiet(source.byHead(current.base));
		const next = lowest(candidates, pr => pr.head !== current.base || visited.has(pr.number));
		if (!next) break;
		visited.add(next.number);
		below.push(next);
		current = next;
	}
	const above: StackPr[] = [];
	for (let current = seed; above.length < MAX_STACK;) {
		const candidates = await quiet(source.byBase(current.head));
		const next = lowest(candidates, pr => pr.base !== current.head || pr.head === pr.base || visited.has(pr.number));
		if (!next) break;
		visited.add(next.number);
		above.push(next);
		current = next;
	}
	return { below, above };
}

async function viewSeed(seed: number, source: PrSource): Promise<StackPr> {
	let pr: StackPr | null;
	try {
		pr = await source.view(seed);
	} catch (err) {
		throw new Error(`Could not read pull request #${seed}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!pr) throw new Error(`Could not read pull request #${seed}: no such pull request`);
	return pr;
}

/**
 * The stack `seed` belongs to, bottom first, and how it was found. A stack longer than {@link MAX_STACK} is cut to
 * a window of that many PRs from the bottom, moved up just far enough to keep the seed in it. A seed that is not
 * part of a stack comes back alone with source `none`. Rejects only when the seed itself cannot be read.
 */
export async function detectStack(
	seed: number,
	source: PrSource,
	options: { defaultBranch?: string } = {},
): Promise<{ stack: QuizStackPr[]; source: QuizStackSource }> {
	const seedPr = await viewSeed(seed, source);
	const isDefault = (branch: string) =>
		!branch || branch === "main" || branch === "master" || branch === options.defaultBranch;

	const { below, above } = await walkBranches(seedPr, source, isDefault);
	if (below.length + above.length > 0) {
		const chain = [...below.reverse(), seedPr, ...above];
		return { stack: windowAround(chain, below.length).map(toQuizPr), source: "branches" };
	}

	const listed = parseStackLines(seedPr.body ?? "", seed);
	if (listed.some(number => number !== seed)) {
		if (!listed.includes(seed)) listed.push(seed);
		const resolved = await Promise.all(
			listed.slice(0, MAX_LISTED).map(async number => {
				if (number === seed) return seedPr;
				try {
					return await source.view(number);
				} catch {
					return null;
				}
			}),
		);
		const found = orderAll(resolved.filter((pr): pr is StackPr => pr !== null));
		if (found.length > 1) {
			const index = found.findIndex(pr => pr.number === seed);
			return { stack: windowAround(found, index).map(toQuizPr), source: "body" };
		}
	}
	return { stack: [toQuizPr(seedPr)], source: "none" };
}

// ── gh ───────────────────────────────────────────────────────────────────────

function parsePr(value: unknown): StackPr | null {
	if (!isRecord(value)) return null;
	const { number, title, headRefName, baseRefName, url, body } = value;
	if (typeof number !== "number" || typeof headRefName !== "string" || typeof baseRefName !== "string") return null;
	const pr: StackPr = {
		number,
		title: typeof title === "string" ? title : "",
		head: headRefName,
		base: baseRefName,
	};
	if (typeof url === "string") pr.url = url;
	if (typeof body === "string") pr.body = body;
	return pr;
}

/** The lookups of a repository through `gh`: read-only, no prompts, bounded by a timeout. */
export function ghPrSource(root: string): PrSource {
	const run = async (args: string[]): Promise<string> => {
		const result = await gh(root, args, GH_TIMEOUT_MS);
		if (result.code !== 0) {
			throw new Error(result.err.split("\n").find(line => line.trim()) ?? `gh ${args[0]} ${args[1]} failed`);
		}
		return result.out;
	};
	const list = async (flag: "--head" | "--base", branch: string): Promise<StackPr[]> => {
		const out = await run([
			"pr",
			"list",
			"--state",
			"open",
			flag,
			branch,
			"--limit",
			String(LIST_LIMIT),
			"--json",
			PR_FIELDS,
		]);
		const parsed: unknown = JSON.parse(out || "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.map(parsePr).filter((pr): pr is StackPr => pr !== null);
	};
	return {
		async view(number) {
			let out: string;
			try {
				out = await run(["pr", "view", String(number), "--json", `${PR_FIELDS},body`]);
			} catch (err) {
				if (err instanceof Error && /could not resolve|no pull requests? found/i.test(err.message)) return null;
				throw err;
			}
			return parsePr(JSON.parse(out));
		},
		byHead: branch => list("--head", branch),
		byBase: branch => list("--base", branch),
	};
}
