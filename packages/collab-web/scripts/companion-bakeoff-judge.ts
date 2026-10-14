/**
 * The cheap second opinion of a bake-off (docs/design-review.md, *Judge role*): the `judge` model role, called in
 * process, answers typed questions about each entry's digest. It never reads code. Per metric there is a `score`
 * question for each entry (a native judge only: the other kinds' scores are ordinal at best) and a `choice` question for
 * each pair of entries, asked twice with the entries swapped; only answers that agree across the swap count.
 *
 * The companion never falls back to the reviewer model or to a challenger for judging: when the judge is
 * unreachable the result is reviewer-only and says so.
 */

import {
	BAKEOFF_JUDGE_DIGEST_CHARS,
	type BakeoffJudgeInfo,
	type BakeoffMetric,
	type BakeoffPair,
} from "@oh-my-pi/pi-wire/bakeoff";
import { definitionOf } from "./companion-bakeoff-metrics";

/** A question as `@oh-my-pi/pi-ai` types it; only what this module asks. */
export type JudgeQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: readonly [string, string, ...string[]] }
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

/** An answer; the fields this module reads. */
export interface JudgeAnswer {
	type: "choice" | "score" | "noul";
	choice?: string;
	score?: number;
	noul?: number;
}

/** The part of `ChainJudge` the bake-off calls; tests replace it with a script. */
export interface JudgeLike {
	judge(
		request: { state: unknown; questions: Record<string, JudgeQuestion> },
		options?: { signal?: AbortSignal },
	): Promise<{ answers: Record<string, JudgeAnswer> }>;
}

/** What opening the standalone judge tells: the role's first candidate. */
export interface JudgeDescribed {
	kind: "native" | "local" | "online";
	explicit: boolean;
	label: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_QUESTION: JudgeQuestion = {
	type: "noul",
	instructions: "Is the sentence true?",
	criteria: { true: "the sentence is true", false: "the sentence is false" },
};
const PROBE_STATE = "Water is wet.";

/** The reason an error gives, in one short line. */
export function reasonOf(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err);
	return text
		.replace(/^judgment:\s*/i, "")
		.split("\n")[0]!
		.slice(0, 200);
}

/** One throw-away judgment (a yes/no on a fixed sentence, 5-second timeout): the judge answers, or it does not. */
export async function probeJudge(judge: JudgeLike): Promise<{ reachable: boolean; reason?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("it did not answer within 5 seconds")), PROBE_TIMEOUT_MS);
	try {
		const result = await judge.judge(
			{ state: PROBE_STATE, questions: { probe: PROBE_QUESTION } },
			{ signal: controller.signal },
		);
		return result.answers.probe === undefined
			? { reachable: false, reason: "it returned no answer" }
			: { reachable: true };
	} catch (err) {
		return {
			reachable: false,
			reason: controller.signal.aborted ? "it did not answer within 5 seconds" : reasonOf(err),
		};
	} finally {
		clearTimeout(timer);
	}
}

/** What the second opinion would use: the role's first candidate, and whether a probe reached it. */
export async function describeSecondOpinion(
	described: JudgeDescribed | undefined,
	judge: JudgeLike | undefined,
	price?: string,
): Promise<BakeoffJudgeInfo> {
	if (!described || !judge) return { state: "none", reason: "No judge model is set up on this computer." };
	const state: BakeoffJudgeInfo["state"] =
		described.kind === "native"
			? "native"
			: described.kind === "local"
				? "local"
				: described.explicit
					? "endpoint"
					: "fallback";
	const probe = await probeJudge(judge);
	return {
		state,
		label: described.label,
		reachable: probe.reachable,
		...(probe.reason ? { reason: probe.reason } : {}),
		...(state === "fallback" && price ? { price } : {}),
	};
}

export interface JudgePassInput {
	judge: JudgeLike;
	/** Native judges answer `score` questions too; other kinds only compare in pairs. */
	native: boolean;
	/** The problem statement, cut for the judge. */
	problem: string;
	/** Entry labels with the digest the judge reads of each. */
	entries: readonly { label: string; digest: string }[];
	metrics: readonly BakeoffMetric[];
	/** Spend so far, USD (from `onUsage`); the pass stops asking once it reaches `budgetUsd`. */
	spent(): number;
	budgetUsd: number;
	signal?: AbortSignal;
	/** The pairs and entries are asked in this order of labels; tests fix it. */
	progress?(done: number, total: number): void;
}

export interface JudgePassResult {
	/** `[label][metric]`, 0–1. A metric no complete answer exists for is absent. */
	scores: Record<string, Record<string, number>>;
	pairs: BakeoffPair[];
	/** Share of the pairwise answers that agreed across the swap. */
	consistency: number;
	/** Questions never asked because the spending limit was reached. */
	unjudged: number;
}

/**
 * The key a metric's question goes by. A text judge's reply is one `<key>: <answer>` line per question and the line is
 * split at its first colon, so a custom metric's `custom:1` would never match: its colon becomes a hyphen.
 */
function questionKey(metric: BakeoffMetric): string {
	return metric.id.replace(":", "-");
}

/** Plain-language prompt for one metric. */
function instructionsFor(metric: BakeoffMetric, ask: string): string {
	return `${definitionOf(metric).definition} ${ask}`;
}

/** Digest of an entry capped to the judge's size, never code. */
export function capDigest(text: string): string {
	return text.length <= BAKEOFF_JUDGE_DIGEST_CHARS ? text : `${text.slice(0, BAKEOFF_JUDGE_DIGEST_CHARS - 1)}…`;
}

/** The winner of one metric in one order: a label, or `tie`. */
function winnerOf(choice: string | undefined, first: string, second: string): string | undefined {
	if (choice === "first") return first;
	if (choice === "second") return second;
	if (choice === "tie") return "tie";
	return undefined;
}

/**
 * Run the judge over every entry and every pair of entries.
 * @throws Error (its message is the reason) when the judge cannot be reached for the first question; once some answers
 * exist a later failure ends the pass with what it has and counts the rest as unjudged.
 */
export async function runJudgePass(input: JudgePassInput): Promise<JudgePassResult> {
	const { entries, metrics } = input;
	const scores: Record<string, Record<string, number>> = Object.fromEntries(entries.map(entry => [entry.label, {}]));
	const pairs: BakeoffPair[] = [];
	const pairQuestions: Record<string, JudgeQuestion> = Object.fromEntries(
		metrics.map(metric => [
			questionKey(metric),
			{
				type: "choice",
				instructions: instructionsFor(
					metric,
					"Which is better on this metric? Judge only what the two summaries say.",
				),
				criteria: { first: null, second: null, tie: "no meaningful difference" },
			} satisfies JudgeQuestion,
		]),
	);
	const total = (input.native ? entries.length : 0) + 2 * ((entries.length * (entries.length - 1)) / 2);
	let done = 0;
	let answered = 0;
	let stopped = false;
	const ask = async (
		state: unknown,
		questions: Record<string, JudgeQuestion>,
	): Promise<Record<string, JudgeAnswer> | undefined> => {
		if (stopped) return undefined;
		if (input.spent() >= input.budgetUsd) {
			stopped = true;
			return undefined;
		}
		try {
			const result = await input.judge.judge({ state, questions }, { signal: input.signal });
			answered++;
			done++;
			input.progress?.(done, total);
			return result.answers;
		} catch (err) {
			if (answered === 0 || input.signal?.aborted) throw err;
			stopped = true;
			return undefined;
		}
	};

	if (input.native) {
		for (const entry of entries) {
			const questions: Record<string, JudgeQuestion> = Object.fromEntries(
				metrics.map(metric => [
					questionKey(metric),
					{
						type: "score",
						instructions: instructionsFor(metric, "Judge this entry only."),
						criteria: definitionOf(metric).levels as unknown as readonly [string, string, ...string[]],
					} satisfies JudgeQuestion,
				]),
			);
			const answers = await ask(
				{ problem: input.problem, entry: { label: entry.label, writeup: entry.digest } },
				questions,
			);
			if (!answers) continue;
			for (const metric of metrics) {
				const score = answers[questionKey(metric)]?.score;
				if (typeof score === "number" && Number.isFinite(score))
					scores[entry.label]![metric.id] = Math.min(1, Math.max(0, score / 4));
			}
		}
	}

	// Pairwise: each pair twice, the entries swapped.
	const wins: Record<string, Record<string, { points: number; pairs: number }>> = Object.fromEntries(
		entries.map(entry => [
			entry.label,
			Object.fromEntries(metrics.map(metric => [metric.id, { points: 0, pairs: 0 }])),
		]),
	);
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const x = entries[i]!;
			const y = entries[j]!;
			const forward = await ask({ problem: input.problem, first: x.digest, second: y.digest }, pairQuestions);
			const backward = forward
				? await ask({ problem: input.problem, first: y.digest, second: x.digest }, pairQuestions)
				: undefined;
			if (!forward || !backward) continue;
			for (const metric of metrics) {
				const one = winnerOf(forward[questionKey(metric)]?.choice, x.label, y.label);
				const two = winnerOf(backward[questionKey(metric)]?.choice, y.label, x.label);
				if (one === undefined || two === undefined) continue;
				const consistent = one === two;
				const winner = consistent ? one : "tie";
				pairs.push({ a: x.label, b: y.label, metric: metric.id, winner, consistent });
				for (const label of [x.label, y.label]) {
					const tally = wins[label]![metric.id]!;
					tally.pairs++;
					tally.points += winner === "tie" ? 0.5 : winner === label ? 1 : 0;
				}
			}
		}
	}
	// A native judge's score and the pairwise win share are averaged; every other judge has the win share alone.
	for (const entry of entries) {
		for (const metric of metrics) {
			const tally = wins[entry.label]![metric.id]!;
			if (tally.pairs === 0) continue;
			const share = tally.points / tally.pairs;
			const absolute = scores[entry.label]![metric.id];
			scores[entry.label]![metric.id] = absolute === undefined ? share : (absolute + share) / 2;
		}
	}
	return {
		scores,
		pairs,
		consistency: pairs.length === 0 ? 1 : pairs.filter(pair => pair.consistent).length / pairs.length,
		unjudged: total - done,
	};
}
