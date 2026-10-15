/**
 * "Sparring partner": "Quiz me" turned around. An agent on the computer reads a set of code changes (a branch, a
 * pull request, a stack of pull requests, what an agent session just changed) and/or a design document, and challenges
 * the decisions in them, one point at a time. You defend each point in your own words; a model answers with one of
 * three moves (concedes, partly, pushes back) from a hidden case file the agent wrote with the point. At the end you get
 * what you held, the risks still open and the changes it suggests.
 *
 * Every point cites code as `path@line@token` (a {@link QuizRef}, checked against the commit before the spar is stored),
 * or a line of the document as `@design@line@token`. A point whose citations all fail is dropped.
 *
 * What the client never receives: the case file of a point (its strongest defence, when the partner must concede, its
 * counters, its suggestion). The strongest defence and the suggestion come back in {@link SparRecord.reveal} once a point
 * is closed.
 *
 * Reuses the quiz's change parts, references and stack detection; defines only what differs. Shared by the companion
 * (which writes, argues and stores spars) and the web app (which plays them). Pure JSON shapes, the limits both sides
 * apply, and the scoring rule.
 */

import type { BlueprintExcerptRef } from "./blueprint";
import type { QuizCreate, QuizPart, QuizRef } from "./quiz";

/** Format version of the stored spar. */
export const SPAR_VERSION = 1;
/** Points of one spar. */
export const SPAR_MAX_POINTS = 12;
/** Times you may answer one point before the partner's last push closes it as open. */
export const SPAR_MAX_ROUNDS = 3;
/** Characters of one defence the companion accepts. */
export const SPAR_MAX_REPLY_CHARS = 4_000;
/** Characters of a pasted or file design document the companion accepts. */
export const SPAR_MAX_DOC_CHARS = 60_000;
/** Spend limit of a spar when the request names none, USD: writing the points and every reply together. */
export const SPAR_DEFAULT_MAX_COST_USD = 6;
/** The reserved citation path of the design document: `@design@12@token`. */
export const SPAR_DESIGN_PATH = "@design";

export type SparKind = "alternative" | "failure" | "cost" | "assumption" | "migration";
export type SparMove = "push" | "partly" | "concede";
export type SparOutcomeKind = "held" | "partly" | "lost" | "open";
export type SparOutcomeBy = "partner" | "you" | "limit";

/** What the device sees of a point: no case file. */
export interface SparPoint {
	/** `p1`, `p2`… unique within the spar. */
	id: string;
	/** Index into {@link Spar.parts}. */
	part: number;
	kind: SparKind;
	/** "Why a second queue instead of the existing one?" */
	title: string;
	/** Markdown: the opening argument. */
	challenge: string;
	severity: 1 | 2 | 3;
	/** Verified citations, the first is the main one. At least one. */
	refs: QuizRef[];
}

export interface SparTurn {
	by: "you" | "partner";
	text: string;
	/** Partner turns. */
	move?: SparMove;
	/** Partner turns: verified citations. */
	refs?: QuizRef[];
	/** Partner turns: the claims of your defence it checked, and whether the code supports them. */
	checked?: { claim: string; holds: boolean }[];
	at: number;
}

export interface SparRecord {
	turns: SparTurn[];
	outcome?: { kind: SparOutcomeKind; by: SparOutcomeBy; note?: string };
	/** Present once the point is closed. */
	reveal?: { strongestDefence: string; suggestion?: string; refs?: QuizRef[] };
}

export interface Spar {
	v: typeof SPAR_VERSION;
	id: string;
	/** Display name, e.g. "interfold · PR #2243–#2248" or "interfold @ feature/x vs main". */
	title: string;
	repo: { root: string; name: string; github?: string };
	createdAt: number;
	/** `provider/model` that wrote the points. */
	model?: string;
	/** The omp session whose conversation the points were written from, when one was given and could be read. */
	sessionId?: string;
	/** One per pull request of a stack, or the one change, or the commit a design document is checked against (no `base`). */
	parts: QuizPart[];
	points: SparPoint[];
	/** Everything the build fixed, dropped or skipped, in plain words. */
	warnings: string[];
	/** The design document, when there is one (its text stays on the computer; read lines through `spar-excerpt`). */
	doc?: { name: string; chars: number };
}

/** The points of a run by what became of them. Ids of {@link SparPoint}. */
export interface SparResult {
	/** The partner conceded. */
	held: string[];
	/** Partly conceded (the residual objection stands) and open (round limit, risk accepted, skipped). */
	open: string[];
	/** Lost and partly: the changes the partner suggests. */
	suggested: string[];
	/** `held / asked` as a whole percent, a partly counting one half; 0 when there is no point. */
	percentHeld: number;
}

/** One run through a spar (or through the points of an earlier run that were not held). */
export interface SparRun {
	/** `r1`, `r2`… unique within the spar. */
	id: string;
	startedAt: number;
	/** Set once every point of the run is closed. */
	finishedAt?: number;
	/** Point ids this run asks, in order. */
	points: string[];
	/** Records by point id. */
	records: Record<string, SparRecord>;
	/** The run this one repeats the unsettled points of. */
	retryOf?: string;
	/** Recomputed by the companion on every change, so it is always current. */
	result: SparResult;
}

/** One row of the spar list. */
export interface SparSummary {
	id: string;
	title: string;
	repoRoot: string;
	/** What was challenged, for the list: `feature/x vs main`, `PR #12`, `PRs #12–#16`, `a design document`. */
	subject: string;
	createdAt: number;
	status: "running" | "ready" | "failed";
	/** While running: the step in plain words. */
	progress?: string;
	/** When failed. */
	error?: string;
	/** The omp session writing the points, while running. */
	instanceId?: string;
	partCount?: number;
	pointCount?: number;
	runCount?: number;
	/** The latest run's standing, with whether every point of it is closed. */
	latest?: { held: number; asked: number; percentHeld: number; finished: boolean; at: number };
	/** Spent so far (writing and replies), USD. */
	costUsd?: number;
	/** The limit this spar was made with, USD. */
	maxCostUsd?: number;
	sessionId?: string;
}

/**
 * What to spar about: what {@link QuizCreate} names, a design document, or both (the document is the claim, the change
 * is what was built). At least one of a change (`ref`, `base`, `pr`, `stack`) or `doc` is required; `sessionId` only adds
 * the session's conversation as the why. A document alone is checked against the checked-out HEAD (a file of the
 * repository given without a `ref` is read from the files as they are).
 */
export interface SparCreate extends Partial<Pick<QuizCreate, "ref" | "base" | "pr" | "stack" | "sessionId">> {
	/** Any folder inside the repository. */
	cwd: string;
	/** Spend limit for the spar, writing and replies together, USD. */
	maxCostUsd?: number;
	/** The model that writes the points. */
	model?: string;
	/** The model of the replies: a role (`@default`) or a `provider/id`. Default `@default`. */
	replyModel?: string;
	/** A pasted design (`text`), or a file of the repository (`path`), read at `ref` or from the working tree for `@worktree`. */
	doc?: { text: string; name?: string } | { path: string };
}

export interface SparGetAnswer {
	spar: Spar;
	runs: SparRun[];
}

/**
 * Companion requests (sent in the companion room like the other `t`-tagged requests, answered by `reqId`). The
 * companion advertises `canSpar` in its hello when it supports them. `quiz-stack` finds the pull requests of a stack.
 *
 * - `spar-list` `{ cwd? }` → `{ spars }` (all repositories when `cwd` is omitted)
 * - `spar-create` `SparCreate` → `{ id }` (the spar appears in the list as `running`)
 * - `spar-get` `{ id }` → `{ spar, runs }`; a new spar has one empty run, and no case files
 * - `spar-reply` `{ id, run, point, text }` → `{ turn, record, run }`: your defence is answered by one model call that
 *   counts against the spar's limit. Refused when the point is closed, the text is empty or over
 *   {@link SPAR_MAX_REPLY_CHARS}, or the limit is used up.
 * - `spar-close` `{ id, run, point, as, note? }` → `{ record, run }`: concede the point yourself (`lost`) or accept the
 *   risk (`open`, also skipping). No model.
 * - `spar-again` `{ id, from?, only? }` → `{ run }`: a new run of every point (`all`) or those the latest run (or
 *   `from`) did not hold (`unsettled`, the default).
 * - `spar-excerpt` `{ id, part, refs }` → `{ excerpts }` (same order; `@design` refs are read from the stored document; a ref
 *   may carry `from`/`to`, see {@link BlueprintExcerptRef})
 * - `spar-delete` `{ id }` → `{}` (stops it first when running)
 *
 * The companion pushes `{ t: "spar-changed", id }` when a spar's summary changes (progress, done, failed, replied).
 */
export type SparRequest =
	| { t: "spar-list"; reqId: number; cwd?: string }
	| ({ t: "spar-create"; reqId: number } & SparCreate)
	| { t: "spar-get"; reqId: number; id: string }
	| { t: "spar-reply"; reqId: number; id: string; run: string; point: string; text: string }
	| { t: "spar-close"; reqId: number; id: string; run: string; point: string; as: "lost" | "open"; note?: string }
	| { t: "spar-again"; reqId: number; id: string; from?: string; only?: "all" | "unsettled" }
	| { t: "spar-excerpt"; reqId: number; id: string; part: number; refs: BlueprintExcerptRef[] }
	| { t: "spar-delete"; reqId: number; id: string };

/**
 * The result of a run, from its records alone (no model): points held, those still open, those with a suggestion.
 * A point with no outcome yet counts as asked and as neither held nor open.
 */
export function scoreSpar(run: Pick<SparRun, "points" | "records">): SparResult {
	const held: string[] = [];
	const open: string[] = [];
	const suggested: string[] = [];
	let credit = 0;
	for (const id of run.points) {
		const outcome = Object.hasOwn(run.records, id) ? run.records[id]!.outcome : undefined;
		if (outcome === undefined) continue;
		if (outcome.kind === "held") {
			held.push(id);
			credit += 1;
		} else if (outcome.kind === "partly") {
			open.push(id);
			suggested.push(id);
			credit += 0.5;
		} else if (outcome.kind === "open") {
			open.push(id);
		} else {
			suggested.push(id);
		}
	}
	const asked = run.points.length;
	return { held, open, suggested, percentHeld: asked === 0 ? 0 : Math.round((credit / asked) * 100) };
}
