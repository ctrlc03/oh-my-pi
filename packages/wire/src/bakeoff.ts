/**
 * "Design bake-off": several models each try to do better than a design or an implementation, in their own
 * worktrees (or as design documents), and a reviewer model you pick reads every entry, the original included, blind,
 * and writes a verdict with code citations. An optional cheap `judge`-role pass scores each metric and compares
 * entries in pairs. The result is a ranked list with reasons; *take this one* keeps that worktree.
 *
 * Entries are labelled `A` to `E` and the reviewer and judge never see which model wrote which entry, in what order
 * the entries were made, or branch names. The companion keeps `entries[].model` from the start and the app hides it
 * until *Show models*; the result is built from labels.
 *
 * Every argument and finding cites code as `path@line@token` (a {@link BlueprintRef}); the companion checks it
 * against the commit of the entry it belongs to before it is stored. In the reviewer's own text a citation carries
 * its entry: `A/path@line@token`.
 *
 * Shared by the companion (which runs, judges and stores bake-offs) and the web app (which starts and reads them).
 * Pure JSON shapes, plus the rules both sides use (presets, labels, budgets).
 */

import type { BlueprintExcerpt, BlueprintRef } from "./blueprint";
import type { QuizRef } from "./quiz";

/** Format version of the stored bake-off. */
export const BAKEOFF_VERSION = 1;
/** Challengers of one bake-off: the fan-out ceiling (`MAX_FANOUT_MODELS`). */
export const BAKEOFF_MAX_CHALLENGERS = 4;
export const BAKEOFF_MIN_CHALLENGERS = 2;
export const BAKEOFF_MAX_METRICS = 6;
export const BAKEOFF_MAX_CUSTOM_CHARS = 600;
export const BAKEOFF_MAX_INSTRUCTIONS_CHARS = 4_000;
/** Largest design document a bake-off takes as its input, characters. */
export const BAKEOFF_MAX_DOC_CHARS = 60_000;
/** Spend limit of a bake-off when the request names none, USD. */
export const BAKEOFF_DEFAULT_MAX_COST_USD = 12;
/** Entry labels, in the order they are drawn from: the original plus at most four challengers. */
export const BAKEOFF_LABELS = "ABCDE";
/** Characters of one entry the judge reads. */
export const BAKEOFF_JUDGE_DIGEST_CHARS = 6_000;
/** A total that differs by this much between two entries is a margin the judge cannot overturn. */
export const BAKEOFF_MARGIN = 0.15;

export type BakeoffMode = "design" | "implementation";
export type BakeoffPreset = "simplicity" | "performance" | "fewer-parts" | "migration-risk" | "lines-changed";

/** A thing that matters to the person: a preset, or their own words (`custom:1`, `custom:2`, …). */
export interface BakeoffMetric {
	id: BakeoffPreset | `custom:${number}`;
	label: string;
	/** Custom metrics: the person's own words, shown verbatim to the reviewer and the judge. */
	text?: string;
	weight: 1 | 2 | 3;
}

/** The presets the form offers. `measured` ones can be computed from facts; `implementationOnly` ones make no sense for a design. */
export const BAKEOFF_PRESETS: readonly { id: BakeoffPreset; label: string; hint: string; implementationOnly?: true }[] =
	[
		{ id: "simplicity", label: "Simplicity", hint: "Easy to read, few special cases" },
		{ id: "performance", label: "Performance", hint: "Fast and light on resources" },
		{ id: "fewer-parts", label: "Fewer moving parts", hint: "Fewer new files, services and settings" },
		{ id: "migration-risk", label: "Migration risk", hint: "Safe to roll out and to roll back" },
		{ id: "lines-changed", label: "Lines changed", hint: "A smaller diff", implementationOnly: true },
	];

export type BakeoffJudgeState = "native" | "local" | "endpoint" | "fallback" | "none";

/** What the second opinion would use, and whether it answered a one-question probe. */
export interface BakeoffJudgeInfo {
	state: BakeoffJudgeState;
	/** `provider/id` of the model the `judge` role resolves to first. */
	label?: string;
	/** Whether it answered the probe; absent for `none`. */
	reachable?: boolean;
	/** Why it did not answer, or why it is off, in plain words. */
	reason?: string;
	/** `fallback` only: what the chain would use costs, per million tokens. */
	price?: string;
}

export interface BakeoffCreate {
	/** Any folder inside the repository. */
	cwd: string;
	/** The original, named as a quiz names what it is about (`QuizCreate`): one part. */
	ref?: string;
	base?: string;
	pr?: number;
	sessionId?: string;
	/** Design mode, or the claim an implementation answers. A pasted text, or a file of the repository. */
	doc?: { text: string; name?: string } | { path: string };
	mode: BakeoffMode;
	/** Free text added to every challenger's brief. */
	instructions?: string;
	metrics: BakeoffMetric[];
	/** 2–4 model selectors, as `FanoutRequest.models`. */
	models: string[];
	/** Selector of the model that reads everything blind and writes the verdict. */
	reviewer: string;
	/** 2 runs the reviewer again with the reverse presentation order and new labels. Default 1. */
	reviewerPasses?: 1 | 2;
	/**
	 * Selector or role (default `@default`) of the model that summarises entries in the one template: every entry in
	 * implementation mode, the original only in design mode (the designers write their own).
	 */
	writer?: string;
	/** `auto` (default) uses the judge model when there is a usable one. */
	judge?: "auto" | "off";
	/** Use a judge that nobody assigned (the role fell through to a general model), pairwise only, labelled advisory. */
	judgeAdvisory?: boolean;
	/** Implementation mode: where challengers start (default `original`). */
	start?: "original" | "base";
	/** The problem to solve when challengers start from the base and nothing else states it. */
	goal?: string;
	/** A run target id and the body the person confirmed. */
	test?: { target: string; detail?: string };
	bench?: { target: string; detail?: string; better: "lower" | "higher"; valueRegex?: string };
	sandboxed?: boolean;
	maxCostUsd?: number;
}

export type BakeoffEntryStatus = "waiting" | "working" | "writing-up" | "ready" | "failed" | "stopped";

/** The template both the designers and the writer fill, so format does not identify authorship. */
export interface BakeoffWriteup {
	summary: string;
	/** Markdown, up to six short paragraphs. */
	approach: string;
	tradeoffs: string[];
	risks: string[];
	migration: string;
	/** A line of evidence per metric the person chose, by metric id. */
	metrics: Record<string, string>;
	/** A mermaid block, optional. */
	diagram?: string;
	/** Verified against the entry's commit. */
	refs: QuizRef[];
}

export interface BakeoffFacts {
	/** Against the original's merge base: the same figures the compare sheet shows. */
	files: number;
	added: number;
	removed: number;
	/** `start: "original"` only. */
	deltaFromOriginal?: { files: number; added: number; removed: number };
	tests?: { target: string; ok: boolean | null; reason?: string; note?: string };
	bench?: {
		target: string;
		better: "lower" | "higher";
		runs: number[];
		value: number | null;
		unit?: string;
		reason?: string;
	};
}

/** What the device sees of an entry. `label` is the key; `model` is always present and the app hides it until *Show models*. */
export interface BakeoffEntry {
	/** `A`..`E`, assigned at creation, shuffled with the bake-off id as seed. */
	label: string;
	kind: "original" | "challenger";
	/** Challengers. */
	model?: string;
	status: BakeoffEntryStatus;
	/** Implementation mode. */
	instanceId?: string;
	branch?: string;
	path?: string;
	writeup?: BakeoffWriteup;
	facts?: BakeoffFacts;
	/** `test script changed`, `hit its spending limit`, `no write-up`, … */
	flags: string[];
	costUsd?: number;
	error?: string;
}

export type BakeoffStage = "preparing" | "entries" | "facts" | "writeups" | "review" | "judge" | "done";

export interface BakeoffFinding {
	label: string;
	kind: "strength" | "weakness";
	text: string;
	refs?: QuizRef[];
	/** False when none of its citations survived: shown dimmed ("not checked against code"). */
	verified: boolean;
}

export interface BakeoffRanked {
	label: string;
	rank: number;
	/** 0–1: the weighted total of the metric scores. */
	score: number;
	reasons: string[];
	/** False when the tests failed while the original passes: *take this one* needs one more tap. */
	eligible: boolean;
	flags: string[];
}

export interface BakeoffPair {
	a: string;
	b: string;
	metric: string;
	winner: string | "tie";
	/** False when the two orders disagreed; counts as a tie. */
	consistent: boolean;
}

export interface BakeoffScore {
	/** The reviewer's 1–5 score, normalised to 0–1. */
	reviewer?: number;
	judge?: number;
	measured?: number;
	/** What the combination rule made of them (0–1). */
	combined?: number;
}

export interface BakeoffVerdictPass {
	/** The reviewer's ranking, best first, as labels. */
	ranking: string[];
	/** The reviewer's markdown, with citations written `A/path@line@token`. */
	verdict: string;
}

export interface BakeoffResult {
	ranking: BakeoffRanked[];
	/** The reviewer's markdown, with citations written `A/path@line@token`. */
	verdict: string;
	findings: BakeoffFinding[];
	/** `[label][metricId]` */
	scores: Record<string, Record<string, BakeoffScore>>;
	pairwise?: BakeoffPair[];
	agreement: "agreed" | "split" | "reviewer-only" | "judge-only";
	reviewerModel: string;
	/** Reads "prompted judge: <label>" etc.; absent when no judge ran. */
	judgeLabel?: string;
	judgeKind?: BakeoffJudgeState;
	/** Share of the judge's pairwise answers that agreed across the swap (0–1); absent without a judge. */
	consistency?: number;
	/** True when the judge contradicted itself on most pairs: its scores carry no weight. */
	judgeIgnored?: boolean;
	/** Why there is no second opinion ("No second opinion: <label> was unreachable (<reason>)"). */
	judgeNote?: string;
	/** Plain words on why the reviewer and the judge disagree, when `agreement` is `split`. */
	splitNote?: string;
	/** Labels written by the reviewer's own model. */
	selfPreference: string[];
	/** Both reviewer passes, when two were run. */
	passes?: BakeoffVerdictPass[];
	/** What the reviewer could not determine. */
	unsure: string[];
	/** The label of the entry the person took. */
	taken?: string;
}

export interface Bakeoff {
	v: typeof BAKEOFF_VERSION;
	id: string;
	title: string;
	repo: { root: string; name: string; github?: string };
	createdAt: number;
	mode: BakeoffMode;
	start?: "original" | "base";
	metrics: BakeoffMetric[];
	/** Free text the person added to every challenger's brief, shown as given. */
	instructions?: string;
	entries: BakeoffEntry[];
	stage: BakeoffStage;
	/** Implementation mode: the fan-out group holding the worktrees and sessions. */
	group?: string;
	result?: BakeoffResult;
	warnings: string[];
	/** Selectors of the reviewer, the writer and the judge-use choice. */
	reviewer: string;
	writer: string;
	judge: "auto" | "off";
	/** What each stage has cost so far, USD. */
	costs: { entries: number; writeups: number; review: number; judge: number };
}

/** One row of the bake-off list. */
export interface BakeoffSummary {
	id: string;
	title: string;
	repoRoot: string;
	/** What was bake-offed, for the list: `feature/x vs main`, `PR #12`, `a design`. */
	subject: string;
	createdAt: number;
	status: "running" | "ready" | "failed";
	progress?: string;
	error?: string;
	instanceId?: string;
	mode?: BakeoffMode;
	stage?: BakeoffStage;
	entryCount?: number;
	/** The label ranked first, once there is a result. */
	top?: string;
	/** The label taken. */
	taken?: string;
	/** `No second opinion: …`, shown in the list row. */
	note?: string;
	costUsd?: number;
	maxCostUsd?: number;
}

export type BakeoffRequest =
	| { t: "bakeoff-list"; reqId: number; cwd?: string }
	| { t: "bakeoff-judge"; reqId: number; cwd?: string }
	| ({ t: "bakeoff-create"; reqId: number } & BakeoffCreate)
	| { t: "bakeoff-get"; reqId: number; id: string }
	| { t: "bakeoff-excerpt"; reqId: number; id: string; entry: string; refs: BlueprintRef[] }
	| { t: "bakeoff-stop"; reqId: number; id: string; entry?: string }
	| { t: "bakeoff-take"; reqId: number; id: string; entry: string; removeOthers?: boolean; discardDirty?: boolean }
	| { t: "bakeoff-delete"; reqId: number; id: string }
	/** Run the review and the judge again on the entries of a bake-off whose review or judge pass failed. */
	| { t: "bakeoff-review"; reqId: number; id: string };

/** What a `bakeoff-take` of an implementation answers: what the keep did to the other worktrees. */
export interface BakeoffTakeResult {
	removed: string[];
	skipped: { model: string; reason: string }[];
}

export type BakeoffReply =
	| { t: "bakeoff-list"; reqId: number; bakeoffs: BakeoffSummary[] }
	| { t: "bakeoff-judge"; reqId: number; judge: BakeoffJudgeInfo }
	| { t: "bakeoff-create"; reqId: number; id: string }
	| { t: "bakeoff-get"; reqId: number; bakeoff: Bakeoff }
	| { t: "bakeoff-excerpt"; reqId: number; excerpts: (BlueprintExcerpt | null)[] }
	| { t: "bakeoff-stop"; reqId: number }
	| { t: "bakeoff-take"; reqId: number; result?: BakeoffTakeResult }
	| { t: "bakeoff-delete"; reqId: number }
	| { t: "bakeoff-review"; reqId: number }
	/** Pushed to every authenticated device when a bake-off's summary changes; carries no `reqId`. */
	| { t: "bakeoff-changed"; id: string };

/** A metric computed from facts alone; `performance` becomes one only when a benchmark was given. */
export function isMeasuredMetric(metric: BakeoffMetric, hasBench: boolean): boolean {
	return metric.id === "lines-changed" || (metric.id === "performance" && hasBench);
}

/**
 * Of a limit, what each stage may spend, in whole cents rounded down: reviewer 25%, judge 2%, reserve 8%, and the rest
 * shared by the challengers and the writer. The writer summarises every entry in implementation mode (challengers 45%,
 * writers 20%) but only the original in design mode, whose designers write their own (55% / 10%).
 */
export function splitBakeoffBudget(
	totalUsd: number,
	mode: BakeoffMode,
): { challengers: number; writers: number; reviewer: number; judge: number; reserve: number } {
	const cents = (share: number): number => Math.floor(totalUsd * share * 100) / 100;
	return {
		challengers: cents(mode === "design" ? 0.55 : 0.45),
		writers: cents(mode === "design" ? 0.1 : 0.2),
		reviewer: cents(0.25),
		judge: cents(0.02),
		reserve: cents(0.08),
	};
}
