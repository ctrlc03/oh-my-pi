/**
 * The briefs of a quiz's agent (see ./companion-quiz): what the omp session is told. How the session is kept read-only and
 * noticed to be done is ./companion-agent, which the architecture maps use too. The session writes the questions and
 * their answer keys as JSON to a file outside the repository; the companion reads it and verifies it
 * (./companion-quiz-verify). A quiz on changes is briefed with the numbered diff of each part; a quiz on a session's
 * topic with the folder's files and the conversation. Either leans on a {@link QuizFocus}; the quiz of a high-stakes
 * session also asks for a share of design and understanding questions.
 */

import { QUIZ_STAKES_TOPIC_SHARE, type QuizFocus } from "@oh-my-pi/pi-wire/quiz";
import { fillTemplate } from "./companion-agent";
import promptTemplate from "./companion-quiz-prompt.md" with { type: "text" };
import topicTemplate from "./companion-quiz-topic-prompt.md" with { type: "text" };

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
	/** The conversation of the session the changes came from, rendered; with entry ids when `sessionCites` is set. */
	digest?: { text: string; turns: number; omitted: number };
	/** What the questions lean on; absent: `mixed`. */
	focus?: QuizFocus;
	/**
	 * The quiz of a high-stakes session: about {@link QUIZ_STAKES_TOPIC_SHARE} of the questions are about the design and
	 * the ideas behind the changes. `delta`: the changes are those since the last passed quiz, and those questions
	 * concern them only.
	 */
	stakes?: { delta: boolean };
	/** The digest marks its messages with entry ids and a question may cite one (`session`). Needs `digest`. */
	sessionCites?: boolean;
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

function sessionSection(digest: NonNullable<QuizBriefInput["digest"]>, cites: boolean): string {
	const cut = digest.omitted > 0 ? ` ${digest.omitted} older turns were left out to fit.` : "";
	return `# The conversation the changes came from

The developer made these changes in a session with an AI agent. This is that conversation: ${digest.turns} turns, the developer's messages and the agent's replies, without tool output.${cut} Use it to ask **why**: the intent, the constraints, the alternatives that were rejected, the surprises. Where the conversation covers a part, at least one of its questions should test the reason behind a decision rather than the mechanics. Check every reason against the code: the conversation can be wrong or out of date, and the code wins. Do not ask about the conversation itself (who said what), only about the code and why it is the way it is. Do not quote it at length.${cites ? ` Each message starts with \`[#<id>]\`, its entry id, which a question can cite (see below).` : ""}

${fenced(digest.text.trim(), "text")}

`;
}

/** How to cite a message of the conversation, for a brief that allows it. */
const SESSION_CITE_RULE =
	'A question may cite a message of the conversation, in `session`, instead of code or as well as it: `"session": [{"entry": "<id>", "quote": "<passage>"}]`. `entry` is the id in the `[#<id>]` marker in front of the message; `quote` is a passage of at least 12 characters copied exactly from that message (whitespace aside), never a paraphrase and never from another message. A citation that does not hold is dropped, and a question left with no citation at all is dropped with it.';

const CHANGES_FOCUS: Record<QuizFocus, string> = {
	mixed: "",
	understanding:
		"Focus of this quiz: **understanding**. Weight the questions towards the ideas the changes rest on: the technique, protocol, data structure or domain concept they use, why it exists and what it guarantees or costs, in general terms, with the cited code as the place where it shows up. Fewer questions about exact mechanics.",
	design:
		"Focus of this quiz: **design**. Weight the questions towards the choices made in the changes and their trade-offs: why this approach over the alternatives, what constraint drove it, what it costs, what would change if the constraint did.",
	implementation:
		"Focus of this quiz: **implementation**. Weight the questions towards how the code does it: control flow, data flow, ordering, what calls what, what is decided at runtime and what at compile time.",
};

/** The share of the questions a high-stakes quiz asks about design and ideas, as a phrase. */
const STAKES_SHARE_PHRASE = `about a quarter (${Math.round(QUIZ_STAKES_TOPIC_SHARE * 100)} %)`;

function stakesAngle(delta: boolean, cites: boolean): string {
	const grounded = cites
		? "They stay grounded: cite the changed code as usual, or a message of the conversation in `session`."
		: "They stay grounded: cite the changed code as usual.";
	const which = delta
		? "The changes are the ones made since the last quiz the developer passed: these questions concern the new changes only, never the older code around them."
		: "These questions concern the changes below.";
	return `Mix of this quiz: it unlocks a push, so most of the questions are about the changes themselves as above, but ${STAKES_SHARE_PHRASE} of them (at least one, and never more than a third) must be **design and understanding** questions instead: why this approach over the alternatives, what trade-off it makes, what idea or concept it rests on and what that guarantees. ${which} ${grounded} Spread them over the parts; the rest are about the mechanics of the changes.`;
}

/** What the brief says about the focus, the mix and conversation citations, as paragraphs ending in a blank line; empty for a plain mixed quiz. */
export function changesAngle(input: Pick<QuizBriefInput, "focus" | "stakes" | "sessionCites">): string {
	const cites = input.sessionCites === true;
	const paragraphs = [
		CHANGES_FOCUS[input.focus ?? "mixed"],
		input.stakes ? stakesAngle(input.stakes.delta, cites) : "",
		cites ? SESSION_CITE_RULE : "",
	].filter(paragraph => paragraph !== "");
	return paragraphs.map(paragraph => `${paragraph}\n\n`).join("");
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
		session: input.digest ? sessionSection(input.digest, input.sessionCites === true) : "",
		angle: changesAngle({
			focus: input.focus,
			stakes: input.stakes,
			sessionCites: input.sessionCites === true && input.digest !== undefined,
		}),
		maxCost: String(input.maxCostUsd),
	});
}

// ── a quiz on a session's topic ──────────────────────────────────────────────

/** Files of the folder named in a brief, at most; the agent can list the rest itself. */
const MAX_BRIEF_FILES = 300;

export interface TopicBriefInput {
	/** Name of the folder, for the brief. */
	repo: string;
	/** What the working directory is: `a copy of the folder's files as they are now`. */
	checkout: string;
	outFile: string;
	maxCostUsd: number;
	focus: QuizFocus;
	/** The folder holds source code: implementation questions are possible. */
	code: boolean;
	/** The files of the folder, relative to it. */
	files: readonly string[];
	/** The conversation of the session, rendered with entry ids; absent when it could not be read. */
	digest?: { text: string; turns: number; omitted: number };
}

function topicSources(input: TopicBriefInput): string {
	const lines: string[] = [];
	if (input.digest) {
		const cut = input.digest.omitted > 0 ? ` ${input.digest.omitted} older turns were left out to fit.` : "";
		lines.push(
			`1. **The conversation.** The developer worked on this with an AI agent. This is that conversation: ${input.digest.turns} messages, the developer's and the agent's, without tool output.${cut} It tells you what the subject is, what was asked for, what was weighed and decided, and what went wrong. Each message starts with \`[#<id>]\`, its entry id, which a question can cite. The conversation can be wrong or out of date: where a file contradicts it, the file wins. Do not quote it at length.`,
		);
	} else {
		lines.push(
			"1. **The conversation** could not be read. Ask from the files and from general background only; never write a `session` citation.",
		);
	}
	lines.push(
		input.files.length > 0
			? `2. **The files in the folder** (your working directory): design documents, notes, code. Read them with the tools; the list is below. A question may cite a line of one as \`path@line@token\`.`
			: "2. **The files in the folder**: there are none to read. Never write a `refs` citation.",
	);
	lines.push(
		input.focus === "implementation"
			? "3. General background is not used by this quiz: every question is about the code."
			: '3. **General background knowledge of the topic**, including what the conversation and the files never covered but anyone who worked on this subject should know. Such a question is marked `"background": true`. Rules for it, which are strict: write only well-established material that a good textbook or the official documentation of the technique states the same way; never invent a fact, a name, a number, a benchmark or a version-specific detail; if you are not sure of an answer, do not write the question. It cites nothing, and it MUST carry an `explanation` (1–3 sentences stating the facts the answer rests on). A background multiple-choice question needs one definitively right choice, and the distractors must be definitively wrong, not matters of opinion.',
	);
	return lines.join("\n\n");
}

function topicFocus(input: TopicBriefInput): string {
	const split = input.code
		? "about a third understanding (the concepts), about a third design (the choices and trade-offs) and about a third implementation (how the code does it)"
		: "about half understanding (the concepts) and half design (the choices and trade-offs); the folder holds no code, so ask no implementation question";
	switch (input.focus) {
		case "understanding":
			return "**Understanding.** Ask about the concepts of the topic: what the ideas are, how they differ from each other, why they work, what they guarantee, cost or rule out, in general terms. Draw on what the conversation covered and on the topic's general background, including what the session never reached but anyone working on this topic should know. About half of the questions should be background questions; the others are tied to the conversation or the files. Do not ask about the implementation unless a concept is only clear through it.";
		case "design":
			return "**Design.** Ask about the choices made and their trade-offs: why this approach over the alternatives the conversation weighed or rejected, what constraint drove it, what it costs, what would change if the constraint did, which risk was accepted. Cite the message where a choice was discussed and the file where it is written down. A background question is allowed for the general trade-off a choice sits on when the session left it open. Do not ask how the code does it.";
		case "implementation":
			return "**Implementation.** Ask how the implementation does it: control flow, data flow, ordering, state, what the code relies on, what happens at runtime and what only when it is written, what breaks if a line is removed. Every question cites code in the folder (`refs`); a question about a message of the conversation is fine as an addition. Write no background question.";
		default:
			return `**Mixed.** Spread the questions over the three kinds: ${split}. Within a kind use whichever source fits: the conversation, the files, or background knowledge.`;
	}
}

function topicCitations(input: TopicBriefInput): string {
	const out: string[] = [];
	if (input.files.length > 0)
		out.push(
			"  - `refs`: 1–3 citations of lines of files in the folder, written `path@line@token`, `path` relative to the folder. `token` is a short piece of text that occurs on that line, copied exactly. The developer sees the cited lines beside the question, so cite what they need to reason about, and never a line that gives the answer away. A citation that does not hold is dropped.",
		);
	if (input.digest) out.push(`  - \`session\`: 1–2 citations of messages of the conversation. ${SESSION_CITE_RULE}`);
	if (input.focus !== "implementation")
		out.push(
			'  - `"background": true` and an `explanation`, and no `refs` and no `session`, for a question of general background knowledge.',
		);
	out.push(
		"  Every question needs at least one of these (a question with no citation that holds and no `background` is dropped).",
	);
	return out.join("\n");
}

function topicQuestionCount(input: TopicBriefInput): string {
	return input.focus === "implementation" || !input.digest ? "6–8" : "6–8 (a small subject may have fewer; never pad)";
}

function topicFiles(files: readonly string[]): string {
	if (files.length === 0) return "";
	const shown = files.slice(0, MAX_BRIEF_FILES);
	const more = files.length > shown.length ? `\n[… ${files.length - shown.length} more files]` : "";
	return `# The files in the folder\n\n${fenced(`${shown.join("\n")}${more}`, "text")}\n\n`;
}

/** The first message of a quiz session on the topic of a session. */
export function buildTopicBrief(input: TopicBriefInput): string {
	return fillTemplate(topicTemplate, {
		subject: `the session in the folder \`${input.repo}\``,
		checkout: input.checkout,
		outFile: input.outFile,
		sources: topicSources(input),
		focus: topicFocus(input),
		count: topicQuestionCount(input),
		citations: topicCitations(input),
		material: `${topicFiles(input.files)}${input.digest ? `# The conversation\n\n${fenced(input.digest.text.trim(), "text")}\n\n` : ""}`,
		maxCost: String(input.maxCostUsd),
	});
}
