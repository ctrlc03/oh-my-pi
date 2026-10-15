/**
 * A finished bake-off as one Markdown document, for Copy report, Share and Download .md. It is built from what the app
 * already holds: the bake-off, its list row's subject, and the code excerpts of its citations.
 *
 * The report reveals what the result view hides until *Show models*: the model of every challenger (judging is over).
 * It never holds the reviewer's, the writer's or the judge's model, an entry's branch, worktree path or session, the
 * fan-out group, the repository's path or GitHub name, or a session id: the docs say what is withheld.
 *
 * Text the reviewer or a designer wrote is nested into the report, not trusted: its headings are demoted below the
 * heading it sits under, and a code fence left open is closed, so it cannot reshape or swallow the sections after it.
 * Anything quoted verbatim goes in a fence longer than any run of backticks inside it.
 */

import type { Bakeoff, BakeoffEntry, BakeoffResult } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintExcerpt, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { fmtCost } from "../../lib/format";
import { refKey } from "../architecture/blueprint-model";
import type { BakeoffCodeAccess } from "./BakeoffCode";
import {
	agreementSummary,
	citationRef,
	costTotal,
	designBody,
	entryCostText,
	entryName,
	entryStatusWord,
	factItems,
	INELIGIBLE_NOTE,
	mergedFlags,
	pairRows,
	parseVerdictCitations,
	rankRows,
	rankText,
	resultNotes,
	scoreCell,
	scoreMetrics,
	stageCostLine,
	verdictCitations,
	type VerdictView,
	verdictViews,
} from "./bakeoff-result-flow";

/** Citations whose code a report holds: more would make a document nobody reads and a long wait to build it. */
export const REPORT_MAX_CITATIONS = 40;

// ── Markdown safety ──────────────────────────────────────────────────────────

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_LINE = /^( {0,3})(#{1,6})(?=[ \t]|$)/;

/**
 * Text written by someone else, set into a document: each ATX heading outside a code fence goes `shift` levels deeper
 * (never past six), and a fence still open at the end is closed. `shift` 0 only closes.
 */
export function embedText(text: string, shift: number): string {
	const out: string[] = [];
	let open: { char: string; size: number } | null = null;
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		const fence = FENCE_LINE.exec(line);
		if (open !== null) {
			out.push(line);
			// A closing fence uses the same character, is at least as long as the opening one and has nothing after it.
			if (fence !== null && fence[1]![0] === open.char && fence[1]!.length >= open.size && fence[2]!.trim() === "")
				open = null;
			continue;
		}
		// An opening backtick fence cannot have a backtick in its info string; such a line is inline code.
		if (fence !== null && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
			open = { char: fence[1]![0]!, size: fence[1]!.length };
			out.push(line);
			continue;
		}
		const heading = HEADING_LINE.exec(line);
		out.push(
			heading === null
				? line
				: `${heading[1]}${"#".repeat(Math.min(6, heading[2]!.length + shift))}${line.slice(heading[0].length)}`,
		);
	}
	if (open !== null) out.push(open.char.repeat(open.size));
	return out.join("\n");
}

function longestRun(text: string, char: string): number {
	let longest = 0;
	for (const run of text.match(new RegExp(`${char}+`, "g")) ?? []) longest = Math.max(longest, run.length);
	return longest;
}

/** `text` in a code fence of backticks at least three long and one longer than any run of backticks inside it. */
export function fence(text: string, info = ""): string {
	const mark = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
	return `${mark}${info}\n${text.replace(/\n+$/, "")}\n${mark}`;
}

/** `text` as inline code on one line, its delimiter longer than any run of backticks inside it. */
export function inlineCode(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	const mark = "`".repeat(longestRun(flat, "`") + 1);
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${mark}${pad}${flat}${pad}${mark}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const cell = (text: string): string => oneLine(text).replace(/\|/g, "\\|");

/** The reviewer's `A/path@line@token` as `` `A/path:line` ``. */
function rewriteCitations(text: string): string {
	return parseVerdictCitations(text)
		.map(segment =>
			segment.kind === "text" ? segment.text : inlineCode(`${segment.label}/${segment.path}:${segment.line}`),
		)
		.join("");
}

/** The reviewer's own words as a block under a heading `shift` levels above the headings it may hold. */
function reviewerBlock(text: string, shift: number): string {
	return embedText(rewriteCitations(text.trim()), shift);
}

/** `text` as a list item, `indent` spaces in; continuation lines line up under its first word. */
function bullet(text: string, indent = 0): string {
	const pad = " ".repeat(indent);
	return reviewerBlock(text, 4)
		.split("\n")
		.map((line, at) => (at === 0 ? `${pad}- ${line}` : line === "" ? "" : `${pad}  ${line}`))
		.join("\n");
}

const plainBullet = (text: string): string => `- ${oneLine(text)}`;

// ── citations ────────────────────────────────────────────────────────────────

export interface ReportCitation {
	/** The entry whose code the citation is read in. */
	label: string;
	ref: BlueprintRef;
}

/** The key an excerpt is held under: the one the code panels cache by, so excerpts already opened are reused. */
export function excerptKey(label: string, ref: BlueprintRef): string {
	return `${label}:${refKey(ref)}`;
}

/** The text of each reading the report prints: the verdict, or each of the two readings when the reviewer read twice. */
function printedViews(result: BakeoffResult): VerdictView[] {
	const views = verdictViews(result);
	return views.length > 1 ? views.filter(view => view.id !== "verdict") : views;
}

/**
 * The distinct citations of the verdict(s) and of the findings, in the order met, up to the cap; `omitted` counts the
 * ones left out. These are the codes the report quotes, so they are what to fetch.
 */
export function reportCitations(
	bakeoff: Pick<Bakeoff, "result">,
	limit = REPORT_MAX_CITATIONS,
): { shown: ReportCitation[]; omitted: number } {
	const result = bakeoff.result;
	if (result === undefined) return { shown: [], omitted: 0 };
	const all = new Map<string, ReportCitation>();
	const add = (label: string, ref: BlueprintRef): void => {
		const key = excerptKey(label, ref);
		if (!all.has(key)) all.set(key, { label, ref });
	};
	for (const view of printedViews(result))
		for (const cited of verdictCitations(view.text)) add(cited.label, citationRef(cited));
	for (const finding of result.findings) for (const ref of finding.refs ?? []) add(finding.label, ref);
	const list = [...all.values()];
	return { shown: list.slice(0, limit), omitted: Math.max(0, list.length - limit) };
}

/**
 * The code each citation points at, read through the screen's reader and cache (so excerpts already opened are not read
 * again), one request per entry. A failed read never stops the report: those citations come back as null, and are not
 * cached, so opening them later still tries again.
 */
export async function loadReportExcerpts(
	access: BakeoffCodeAccess,
	citations: readonly ReportCitation[],
): Promise<Map<string, BlueprintExcerpt | null>> {
	const found = new Map<string, BlueprintExcerpt | null>();
	const missing = new Map<string, BlueprintRef[]>();
	for (const { label, ref } of citations) {
		const key = excerptKey(label, ref);
		if (access.cache.has(key)) found.set(key, access.cache.get(key) ?? null);
		else missing.set(label, [...(missing.get(label) ?? []), ref]);
	}
	for (const [label, refs] of missing) {
		try {
			const got = await access.excerpts(label, refs);
			refs.forEach((ref, at) => {
				const excerpt = got[at] ?? null;
				access.cache.set(excerptKey(label, ref), excerpt);
				found.set(excerptKey(label, ref), excerpt);
			});
		} catch {
			for (const ref of refs) found.set(excerptKey(label, ref), null);
		}
	}
	return found;
}

// ── the report ───────────────────────────────────────────────────────────────

export interface ReportInput {
	bakeoff: Bakeoff;
	/** The list row's `subject` (`feature/x vs main`, `PR #12`, `a design`); unknown when the row is not at hand. */
	subject?: string;
	/** Code of the citations, by {@link excerptKey}; a citation missing or null is listed without code. */
	excerpts: ReadonlyMap<string, BlueprintExcerpt | null>;
}

const isoDay = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

/** The text of a note that may name the reviewer's or the judge's model, with the names taken out. */
function withoutModels(text: string, result: BakeoffResult): string {
	let out = text;
	if (result.judgeLabel) out = out.split(result.judgeLabel).join("the judge");
	if (result.reviewerModel) out = out.split(result.reviewerModel).join("the reviewer");
	return out;
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
	const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;
	return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function factsSection(bakeoff: Bakeoff, subject: string | undefined): string[] {
	const facts: string[] = [];
	if (subject !== undefined && subject.trim() !== "") facts.push(`- Subject: ${oneLine(subject)}`);
	facts.push(`- Mode: ${bakeoff.mode === "design" ? "Design only" : "Implementation"}`);
	if (bakeoff.mode === "implementation")
		facts.push(`- Challengers started from: ${bakeoff.start === "base" ? "the base" : "the original's code"}`);
	const day = isoDay(bakeoff.createdAt);
	if (day !== null) facts.push(`- Started: ${day}`);
	if (bakeoff.result?.taken !== undefined) facts.push(`- Taken: Entry ${bakeoff.result.taken}`);
	if (bakeoff.folder === true) facts.push("- About: a folder that is not a git repository");
	return facts;
}

/** The bake-off as Markdown: see the module note for what it holds and what it never does. */
export function bakeoffReport(input: ReportInput): string {
	const { bakeoff, subject, excerpts } = input;
	const result = bakeoff.result;
	const entries = [...bakeoff.entries].sort((a, b) => a.label.localeCompare(b.label));
	const named = (label: string): string => {
		const found = bakeoff.entries.find(entry => entry.label === label);
		return found === undefined ? `Entry ${label}` : entryName(found, true);
	};
	const sections: string[] = [];
	const section = (heading: string, ...body: string[]): void => {
		sections.push([heading, ...body].join("\n\n"));
	};

	sections.push(`# ${oneLine(bakeoff.title)}`);
	const facts = factsSection(bakeoff, subject);
	if (facts.length > 0) sections.push(facts.join("\n"));

	if (bakeoff.metrics.length > 0)
		section(
			"## What matters",
			bakeoff.metrics
				.map(metric => {
					const text = metric.text === undefined ? "" : `: ${oneLine(metric.text)}`;
					return `- **${oneLine(metric.label)}** (weight ${metric.weight} of 3)${text}`;
				})
				.join("\n"),
		);
	if (bakeoff.instructions !== undefined && bakeoff.instructions.trim() !== "")
		section("## Instructions given to every challenger", fence(bakeoff.instructions.trim()));

	if (entries.length > 0)
		section("## Entries", ...entries.map(entry => entrySection(entry, named(entry.label), result)));

	if (result !== undefined) {
		const rows = rankRows(result);
		if (rows.length > 0)
			section(
				"## Ranking",
				rows
					.map(row => {
						const ranked = result.ranking.find(item => item.label === row.label);
						const head = `- **${rankText(row)}.** ${named(row.label)} — ${row.percent}%${row.taken ? " — taken" : ""}`;
						const notes = [
							...(row.eligible ? [] : [`  - ${INELIGIBLE_NOTE}`]),
							...(ranked?.reasons ?? []).map(reason => bullet(reason, 2)),
						];
						return [head, ...notes].join("\n");
					})
					.join("\n"),
			);

		const views = printedViews(result);
		const found = views
			.filter(view => view.text.trim() !== "")
			.map(view => {
				if (views.length === 1) return reviewerBlock(view.text, 2);
				const order =
					view.ranking === undefined ? "" : `The reviewer's order: ${view.ranking.map(named).join(", ")}\n\n`;
				return `### ${view.label}\n\n${order}${reviewerBlock(view.text, 3)}`;
			});
		const findings = [...new Set(result.findings.map(finding => finding.label))].sort().map(label => {
			const own = result.findings.filter(finding => finding.label === label);
			const group = (kind: "strength" | "weakness", title: string): string[] => {
				const items = own.filter(finding => finding.kind === kind);
				if (items.length === 0) return [];
				return [
					`**${title}**`,
					items
						.map(finding =>
							bullet(finding.verified ? finding.text : `${finding.text.trim()} (not checked against code)`),
						)
						.join("\n"),
				];
			};
			return [`### ${named(label)}`, ...group("strength", "Strengths"), ...group("weakness", "Weaknesses")].join(
				"\n\n",
			);
		});
		if (found.length > 0 || findings.length > 0) section("## What the reviewer found", ...found, ...findings);

		const secondOpinion = result.agreement !== "reviewer-only";
		const scoreRows = scoreTable(bakeoff, result, named);
		const pairs = pairRows(result.pairwise ?? [], bakeoff.metrics);
		if (secondOpinion) {
			const agreement = agreementSummary(result);
			const lines = [`- ${agreement.text}`];
			if (agreement.note !== null) lines.push(`- Why they split: ${oneLine(withoutModels(agreement.note, result))}`);
			section(
				"## Second opinion",
				lines.join("\n"),
				...(scoreRows === null ? [] : ["### Scores", scoreRows]),
				...(pairs.length === 0
					? []
					: [
							"### Pairwise comparisons",
							table(
								["Pair", "Metric", "Better"],
								pairs.map(row => [row.pair, row.metric, row.outcome]),
							),
						]),
			);
		} else if (scoreRows !== null) section("## Scores", scoreRows);

		const notes = resultNotes(result);
		if (notes.length > 0)
			section(
				"## How far to trust the result",
				notes.map(note => plainBullet(withoutModels(note.text, result))).join("\n"),
			);

		const measured = entries.flatMap(entry => measurements(entry, named(entry.label)));
		if (measured.length > 0) section("## Tests and benchmarks", ...measured);

		if (result.unsure.length > 0)
			section("## What the reviewer could not tell", result.unsure.map(item => bullet(item)).join("\n"));
	}

	const spent = costTotal(bakeoff.costs);
	const byStage = stageCostLine(bakeoff.costs);
	if (spent > 0 || byStage !== null)
		section(
			"## Cost",
			[`- Total: ${fmtCost(spent)}`, ...(byStage === null ? [] : [`- By stage: ${byStage}`])].join("\n"),
		);
	if (bakeoff.warnings.length > 0)
		section("## Notes from the run", bakeoff.warnings.map(warning => bullet(warning)).join("\n"));

	const cited = reportCitations(bakeoff);
	if (cited.shown.length > 0 || cited.omitted > 0)
		section(
			"## Cited code",
			...cited.shown.map(citation => citedCode(citation, excerpts.get(excerptKey(citation.label, citation.ref)))),
			...(cited.omitted === 0
				? []
				: [
						`${cited.omitted} more ${cited.omitted === 1 ? "citation was" : "citations were"} left out of this report to keep it short.`,
					]),
		);

	if (bakeoff.mode === "design") {
		const designs = entries.map(
			entry => `### ${named(entry.label)}\n\n${designBody(bakeoff, entry, 4, written => embedText(written, 4))}`,
		);
		if (designs.length > 0) section("## Designs", ...designs);
	}

	return `${sections.join("\n\n")}\n`;
}

function entrySection(entry: BakeoffEntry, name: string, result: BakeoffResult | undefined): string {
	const ranked = result?.ranking.find(item => item.label === entry.label);
	const lines = [`- Status: ${entryStatusWord(entry.status)}`];
	const cost = entryCostText(entry);
	if (cost !== null) lines.push(`- Cost: ${cost}`);
	const flags = mergedFlags(entry.flags, ranked?.flags);
	if (flags.length > 0) lines.push(`- Flags: ${flags.map(oneLine).join(", ")}`);
	if (entry.facts !== undefined) for (const item of factItems(entry.facts)) lines.push(plainBullet(item.text));
	return `### ${name}\n\n${lines.join("\n")}`;
}

/** What each entry's test run and benchmark found, one block per entry that has either. */
function measurements(entry: BakeoffEntry, name: string): string[] {
	const facts = entry.facts;
	if (facts === undefined || (facts.tests === undefined && facts.bench === undefined)) return [];
	const lines: string[] = [];
	const tests = facts.tests;
	if (tests !== undefined) {
		const why = tests.reason ?? tests.note;
		const verdict = tests.ok === true ? "passed" : tests.ok === false ? "failed" : "not verified";
		lines.push(`- Tests ${inlineCode(tests.target)}: ${verdict}${why ? ` — ${oneLine(why)}` : ""}`);
	}
	const bench = facts.bench;
	if (bench !== undefined) {
		const better = `${bench.better} is better`;
		if (bench.value === null)
			lines.push(
				`- Benchmark ${inlineCode(bench.target)}: not measured${bench.reason ? ` — ${oneLine(bench.reason)}` : ""} (${better})`,
			);
		else {
			const unit = bench.unit ? ` ${bench.unit}` : "";
			const runs = bench.runs.length > 1 ? `; runs: ${bench.runs.join(", ")}` : "";
			lines.push(`- Benchmark ${inlineCode(bench.target)}: ${bench.value}${unit} (${better}${runs})`);
		}
	}
	return [`### ${name}\n\n${lines.join("\n")}`];
}

/** The per-metric scores of every scored entry, best ranked first; null when nobody scored anything. */
function scoreTable(bakeoff: Bakeoff, result: BakeoffResult, named: (label: string) => string): string | null {
	const metrics = scoreMetrics(result, bakeoff.metrics);
	const ranked = rankRows(result).map(row => row.label);
	const labels = [
		...ranked,
		...Object.keys(result.scores)
			.filter(label => !ranked.includes(label))
			.sort(),
	];
	const rows: string[][] = [];
	for (const label of labels)
		for (const metric of metrics) {
			const shown = scoreCell(result.scores[label]?.[metric.id]);
			if (shown.parts.length === 0 && shown.combined === null) continue;
			const part = (kind: "reviewer" | "judge" | "measured"): string =>
				shown.parts.find(item => item.kind === kind)?.text ?? "–";
			rows.push([
				named(label),
				metric.label,
				part("reviewer"),
				part("judge"),
				part("measured"),
				shown.combined ?? "–",
			]);
		}
	return rows.length === 0 ? null : table(["Entry", "Metric", "Reviewer", "Judge", "Measured", "Combined"], rows);
}

/** One cited line: `Entry A — src/q.ts:41`, then the code around it, or a note that there is none. */
function citedCode(citation: ReportCitation, excerpt: BlueprintExcerpt | null | undefined): string {
	const { label, ref } = citation;
	const head = `### Entry ${label} — ${ref.path}:${ref.line}`;
	if (excerpt === null || excerpt === undefined) return `${head}\n\nThe code was not available.`;
	const last = excerpt.start + Math.max(0, excerpt.lines.length - 1);
	const caption = `Lines ${excerpt.start}–${last}; the cited line is ${excerpt.line}${excerpt.side === "base" ? ", from the code before the change" : ""}.`;
	const language = (excerpt.language ?? "").replace(/[^\w+#.-]/g, "");
	return `${head}\n\n${caption}\n\n${fence(excerpt.lines.join("\n"), language)}`;
}
