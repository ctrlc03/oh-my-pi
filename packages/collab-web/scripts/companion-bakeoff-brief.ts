/**
 * What the sessions of a bake-off are told (docs/design-review.md, *Prompt files to add*): the designers of design mode,
 * the neutral writer, the reviewer, and the first prompt of an implementation challenger. How a read-only session is
 * kept read-only and noticed to be done is ./companion-agent; the prompts are the .md files beside this one.
 */

import type { BakeoffMetric } from "@oh-my-pi/pi-wire/bakeoff";
import { fillTemplate } from "./companion-agent";
import designTemplate from "./companion-bakeoff-design-prompt.md" with { type: "text" };
import { renderMetrics } from "./companion-bakeoff-metrics";
import reviewTemplate from "./companion-bakeoff-review-prompt.md" with { type: "text" };
import writeupTemplate from "./companion-bakeoff-writeup-prompt.md" with { type: "text" };
import { fenced } from "./companion-quiz-agent";

const MAX_PROBLEM_BODY_CHARS = 6_000;
const MAX_DOC_BRIEF_CHARS = 30_000;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[… cut]`;
}

/** The problem as the sessions read it: the person's own words, the document, the pull request's description, the session's conversation. */
export interface ProblemInput {
	/** What the bake-off is about, one line: `feature/x vs main`, `PR #12`, `a design document`. */
	subject: string;
	/** The statement of the goal the person typed, for a challenger that starts from the base. */
	goal?: string;
	/** Design or claim the entries answer. */
	doc?: { name?: string; text: string };
	/** Description of the pull request, when the original is one. */
	pr?: { title: string; body?: string };
	/** The conversation of the session the original came from, rendered. */
	digest?: string;
}

/** The problem statement every session of one bake-off reads (and the judge reads a cut of). */
export function problemText(input: ProblemInput): string {
	const out: string[] = [`This is about ${input.subject}.`];
	if (input.goal && input.goal.trim() !== "")
		out.push("", "The goal, as the person states it:", "", fenced(input.goal.trim(), "text"));
	if (input.pr)
		out.push(
			"",
			`The pull request is titled "${input.pr.title}".`,
			...(input.pr.body && input.pr.body.trim() !== ""
				? [
						"Its description, as its author wrote it:",
						"",
						fenced(clip(input.pr.body.trim(), MAX_PROBLEM_BODY_CHARS), "text"),
					]
				: []),
		);
	if (input.doc)
		out.push(
			"",
			input.doc.name ? `The design document (${input.doc.name}):` : "The design document:",
			"",
			fenced(clip(input.doc.text.trim(), MAX_DOC_BRIEF_CHARS), "markdown"),
		);
	if (input.digest && input.digest.trim() !== "")
		out.push(
			"",
			"The conversation the change came from (the developer's messages and an AI agent's replies, without tool output). It says what the person wanted and what they ruled out; the code wins where they disagree:",
			"",
			fenced(clip(input.digest.trim(), MAX_PROBLEM_BODY_CHARS * 2), "text"),
		);
	return out.join("\n");
}

/** `"simplicity": "one sentence of evidence", …`: the `metrics` object of the write-up template. */
function metricKeys(metrics: readonly BakeoffMetric[]): string {
	return metrics.map(metric => `"${metric.id}": "one sentence of evidence"`).join(", ");
}

function instructionsSection(instructions: string | undefined): string {
	return instructions && instructions.trim() !== ""
		? `# What the person added\n\n${fenced(instructions.trim(), "text")}\n\n`
		: "";
}

export interface DesignBriefInput {
	repo: string;
	subject: string;
	/** What the working directory is: `the code the design is about`. */
	checkout: string;
	outFile: string;
	maxCostUsd: number;
	problem: string;
	/** The design or change to beat, as text (the document, or the numbered diff of the change). */
	subjectBody: string;
	metrics: readonly BakeoffMetric[];
	measured: ReadonlySet<string>;
	instructions?: string;
}

/** The first message of a design-mode challenger. */
export function buildDesignBrief(input: DesignBriefInput): string {
	return fillTemplate(designTemplate, {
		repo: input.repo,
		subject: input.subject,
		checkout: input.checkout,
		outFile: input.outFile,
		maxCost: String(input.maxCostUsd),
		problem: `${input.problem}\n\n# The design to do better than\n\n${input.subjectBody}`,
		metrics: renderMetrics(input.metrics, input.measured),
		metricKeys: metricKeys(input.metrics),
		instructions: instructionsSection(input.instructions),
	});
}

export interface WriteupBriefInput {
	repo: string;
	/** What the working directory holds: `the code of one solution`, `a design document`. */
	subject: string;
	outFile: string;
	maxCostUsd: number;
	problem: string;
	/** The numbered diff, or the document, of the entry. */
	subjectBody: string;
	metrics: readonly BakeoffMetric[];
}

/** The first message of the neutral writer. */
export function buildWriteupBrief(input: WriteupBriefInput): string {
	return fillTemplate(writeupTemplate, {
		repo: input.repo,
		subject: input.subject,
		outFile: input.outFile,
		maxCost: String(input.maxCostUsd),
		problem: input.problem,
		subjectBody: input.subjectBody,
		metrics: renderMetrics(input.metrics, new Set()),
		metricKeys: metricKeys(input.metrics),
	});
}

/** One entry as the reviewer's brief shows it. */
export interface ReviewEntryInput {
	/** The label the reviewer reads. */
	label: string;
	/** The folder of the entry inside the working directory. */
	folder: string;
	/** The write-up as markdown, scrubbed. */
	writeup: string;
	/** One line of measured facts, or `No measured facts.` */
	facts: string;
	flags: readonly string[];
	/** Changed files and numbered diff against the base (implementation mode). */
	stat?: string;
	diff?: string;
}

function entrySection(entry: ReviewEntryInput): string {
	const out = [
		`## Entry ${entry.label}`,
		"",
		`Its folder: \`${entry.folder}/\`.`,
		"",
		"Its write-up:",
		"",
		fenced(entry.writeup.trim(), "markdown"),
		"",
		`Measured facts: ${entry.facts}`,
	];
	if (entry.flags.length > 0) out.push("", `Flags: ${entry.flags.join("; ")}.`);
	if (entry.stat && entry.stat.trim() !== "") out.push("", "Changed files:", "", fenced(entry.stat.trim(), "text"));
	if (entry.diff !== undefined)
		out.push(
			"",
			"The diff against the base:",
			"",
			fenced(entry.diff.trim() === "" ? "(no textual changes)" : entry.diff.trim(), "text"),
		);
	return out.join("\n");
}

export interface ReviewBriefInput {
	repo: string;
	outFile: string;
	maxCostUsd: number;
	problem: string;
	metrics: readonly BakeoffMetric[];
	measured: ReadonlySet<string>;
	/** In the order the reviewer reads them. */
	entries: readonly ReviewEntryInput[];
	/** Extra line about how to read the folders (design mode: the shared code folder). */
	folderNote?: string;
}

/** The first message of the reviewer. `labels` are the ones the reviewer reads. */
export function buildReviewBrief(input: ReviewBriefInput): string {
	const labels = input.entries.map(entry => entry.label);
	const first = input.metrics[0];
	return fillTemplate(reviewTemplate, {
		repo: input.repo,
		entryCount: String(input.entries.length),
		labels: labels.join(", "),
		folders: `${input.entries.map(entry => `\`${entry.folder}/\``).join(", ")}${input.folderNote ? `; ${input.folderNote}` : ""}`,
		outFile: input.outFile,
		maxCost: String(input.maxCostUsd),
		problem: input.problem,
		metrics: renderMetrics(input.metrics, input.measured),
		entries: input.entries.map(entrySection).join("\n\n"),
		scoreExample: input.metrics
			.map(metric => `"${metric.id}": ${first && metric.id === first.id ? 4 : 3}`)
			.join(", "),
	});
}

/** First prompt of an implementation challenger (through the fan-out's `prompt`). */
export function buildImplementationPrompt(input: {
	problem: string;
	metrics: readonly BakeoffMetric[];
	measured: ReadonlySet<string>;
	instructions?: string;
	/** `start: "original"`: the folder already holds the original's code; else it holds the base. */
	startsFromOriginal: boolean;
	testCommand?: string;
}): string {
	const out = [
		input.startsFromOriginal
			? "This folder holds one attempt at the problem below. Improve it against the things that matter. You may keep, rework or discard what is there."
			: "This folder holds the code before the problem below was addressed. Solve the problem against the things that matter, your own way.",
		"",
		"# The problem",
		"",
		input.problem,
		"",
		"# What matters",
		"",
		"The person cares about these, in this order, each with a weight. Others are doing the same task; the best result wins.",
		"",
		renderMetrics(input.metrics, input.measured),
	];
	if (input.instructions && input.instructions.trim() !== "")
		out.push("", "# What the person added", "", fenced(input.instructions.trim(), "text"));
	out.push(
		"",
		"# Rules",
		"",
		"- Work only in this folder.",
		input.testCommand
			? `- Finish with the tests passing: \`${input.testCommand}\`. Do not edit the test script or what it runs to make it pass.`
			: "- Finish with a working change.",
		"- Do not write documentation files, and do not commit or push.",
		"- Do not name yourself or your model in the code or in comments.",
	);
	return out.join("\n");
}
