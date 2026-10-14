/**
 * What the bake-off sheet's list and form decide, with no React: how the form's values become a request and what is
 * wrong with them, how the judge model is described, which models a mode can use, a rough cost, and the rows of the list.
 */

import {
	BAKEOFF_DEFAULT_MAX_COST_USD,
	BAKEOFF_MAX_CHALLENGERS,
	BAKEOFF_MAX_CUSTOM_CHARS,
	BAKEOFF_MAX_DOC_CHARS,
	BAKEOFF_MAX_INSTRUCTIONS_CHARS,
	BAKEOFF_MAX_METRICS,
	BAKEOFF_MIN_CHALLENGERS,
	BAKEOFF_PRESETS,
	type BakeoffCreate,
	type BakeoffJudgeInfo,
	type BakeoffMetric,
	type BakeoffMode,
	type BakeoffPreset,
	type BakeoffSummary,
} from "@oh-my-pi/pi-wire/bakeoff";
import { parseForeignSelector } from "../../lib/fanout";
import { fmtCost } from "../../lib/format";
import { parseLimit } from "../quiz/quiz-flow";
import type { BakeoffDocInput, BakeoffSubject } from "./bakeoff-types";

/** The largest spending limit the companion takes, USD. */
export const BAKEOFF_MAX_COST_USD = 100;
/** The longest statement of a goal the companion takes, characters. */
export const BAKEOFF_MAX_GOAL_CHARS = 2_000;
/** The longest pattern for a benchmark's number the companion takes, characters. */
export const BAKEOFF_MAX_REGEX_CHARS = 200;
/** The limit field's starting text. */
export const DEFAULT_LIMIT = String(BAKEOFF_DEFAULT_MAX_COST_USD);

// ── what matters ─────────────────────────────────────────────────────────────

/** The weights a person's marks make: the starred one counts most, what they wrote counts above a preset. */
const WEIGHT_STARRED = 3;
const WEIGHT_CUSTOM = 2;
const WEIGHT_PRESET = 1;

/** What the "What matters" part of the form holds. */
export interface MetricPick {
	/** The ticked presets. */
	presets: readonly BakeoffPreset[];
	/** What the person wrote, one entry per thing, in the order added. */
	customs: readonly string[];
	/** The one that matters most: a preset id, or `custom:N` (N counts from 1 in `customs`); null: none starred. */
	starred: string | null;
}

/** The id the nth (0-based) custom metric has. */
export function customId(index: number): `custom:${number}` {
	return `custom:${index + 1}`;
}

/** A short name for a custom metric: the start of what was written. */
export function customLabel(text: string): string {
	const line = text.trim().replace(/\s+/g, " ");
	return line.length <= 40 ? line : `${line.slice(0, 39)}…`;
}

/** The presets a mode offers: a design has no diff to count lines of. */
export function presetsFor(mode: BakeoffMode): readonly (typeof BAKEOFF_PRESETS)[number][] {
	return BAKEOFF_PRESETS.filter(preset => mode === "implementation" || preset.implementationOnly !== true);
}

/** `pick` with what `mode` cannot use taken out (a star on a dropped preset goes with it). */
export function pickForMode(pick: MetricPick, mode: BakeoffMode): MetricPick {
	const offered = presetsFor(mode).map(preset => preset.id);
	const presets = pick.presets.filter(id => offered.includes(id));
	const { starred } = pick;
	const keep = starred === null || starred.startsWith("custom:") || offered.includes(starred as BakeoffPreset);
	return { ...pick, presets, starred: keep ? starred : null };
}

/** The pick after a preset is ticked or unticked; unticking the starred one clears the star. */
export function togglePreset(pick: MetricPick, id: BakeoffPreset): MetricPick {
	if (pick.presets.includes(id))
		return {
			...pick,
			presets: pick.presets.filter(item => item !== id),
			starred: pick.starred === id ? null : pick.starred,
		};
	return { ...pick, presets: [...pick.presets, id] };
}

/** The pick after the star moves to `key` (or leaves it, when it was there). */
export function toggleStar(pick: MetricPick, key: string): MetricPick {
	return { ...pick, starred: pick.starred === key ? null : key };
}

/** The pick with `text` added as a custom metric; unchanged for empty text. */
export function addCustom(pick: MetricPick, text: string): MetricPick {
	const trimmed = text.trim();
	return trimmed === "" ? pick : { ...pick, customs: [...pick.customs, trimmed] };
}

/** The pick without the custom metric at `index`; the ones after it renumber, and so does a star on one of them. */
export function removeCustom(pick: MetricPick, index: number): MetricPick {
	const customs = pick.customs.filter((_, at) => at !== index);
	let { starred } = pick;
	if (starred?.startsWith("custom:")) {
		const at = Number(starred.slice("custom:".length)) - 1;
		if (at === index) starred = null;
		else if (at > index) starred = customId(at - 1);
	}
	return { ...pick, customs, starred };
}

/** How many things matter, ticked and written. */
export function metricCount(pick: MetricPick): number {
	return pick.presets.length + pick.customs.length;
}

/** The metrics of a pick, presets first (in the form's order) then the person's own, with the weights their marks make. */
export function buildMetrics(pick: MetricPick): BakeoffMetric[] {
	const out: BakeoffMetric[] = [];
	for (const preset of BAKEOFF_PRESETS) {
		if (!pick.presets.includes(preset.id)) continue;
		out.push({
			id: preset.id,
			label: preset.label,
			weight: pick.starred === preset.id ? WEIGHT_STARRED : WEIGHT_PRESET,
		});
	}
	pick.customs.forEach((raw, at) => {
		const text = raw.trim();
		const id = customId(at);
		out.push({ id, label: customLabel(text), text, weight: pick.starred === id ? WEIGHT_STARRED : WEIGHT_CUSTOM });
	});
	return out;
}

// ── models ───────────────────────────────────────────────────────────────────

/** Whether a selector names a model a vendor's agent runs (it can write code, but cannot be kept blind and read-only). */
export function isForeignSelector(selector: string): boolean {
	return parseForeignSelector(selector) !== null;
}

/** The selectors a design bake-off can use: omp's own models only. */
export function withoutForeign(selectors: readonly string[]): string[] {
	return selectors.filter(selector => !isForeignSelector(selector));
}

export interface ModelPrice {
	input: number;
	output: number;
}

/**
 * A rough guess of what the challengers and the reviewer cost, USD, from the models' prices per million tokens; null
 * when a price is missing. The token counts are assumptions, not measurements: an entry reads the code and writes a
 * document (design) or works for a while in a worktree (implementation), and the reviewer reads every entry.
 */
export function estimateBakeoffCost(args: {
	mode: BakeoffMode;
	challengers: readonly (ModelPrice | undefined)[];
	reviewer: ModelPrice | undefined;
}): number | null {
	const { mode, challengers, reviewer } = args;
	if (challengers.length === 0 || reviewer === undefined) return null;
	const design = mode === "design";
	const perChallenger = design ? { input: 150_000, output: 12_000 } : { input: 800_000, output: 60_000 };
	const perEntryRead = design ? 25_000 : 40_000;
	const cost = (price: ModelPrice, input: number, output: number): number =>
		(price.input * input + price.output * output) / 1_000_000;
	let total = 0;
	for (const price of challengers) {
		if (price === undefined) return null;
		total += cost(price, perChallenger.input, perChallenger.output);
	}
	total += cost(reviewer, perEntryRead * (challengers.length + 1), 8_000);
	return total;
}

/** The estimate as one plain sentence; null when there is none. */
export function estimateText(estimate: number | null, limit: number | null): string | null {
	if (estimate === null) return null;
	const guess = estimate < 0.01 ? "under 1 cent" : `about ${fmtCost(estimate)}`;
	const stop = limit === null ? "" : ` It stops at your limit of ${fmtCost(limit)}.`;
	return `A rough guess: ${guess} for the models you picked.${stop}`;
}

// ── the second opinion ───────────────────────────────────────────────────────

/** How the form describes the judge model, from what the companion answered. */
export type JudgeView =
	| { kind: "checking" }
	/** A judge somebody assigned that answered: on by default. */
	| { kind: "usable"; label: string }
	| { kind: "unreachable"; message: string }
	/** Nothing was assigned: off by default; can be used as advice. */
	| { kind: "fallback"; label: string | null; price: string | null }
	| { kind: "none"; message: string };

const NO_JUDGE = "No judge model is set. The reviewer will decide alone.";

/** `info` (null while the companion has not answered) as what the form shows. */
export function judgeView(info: BakeoffJudgeInfo | null): JudgeView {
	if (info === null) return { kind: "checking" };
	if (info.state === "none") return { kind: "none", message: NO_JUDGE };
	const label = info.label ?? "the judge model";
	if (info.reachable === false) {
		const reason =
			info.reason === undefined || info.reason.trim() === "" ? "no reason was given" : info.reason.trim();
		return { kind: "unreachable", message: `The judge model ${label} did not answer: ${reason}` };
	}
	if (info.state === "fallback") return { kind: "fallback", label: info.label ?? null, price: info.price ?? null };
	return { kind: "usable", label };
}

/** The judge toggle's value before the person touches it: on only for a judge that is assigned and answered. */
export function judgeOnByDefault(view: JudgeView): boolean {
	return view.kind === "usable";
}

/** What the request says about the judge: used, off, or used as advice (the role fell through to a general model). */
export function judgeChoice(
	view: JudgeView,
	use: boolean,
	advisory: boolean,
): Pick<BakeoffCreate, "judge" | "judgeAdvisory"> {
	if (view.kind === "usable") return { judge: use ? "auto" : "off" };
	if (view.kind === "fallback" && advisory) return { judge: "auto", judgeAdvisory: true };
	return { judge: "off" };
}

// ── the form ─────────────────────────────────────────────────────────────────

/** A test or benchmark target the person picked, with the body they saw. */
export interface TargetChoice {
	/** `RunTarget.id`. */
	target: string;
	detail?: string;
}

export interface BenchChoice extends TargetChoice {
	better: "lower" | "higher";
	/** A pattern for the number the benchmark prints, as typed; empty: the run's time. */
	valueRegex: string;
}

export interface BakeoffFormValues {
	/** Any folder of the repository. */
	cwd: string;
	subject: BakeoffSubject;
	/** The session whose conversation may be read; null: none to offer. */
	sessionId: string | null;
	/** The checkbox "Include why it was done". */
	useConversation: boolean;
	/** The design document, when one is given (alone, or attached to a change as what it should do). */
	doc: BakeoffDocInput | null;
	mode: BakeoffMode;
	/** Implementation only. */
	start: "original" | "base";
	/** The goal as typed; used when starting from the base. */
	goal: string;
	metrics: MetricPick;
	/** The extra instructions as typed. */
	instructions: string;
	/** Selectors of the challengers. */
	models: readonly string[];
	/** Selector of the reviewer; empty: none picked. */
	reviewer: string;
	judge: JudgeView;
	/** The judge toggle; null: not touched, so the default for `judge`. */
	judgeUse: boolean | null;
	/** The "Use it anyway (advisory)" checkbox. */
	judgeAdvisory: boolean;
	/** Implementation only. */
	test: TargetChoice | null;
	bench: BenchChoice | null;
	/** The spending-limit field as typed. */
	limit: string;
}

/** Whether the subject and the person's choices already say what the challengers should solve. */
export function statesGoal(
	values: Pick<BakeoffFormValues, "subject" | "doc" | "sessionId" | "useConversation">,
): boolean {
	if (values.doc !== null) return true;
	if (values.subject.kind === "pr") return true;
	return values.subject.kind === "changes" && values.sessionId !== null && values.useConversation;
}

/** Why a path cannot be a file of the repository, in plain words; null when it can. */
function pathProblem(path: string): string | null {
	if (path === "") return "Name the file of the design.";
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes(".."))
		return "The design's file must be inside the repository: give its path from the repository's root.";
	return null;
}

/** What is wrong with the form's values, in plain words, in the order the form shows its parts. Empty when nothing is. */
export function validateBakeoff(values: BakeoffFormValues): string[] {
	const problems: string[] = [];
	const { subject, doc, mode } = values;
	if (values.cwd === "") problems.push("There is no repository to compare in.");
	if (subject.kind === "branch" && subject.name.trim() === "") problems.push("Pick a branch.");
	if (subject.kind === "doc" && doc === null) problems.push("Add the design: paste it or name a file.");
	if (doc !== null) {
		if (doc.source === "file") {
			const problem = pathProblem(doc.path.trim());
			if (problem !== null) problems.push(problem);
		} else if (doc.text.trim() === "") problems.push("The design is empty.");
		else if (doc.text.trim().length > BAKEOFF_MAX_DOC_CHARS)
			problems.push(`The design is longer than ${BAKEOFF_MAX_DOC_CHARS.toLocaleString("en-US")} characters.`);
	}
	if (mode === "implementation" && subject.kind === "doc")
		problems.push(
			"An implementation needs a change to start from: pick this session's changes, a branch or a pull request.",
		);

	const count = metricCount(values.metrics);
	if (count < 1) problems.push("Pick at least one thing that matters.");
	if (count > BAKEOFF_MAX_METRICS) problems.push(`Pick at most ${BAKEOFF_MAX_METRICS} things that matter.`);
	if (values.metrics.customs.some(text => text.trim().length > BAKEOFF_MAX_CUSTOM_CHARS))
		problems.push(`What you write about what matters is at most ${BAKEOFF_MAX_CUSTOM_CHARS} characters each.`);
	if (values.instructions.trim().length > BAKEOFF_MAX_INSTRUCTIONS_CHARS)
		problems.push(
			`The extra instructions are at most ${BAKEOFF_MAX_INSTRUCTIONS_CHARS.toLocaleString("en-US")} characters.`,
		);

	if (values.models.length < BAKEOFF_MIN_CHALLENGERS || values.models.length > BAKEOFF_MAX_CHALLENGERS)
		problems.push(`Pick ${BAKEOFF_MIN_CHALLENGERS} to ${BAKEOFF_MAX_CHALLENGERS} challengers.`);
	else if (mode === "design" && values.models.some(isForeignSelector))
		problems.push(
			"A design is written by omp's own models: drop the other vendors' agents, or compare implementations.",
		);
	if (values.reviewer === "") problems.push("Pick the reviewer.");
	else if (isForeignSelector(values.reviewer))
		problems.push("The reviewer must be one of omp's own models: another vendor's agent cannot read blind.");

	if (mode === "implementation" && values.start === "base") {
		const goal = values.goal.trim();
		if (goal.length > BAKEOFF_MAX_GOAL_CHARS)
			problems.push(`The goal is at most ${BAKEOFF_MAX_GOAL_CHARS.toLocaleString("en-US")} characters.`);
		else if (goal === "" && !statesGoal(values) && subject.kind !== "doc")
			problems.push("Starting fresh needs the goal: say what it should solve.");
	}
	if (mode === "implementation" && values.bench !== null) {
		const pattern = values.bench.valueRegex.trim();
		if (pattern.length > BAKEOFF_MAX_REGEX_CHARS)
			problems.push(`The benchmark's pattern is at most ${BAKEOFF_MAX_REGEX_CHARS} characters.`);
		else if (pattern !== "") {
			try {
				new RegExp(pattern);
			} catch {
				problems.push("The benchmark's pattern is not a valid regular expression.");
			}
		}
	}

	const limit = parseLimit(values.limit);
	if (limit === null) problems.push("The spending limit must be more than $0.");
	else if (limit > BAKEOFF_MAX_COST_USD) problems.push(`The spending limit is at most $${BAKEOFF_MAX_COST_USD}.`);
	return problems;
}

/** The request the form's values make, or the first thing wrong with them. */
export function buildBakeoffCreate(values: BakeoffFormValues): { request: BakeoffCreate } | { error: string } {
	const [problem] = validateBakeoff(values);
	if (problem !== undefined) return { error: problem };
	const maxCostUsd = parseLimit(values.limit)!;
	const { subject, mode } = values;
	const request: BakeoffCreate = {
		cwd: values.cwd,
		mode,
		metrics: buildMetrics(values.metrics),
		models: [...values.models],
		reviewer: values.reviewer,
		...judgeChoice(values.judge, values.judgeUse ?? judgeOnByDefault(values.judge), values.judgeAdvisory),
		maxCostUsd,
	};
	const instructions = values.instructions.trim();
	if (instructions !== "") request.instructions = instructions;

	const { doc } = values;
	if (doc !== null) {
		if (doc.source === "file") request.doc = { path: doc.path.trim() };
		else {
			const name = doc.name.trim();
			request.doc = { text: doc.text.trim(), ...(name === "" ? {} : { name }) };
		}
	}
	if (subject.kind === "changes") {
		request.ref = "@worktree";
		request.base = "@default";
		if (values.useConversation && values.sessionId !== null) request.sessionId = values.sessionId;
	} else if (subject.kind === "branch") {
		request.ref = subject.name.trim();
		request.base = "@default";
	} else if (subject.kind === "pr") {
		request.pr = subject.number;
	} else if (values.useConversation && values.sessionId !== null) {
		// A design alone, written in a session: the conversation says why.
		request.sessionId = values.sessionId;
	}

	if (mode === "implementation") {
		request.start = values.start;
		const goal = values.goal.trim();
		if (values.start === "base" && goal !== "") request.goal = goal;
		if (values.test !== null) {
			const { target, detail } = values.test;
			request.test = { target, ...(detail === undefined ? {} : { detail }) };
		}
		if (values.bench !== null) {
			const { target, detail, better, valueRegex } = values.bench;
			const pattern = valueRegex.trim();
			request.bench = {
				target,
				...(detail === undefined ? {} : { detail }),
				better,
				...(pattern === "" ? {} : { valueRegex: pattern }),
			};
		}
	}
	return { request };
}

/** What a stage of the limit comes to, for the one-line preview under the limit field; null for a limit that cannot be used. */
export function limitPreview(
	limit: string,
	split: { challengers: number; writers: number; reviewer: number; judge: number; reserve: number },
): string | null {
	const value = parseLimit(limit);
	if (value === null || value > BAKEOFF_MAX_COST_USD) return null;
	return `Challengers ${fmtCost(split.challengers)}, write-ups ${fmtCost(split.writers)}, reviewer ${fmtCost(split.reviewer)}, second opinion ${fmtCost(split.judge)}, spare ${fmtCost(split.reserve)}.`;
}

// ── the list ─────────────────────────────────────────────────────────────────

export type RowStatus =
	| { kind: "running"; text: string }
	| { kind: "failed"; text: string }
	| { kind: "ready"; text: string };

/** What a row says about how the bake-off stands. */
export function rowStatus(bakeoff: BakeoffSummary): RowStatus {
	if (bakeoff.status === "running") return { kind: "running", text: bakeoff.progress ?? "Starting" };
	if (bakeoff.status === "failed") return { kind: "failed", text: bakeoff.error ?? "The bake-off could not be run." };
	return { kind: "ready", text: "Ready" };
}

/** `Design` or `Implementation`; null when the row does not say. */
export function modeWord(mode: BakeoffMode | undefined): string | null {
	if (mode === undefined) return null;
	return mode === "design" ? "Design" : "Implementation";
}

/** `3 entries`; null when the row does not say. */
export function entryCountText(count: number | undefined): string | null {
	if (count === undefined) return null;
	return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/** `You took B`, else `A ranked first` once there is a result; null before. */
export function rankText(bakeoff: BakeoffSummary): string | null {
	if (bakeoff.taken !== undefined) return `You took ${bakeoff.taken}`;
	if (bakeoff.top !== undefined) return `${bakeoff.top} ranked first`;
	return null;
}

/** `$1.20 of $12.00`, `$1.20`, `Limit $12.00` or null, from what the row knows. */
export function costText(bakeoff: BakeoffSummary): string | null {
	if (bakeoff.costUsd === undefined)
		return bakeoff.maxCostUsd === undefined ? null : `Limit ${fmtCost(bakeoff.maxCostUsd)}`;
	return bakeoff.maxCostUsd === undefined
		? fmtCost(bakeoff.costUsd)
		: `${fmtCost(bakeoff.costUsd)} of ${fmtCost(bakeoff.maxCostUsd)}`;
}

/** `/a/b/repo` → `repo`. */
export function repoName(root: string): string {
	return root.replace(/\/+$/, "").split("/").pop() || root;
}

/** The rows grouped by repository, the groups ordered by their newest bake-off, each group newest first. */
export function groupByRepo(
	bakeoffs: readonly BakeoffSummary[],
): { repoRoot: string; name: string; bakeoffs: BakeoffSummary[] }[] {
	const groups = new Map<string, BakeoffSummary[]>();
	for (const bakeoff of [...bakeoffs].sort((a, b) => b.createdAt - a.createdAt)) {
		const group = groups.get(bakeoff.repoRoot);
		if (group === undefined) groups.set(bakeoff.repoRoot, [bakeoff]);
		else group.push(bakeoff);
	}
	return [...groups].map(([repoRoot, items]) => ({ repoRoot, name: repoName(repoRoot), bakeoffs: items }));
}
