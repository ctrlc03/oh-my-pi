/**
 * The write-up of a bake-off entry (docs/design-review.md, *Write-up template*): the JSON a designer or the neutral
 * writer files, checked for shape, its citations checked against the entry's commit, and rendered as text for the
 * reviewer and (shortened) for the judge. Designers and the writer fill the same template, so format does not
 * identify authorship.
 */

import type { BakeoffFacts, BakeoffWriteup } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { checkCitations, parseRefs, readCitedFiles, str, Warnings } from "./companion-citations";
import { isRecord } from "../src/tool-render/util";

const MAX_SUMMARY_CHARS = 800;
const MAX_APPROACH_CHARS = 6_000;
const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 500;
const MAX_MIGRATION_CHARS = 1_800;
const MAX_METRIC_CHARS = 500;
const MAX_DIAGRAM_CHARS = 4_000;

/** The write-up as the file has it: shape checked, citations not yet. */
export interface ParsedWriteup extends Omit<BakeoffWriteup, "refs"> {
	refs: BlueprintRef[];
	/** How many citations the file named before any was checked. */
	refsGiven: number;
}

function list(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = str(item, MAX_ITEM_CHARS);
		if (text !== undefined) out.push(text);
		if (out.length >= MAX_LIST_ITEMS) break;
	}
	return out;
}

/** The mermaid source of a diagram the agent wrote, without its fence; undefined when there is none. */
function diagramSource(value: unknown): string | undefined {
	const text = str(value, MAX_DIAGRAM_CHARS);
	if (text === undefined) return undefined;
	const fenced = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```$/.exec(text);
	return (fenced ? fenced[1]! : text).trim() || undefined;
}

/**
 * @throws Error in plain words when the file is not the template: not an object, or without a summary or an approach.
 */
export function parseWriteup(raw: unknown, metricIds: readonly string[]): ParsedWriteup {
	if (!isRecord(raw)) throw new Error("The write-up is not a JSON object.");
	const summary = str(raw.summary, MAX_SUMMARY_CHARS);
	const approach = str(raw.approach, MAX_APPROACH_CHARS);
	if (summary === undefined) throw new Error("The write-up has no summary.");
	if (approach === undefined) throw new Error("The write-up has no approach.");
	const metrics: Record<string, string> = {};
	if (isRecord(raw.metrics)) {
		for (const id of metricIds) {
			const line = str(raw.metrics[id], MAX_METRIC_CHARS);
			if (line !== undefined) metrics[id] = line;
		}
	}
	const refsGiven = Array.isArray(raw.refs) ? raw.refs.length : 0;
	return {
		summary,
		approach,
		tradeoffs: list(raw.tradeoffs),
		risks: list(raw.risks),
		migration: str(raw.migration, MAX_MIGRATION_CHARS) ?? "",
		metrics,
		diagram: diagramSource(raw.diagram),
		refs: parseRefs(raw.refs),
		refsGiven,
	};
}

/**
 * The write-up with its citations checked against the entry's commit (`lines` reads a file there). A citation that
 * does not hold is dropped.
 * @throws Error when the file named citations and none of them held: the write-up is not trusted.
 */
export async function verifyWriteup(
	parsed: ParsedWriteup,
	lines: (path: string) => Promise<string[] | null>,
	warnings: string[],
): Promise<BakeoffWriteup> {
	const { refsGiven, refs, ...rest } = parsed;
	const found = new Warnings();
	const files = await readCitedFiles(
		refs.map(ref => ({ side: "head" as const, path: ref.path })),
		(_side, path) => lines(path),
	);
	const kept = checkCitations(refs, "the write-up", () => "head", files, { verified: 0, moved: 0, dropped: 0 }, found);
	warnings.push(...found.list());
	if (refsGiven > 0 && kept.length === 0)
		throw new Error("None of the write-up's citations held up against the code.");
	return { ...rest, refs: kept };
}

/** Apply `scrub` to every piece of text of a write-up. */
export function scrubWriteup(writeup: BakeoffWriteup, scrub: (text: string) => string): BakeoffWriteup {
	return {
		...writeup,
		summary: scrub(writeup.summary),
		approach: scrub(writeup.approach),
		tradeoffs: writeup.tradeoffs.map(scrub),
		risks: writeup.risks.map(scrub),
		migration: scrub(writeup.migration),
		metrics: Object.fromEntries(Object.entries(writeup.metrics).map(([id, line]) => [id, scrub(line)])),
		diagram: writeup.diagram === undefined ? undefined : scrub(writeup.diagram),
	};
}

/** One line of what the measuring found, for the reviewer and the judge. */
export function factsLine(facts: BakeoffFacts | undefined): string {
	if (!facts) return "No measured facts.";
	const parts = [`${facts.files} files, +${facts.added} −${facts.removed} against the base`];
	if (facts.deltaFromOriginal)
		parts.push(
			`${facts.deltaFromOriginal.files} files, +${facts.deltaFromOriginal.added} −${facts.deltaFromOriginal.removed} changed from the starting point`,
		);
	if (facts.tests) {
		const { ok, reason, note } = facts.tests;
		parts.push(
			ok === true
				? `tests passed${note ? ` (${note})` : ""}`
				: ok === false
					? `tests failed${reason ? ` (${reason})` : ""}`
					: `tests not verified${reason ? ` (${reason})` : ""}`,
		);
	}
	if (facts.bench) {
		const { value, unit, better, runs, reason } = facts.bench;
		parts.push(
			value === null
				? `benchmark not measured${reason ? ` (${reason})` : ""}`
				: `benchmark ${value}${unit ? ` ${unit}` : ""} (${better} is better; ${runs.length} runs)`,
		);
	}
	return `${parts.join("; ")}.`;
}

/** The write-up as markdown. */
export function renderWriteup(writeup: BakeoffWriteup, metricLabels: Readonly<Record<string, string>>): string {
	const out = [writeup.summary, "", "### Approach", "", writeup.approach];
	if (writeup.tradeoffs.length > 0) out.push("", "### Trade-offs", "", ...writeup.tradeoffs.map(item => `- ${item}`));
	if (writeup.risks.length > 0) out.push("", "### Risks", "", ...writeup.risks.map(item => `- ${item}`));
	if (writeup.migration !== "") out.push("", "### Migration", "", writeup.migration);
	const lines = Object.entries(writeup.metrics);
	if (lines.length > 0)
		out.push(
			"",
			"### Against the metrics",
			"",
			...lines.map(([id, line]) => `- **${metricLabels[id] ?? id}:** ${line}`),
		);
	if (writeup.diagram) out.push("", "```mermaid", writeup.diagram, "```");
	if (writeup.refs.length > 0)
		out.push(
			"",
			"### Code it points at",
			"",
			...writeup.refs.map(ref => `- \`${ref.path}@${ref.line}@${ref.token}\``),
		);
	return out.join("\n");
}

/**
 * What the judge reads of an entry: summary, approach, trade-offs, risks, migration, the per-metric lines and the facts
 * as one line, cut to `maxChars` (the same cap for every entry, so length does not decide). Never code.
 */
export function judgeDigest(
	writeup: BakeoffWriteup | undefined,
	facts: BakeoffFacts | undefined,
	metricLabels: Readonly<Record<string, string>>,
	maxChars: number,
): string {
	const parts = writeup
		? [
				`Summary: ${writeup.summary}`,
				`Approach: ${writeup.approach}`,
				...(writeup.tradeoffs.length > 0 ? [`Trade-offs: ${writeup.tradeoffs.join("; ")}`] : []),
				...(writeup.risks.length > 0 ? [`Risks: ${writeup.risks.join("; ")}`] : []),
				...(writeup.migration !== "" ? [`Migration: ${writeup.migration}`] : []),
				...Object.entries(writeup.metrics).map(([id, line]) => `${metricLabels[id] ?? id}: ${line}`),
			]
		: ["No write-up."];
	const body = parts.join("\n");
	const facing = `\nFacts: ${factsLine(facts)}`;
	if (body.length + facing.length <= maxChars) return `${body}${facing}`;
	return `${body.slice(0, Math.max(0, maxChars - facing.length - 1))}…${facing}`;
}
