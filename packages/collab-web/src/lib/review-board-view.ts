/**
 * The review board's logic, apart from React: a file's diff grouped into hunks that line up with the agent's
 * notes and the reviewer's comments, the layout a width calls for, per-hunk syntax highlighting, converting
 * what the app already has (a turn's files, the branch review) into board files, and the prompt that carries
 * the comments back to the agent.
 */
import type { TurnDiffFile } from "@oh-my-pi/pi-wire";
import type { GitFileChange } from "./companion";
import { HIGHLIGHT_MAX_CHARS } from "./highlight";
import {
	buildReviewPrompt,
	commentLayout,
	type DiffRow,
	isLineRow,
	parseUnifiedDiff,
	type ReviewComment,
	type ReviewScope,
	rowKey,
} from "./review-comments";
import type { BoardFile, HunkNote, ReviewSubject, StackPr } from "./review-board";
import { subjectKey } from "./review-board";
import { type SplitLine, splitLines } from "./split-diff";

/** Four columns (old, new, agent, comments), three (unified, agent, comments) or everything stacked. */
export type BoardLayout = "four" | "three" | "stacked";

/** Widest sheet the stacked layout still fits in: below this width columns would be too narrow to read. */
const THREE_MIN = 860;
/** The sheet width from which old and new code sit side by side next to the notes and comments. */
const FOUR_MIN = 1040;

/** The layout for the board area's width in layout pixels; a phone always stacks. */
export function boardLayout(width: number, phone: boolean): BoardLayout {
	if (phone || width < THREE_MIN) return "stacked";
	return width >= FOUR_MIN ? "four" : "three";
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * The part of a hunk header notes are anchored by, `@@ -a,b +c,d @@`: what follows it (the enclosing function a
 * tool may print) is context, not identity.
 */
export function hunkKey(header: string): string {
	return HUNK_HEADER.exec(header)?.[0] ?? header.trim();
}

/** One `@@` hunk of a file's diff. */
export interface HunkBlock {
	/** Position among the file's hunks. */
	index: number;
	/** The header line as it appears in the diff. */
	header: string;
	/** `hunkKey(header)`: how notes find it. */
	key: string;
	/** Row index of the header in the file's `rows`. */
	headerRow: number;
	/** First and last row of the body, inclusive; `last < first` for an empty body. */
	first: number;
	last: number;
	/** The body as side-by-side display lines (row indexes into the file's `rows`). */
	lines: SplitLine[];
}

/** A file's diff, parsed. */
export interface ParsedFile {
	rows: DiffRow[];
	hunks: HunkBlock[];
	/** Text of a diff with no hunk at all (a binary notice, a mode change): shown as is. */
	notice: string[];
}

function shiftLine(line: SplitLine, by: number): SplitLine {
	if (line.kind === "full") return { kind: "full", row: line.row + by };
	return {
		kind: "pair",
		left: line.left === null ? null : line.left + by,
		right: line.right === null ? null : line.right + by,
	};
}

/** Groups `parseUnifiedDiff`'s rows by `@@` header; a `\ No newline` marker belongs to the hunk it follows. */
export function parseFile(diff: string): ParsedFile {
	const rows = parseUnifiedDiff(diff);
	const headers: number[] = [];
	rows.forEach((row, i) => {
		if (row.kind === "hunk" && HUNK_HEADER.test(row.text)) headers.push(i);
	});
	if (headers.length === 0) {
		return { rows, hunks: [], notice: diff.trim().length === 0 ? [] : rows.map(row => row.text) };
	}
	const hunks = headers.map((headerRow, index): HunkBlock => {
		const first = headerRow + 1;
		const last = (headers[index + 1] ?? rows.length) - 1;
		const header = rows[headerRow]!.text;
		return {
			index,
			header,
			key: hunkKey(header),
			headerRow,
			first,
			last,
			lines: splitLines(rows.slice(first, last + 1)).map(line => shiftLine(line, first)),
		};
	});
	return { rows, hunks, notice: [] };
}

/** The hunk holding body row `row`, or -1. */
export function hunkOfRow(hunks: readonly HunkBlock[], row: number): number {
	for (const hunk of hunks) if (row >= hunk.headerRow && row <= hunk.last) return hunk.index;
	return -1;
}

/** The first and last commentable rows of a hunk (what a whole-hunk comment selects), or null for a hunk with none. */
export function hunkLineRange(rows: readonly DiffRow[], hunk: HunkBlock): { first: number; last: number } | null {
	let first = -1;
	let last = -1;
	for (let i = hunk.first; i <= hunk.last; i++) {
		if (!isLineRow(rows[i]!)) continue;
		if (first === -1) first = i;
		last = i;
	}
	return first === -1 ? null : { first, last };
}

/** One file's comments, placed under the hunk they end in, in row order; those no hunk holds any more are orphans. */
export function commentsByHunk(
	parsed: ParsedFile,
	comments: Readonly<Record<string, ReviewComment>> | undefined,
	scope: ReviewScope,
	path: string,
): {
	byHunk: Array<Array<[string, ReviewComment, number]>>;
	orphans: Array<[string, ReviewComment]>;
	marked: Record<number, true>;
} {
	const layout = commentLayout(parsed.rows, comments, scope, path);
	const byHunk: Array<Array<[string, ReviewComment, number]>> = parsed.hunks.map(() => []);
	const orphans = [...layout.orphans];
	for (const [row, entries] of Object.entries(layout.after)) {
		const at = Number(row);
		const hunk = hunkOfRow(parsed.hunks, at);
		for (const [id, c] of entries) {
			if (hunk === -1) orphans.push([id, c]);
			else byHunk[hunk]!.push([id, c, at]);
		}
	}
	for (const group of byHunk) group.sort((a, b) => a[2] - b[2]);
	return { byHunk, orphans, marked: layout.marked };
}

/** The agent's notes by file and hunk. */
export function indexNotes(notes: readonly HunkNote[]): Map<string, HunkNote[]> {
	const index = new Map<string, HunkNote[]>();
	for (const note of notes) {
		const id = noteId(note.path, note.hunk);
		const group = index.get(id);
		if (group === undefined) index.set(id, [note]);
		else group.push(note);
	}
	return index;
}

function noteId(path: string, header: string): string {
	return `${path}\u0000${hunkKey(header)}`;
}

/** The notes written for one hunk, in the order the host listed them. */
export function notesOf(index: ReadonlyMap<string, HunkNote[]>, path: string, header: string): readonly HunkNote[] {
	return index.get(noteId(path, header)) ?? [];
}

/**
 * Where a note came from, as the board's badge words it. A generated note that kept the session it was written
 * from (it rewrote a thin session note) says so.
 */
export function noteSource(note: HunkNote): string {
	const fromSession = note.sessionTitle || note.sessionId || note.turn !== undefined;
	if (note.source === "generated" && !fromSession) return "generated";
	const parts = [note.source === "generated" ? "generated from session" : "from session"];
	if (note.sessionTitle) parts.push(note.sessionTitle);
	if (note.turn !== undefined) parts.push(`turn ${note.turn}`);
	return parts.join(" · ");
}

/** A hash of the diffs, the notes' cache identity where no commit names the subject. Order of `files` does not matter. */
export function diffVersion(files: readonly { path: string; diff: string }[]): string {
	// cyrb53: 53 bits of a fast string hash is enough to tell one diff set from another.
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	const feed = (text: string): void => {
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
	};
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		feed(file.path);
		feed("\u0000");
		feed(file.diff);
		feed("\u0001");
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The scope a subject's comments carry (and are stored with). */
export function boardScope(subject: ReviewSubject): ReviewScope {
	return subject.kind === "pr" ? "pr" : subject.kind === "branch" ? "branch" : "turn";
}

/** The key a subject's unsent comments and viewed marks are stored under: per session, so two sessions never share a review. */
export function boardStorageKey(sessionId: string, subject: ReviewSubject): string {
	return `${sessionId}.board.${subjectKey(subject)}`;
}

/** A turn's files as board files. */
export function turnFilesToBoard(files: readonly TurnDiffFile[]): BoardFile[] {
	return files.map(file => ({
		path: file.path,
		status: file.status === "typechange" ? "modified" : file.status,
		diff: file.diff,
		added: file.added ?? 0,
		removed: file.removed ?? 0,
		...(file.truncated === true && { truncated: true }),
	}));
}

/** A branch-review file (its `git status --porcelain` code) with its diff as a board file. */
export function reviewFileToBoard(change: GitFileChange, diff: string, truncated: boolean): BoardFile {
	const code = change.status;
	const status: BoardFile["status"] = code.includes("D")
		? "deleted"
		: code.includes("A") || code === "??"
			? "added"
			: code.includes("R")
				? "renamed"
				: "modified";
	return {
		path: change.path,
		status,
		diff,
		added: change.added ?? 0,
		removed: change.removed ?? 0,
		...(truncated && { truncated: true }),
	};
}

/** Per-line highlight.js markup for a hunk body's rows, indexed by row; null where a row stays plain. */
export interface Highlighter {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}

/**
 * Highlights each diff line on its own (the `+`/`-`/space prefix is not part of the code). A file past
 * `HIGHLIGHT_MAX_CHARS`, or a language the highlighter lacks, stays plain.
 */
export function highlightRows(
	hljs: Highlighter,
	language: string | undefined,
	rows: readonly DiffRow[],
): Array<string | null> {
	const plain = rows.map(() => null);
	if (language === undefined || !hljs.getLanguage(language)) return plain;
	let total = 0;
	for (const row of rows) total += row.text.length;
	if (total > HIGHLIGHT_MAX_CHARS) return plain;
	return rows.map(row => {
		if (!isLineRow(row)) return null;
		try {
			return hljs.highlight(row.text.slice(1), { language, ignoreIllegals: true }).value;
		} catch {
			return null;
		}
	});
}

/** The stack position a comment prompt names. */
export interface StackPosition {
	pr: StackPr;
	/** 1-based, bottom first. */
	index: number;
	total: number;
	/** The PR below, when there is one. */
	below?: StackPr;
}

export interface BoardPromptInput {
	subject: ReviewSubject;
	/** The PR's place in its stack (`subject.kind === "pr"`). */
	stack?: StackPosition | null;
	/** The session's branch and what it is compared with (`subject.kind === "branch"`). */
	branch?: { name: string | null; base: string | null } | null;
	/** The prompt turn (`subject.kind === "session"` with an `entryId`). */
	turn?: { turn: number; label: string } | null;
	comments: readonly ReviewComment[];
	/** The diffs the comments were made on and the agent's notes on their hunks. */
	files: readonly BoardFile[];
	notes: readonly HunkNote[];
}

/** The longest a quoted agent note gets in the prompt: the agent wrote it, it needs a pointer, not a copy. */
const NOTE_QUOTE_MAX = 1200;

function prLabel(pr: StackPr): string {
	return `PR #${pr.number} "${pr.title}"`;
}

/** The sentence that opens the prompt: what was reviewed, down to the stack position, branch or turn. */
export function boardHeading(input: Pick<BoardPromptInput, "subject" | "stack" | "branch" | "turn">): string {
	const { subject } = input;
	switch (subject.kind) {
		case "pr": {
			const { stack } = input;
			if (stack === null || stack === undefined) return `Review comments on PR #${subject.number}:`;
			const where =
				stack.total > 1
					? `part ${stack.index} of ${stack.total} in its stack, bottom first; only its own changes, against ${
							stack.below === undefined
								? `its base ${stack.pr.base}`
								: `${prLabel(stack.below)} (${stack.pr.base})`
						}`
					: `against its base ${stack.pr.base}`;
			return `Review comments on ${prLabel(stack.pr)} (${stack.pr.head}; ${where}):`;
		}
		case "branch": {
			const { branch } = input;
			const name = branch?.name ?? "the current branch";
			return branch?.base ? `Review comments on ${name} against ${branch.base}:` : `Review comments on ${name}:`;
		}
		case "session": {
			const { turn } = input;
			if (subject.entryId === undefined) return "Review comments on the changes made in this session:";
			if (turn === null || turn === undefined)
				return "Review comments on the changes made in one turn of this session:";
			return `Review comments on the changes from turn ${turn.turn}${turn.label === "" ? "" : ` ("${turn.label}")`}:`;
		}
	}
}

function quote(text: string): string {
	const clipped = text.length > NOTE_QUOTE_MAX ? `${text.slice(0, NOTE_QUOTE_MAX - 1)}…` : text;
	return clipped
		.trim()
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
}

/** The agent's notes on the hunk a comment ends in, quoted with where they came from; null when the hunk has none. */
function noteContext(input: BoardPromptInput): (comment: ReviewComment) => string | null {
	const parsed = new Map<string, ParsedFile>();
	for (const file of input.files) parsed.set(file.path, parseFile(file.diff));
	const index = indexNotes(input.notes);
	return comment => {
		const file = parsed.get(comment.path);
		if (file === undefined) return null;
		const row = file.rows.findIndex(r => isLineRow(r) && rowKey(r) === comment.to);
		if (row === -1) return null;
		const hunk = file.hunks[hunkOfRow(file.hunks, row)];
		if (hunk === undefined) return null;
		const notes = notesOf(index, comment.path, hunk.header);
		if (notes.length === 0) return null;
		return notes
			.map(note => {
				const intent = note.intent ? `, intent: ${note.intent}` : "";
				return `Your note on this hunk (${noteSource(note)}${intent}):\n${quote(note.text)}`;
			})
			.join("\n\n");
	};
}

/** The one prompt that carries the board's comments to the agent. */
export function buildBoardPrompt(input: BoardPromptInput): string {
	return buildReviewPrompt(input.comments, boardHeading(input), noteContext(input));
}
