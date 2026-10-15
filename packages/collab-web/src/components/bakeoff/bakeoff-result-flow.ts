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

/**
 * Review again is allowed when the run failed in the review or the second opinion and two entries can still be compared
 * (the companion's rule). A bake-off of a folder that is not a git repository has no checkout to read the code from
 * again, so the review cannot be repeated.
 */
export function canReviewAgain(status: "running" | "ready" | "failed", bakeoff: Bakeoff): boolean {
	if (status !== "failed" || bakeoff.folder === true) return false;
	if (bakeoff.stage !== "review" && bakeoff.stage !== "judge") return false;
	return bakeoff.entries.filter(isReviewable).length >= 2;
}

/** A map of an entry's code needs its worktree: an implementation entry the bake-off still holds, never a folder's design. */
export function canMapEntry(bakeoff: Bakeoff, entry: BakeoffEntry): boolean {
	return (
		bakeoff.mode === "implementation" && bakeoff.folder !== true && entry.path !== undefined && isReviewable(entry)
	);
}

/** A spar over an entry reads the code in a checkout, which a folder that is not a git repository does not have. */
export function canSparEntry(bakeoff: Bakeoff, entry: BakeoffEntry): boolean {
	return bakeoff.folder !== true && isReviewable(entry);
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

/**
 * The sections of an entry's write-up as Markdown, headed at `level` (`2` is `##`), without a title. `text` is applied to
 * every piece the designer wrote, so a caller that nests the design in a larger document can demote its headings.
 */
export function designBody(
	bakeoff: Pick<Bakeoff, "metrics">,
	entry: BakeoffEntry,
	level = 2,
	text: (written: string) => string = written => written,
): string {
	const writeup = entry.writeup;
	if (writeup === undefined) return "This entry has no write-up.";
	const head = (name: string): string => `${"#".repeat(level)} ${name}`;
	const out: string[] = [head("Summary"), "", text(writeup.summary.trim()), ""];
	out.push(head("Approach"), "", text(writeup.approach.trim()), "");
	if (writeup.diagram !== undefined && writeup.diagram.trim() !== "")
		out.push(head("Diagram"), "", diagramMarkdown(writeup.diagram), "");
	if (writeup.tradeoffs.length > 0)
		out.push(head("Trade-offs"), "", ...writeup.tradeoffs.map(item => `- ${text(item)}`), "");
	if (writeup.risks.length > 0) out.push(head("Risks"), "", ...writeup.risks.map(item => `- ${text(item)}`), "");
	if (writeup.migration.trim() !== "") out.push(head("Migration"), "", text(writeup.migration.trim()), "");
	const evidence = Object.entries(writeup.metrics);
	if (evidence.length > 0)
		out.push(
			head("What matters"),
			"",
			...evidence.map(([id, line]) => `- **${metricLabel(bakeoff.metrics, id)}**: ${text(line)}`),
			"",
		);
	if (writeup.refs.length > 0)
		out.push(head("Code"), "", ...writeup.refs.map(ref => `- \`${ref.path}:${ref.line}\` (${ref.token})`), "");
	return out.join("\n").replace(/\n+$/, "");
}

/** The write-up of an entry as Markdown, for Copy design and for the first message of a session started from it. */
export function designMarkdown(bakeoff: Pick<Bakeoff, "title" | "metrics">, entry: BakeoffEntry): string {
	return `# ${bakeoff.title}\n\n${designBody(bakeoff, entry)}\n`;
}

// ── taking the result out: file names, patches ───────────────────────────────

/** Lowercase ASCII words of a title, so every file system takes the name; empty when the title has none. */
function titleSlug(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

/** `faster-queue-bake-off.md`. Only the title and a fixed word: the report may name models, its file name never does. */
export function reportFileName(bakeoff: Pick<Bakeoff, "title">): string {
	const slug = titleSlug(bakeoff.title);
	return slug === "" ? "bake-off.md" : `${slug}-bake-off.md`;
}

/** `faster-queue-entry-b.patch`: the entry's label, never its model. */
export function patchFileName(bakeoff: Pick<Bakeoff, "title">, entry: Pick<BakeoffEntry, "label">): string {
	return `${titleSlug(bakeoff.title) || "bake-off"}-entry-${entry.label.toLowerCase()}.patch`;
}

/** `faster-queue-patches.patch`: every exported entry in one file. */
export function combinedPatchFileName(bakeoff: Pick<Bakeoff, "title">): string {
	return `${titleSlug(bakeoff.title) || "bake-off"}-patches.patch`;
}

export interface PatchControls {
	/** Whether the entry gets Download patch and Copy patch at all. */
	show: boolean;
	/** Why both are disabled, in the companion's words; null when they work. */
	disabledReason: string | null;
}

/**
 * The patch buttons of an entry: shown on a finished implementation bake-off when the companion can export patches. An
 * entry the companion says cannot be exported keeps them, disabled, with the reason; one it says nothing about (an
 * older companion's) keeps them enabled, and the companion's refusal is shown if there is one.
 */
export function patchControls(
	bakeoff: Pick<Bakeoff, "mode" | "result">,
	entry: Pick<BakeoffEntry, "patch">,
	canPatch: boolean,
): PatchControls {
	if (!canPatch || bakeoff.mode !== "implementation" || bakeoff.result === undefined)
		return { show: false, disabledReason: null };
	return { show: true, disabledReason: entry.patch?.ok === false ? entry.patch.reason : null };
}

/** The entries as the combined patch lists them: the ranking best first, then any entry the ranking leaves out, by label. */
export function patchOrder(bakeoff: Pick<Bakeoff, "entries" | "result">): BakeoffEntry[] {
	const ranked = bakeoff.result === undefined ? [] : rankRows(bakeoff.result).map(row => row.label);
	const byLabel = new Map(bakeoff.entries.map(entry => [entry.label, entry]));
	const ordered = ranked.flatMap(label => byLabel.get(label) ?? []);
	const rest = bakeoff.entries.filter(entry => !ranked.includes(entry.label));
	return [...ordered, ...rest.sort((a, b) => a.label.localeCompare(b.label))];
}

const PATCH_BANNER = [
	"# These patches are ALTERNATIVES: each entry below is one way to do the same task, against the same base.",
	"# Do not apply this whole file. Split it at the `# ===== Entry` lines and give one entry's part to `git apply`.",
];

/** `# ===== Entry A (rank 1, taken) =====`: labels only, never a model. */
function patchSeparator(bakeoff: Pick<Bakeoff, "result">, label: string): string {
	const row = bakeoff.result === undefined ? undefined : rankRows(bakeoff.result).find(item => item.label === label);
	const parts = [row === undefined ? "not ranked" : `rank ${rankText(row)}`];
	if (row?.taken === true) parts.push("taken");
	return `# ===== Entry ${label} (${parts.join(", ")}) =====`;
}

/**
 * One file with the patch of every entry in `patches` (by label), the winner first, a separator block before each and a
 * banner that says they are alternatives. Not a zip: the app has no zip writer, and several downloads from one tap are
 * blocked or prompt in browsers and become several share sheets on a phone, so a single file is the one-tap option.
 */
export function combinedPatch(
	bakeoff: Pick<Bakeoff, "entries" | "result">,
	patches: ReadonlyMap<string, string>,
): string {
	const entries = patchOrder(bakeoff).filter(entry => patches.has(entry.label));
	const out: string[] = [
		...PATCH_BANNER,
		`# Entries in this file: ${entries.map(entry => entry.label).join(", ")}`,
		"",
	];
	for (const entry of entries) {
		const patch = patches.get(entry.label)!;
		out.push(patchSeparator(bakeoff, entry.label), "");
		out.push(patch === "" ? "# (this entry changes nothing)" : patch.endsWith("\n") ? patch.slice(0, -1) : patch, "");
	}
	return out.join("\n");
}

export interface LeftOut {
	label: string;
	reason: string;
}

/** `Left out: Entry C (reason), Entry D (reason)`; null when nothing was left out. */
export function leftOutLine(leftOut: readonly LeftOut[]): string | null {
	if (leftOut.length === 0) return null;
	return `Left out: ${leftOut.map(item => `Entry ${item.label} (${item.reason})`).join(", ")}`;
}

/**
 * Fetch the patch of every entry that can be exported, one after another (the companion makes each with a `git diff`),
 * and join them. `patch` is null when none could be fetched.
 */
export async function collectPatches(
	bakeoff: Pick<Bakeoff, "mode" | "result" | "entries">,
	fetchPatch: (label: string) => Promise<string>,
): Promise<{ patch: string | null; included: string[]; leftOut: LeftOut[] }> {
	const patches = new Map<string, string>();
	const leftOut: LeftOut[] = [];
	for (const entry of patchOrder(bakeoff)) {
		const { show, disabledReason } = patchControls(bakeoff, entry, true);
		if (!show) continue;
		if (disabledReason !== null) {
			leftOut.push({ label: entry.label, reason: disabledReason });
			continue;
		}
		try {
			patches.set(entry.label, await fetchPatch(entry.label));
		} catch (err) {
			leftOut.push({ label: entry.label, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return {
		patch: patches.size === 0 ? null : combinedPatch(bakeoff, patches),
		included: [...patches.keys()],
		leftOut,
	};
}
