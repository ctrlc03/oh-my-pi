import type {
	Bakeoff,
	BakeoffEntry,
	BakeoffEntryStatus,
	BakeoffFacts,
	BakeoffMetric,
	BakeoffMode,
	BakeoffPair,
	BakeoffRanked,
	BakeoffResult,
	BakeoffScore,
	BakeoffStage,
	BakeoffSummary,
	BakeoffTakeResult,
} from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { fmtCost } from "../../lib/format";

// ── stages and entries ───────────────────────────────────────────────────────

/** The stages a bake-off of `mode` goes through, in order: a design has nothing to measure. */
export function stageSteps(mode: BakeoffMode): BakeoffStage[] {
	return mode === "design"
		? ["preparing", "entries", "writeups", "review", "judge"]
		: ["preparing", "entries", "facts", "writeups", "review", "judge"];
}

/** What the bake-off is doing, in plain words. */
export function stageWord(stage: BakeoffStage, mode: BakeoffMode): string {
	switch (stage) {
		case "preparing":
			return "Getting ready";
		case "entries":
			return mode === "design" ? "The entries are writing their designs" : "The entries are working";
		case "facts":
			return "Measuring each entry";
		case "writeups":
			return "Writing up each entry";
		case "review":
			return "The reviewer is reading every entry";
		case "judge":
			return "Getting a second opinion";
		case "done":
			return "Done";
	}
}

/** Where `stage` sits among the steps of `mode`, so a stepper can mark what is done: -1 when the mode skips it. */
export function stageIndex(stage: BakeoffStage, mode: BakeoffMode): number {
	if (stage === "done") return stageSteps(mode).length;
	return stageSteps(mode).indexOf(stage);
}

export function entryStatusWord(status: BakeoffEntryStatus): string {
	switch (status) {
		case "waiting":
			return "Waiting";
		case "working":
			return "Working";
		case "writing-up":
			return "Writing up";
		case "ready":
			return "Ready";
		case "failed":
			return "Failed";
		case "stopped":
			return "Stopped";
	}
}

export type EntryTone = "busy" | "ok" | "err" | "muted";

export function entryStatusTone(status: BakeoffEntryStatus): EntryTone {
	switch (status) {
		case "working":
		case "writing-up":
			return "busy";
		case "ready":
			return "ok";
		case "failed":
			return "err";
		case "waiting":
		case "stopped":
			return "muted";
	}
}

/** `Entry B`; with models shown, `Entry B (the original)` or `Entry B (<model>)`. */
export function entryName(entry: Pick<BakeoffEntry, "label" | "kind" | "model">, reveal: boolean): string {
	const name = `Entry ${entry.label}`;
	const origin = entryOrigin(entry, reveal);
	return origin === null ? name : `${name} (${origin})`;
}

/** Who made the entry; null while the models are hidden. */
export function entryOrigin(entry: Pick<BakeoffEntry, "kind" | "model">, reveal: boolean): string | null {
	if (!reveal) return null;
	if (entry.kind === "original") return "the original";
	return entry.model ?? "a challenger";
}

/** An entry the review reads and the person can take: it did not fail, and has a write-up or facts (the companion's rule). */
export function isReviewable(entry: BakeoffEntry): boolean {
	return entry.status !== "failed" && (entry.writeup !== undefined || entry.facts !== undefined);
}

/** A challenger that can still be stopped on its own. */
export function canStopEntry(entry: BakeoffEntry): boolean {
	return entry.kind === "challenger" && (entry.status === "working" || entry.status === "waiting");
}

/** The state of the run as the screen shows it: the companion's row when it has one, else what the document says. */
export function runState(
	summary: Pick<BakeoffSummary, "status"> | null | undefined,
	bakeoff: Pick<Bakeoff, "result"> | null | undefined,
): "running" | "ready" | "failed" {
	if (summary) return summary.status;
	return bakeoff?.result ? "ready" : "running";
}

/** Review again is allowed when the run failed in the review or the second opinion and two entries can still be compared (the companion's rule). */
export function canReviewAgain(status: "running" | "ready" | "failed", bakeoff: Bakeoff): boolean {
	if (status !== "failed") return false;
	if (bakeoff.stage !== "review" && bakeoff.stage !== "judge") return false;
	return bakeoff.entries.filter(isReviewable).length >= 2;
}

/** What Review again costs, said before it is tapped. */
export function reviewAgainNote(bakeoff: Pick<Bakeoff, "costs">): string {
	const last = bakeoff.costs.review + bakeoff.costs.judge;
	const spent = last > 0 ? ` The last try cost ${fmtCost(last)}.` : "";
	return `Review again costs again: the reviewer and the second opinion read the same entries once more.${spent}`;
}

// ── money ────────────────────────────────────────────────────────────────────

export function costTotal(costs: Bakeoff["costs"]): number {
	return costs.entries + costs.writeups + costs.review + costs.judge;
}

/** `Spent $1.20 of $12.00`, `Spent $1.20 so far` or null when nothing is known yet. */
export function costLine(
	bakeoff: Pick<Bakeoff, "costs"> | null,
	summary: Pick<BakeoffSummary, "costUsd" | "maxCostUsd"> | null | undefined,
): string | null {
	const total = summary?.costUsd ?? (bakeoff === null ? undefined : costTotal(bakeoff.costs));
	const max = summary?.maxCostUsd;
	if (total === undefined || (total <= 0 && max === undefined)) return null;
	return max === undefined ? `Spent ${fmtCost(total)} so far` : `Spent ${fmtCost(total)} of ${fmtCost(max)}`;
}

/** What each stage has cost, for the detail line; stages that cost nothing are left out. */
export function stageCostLine(costs: Bakeoff["costs"]): string | null {
	const parts: [string, number][] = [
		["Entries", costs.entries],
		["Write-ups", costs.writeups],
		["Review", costs.review],
		["Second opinion", costs.judge],
	];
	const shown = parts.filter(([, usd]) => usd > 0).map(([name, usd]) => `${name} ${fmtCost(usd)}`);
	return shown.length === 0 ? null : shown.join(" · ");
}

export function entryCostText(entry: Pick<BakeoffEntry, "costUsd">): string | null {
	return entry.costUsd === undefined ? null : fmtCost(entry.costUsd);
}

// ── facts ────────────────────────────────────────────────────────────────────

export interface FactItem {
	key: string;
	text: string;
	tone?: "ok" | "err" | "warn";
}

const signed = (added: number, removed: number): string => `+${added} \u2212${removed}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The measured facts of an entry as short lines: size, change from the original, tests, benchmark. */
export function factItems(facts: BakeoffFacts): FactItem[] {
	const items: FactItem[] = [
		{ key: "size", text: `${plural(facts.files, "file", "files")}, ${signed(facts.added, facts.removed)}` },
	];
	const delta = facts.deltaFromOriginal;
	if (delta !== undefined && (delta.files > 0 || delta.added > 0 || delta.removed > 0))
		items.push({
			key: "delta",
			text: `Changes ${plural(delta.files, "file", "files")}, ${signed(delta.added, delta.removed)} from the original`,
		});
	const tests = facts.tests;
	if (tests !== undefined) {
		if (tests.ok === true) items.push({ key: "tests", text: "Tests passed", tone: "ok" });
		else if (tests.ok === false)
			items.push({
				key: "tests",
				text: tests.reason ? `Tests failed: ${tests.reason}` : "Tests failed",
				tone: "err",
			});
		else
			items.push({
				key: "tests",
				text: `Tests not verified: ${tests.reason ?? tests.note ?? "they could not be run"}`,
				tone: "warn",
			});
	}
	const bench = facts.bench;
	if (bench !== undefined) {
		if (bench.value === null)
			items.push({
				key: "bench",
				text: `Benchmark not measured: ${bench.reason ?? "it could not be run"}`,
				tone: "warn",
			});
		else {
			const unit = bench.unit ? ` ${bench.unit}` : "";
			const runs = bench.runs.length > 1 ? ` (median of ${bench.runs.length} runs)` : "";
			items.push({ key: "bench", text: `Benchmark ${roundValue(bench.value)}${unit}${runs}` });
		}
	}
	return items;
}

function roundValue(n: number): string {
	return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** The label a metric shows under: the person's choice, or its id when the metric is not in the list. */
export function metricLabel(metrics: readonly BakeoffMetric[], id: string): string {
	return metrics.find(metric => metric.id === id)?.label ?? id;
}

/** The fenced mermaid block of a diagram the write-up carries, whether or not the author fenced it. */
export function diagramMarkdown(diagram: string): string {
	const fenced = /^\s*```(?:mermaid)?[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(diagram);
	const source = (fenced ? fenced[1]! : diagram).replace(/\s+$/, "");
	return `\`\`\`mermaid\n${source}\n\`\`\``;
}

// ── ranking ──────────────────────────────────────────────────────────────────

export interface RankRow {
	label: string;
	rank: number;
	/** Another entry has the same rank. */
	tied: boolean;
	score: number;
	percent: number;
	reason: string | null;
	eligible: boolean;
	flags: string[];
	taken: boolean;
}

export function percent(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

/** The ranking best first (ties by label), with its top reason. */
export function rankRows(result: BakeoffResult): RankRow[] {
	const sorted = [...result.ranking].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
	return sorted.map(item => ({
		label: item.label,
		rank: item.rank,
		tied: sorted.some(other => other !== item && other.rank === item.rank),
		score: item.score,
		percent: percent(item.score),
		reason: item.reasons[0] ?? null,
		eligible: item.eligible,
		flags: item.flags,
		taken: result.taken === item.label,
	}));
}

export function rankText(row: Pick<RankRow, "rank" | "tied">): string {
	return row.tied ? `=${row.rank}` : String(row.rank);
}

export const INELIGIBLE_NOTE = "Tests fail \u2014 the original passes";

/** Why *Take this one* needs one more tap for this entry; null when it does not. */
export function ineligibleReason(ranked: Pick<BakeoffRanked, "eligible"> | undefined): string | null {
	return ranked !== undefined && !ranked.eligible ? INELIGIBLE_NOTE : null;
}

/** Flags of an entry as the ranking and the entry both state them, once each, in the order given. */
export function mergedFlags(...lists: readonly (readonly string[] | undefined)[]): string[] {
	const out: string[] = [];
	for (const list of lists) for (const flag of list ?? []) if (!out.includes(flag)) out.push(flag);
	return out;
}

// ── agreement and notes ──────────────────────────────────────────────────────

export interface AgreementSummary {
	kind: BakeoffResult["agreement"];
	text: string;
	tone: "ok" | "warn" | "muted";
	/** Why the two split, as the companion put it. */
	note: string | null;
}

export function agreementSummary(result: Pick<BakeoffResult, "agreement" | "splitNote">): AgreementSummary {
	switch (result.agreement) {
		case "agreed":
			return { kind: "agreed", text: "Reviewer and judge agree", tone: "ok", note: null };
		case "split":
			return { kind: "split", text: "Split verdict", tone: "warn", note: result.splitNote ?? null };
		case "reviewer-only":
			return { kind: "reviewer-only", text: "Reviewer only", tone: "muted", note: null };
		case "judge-only":
			return { kind: "judge-only", text: "Judge only", tone: "muted", note: null };
	}
}

export interface ResultNote {
	key: string;
	tone: "info" | "warn";
	text: string;
}

const entriesText = (labels: readonly string[]): string =>
	labels.length === 1
		? `entry ${labels[0]}`
		: `entries ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

/** What the result says about how far to trust it, in plain words and in the order a reader needs it. */
export function resultNotes(
	result: Pick<BakeoffResult, "judgeNote" | "judgeIgnored" | "consistency" | "selfPreference">,
): ResultNote[] {
	const notes: ResultNote[] = [];
	if (result.judgeNote) notes.push({ key: "judge-note", tone: "info", text: result.judgeNote });
	if (result.judgeIgnored)
		notes.push({
			key: "judge-ignored",
			tone: "warn",
			text: "The second opinion contradicted itself, so it was not counted",
		});
	else if (result.consistency !== undefined)
		notes.push({
			key: "consistency",
			tone: "info",
			text: `The second opinion agreed with itself on ${percent(result.consistency)}% of its comparisons`,
		});
	if (result.selfPreference.length > 0)
		notes.push({
			key: "self-preference",
			tone: "warn",
			text: `The reviewer's own model wrote ${entriesText(result.selfPreference)}, so it may favour ${
				result.selfPreference.length === 1 ? "it" : "them"
			}`,
		});
	return notes;
}

// ── rankings of the two parties ──────────────────────────────────────────────

/** Weighted mean of one party's scores per entry, over the metrics it scored; null for an entry it did not score. */
function partyTotals(
	result: Pick<BakeoffResult, "scores">,
	metrics: readonly BakeoffMetric[],
	party: "reviewer" | "judge",
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [label, byMetric] of Object.entries(result.scores)) {
		let sum = 0;
		let weights = 0;
		for (const [id, score] of Object.entries(byMetric)) {
			const value = score[party];
			if (value === undefined) continue;
			const weight = metrics.find(metric => metric.id === id)?.weight ?? 1;
			sum += weight * value;
			weights += weight;
		}
		if (weights > 0) out.set(label, sum / weights);
	}
	return out;
}

function orderOf(totals: Map<string, number>): string[] {
	return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label);
}

/** The reviewer's own order: what it wrote when two readings ran, else what its scores say. Null when neither is known. */
export function reviewerRanking(result: BakeoffResult, metrics: readonly BakeoffMetric[]): string[] | null {
	const written = result.passes?.[0]?.ranking;
	if (written !== undefined && written.length > 0) return written;
	const derived = orderOf(partyTotals(result, metrics, "reviewer"));
	return derived.length > 0 ? derived : null;
}

/** The second opinion's order, from its scores; null when it gave none. */
export function judgeRanking(result: BakeoffResult, metrics: readonly BakeoffMetric[]): string[] | null {
	const derived = orderOf(partyTotals(result, metrics, "judge"));
	return derived.length > 0 ? derived : null;
}

export interface VerdictView {
	id: string;
	label: string;
	text: string;
	/** The reviewer's order of that reading; absent for the combined verdict. */
	ranking?: string[];
}

/** The verdict as one text, or, when the reviewer read twice, each reading beside it. */
export function verdictViews(result: BakeoffResult): VerdictView[] {
	const views: VerdictView[] = [{ id: "verdict", label: "Verdict", text: result.verdict }];
	const passes = result.passes ?? [];
	if (passes.length > 1)
		passes.forEach((pass, at) =>
			views.push({
				id: `pass-${at + 1}`,
				label: at === 0 ? "First reading" : at === 1 ? "Second reading" : `Reading ${at + 1}`,
				text: pass.verdict,
				ranking: pass.ranking,
			}),
		);
	return views;
}

// ── scores and pairs ─────────────────────────────────────────────────────────

/** The reviewer's 0–1 score as the 1–5 the reviewer gave: `4/5`, `3.5/5`. */
export function reviewerText(score: number): string {
	const five = Math.round((score * 4 + 1) * 2) / 2;
	return `${Number.isInteger(five) ? five : five.toFixed(1)}/5`;
}

export interface ScoreCell {
	/** The reviewer's, the judge's and the measured number, whichever exist. */
	parts: { kind: "reviewer" | "judge" | "measured"; text: string }[];
	combined: string | null;
	/** The combined score is the measurement. */
	measured: boolean;
}

export function scoreCell(score: BakeoffScore | undefined): ScoreCell {
	const parts: ScoreCell["parts"] = [];
	if (score?.reviewer !== undefined) parts.push({ kind: "reviewer", text: reviewerText(score.reviewer) });
	if (score?.judge !== undefined) parts.push({ kind: "judge", text: `${percent(score.judge)}%` });
	if (score?.measured !== undefined) parts.push({ kind: "measured", text: `${percent(score.measured)}%` });
	return {
		parts,
		combined: score?.combined === undefined ? null : `${percent(score.combined)}%`,
		measured: score?.measured !== undefined,
	};
}

/** The metrics of the table, in the person's order, then any the scores carry that the list does not. */
export function scoreMetrics(
	result: Pick<BakeoffResult, "scores">,
	metrics: readonly BakeoffMetric[],
): { id: string; label: string }[] {
	const ids = metrics.map(metric => metric.id as string);
	for (const byMetric of Object.values(result.scores))
		for (const id of Object.keys(byMetric)) if (!ids.includes(id)) ids.push(id);
	return ids.map(id => ({ id, label: metricLabel(metrics, id) }));
}

export interface PairRow {
	key: string;
	pair: string;
	metric: string;
	outcome: string;
}

/** The pairwise answers as rows: who was better on what, with a disagreement between the two orders counted as a tie. */
export function pairRows(pairs: readonly BakeoffPair[], metrics: readonly BakeoffMetric[]): PairRow[] {
	return pairs.map((pair, at) => ({
		key: `${pair.a}:${pair.b}:${pair.metric}:${at}`,
		pair: `${pair.a} vs ${pair.b}`,
		metric: metricLabel(metrics, pair.metric),
		outcome: !pair.consistent
			? "Tie (the two orders disagreed)"
			: pair.winner === "tie"
				? "Tie"
				: `Entry ${pair.winner}`,
	}));
}

// ── citations in the verdict ─────────────────────────────────────────────────

export interface VerdictCitation {
	label: string;
	path: string;
	line: number;
	token: string;
}

export type VerdictSegment = { kind: "text"; text: string } | ({ kind: "citation"; raw: string } & VerdictCitation);

const BACKTICKED = "`([A-E])\\/([^`\\n]+?)@(\\d+)@([^`\\n]+)`";
const BARE = "(?<![\\w`/])([A-E])\\/([^\\s`@]+?)@(\\d+)@([^\\s`]+)";
const TRAILING = /[.,;:!?)\]]+$/;

/** The verdict as text and citations: the reviewer writes each as `A/path@line@token` (usually in backticks). */
export function parseVerdictCitations(text: string): VerdictSegment[] {
	const out: VerdictSegment[] = [];
	const push = (segment: VerdictSegment): void => {
		const last = out[out.length - 1];
		if (segment.kind === "text") {
			if (segment.text === "") return;
			if (last?.kind === "text") last.text += segment.text;
			else out.push(segment);
		} else out.push(segment);
	};
	const pattern = new RegExp(`${BACKTICKED}|${BARE}`, "g");
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		const ticked = match[1] !== undefined;
		const [label, path, line, rawToken] = ticked
			? [match[1]!, match[2]!, match[3]!, match[4]!]
			: [match[5]!, match[6]!, match[7]!, match[8]!];
		const token = (ticked ? rawToken : rawToken.replace(TRAILING, "")).trim();
		const number = Number(line);
		if (token === "" || !Number.isSafeInteger(number) || number < 1) continue;
		const start = match.index!;
		const spoken = ticked
			? match[0]
			: match[0].slice(0, match[0].length - (rawToken.length - rawToken.replace(TRAILING, "").length));
		push({ kind: "text", text: text.slice(at, start) });
		push({ kind: "citation", raw: spoken, label, path, line: number, token });
		at = start + spoken.length;
	}
	push({ kind: "text", text: text.slice(at) });
	return out;
}

/** The distinct citations of a verdict, in the order first cited. */
export function verdictCitations(text: string): VerdictCitation[] {
	const seen = new Set<string>();
	const out: VerdictCitation[] = [];
	for (const segment of parseVerdictCitations(text)) {
		if (segment.kind !== "citation") continue;
		const key = `${segment.label}/${segment.path}@${segment.line}@${segment.token}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ label: segment.label, path: segment.path, line: segment.line, token: segment.token });
	}
	return out;
}

export function citationRef(citation: Pick<VerdictCitation, "path" | "line" | "token">): BlueprintRef {
	return { path: citation.path, line: citation.line, token: citation.token };
}

/** `src/queue.ts:41`, for a chip. */
export function citationText(citation: Pick<VerdictCitation, "path" | "line">): string {
	return `${citation.path}:${citation.line}`;
}

// ── taking an entry ──────────────────────────────────────────────────────────

/** The result is in, nothing was taken yet, and the entry can be taken. */
export function canTake(bakeoff: Bakeoff, entry: BakeoffEntry): boolean {
	if (bakeoff.result === undefined || bakeoff.result.taken !== undefined) return false;
	if (!isReviewable(entry)) return false;
	return !keepsWorktree(bakeoff, entry) || entry.instanceId !== undefined;
}

/** Taking this entry keeps a session's worktree (a challenger of an implementation); the original and designs have none to keep. */
export function keepsWorktree(bakeoff: Pick<Bakeoff, "mode">, entry: Pick<BakeoffEntry, "kind">): boolean {
	return bakeoff.mode === "implementation" && entry.kind === "challenger";
}

export interface TakePlan {
	keepsWorktree: boolean;
	/** The other challengers whose worktrees can be removed. */
	others: string[];
	/** Why one more tap is needed; null when it is not. */
	ineligible: string | null;
}

export function takePlan(bakeoff: Bakeoff, entry: BakeoffEntry): TakePlan {
	const keeps = keepsWorktree(bakeoff, entry);
	const ranked = bakeoff.result?.ranking.find(item => item.label === entry.label);
	return {
		keepsWorktree: keeps,
		others: keeps
			? bakeoff.entries
					.filter(
						other => other.label !== entry.label && other.kind === "challenger" && other.instanceId !== undefined,
					)
					.map(other => other.label)
			: [],
		ineligible: ineligibleReason(ranked),
	};
}

/** What taking an implementation did to the other worktrees, as sentences; models only when shown. */
export function takeLines(result: BakeoffTakeResult | undefined, reveal: boolean): string[] {
	if (result === undefined) return [];
	const lines: string[] = [];
	if (result.removed.length > 0)
		lines.push(`Removed ${plural(result.removed.length, "other worktree", "other worktrees")}.`);
	if (result.skipped.length > 0) {
		lines.push(`${plural(result.skipped.length, "worktree stayed", "worktrees stayed")} in place:`);
		for (const item of result.skipped) lines.push(reveal ? `${item.model}: ${item.reason}` : item.reason);
	}
	return lines;
}

// ── the design as Markdown ───────────────────────────────────────────────────

/** The write-up of an entry as Markdown, for Copy design and for the first message of a session started from it. */
export function designMarkdown(bakeoff: Pick<Bakeoff, "title" | "metrics">, entry: BakeoffEntry): string {
	const writeup = entry.writeup;
	const out: string[] = [`# ${bakeoff.title}`, ""];
	if (writeup === undefined) {
		out.push("This entry has no write-up.");
		return `${out.join("\n")}\n`;
	}
	out.push("## Summary", "", writeup.summary.trim(), "");
	out.push("## Approach", "", writeup.approach.trim(), "");
	if (writeup.diagram !== undefined && writeup.diagram.trim() !== "")
		out.push("## Diagram", "", diagramMarkdown(writeup.diagram), "");
	if (writeup.tradeoffs.length > 0) out.push("## Trade-offs", "", ...writeup.tradeoffs.map(item => `- ${item}`), "");
	if (writeup.risks.length > 0) out.push("## Risks", "", ...writeup.risks.map(item => `- ${item}`), "");
	if (writeup.migration.trim() !== "") out.push("## Migration", "", writeup.migration.trim(), "");
	const evidence = Object.entries(writeup.metrics);
	if (evidence.length > 0)
		out.push(
			"## What matters",
			"",
			...evidence.map(([id, line]) => `- **${metricLabel(bakeoff.metrics, id)}**: ${line}`),
			"",
		);
	if (writeup.refs.length > 0)
		out.push("## Code", "", ...writeup.refs.map(ref => `- \`${ref.path}:${ref.line}\` (${ref.token})`), "");
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
