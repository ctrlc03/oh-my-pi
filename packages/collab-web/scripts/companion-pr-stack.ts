/**
 * The pull requests of a stack and each one's own changes, for the review board (`pr-stack`, `pr-own-diff`).
 *
 * The stack is found the way "Quiz me" finds it (./companion-quiz-stack: the branch chain through `gh pr list`, else
 * the stack list in the PR bodies). A pull request's own changes are its head against the merge base with the head of
 * the pull request below it, or, for the bottom one, against its base branch (./companion-review-base `ownBase`), so a
 * stacked pull request shows its own commits whatever the branch below has become since. Both heads are fetched into
 * private refs (./companion-blueprint-git); nothing touches the user's checkout, branches or index.
 *
 * Results are reused for a minute (a board steps through a whole stack: one detection answers every pull request of
 * it) and a diff is kept by the two commits it is between, which never change.
 */

import type { BlueprintCommit } from "@oh-my-pi/pi-wire/blueprint";
import type { BoardFile, PrOwnDiff, StackPr as BoardStackPr } from "../src/lib/review-board";
import { defaultBranch, repoInfo, type ResolvedTarget, resolvePrHead, resolveTarget } from "./companion-blueprint-git";
import { git, gitFailure } from "./companion-git";
import { MAX_FILE_DIFF_CHARS, MAX_FILES, splitPrDiff, unquoteGitPath } from "./companion-prreview";
import { detectStackPrs, ghPrSource, type PrSource, type StackPr } from "./companion-quiz-stack";
import { ownBase } from "./companion-review-base";

/** How long a stack or a pull request's own diff is reused. */
export const STACK_TTL_MS = 60_000;
const MAX_CACHED = 16;
/** Largest `git diff` read between two commits. */
const DIFF_BYTES = 16 * 1024 * 1024;
const MAX_NUMBER = 999_999_999;

const decoder = new TextDecoder();

/** A pull request number from a device. */
export function checkPrNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_NUMBER) {
		throw new Error("invalid pull request number");
	}
	return value;
}

/** A pull request of a stack as the board lists it. */
export function boardStackPr(pr: StackPr): BoardStackPr {
	return {
		number: pr.number,
		title: pr.title,
		head: pr.head,
		base: pr.base,
		url: pr.url ?? "",
		state: pr.state ?? "open",
	};
}

/**
 * The pull request directly below `number` in `stack` (bottom first): the previous one, when `number`'s base branch is
 * its head branch. Undefined for the bottom pull request and for one whose base is something else (a window of a long
 * stack, a stack found by its bodies in which the branches are not chained).
 */
export function pullRequestBelow(stack: readonly StackPr[], number: number): StackPr | undefined {
	const index = stack.findIndex(pr => pr.number === number);
	if (index < 1) return undefined;
	const below = stack[index - 1]!;
	return stack[index]!.base === below.head ? below : undefined;
}

// ── the diff as board files ──────────────────────────────────────────────────

/** One file's section of a git diff as the board shows it; `diff` over {@link MAX_FILE_DIFF_CHARS} is cut at a line. */
export function boardFile(section: { path: string; diff: string }): BoardFile {
	let status: BoardFile["status"] = "modified";
	let oldPath: string | undefined;
	let added = 0;
	let removed = 0;
	let inHunk = false;
	for (const line of section.diff.split("\n")) {
		if (inHunk) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		} else if (line.startsWith("@@")) {
			inHunk = true;
		} else if (line.startsWith("new file mode")) {
			status = "added";
		} else if (line.startsWith("deleted file mode")) {
			status = "deleted";
		} else if (line.startsWith("rename from ")) {
			status = "renamed";
			oldPath = unquoteGitPath(line.slice("rename from ".length));
		}
	}
	const file: BoardFile = { path: section.path, status, diff: section.diff, added, removed };
	if (oldPath !== undefined) file.oldPath = oldPath;
	if (section.diff.length > MAX_FILE_DIFF_CHARS) {
		const cut = section.diff.lastIndexOf("\n", MAX_FILE_DIFF_CHARS);
		file.diff = section.diff.slice(0, cut === -1 ? MAX_FILE_DIFF_CHARS : cut + 1);
		file.truncated = true;
	}
	return file;
}

/**
 * The files of a `git diff`. `truncated`: git's output reached its cap, so the last file was cut (a cut mid-line is
 * dropped) and files after it are missing.
 */
export function boardFiles(raw: string, truncated: boolean): BoardFile[] {
	const text = truncated ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
	const files = splitPrDiff(text).slice(0, MAX_FILES).map(boardFile);
	const last = files.at(-1);
	if (truncated && last !== undefined) last.truncated = true;
	return files;
}

/** `git diff -M` of two commits as board files. */
export async function diffBoardFiles(root: string, base: string, head: string): Promise<BoardFile[]> {
	const result = await git(
		root,
		[
			"diff",
			"-U3",
			"-M",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			base,
			head,
			"--",
		],
		{ maxBytes: DIFF_BYTES },
	);
	if (result.code !== 0 && !result.truncated) throw gitFailure(result, "git diff");
	return boardFiles(decoder.decode(result.out), result.truncated);
}

// ── the engine ───────────────────────────────────────────────────────────────

/** How the engine talks to git and GitHub; tests replace it. */
export interface PrStackDeps {
	/** The primary checkout of the repository containing `cwd`. */
	root(cwd: string): Promise<string>;
	source(root: string): PrSource;
	defaultBranch(root: string): Promise<string | undefined>;
	/** The pull request's head and, when it has changes beyond its base branch, its base. */
	target(root: string, number: number): Promise<ResolvedTarget>;
	/** Only the pull request's head. */
	head(root: string, number: number): Promise<BlueprintCommit>;
	ownBase: typeof ownBase;
	diff(root: string, base: string, head: string): Promise<BoardFile[]>;
	now(): number;
}

export interface PrStack {
	/** The pull requests of the stack `number` belongs to, bottom first; a lone pull request is a one-entry stack. */
	stack(cwd: string, number: unknown): Promise<BoardStackPr[]>;
	/** `number`'s own changes against the pull request below it in its stack, or against its base. */
	ownDiff(cwd: string, number: unknown): Promise<PrOwnDiff>;
}

const defaultDeps: PrStackDeps = {
	async root(cwd) {
		return (await repoInfo(cwd)).root;
	},
	source: ghPrSource,
	defaultBranch: async root => (await defaultBranch(root).catch(() => undefined))?.name,
	target: (root, number) => resolveTarget(root, { ref: `pr/${number}` }),
	head: resolvePrHead,
	ownBase,
	diff: diffBoardFiles,
	now: Date.now,
};

/** `map` as a least-recently-added cache of at most {@link MAX_CACHED} entries. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_CACHED) map.delete(map.keys().next().value as string);
}

export function createPrStack(deps: PrStackDeps = defaultDeps): PrStack {
	const stacks = new Map<string, { at: number; stack: Promise<StackPr[]> }>();
	const owns = new Map<string, { at: number; diff: Promise<PrOwnDiff> }>();
	/** Diffs by the two commits they are between: immutable, so never stale. */
	const ranges = new Map<string, Promise<BoardFile[]>>();

	function stackOf(root: string, number: number): Promise<StackPr[]> {
		const now = deps.now();
		const hit = stacks.get(`${root}#${number}`);
		if (hit !== undefined && now - hit.at < STACK_TTL_MS) return hit.stack;
		const found = (async () => {
			const { stack } = await detectStackPrs(number, deps.source(root), {
				defaultBranch: await deps.defaultBranch(root),
			});
			return stack;
		})();
		const entry = { at: now, stack: found };
		remember(stacks, `${root}#${number}`, entry);
		// One detection answers every pull request of the stack the board steps through.
		found.then(
			stack => {
				for (const pr of stack) if (pr.number !== number) remember(stacks, `${root}#${pr.number}`, entry);
			},
			// A failure is not remembered: the next request asks again.
			() => stacks.delete(`${root}#${number}`),
		);
		return found;
	}

	function rangeFiles(root: string, base: string, head: string): Promise<BoardFile[]> {
		const key = `${root}:${base}..${head}`;
		const hit = ranges.get(key);
		if (hit !== undefined) return hit;
		const files = deps.diff(root, base, head);
		remember(ranges, key, files);
		files.catch(() => ranges.delete(key));
		return files;
	}

	async function computeOwn(root: string, number: number): Promise<PrOwnDiff> {
		const stack = await stackOf(root, number);
		const viewed = stack.find(pr => pr.number === number);
		if (viewed === undefined) throw new Error(`Pull request #${number} is not part of its own stack.`);
		const below = pullRequestBelow(stack, number);
		const [target, belowHead] = await Promise.all([
			deps.target(root, number),
			below === undefined ? undefined : deps.head(root, below.number),
		]);
		const base = await deps.ownBase(root, target, viewed, below, belowHead);
		if (!base) throw new Error(`Could not find what pull request #${number} changes: it has no base.`);
		const files = await rangeFiles(root, base.commit, target.head.commit);
		const ref = below !== undefined && belowHead !== undefined ? below.head : (base.ref ?? viewed.base);
		return { number, head: target.head.commit, against: { ref, sha: base.commit }, files };
	}

	return {
		async stack(cwd, number) {
			const n = checkPrNumber(number);
			return (await stackOf(await deps.root(cwd), n)).map(boardStackPr);
		},
		async ownDiff(cwd, number) {
			const n = checkPrNumber(number);
			const root = await deps.root(cwd);
			const key = `${root}#${n}`;
			const hit = owns.get(key);
			if (hit !== undefined && deps.now() - hit.at < STACK_TTL_MS) return hit.diff;
			const diff = computeOwn(root, n);
			remember(owns, key, { at: deps.now(), diff });
			diff.catch(() => owns.delete(key));
			return diff;
		},
	};
}
