/**
 * The brief of a sparring session's agent (see ./companion-spar): what the omp session is told. How the session is kept
 * read-only and noticed to be done is ./companion-agent. The session writes the points and their case files as JSON to a
 * file outside the repository; the companion reads it and verifies it (./companion-spar-verify).
 */

import { SPAR_DESIGN_PATH, SPAR_MAX_POINTS } from "@oh-my-pi/pi-wire/spar";
import { fillTemplate } from "./companion-agent";
import { type BriefPart, fenced, partSection } from "./companion-quiz-agent";
import promptTemplate from "./companion-spar-prompt.md" with { type: "text" };

export interface SparBriefInput {
	repo: string;
	/** Short statement of what is challenged: `branch feature vs main`, `pull requests #1, #2 and #3`, `a design document`. */
	subject: string;
	/** What the working directory is: `the last pull request's head`. */
	checkout: string;
	outFile: string;
	maxCostUsd: number;
	/** True when the parts are the pull requests of a stack, in stack order. */
	stack: boolean;
	parts: BriefPart[];
	/** The design document: its name and text, as pasted or read from the repository. */
	doc?: { name: string; text: string };
	/** The conversation of the session the changes came from, rendered. */
	digest?: { text: string; turns: number; omitted: number };
}

/** The text of a document with its line numbers, as the citations `@design@line@token` count them. */
export function numberLines(text: string): string {
	const lines = text.split(/\r?\n/);
	const width = String(lines.length).length;
	return lines.map((line, index) => `${String(index + 1).padStart(width)}  ${line}`).join("\n");
}

function documentSection(doc: NonNullable<SparBriefInput["doc"]>, hasChange: boolean): string {
	const role = hasChange
		? "It is the claim: what the developer says the work does and why. The parts above are what was built. Challenge the document where the code does not do what it says, and where the document leaves a decision unexplained."
		: "There is no diff: the document is the work, and the checkout is the code it describes. Challenge its decisions, and check its claims about the code against the checkout.";
	return `# The design document

${fenced(doc.name, "text")}

${role} Its lines are numbered; cite one as \`${SPAR_DESIGN_PATH}@<line>@token\`, for example \`${SPAR_DESIGN_PATH}@12@a second queue\`. Cite code in the usual way.

${fenced(numberLines(doc.text), "text")}

`;
}

function sessionSection(digest: NonNullable<SparBriefInput["digest"]>): string {
	const cut = digest.omitted > 0 ? ` ${digest.omitted} older turns were left out to fit.` : "";
	return `# The conversation the work came from

The developer made this work in a session with an AI agent. This is that conversation: ${digest.turns} turns, the developer's messages and the agent's replies, without tool output.${cut} Use it to find the decisions that deserve a challenge and the reasons that were given for them. Check every reason against the code: the conversation can be wrong or out of date, and the code wins. Do not make a point about the conversation itself (who said what), only about the code and why it is the way it is. Do not quote it at length.

${fenced(digest.text.trim(), "text")}

`;
}

/** The first message of the sparring session. */
export function buildSparBrief(input: SparBriefInput): string {
	const count = input.parts.length;
	const hasChange = input.parts.some(part => !part.noDiff);
	return fillTemplate(promptTemplate, {
		repo: input.repo,
		subject: input.subject,
		checkout: input.checkout,
		outFile: input.outFile,
		partCount: String(count),
		plural: count === 1 ? "" : "s",
		partsNote: input.stack
			? "They are the pull requests of one stack, bottom first: each builds on the one before, and a point may ask how a later part depends on an earlier one."
			: count === 1
				? "It is one piece of work."
				: "They are separate pieces of work.",
		reading: hasChange
			? "Each part below gives what it is, then its diff. Read the diff, then read the code around it in the checkout until you understand why the change works, not only what it changed.\n\nHow to read a diff here: a file header `### path (modified|added|removed|renamed from old/path)`, git's `@@` hunk header, then one line per diff line: a marker (` ` context, `+` added, `-` removed), a line number, two spaces, the text. Context and added lines carry the line number in the NEW version of the file: cite them as `path@<number>@token`. Removed lines carry the line number in the OLD version: cite them as `base:path@<number>@token`. Files or lines may be cut to fit; a note says so. The checkout is the NEW version of the last part, so lines of earlier parts may have moved: that is why a citation has a token."
			: "",
		parts: input.parts.map(partSection).join("\n\n"),
		document: input.doc ? documentSection(input.doc, hasChange) : "",
		session: input.digest ? sessionSection(input.digest) : "",
		whyRule: input.digest
			? "Where the conversation below covers a part, at least one of its points tests a stated reason against the code. When the code and the reason disagree, the code wins and the disagreement is the point."
			: "There is no conversation to draw on: ask what the code and the document leave unsaid.",
		maxPoints: String(SPAR_MAX_POINTS),
		maxCost: String(input.maxCostUsd),
	});
}
