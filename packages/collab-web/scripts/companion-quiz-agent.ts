/**
 * The brief of a quiz's agent (see ./companion-quiz): what the omp session is told. How the session is kept read-only and
 * noticed to be done is ./companion-agent, which the architecture maps use too. The session writes the questions and
 * their answer keys as JSON to a file outside the repository; the companion reads it and verifies it
 * (./companion-quiz-verify).
 */

import { fillTemplate } from "./companion-agent";
import promptTemplate from "./companion-quiz-prompt.md" with { type: "text" };

/** Default spending limit of a quiz, USD: writing the questions and grading every open answer. */
export const DEFAULT_QUIZ_MAX_COST_USD = 1;

const MAX_BODY_CHARS = 2_000;
const MAX_STAT_CHARS = 3_000;

/** One part of a quiz as the brief shows it. */
export interface BriefPart {
	title: string;
	/** What it is: `pull request #12 (feature → main)`, `branch feature vs main`. */
	about: string;
	/** The pull request's description, when it has one. */
	body?: string;
	stat: string;
	/** The numbered diff from ./companion-quiz-diff; empty with `noDiff` for a part that has none. */
	diff: string;
	/** A part that is not a change (a design document checked against the code): it has no diff to show. */
	noDiff?: boolean;
}

export interface QuizBriefInput {
	repo: string;
	/** Short statement of what changed: `branch feature vs main`, `pull requests #1, #2 and #3`. */
	subject: string;
	/** What the working directory is: `the last pull request's head`. */
	checkout: string;
	outFile: string;
	maxCostUsd: number;
	/** True when the parts are the pull requests of a stack, in stack order. */
	stack: boolean;
	parts: BriefPart[];
	/** The conversation of the session the changes came from, rendered. */
	digest?: { text: string; turns: number; omitted: number };
}

/** A code fence longer than any run of backticks in `text`, so quoted code never closes it early. */
export function fenced(text: string, info = ""): string {
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(longest + 1);
	return `${fence}${info}\n${text}\n${fence}`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[… cut]`;
}

/** The brief's section of one part. */
export function partSection(part: BriefPart, index: number): string {
	const out = [`## Part ${index + 1}: ${part.title}`, "", part.about];
	if (part.body && part.body.trim() !== "")
		out.push(
			"",
			"Its description, as its author wrote it:",
			"",
			fenced(clip(part.body.trim(), MAX_BODY_CHARS), "text"),
		);
	if (part.noDiff) return out.join("\n");
	if (part.stat.trim() !== "")
		out.push("", "Changed files:", "", fenced(clip(part.stat.trim(), MAX_STAT_CHARS), "text"));
	out.push("", "The diff:", "", fenced(part.diff.trim() === "" ? "(no textual changes)" : part.diff.trim(), "text"));
	return out.join("\n");
}

function sessionSection(digest: NonNullable<QuizBriefInput["digest"]>): string {
	const cut = digest.omitted > 0 ? ` ${digest.omitted} older turns were left out to fit.` : "";
	return `# The conversation the changes came from

The developer made these changes in a session with an AI agent. This is that conversation: ${digest.turns} turns, the developer's messages and the agent's replies, without tool output.${cut} Use it to ask **why**: the intent, the constraints, the alternatives that were rejected, the surprises. Where the conversation covers a part, at least one of its questions should test the reason behind a decision rather than the mechanics. Check every reason against the code: the conversation can be wrong or out of date, and the code wins. Do not ask about the conversation itself (who said what), only about the code and why it is the way it is. Do not quote it at length.

${fenced(digest.text.trim(), "text")}

`;
}

/** The first message of the quiz session. */
export function buildQuizBrief(input: QuizBriefInput): string {
	const count = input.parts.length;
	return fillTemplate(promptTemplate, {
		repo: input.repo,
		subject: input.subject,
		checkout: input.checkout,
		outFile: input.outFile,
		partCount: String(count),
		plural: count === 1 ? "" : "s",
		partsNote: input.stack
			? "They are the pull requests of one stack, bottom first: each builds on the one before, and a question may ask how a later part depends on an earlier one."
			: count === 1
				? "It is one set of changes."
				: "They are separate sets of changes.",
		parts: input.parts.map(partSection).join("\n\n"),
		session: input.digest ? sessionSection(input.digest) : "",
		maxCost: String(input.maxCostUsd),
	});
}
