/**
 * How the reviewer's verdict, the judge's answers and the measured facts combine into a ranking (docs/design-review.md,
 * *How the verdict and the scores combine*). Pure: no model calls, no I/O.
 *
 * Per metric `m` and entry `e` there are up to three numbers, each 0–1: `reviewer`, `judge` and `measured`.
 *
 *     metricScore = measured                      when the metric is measured and a measurement exists
 *                 = 0.7 × reviewer + 0.3 × judge  when both exist
 *                 = whichever exists              otherwise
 *     total(e)    = Σ weight × metricScore / Σ weight
 *
 * The reviewer leads: two entries whose totals differ by 0.15 or more are ordered by the reviewer's ranking, whatever
 * the judge said; inside the margin the order is by total.
 */

import {
	BAKEOFF_MARGIN,
	type BakeoffFacts,
	type BakeoffFinding,
	type BakeoffMetric,
	type BakeoffRanked,
	type BakeoffResult,
	type BakeoffScore,
	isMeasuredMetric,
} from "@oh-my-pi/pi-wire/bakeoff";

const REVIEWER_WEIGHT = 0.7;
/** A judge that contradicts itself on more than this share of its pairs carries no weight. */
export const JUDGE_MIN_CONSISTENCY = 0.5;

export interface JudgeInput {
	/** `[label][metric]`, 0–1. */
	scores: Record<string, Record<string, number>>;
	/** Share of pairwise answers that agreed across the swap, 0–1. */
	consistency: number;
}

export interface RankInput {
	metrics: readonly BakeoffMetric[];
	/** Entry labels. */
	labels: readonly string[];
	originalLabel: string;
	/** `[label][metric]`, 0–1, already averaged over passes. */
	reviewer: Record<string, Record<string, number>>;
	/** One ranking per reviewer pass, best first. */
	reviewerRankings: readonly (readonly string[])[];
	judge?: JudgeInput;
	facts: Record<string, BakeoffFacts | undefined>;
	hasBench: boolean;
	hasTestTarget: boolean;
	findings: readonly BakeoffFinding[];
	/** Flags of each entry, as the entry carries them. */
	flags: Record<string, readonly string[]>;
	/** Labels written by the reviewer's own model. */
	selfPreference: readonly string[];
}

export interface Combined {
	ranking: BakeoffRanked[];
	scores: Record<string, Record<string, BakeoffScore>>;
	agreement: BakeoffResult["agreement"];
	/** Plain words on why the result is split, when it is. */
	splitNote?: string;
	/** True when the judge was given no weight for contradicting itself. */
	judgeIgnored: boolean;
}

/** `value` scaled over `values` so the smallest is 1 and the largest 0 (smaller is better); 0.5 when they do not differ. */
function lowerIsBetter(value: number, values: readonly number[]): number {
	const low = Math.min(...values);
	const high = Math.max(...values);
	return high === low ? 0.5 : (high - value) / (high - low);
}

/** Per entry, what the facts alone say about a measured metric; entries without a measurement are absent. */
export function measuredScores(
	metric: BakeoffMetric,
	labels: readonly string[],
	facts: Readonly<Record<string, BakeoffFacts | undefined>>,
	hasBench: boolean,
): Record<string, number> {
	if (!isMeasuredMetric(metric, hasBench)) return {};
	const raw: Record<string, number> = {};
	let lowerBetter = true;
	for (const label of labels) {
		const entry = facts[label];
		if (!entry) continue;
		if (metric.id === "lines-changed") raw[label] = entry.added + entry.removed;
		else if (entry.bench && entry.bench.value !== null) {
			raw[label] = entry.bench.value;
			lowerBetter = entry.bench.better === "lower";
		}
	}
	const labelsWith = Object.keys(raw);
	// One measurement alone says nothing about a better or worse.
	if (labelsWith.length < 2) return {};
	const sign = lowerBetter ? 1 : -1;
	const values = labelsWith.map(label => sign * raw[label]!);
	return Object.fromEntries(labelsWith.map(label => [label, lowerIsBetter(sign * raw[label]!, values)]));
}

function totalOf(metrics: readonly BakeoffMetric[], score: (metric: BakeoffMetric) => number | undefined): number {
	let sum = 0;
	let weight = 0;
	for (const metric of metrics) {
		const value = score(metric);
		if (value === undefined) continue;
		sum += metric.weight * value;
		weight += metric.weight;
	}
	return weight === 0 ? 0 : sum / weight;
}

/** `rank-in-pass` summed over passes: lower is better. */
function reviewerOrder(rankings: readonly (readonly string[])[], labels: readonly string[]): string[] {
	const points = (label: string): number => rankings.reduce((sum, ranking) => sum + ranking.indexOf(label), 0);
	return [...labels].sort((a, b) => points(a) - points(b) || a.localeCompare(b));
}

function reasonsFor(
	label: string,
	metrics: readonly BakeoffMetric[],
	scores: Record<string, BakeoffScore>,
	findings: readonly BakeoffFinding[],
	facts: BakeoffFacts | undefined,
): string[] {
	const reasons: string[] = [];
	for (const [kind, noun] of [
		["strength", "Strength"],
		["weakness", "Weakness"],
	] as const) {
		for (const finding of findings.filter(f => f.label === label && f.kind === kind).slice(0, 2))
			reasons.push(`${noun}: ${finding.text}`);
	}
	for (const metric of metrics) {
		const score = scores[metric.id];
		if (!score) continue;
		const parts: string[] = [];
		if (score.reviewer !== undefined)
			parts.push(`reviewer ${(score.reviewer * 4 + 1).toFixed(1).replace(/\.0$/, "")}/5`);
		if (score.judge !== undefined) parts.push(`judge ${score.judge.toFixed(2)}`);
		if (score.measured !== undefined) parts.push(`measured ${score.measured.toFixed(2)}`);
		if (parts.length === 0) continue;
		const extra =
			metric.id === "lines-changed" && facts ? `, ${facts.files} files / ${facts.added + facts.removed} lines` : "";
		reasons.push(`${metric.label}: ${parts.join(", ")}${extra}`);
	}
	return reasons;
}

/** Combine the three sources into a ranking. */
export function combine(input: RankInput): Combined {
	const { metrics, labels } = input;
	const judgeIgnored = input.judge !== undefined && input.judge.consistency < JUDGE_MIN_CONSISTENCY;
	const judge = input.judge && !judgeIgnored ? input.judge : undefined;

	const measured: Record<string, Record<string, number>> = {};
	for (const metric of metrics) measured[metric.id] = measuredScores(metric, labels, input.facts, input.hasBench);

	const scores: Record<string, Record<string, BakeoffScore>> = {};
	for (const label of labels) {
		scores[label] = {};
		for (const metric of metrics) {
			const reviewer = input.reviewer[label]?.[metric.id];
			const judged = judge?.scores[label]?.[metric.id];
			const taken = measured[metric.id]?.[label];
			const score: BakeoffScore = {
				...(reviewer !== undefined ? { reviewer } : {}),
				...(judged !== undefined ? { judge: judged } : {}),
				...(taken !== undefined ? { measured: taken } : {}),
			};
			const combined =
				taken !== undefined
					? taken
					: reviewer !== undefined && judged !== undefined
						? REVIEWER_WEIGHT * reviewer + (1 - REVIEWER_WEIGHT) * judged
						: (reviewer ?? judged);
			if (combined !== undefined) score.combined = combined;
			scores[label]![metric.id] = score;
		}
	}
	const total = (label: string): number => totalOf(metrics, metric => scores[label]![metric.id]?.combined);

	const order = reviewerOrder(input.reviewerRankings, labels);
	const position = (label: string): number => order.indexOf(label);
	const sorted = [...labels].sort((a, b) => {
		const delta = total(b) - total(a);
		if (Math.abs(delta) >= BAKEOFF_MARGIN) return position(a) - position(b);
		return delta || position(a) - position(b);
	});

	const originalTests = input.facts[input.originalLabel]?.tests;
	const ranking = sorted.map((label, index): BakeoffRanked => {
		const facts = input.facts[label];
		const flags = [...(input.flags[label] ?? [])];
		const tests = facts?.tests;
		const eligible = !(
			input.hasTestTarget &&
			label !== input.originalLabel &&
			tests?.ok === false &&
			originalTests?.ok === true
		);
		return {
			label,
			rank: index + 1,
			score: total(label),
			reasons: reasonsFor(label, metrics, scores[label]!, input.findings, facts),
			eligible,
			flags,
		};
	});

	// Agreement: who the reviewer and the judge each put first.
	const reviewerTop = order[0];
	const passTops = new Set(input.reviewerRankings.map(ranking => ranking[0]));
	let agreement: Combined["agreement"] = "reviewer-only";
	let splitNote: string | undefined;
	if (judge) {
		const judgeTotal = (label: string): number => totalOf(metrics, metric => judge.scores[label]?.[metric.id]);
		const judgeTop = [...labels].sort((a, b) => judgeTotal(b) - judgeTotal(a) || a.localeCompare(b))[0];
		agreement = judgeTop === reviewerTop ? "agreed" : "split";
		if (agreement === "split")
			splitNote = `The reviewer put ${reviewerTop} first and the judge put ${judgeTop} first.`;
		if (input.selfPreference.includes(reviewerTop!) && judgeTop !== reviewerTop) {
			agreement = "split";
			splitNote = `The reviewer ranked ${reviewerTop} first, an entry written by its own model, and the judge did not.`;
		}
	}
	if (passTops.size > 1) {
		agreement = "split";
		splitNote = "The two reviewer passes did not agree on the first entry.";
	}
	return { ranking, scores, agreement, splitNote, judgeIgnored };
}

/** Share of a bake-off's pairwise answers that agreed across the swap. */
export function consistencyOf(pairs: readonly { consistent: boolean }[]): number {
	return pairs.length === 0 ? 1 : pairs.filter(pair => pair.consistent).length / pairs.length;
}
