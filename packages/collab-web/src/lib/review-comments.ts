/**
 * Line comments on a unified diff, gathered into one review prompt for the agent.
 * Diffs are parsed into numbered rows so a comment can name the file lines it is about.
 */
import { readJson, writeJson } from "./storage";

export interface DiffRow {
	/** `hunk`: a `@@` header, the `\ No newline` marker or any line outside a hunk: shown, never commented. */
	kind: "hunk" | "add" | "del" | "ctx";
	/** Line in the old file; absent on added and non-line rows. */
	oldLine?: number;
	/** Line in the new file; absent on removed and non-line rows. */
	newLine?: number;
	/** The raw diff line, `+`/`-`/space prefix included. */
	text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Rows of a single-file unified diff with old/new line numbers taken from the `@@` headers.
 * The `diff --git` / `index` / `---` / `+++` preamble is dropped: the path is the caller's row header.
 * Hunk line counts bound each hunk, so a diff that continues with another file's header
 * cannot have that header read as a change.
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
	const all = diff.replace(/\n$/, "").split("\n");
	const firstHunk = all.findIndex(line => HUNK_HEADER.test(line));
	// No hunk at all (a binary notice, say): nothing to number, show the text as is.
	if (firstHunk === -1) return all.map(text => ({ kind: "hunk", text }));
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of all.slice(firstHunk)) {
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			oldLeft = header[2] === undefined ? 1 : Number(header[2]);
			newLeft = header[4] === undefined ? 1 : Number(header[4]);
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		if (line.startsWith("\\") || (oldLeft <= 0 && newLeft <= 0)) {
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ kind: "add", newLine, text: line });
			newLine++;
			newLeft--;
		} else if (line.startsWith("-")) {
			rows.push({ kind: "del", oldLine, text: line });
			oldLine++;
			oldLeft--;
		} else {
			// Some tools strip the lone space off a blank context line.
			rows.push({ kind: "ctx", oldLine, newLine, text: line === "" ? " " : line });
			oldLine++;
			newLine++;
			oldLeft--;
			newLeft--;
		}
	}
	return rows;
}

/** A row a comment can attach to. */
export function isLineRow(row: DiffRow): boolean {
	return row.kind !== "hunk";
}

/** Identifies a line row within its file's diff; stable while the diff keeps that line. */
export function rowKey(row: DiffRow): string {
	return `${row.oldLine ?? ""}:${row.newLine ?? ""}`;
}

/** Rows `a` to `b` (either order) lie in one hunk: no `@@` header between them. */
export function sameHunk(rows: readonly DiffRow[], a: number, b: number): boolean {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (let i = lo + 1; i <= hi; i++) if (rows[i]?.text.startsWith("@@")) return false;
	return true;
}

/** The rows a reader has picked in one file's diff: `anchor` is the first tap, `head` the last (either order). */
export interface RowSelection {
	anchor: number;
	head: number;
}

/**
 * The selection after a tap on row `i`: a first tap picks it, a second (or a shift-click) in the same hunk extends
 * the range, tapping the lone selected row again clears it (null), and a tap in another hunk starts afresh.
 * `fresh` is a new selection, whose draft text starts over.
 */
export function pickRow(
	rows: readonly DiffRow[],
	sel: RowSelection | null,
	i: number,
	extend: boolean,
): { sel: RowSelection | null; fresh: boolean } {
	if (sel === null) return { sel: { anchor: i, head: i }, fresh: true };
	const single = sel.anchor === sel.head;
	if (single && !extend && i === sel.anchor) return { sel: null, fresh: true };
	if ((single || extend) && sameHunk(rows, sel.anchor, i))
		return { sel: { anchor: sel.anchor, head: i }, fresh: false };
	return { sel: { anchor: i, head: i }, fresh: true };
}

/** Where a file's comments sit among its diff rows. */
export interface CommentLayout {
	/** Comments by the row they end on. */
	after: Record<number, Array<[string, ReviewComment]>>;
	/** Rows some comment covers. */
	marked: Record<number, true>;
	/** Comments whose lines the diff no longer has (the file changed since): they stay reachable. */
	orphans: Array<[string, ReviewComment]>;
}

export function commentLayout(
	rows: readonly DiffRow[],
	comments: Readonly<Record<string, ReviewComment>> | undefined,
	scope: ReviewScope,
	path: string,
): CommentLayout {
	const index: Record<string, number> = {};
	rows.forEach((row, i) => {
		if (isLineRow(row)) index[rowKey(row)] = i;
	});
	const after: CommentLayout["after"] = {};
	const marked: CommentLayout["marked"] = {};
	const orphans: CommentLayout["orphans"] = [];
	for (const [id, c] of Object.entries(comments ?? {})) {
		if (c.scope !== scope || c.path !== path) continue;
		const from = Object.hasOwn(index, c.from) ? index[c.from] : undefined;
		const to = Object.hasOwn(index, c.to) ? index[c.to] : undefined;
		if (from === undefined || to === undefined) {
			orphans.push([id, c]);
			continue;
		}
		(after[to] ??= []).push([id, c]);
		for (let i = from; i <= to; i++) marked[i] = true;
	}
	return { after, marked, orphans };
}

/** `tree`: working-tree tab; `branch`: branch-review tab; `pr`: a GitHub pull request's files; `turn`: what the agent changed in a turn or a session. */
export type ReviewScope = "tree" | "branch" | "pr" | "turn";

export interface ReviewComment {
	scope: ReviewScope;
	path: string;
	/** `rowKey` of the first and last commented row. */
	from: string;
	to: string;
	/** Line numbers shown in the prompt: new-file lines, or old-file lines when `removed`. */
	start: number;
	end: number;
	/** Every commented line was deleted, so the numbers are old-file lines. */
	removed: boolean;
	/** The commented diff lines, prefix included. */
	lines: string[];
	text: string;
}

export function commentId(c: Pick<ReviewComment, "scope" | "path" | "from" | "to">): string {
	return `${c.scope}\t${c.path}\t${c.from}\t${c.to}`;
}

/** A comment on rows `a` to `b` (either order) of `rows`, or null when neither holds a line. */
export function commentOnRows(
	rows: readonly DiffRow[],
	a: number,
	b: number,
	scope: ReviewScope,
	path: string,
	text: string,
): ReviewComment | null {
	const picked = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter(isLineRow);
	const first = picked[0];
	const last = picked[picked.length - 1];
	if (first === undefined || last === undefined) return null;
	const news = picked.flatMap(row => (row.newLine === undefined ? [] : [row.newLine]));
	const removed = news.length === 0;
	const numbers = removed ? picked.flatMap(row => (row.oldLine === undefined ? [] : [row.oldLine])) : news;
	return {
		scope,
		path,
		from: rowKey(first),
		to: rowKey(last),
		start: Math.min(...numbers),
		end: Math.max(...numbers),
		removed,
		lines: picked.map(row => row.text),
		text,
	};
}

/** `12`, `12-14`, with `(removed)` for old-file lines. */
export function lineLabel(c: Pick<ReviewComment, "start" | "end" | "removed">): string {
	const range = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`;
	return c.removed ? `${range} (removed)` : range;
}

/** Backtick fence long enough that no quoted line closes it. */
function fenceFor(lines: readonly string[]): string {
	let longest = 2;
	for (const line of lines) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(longest + 1);
}

/**
 * One prompt for the whole review: per file, each comment's lines quoted, then what to change.
 * `context` may name what a comment replies to (the agent's note on the hunk); it is quoted between the lines and
 * the comment, which is then introduced as the reviewer's.
 */
export function buildReviewPrompt(
	comments: readonly ReviewComment[],
	heading = "Review comments on the changes:",
	context?: (comment: ReviewComment) => string | null,
): string {
	const byPath = new Map<string, ReviewComment[]>();
	for (const c of comments) {
		const group = byPath.get(c.path);
		if (group === undefined) byPath.set(c.path, [c]);
		else group.push(c);
	}
	const blocks: string[] = [heading];
	for (const [path, group] of byPath) {
		group.sort((a, b) => a.start - b.start || a.end - b.end);
		for (const c of group) {
			const fence = fenceFor(c.lines);
			const replyTo = context?.(c) ?? null;
			const body = replyTo === null ? c.text.trim() : `${replyTo}\n\nMy comment:\n${c.text.trim()}`;
			blocks.push(`${path}:${lineLabel(c)}\n${fence}diff\n${c.lines.join("\n")}\n${fence}\n${body}`);
		}
	}
	return blocks.join("\n\n");
}

const REVIEW_KEY_PREFIX = "omp.collab.review.";

function isComment(v: unknown): v is ReviewComment {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	return (
		(c.scope === "tree" || c.scope === "branch" || c.scope === "pr" || c.scope === "turn") &&
		typeof c.path === "string" &&
		typeof c.from === "string" &&
		typeof c.to === "string" &&
		typeof c.start === "number" &&
		typeof c.end === "number" &&
		typeof c.removed === "boolean" &&
		Array.isArray(c.lines) &&
		c.lines.every(line => typeof line === "string") &&
		typeof c.text === "string" &&
		c.text.trim().length > 0
	);
}

/** Stored comments by id; entries of an unknown shape are dropped. */
export function parseStoredComments(raw: unknown): Record<string, ReviewComment> {
	const comments: Record<string, ReviewComment> = {};
	if (!Array.isArray(raw)) return comments;
	for (const v of raw) if (isComment(v)) comments[commentId(v)] = v;
	return comments;
}

/** Per session: the unsent review, so a reload keeps a half-written one. */
export function loadReviewComments(sessionId: string): Record<string, ReviewComment> {
	return parseStoredComments(readJson(REVIEW_KEY_PREFIX + sessionId));
}

export function saveReviewComments(sessionId: string, comments: Readonly<Record<string, ReviewComment>>): void {
	const all = Object.values(comments);
	writeJson(REVIEW_KEY_PREFIX + sessionId, all.length > 0 ? all : null);
}

/** What the diff views need to comment: the review so far and how to change it. */
export interface DiffReview {
	comments: Readonly<Record<string, ReviewComment>>;
	save(comment: ReviewComment): void;
	remove(id: string): void;
}
