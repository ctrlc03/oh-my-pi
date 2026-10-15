/**
 * What the engines that review a set of code changes share: "Quiz me" (./companion-quiz) and the sparring partner
 * (./companion-spar). A run that reads one or more parts (a change, or the pull requests of a stack), the queue that
 * limits how many are written at once, the lock that serializes writes to one stored document, the parts resolved to
 * held commits, the numbered diff and session digest a writing session is briefed with, and the checks that code a
 * part cites is really there. Functions over an explicit context: the engines own their stores and their closures.
 */

import type { BlueprintCommit, BlueprintExcerpt, BlueprintExcerptRef, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { QUIZ_MAX_PARTS, type QuizCreate, type QuizPart } from "@oh-my-pi/pi-wire/quiz";
import type { BriefPart } from "./companion-quiz-agent";
import { holdCommit, readBlob, releaseCommits, resolveTarget, stackBase } from "./companion-blueprint-git";
import { checkCitations, readCitedFiles, type Side, Warnings } from "./companion-citations";
import { assertRangeBudget, excerptOf, readExcerpts, splitLines } from "./companion-excerpt";
import { partDiff } from "./companion-quiz-diff";
import { type Digest, sessionDigest } from "./companion-quiz-digest";
import type { PrSource, StackPr } from "./companion-quiz-stack";
import { findSessionFile } from "./companion-sessions";

/** Characters of diff over all parts of a brief, and the least one part gets. */
export const TOTAL_DIFF_CHARS = 90_000;
export const MIN_PART_DIFF_CHARS = 8_000;
/** Characters of the session conversation in a brief. */
export const DIGEST_CHARS = 24_000;
export const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{6,80}$/;

/** Thrown inside a run whose document was deleted. */
export class Cancelled extends Error {}

export interface Run {
	id: string;
	cancelled: boolean;
	instanceId?: string;
	/** Parts whose commits are held, so they can be released. */
	held: number;
	done: Promise<void>;
}

/** What a run was asked to review, checked and resolved at the request. */
export interface Job {
	root: string;
	name: string;
	github?: string;
	title: string;
	subject: string;
	/** Pull requests (bottom first) or, for one change that is not a pull request, the resolved target. */
	prs?: number[];
	target?: { head: BlueprintCommit; base?: BlueprintCommit; label: string };
	sessionId?: string;
	maxCostUsd: number;
	model?: string;
}

/** One part, resolved to the commits its citations are checked against. `base` is absent for a part that has no diff. */
export interface ResolvedPart {
	title: string;
	pr?: StackPr;
	head: BlueprintCommit;
	base?: BlueprintCommit;
}

/** A part that is a change: it has a base to compare with. */
export type ChangePart = ResolvedPart & { base: BlueprintCommit };

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function positiveInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 999_999_999)
		throw new Error(`invalid ${what}`);
	return value;
}

/** The pull requests a request names, bottom first: its `stack`, else its `pr`; undefined for a change that is not a pull request. */
export function pullRequestNumbers(request: Pick<QuizCreate, "stack" | "pr">): number[] | undefined {
	if (request.stack !== undefined) {
		if (!Array.isArray(request.stack)) throw new Error("invalid stack");
		const numbers = request.stack.map(number => positiveInt(number, "pull request number"));
		if (numbers.length === 0 || numbers.length > QUIZ_MAX_PARTS)
			throw new Error(`A stack has between 1 and ${QUIZ_MAX_PARTS} pull requests.`);
		if (new Set(numbers).size !== numbers.length) throw new Error("invalid stack");
		return numbers;
	}
	return request.pr === undefined ? undefined : [positiveInt(request.pr, "pull request number")];
}

export function prRange(prs: readonly number[]): string {
	const first = prs[0]!;
	const last = prs[prs.length - 1]!;
	return prs.length === 1 ? `PR #${first}` : `PRs #${first}–#${last}`;
}

/** `sessionId` when it is a well-formed omp session id (or absent). @throws Error "invalid session". */
export function checkSessionId(sessionId: unknown): string | undefined {
	if (sessionId === undefined) return undefined;
	if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) throw new Error("invalid session");
	return sessionId;
}

// ── queue and lock ───────────────────────────────────────────────────────────

/** At most `limit` runs at once; the rest wait their turn, in order. */
export interface RunSlots {
	acquire(): Promise<void>;
	release(): void;
}

export function createRunSlots(limit: number): RunSlots {
	const waiting: (() => void)[] = [];
	let active = 0;
	return {
		async acquire() {
			if (active < limit) {
				active++;
				return;
			}
			await new Promise<void>(resolve => waiting.push(resolve));
		},
		release() {
			const next = waiting.shift();
			if (next) next();
			else active--;
		},
	};
}

/** The tails of the work queued per document id. */
export type Locks = Map<string, Promise<unknown>>;

/** Work on one stored document runs one piece after the other: each rewrites the whole document. */
export async function locked<T>(locks: Locks, id: string, work: () => Promise<T>): Promise<T> {
	const previous = locks.get(id) ?? Promise.resolve();
	const next = previous.then(work, work);
	const tail = next.catch(() => undefined);
	locks.set(id, tail);
	try {
		return await next;
	} finally {
		if (locks.get(id) === tail) locks.delete(id);
	}
}

// ── parts ────────────────────────────────────────────────────────────────────

export interface ResolvePartsContext {
	/** The pull requests of a repository. */
	prSource(root: string): PrSource;
	/** Show a step in the document's row; throws {@link Cancelled} when the document is gone. */
	progress(run: Run, text: string): Promise<void>;
}

/**
 * The parts of a job as commits, held under private refs `<run id>/p<n>` until released ({@link releaseParts}): the pull
 * requests of a stack (a pull request stacked on the one below shows its own changes only), or the one resolved target.
 * @throws Error when there is nothing to compare, or a pull request has no base.
 */
export async function resolveParts(context: ResolvePartsContext, run: Run, job: Job): Promise<ChangePart[]> {
	if (job.target) {
		const { head, base } = job.target;
		if (!base) throw new Error("There is nothing to compare these changes with.");
		await holdCommit(job.root, `${run.id}/p0`, "head", head.commit);
		await holdCommit(job.root, `${run.id}/p0`, "base", base.commit);
		run.held = 1;
		return [{ title: job.sessionId ? "What the session changed" : job.subject, head, base }];
	}
	const source = context.prSource(job.root);
	const parts: ChangePart[] = [];
	for (const number of job.prs ?? []) {
		if (run.cancelled) throw new Cancelled();
		await context.progress(run, `Fetching pull request #${number}`);
		const target = await resolveTarget(job.root, { ref: `pr/${number}` });
		const viewed = await source.view(number).catch(() => null);
		const below = parts[parts.length - 1];
		// A pull request stacked on the one below shows its own changes only, whatever the branch below has become.
		const base =
			below?.pr?.head && viewed?.base === below.pr.head
				? await stackBase(job.root, target.head.commit, below.head)
				: target.base;
		if (!base) throw new Error(`Could not find what pull request #${number} changes: it has no base.`);
		const index = parts.length;
		await holdCommit(job.root, `${run.id}/p${index}`, "head", target.head.commit);
		await holdCommit(job.root, `${run.id}/p${index}`, "base", base.commit);
		run.held = index + 1;
		parts.push({
			title: `#${number} ${viewed?.title || target.head.subject || ""}`.trim(),
			pr: viewed ?? { number, title: target.head.subject ?? "", head: "", base: "" },
			head: target.head,
			base,
		});
	}
	return parts;
}

/** Drop the commits {@link resolveParts} held for the first `count` parts of document `id`. */
export async function releaseParts(root: string, id: string, count: number): Promise<void> {
	for (let index = 0; index < count; index++) await releaseCommits(root, `${id}/p${index}`).catch(() => undefined);
}

/** What a part is, for a brief. */
export function describePart(part: ResolvedPart, index: number, count: number, subject: string): string {
	if (part.pr) {
		const branches = part.pr.head && part.pr.base ? ` (${part.pr.head} → ${part.pr.base})` : "";
		return `Pull request #${part.pr.number}${branches}${count > 1 ? `, part ${index + 1} of the stack` : ""}.`;
	}
	if (!part.base) return `${subject}: the code at \`${part.head.commit.slice(0, 8)}\`.`;
	return `${subject}: the changes since \`${part.base.commit.slice(0, 8)}\` (${part.base.ref ?? "the base"}), up to \`${part.head.commit.slice(0, 8)}\`.`;
}

/**
 * The numbered diff of every part, for a brief. A part without a base has no diff. `warnings` gets a line for each part
 * whose diff was cut to fit; `what` names what is written from it ("questions", "points").
 */
export async function briefParts(
	root: string,
	parts: readonly ResolvedPart[],
	subject: string,
	warnings: string[],
	what: string,
): Promise<BriefPart[]> {
	const share = Math.max(MIN_PART_DIFF_CHARS, Math.floor(TOTAL_DIFF_CHARS / parts.length));
	const out: BriefPart[] = [];
	for (const [index, part] of parts.entries()) {
		const about = describePart(part, index, parts.length, subject);
		if (!part.base) {
			out.push({ title: part.title, about, stat: "", diff: "", noDiff: true });
			continue;
		}
		const diff = await partDiff(root, part.base.commit, part.head.commit, { maxChars: share });
		if (diff.truncated)
			warnings.push(
				`Part ${index + 1}: the diff was too large to show whole${diff.omittedFiles > 0 ? ` (${diff.omittedFiles} files left out)` : ""}; ${what} are about the part that was shown.`,
			);
		out.push({ title: part.title, about, body: part.pr?.body, stat: diff.stat, diff: diff.text });
	}
	return out;
}

/** The conversation of a session as a brief shows it, or null (with a warning) when it cannot be read. */
export async function readDigest(
	sessionsDir: string,
	sessionId: string | undefined,
	warnings: string[],
	what: string,
): Promise<Digest | null> {
	if (!sessionId) return null;
	const file = await findSessionFile(sessionsDir, sessionId);
	const digest = file === null ? null : await sessionDigest(file, DIGEST_CHARS);
	if (digest === null)
		warnings.push(
			`The conversation of session ${sessionId} could not be read, so the ${what} come from the code alone.`,
		);
	return digest;
}

// ── code a part cites ────────────────────────────────────────────────────────

/**
 * A stored document as far as reading code goes: where the repository is, what its parts are, and the documents that
 * are not in git (a design the user pasted) by the reserved path they are cited under (`@design`), as lines.
 */
export interface CodeSubject {
	repo: { root: string };
	parts: readonly QuizPart[];
	documents?: ReadonlyMap<string, readonly string[]>;
}

/** The part's commits, for reading code out of git. */
export function commitsOf(part: QuizPart): { head: string; base?: string } {
	return { head: part.head.commit, base: part.base?.commit };
}

/** The part's cited code as graders and the screen read it; a cited document is read from its stored lines. */
export async function partExcerpts(
	subject: CodeSubject,
	part: number,
	refs: readonly BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	const found = subject.parts[part];
	if (!found) throw new Error("There is no such part.");
	assertRangeBudget(refs);
	const documents = subject.documents;
	const inGit = refs.filter(ref => !documents?.has(ref.path));
	const read = inGit.length === 0 ? [] : await readExcerpts(subject.repo.root, commitsOf(found), inGit);
	let next = 0;
	return refs.map(ref => {
		const lines = documents?.get(ref.path);
		return lines === undefined ? (read[next++] ?? null) : excerptOf(lines, ref, "head", "document");
	});
}

/** Refs a model pointed at that hold in the part's code (or in a cited document). */
export async function verifiedRefs(
	subject: CodeSubject,
	part: number,
	refs: readonly BlueprintRef[],
	what = "the explanation",
): Promise<BlueprintRef[]> {
	const found = subject.parts[part];
	if (!found || refs.length === 0) return [];
	const commits = commitsOf(found);
	const files = await readCitedFiles(
		refs.map(ref => ({ side: ref.side ?? "head", path: ref.path })),
		async (side: Side, file) => {
			const document = subject.documents?.get(file);
			if (document !== undefined) return [...document];
			const text = await readBlob(
				subject.repo.root,
				side === "base" ? (commits.base ?? commits.head) : commits.head,
				file,
			);
			return text === null ? null : splitLines(text);
		},
	);
	return checkCitations(
		refs,
		what,
		ref => ref.side ?? "head",
		files,
		{ verified: 0, moved: 0, dropped: 0 },
		new Warnings(),
	);
}
