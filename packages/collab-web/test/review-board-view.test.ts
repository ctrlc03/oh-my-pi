import { describe, expect, it } from "bun:test";
import type { TurnDiffFile } from "@oh-my-pi/pi-wire";
import { HIGHLIGHT_MAX_CHARS } from "../src/lib/highlight";
import type { BoardFile, HunkNote, StackPr } from "../src/lib/review-board";
import {
	boardHeading,
	boardLayout,
	boardScope,
	boardStorageKey,
	buildBoardPrompt,
	commentsByHunk,
	diffVersion,
	type Highlighter,
	highlightRows,
	hunkKey,
	hunkLineRange,
	hunkOfRow,
	indexNotes,
	noteSource,
	notesOf,
	parseFile,
	reviewFileToBoard,
	turnFilesToBoard,
} from "../src/lib/review-board-view";
import {
	commentLayout,
	commentOnRows,
	pickRow,
	type ReviewComment,
	type RowSelection,
} from "../src/lib/review-comments";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -3,4 +3,5 @@ function head()",
	" keep one",
	"-old two",
	"+new two",
	"+new two b",
	" keep three",
	"@@ -20 +21,2 @@",
	"-gone",
	"\\ No newline at end of file",
	"+here",
	"+and here",
	"\\ No newline at end of file",
	"",
].join("\n");

const file = (path: string, diff: string): BoardFile => ({
	path,
	status: "modified",
	diff,
	added: 1,
	removed: 1,
});

describe("parseFile", () => {
	it("groups rows by hunk, a `\\ No newline` marker staying with the hunk it follows", () => {
		const parsed = parseFile(DIFF);
		expect(parsed.hunks.map(h => [h.index, h.key, h.headerRow, h.first, h.last])).toEqual([
			[0, "@@ -3,4 +3,5 @@", 0, 1, 5],
			[1, "@@ -20 +21,2 @@", 6, 7, 11],
		]);
		// the header keeps the function context the diff printed
		expect(parsed.hunks[0]!.header).toBe("@@ -3,4 +3,5 @@ function head()");
		expect(parsed.notice).toEqual([]);
	});

	it("lays each hunk body out side by side with row indexes of the whole file", () => {
		const { hunks } = parseFile(DIFF);
		const shown = hunks[0]!.lines.map(line =>
			line.kind === "full" ? `full ${line.row}` : `${line.left ?? "-"}|${line.right ?? "-"}`,
		);
		expect(shown).toEqual(["1|1", "2|3", "-|4", "5|5"]);
		const second = hunks[1]!.lines.map(line =>
			line.kind === "full" ? `full ${line.row}` : `${line.left ?? "-"}|${line.right ?? "-"}`,
		);
		expect(second).toEqual(["7|-", "full 8", "-|9", "-|10", "full 11"]);
		// every body row appears exactly once, header rows never
		const seen: number[] = [];
		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				const ids = line.kind === "full" ? [line.row] : [line.left, line.right];
				for (const id of new Set(ids)) if (id !== null) seen.push(id);
			}
		}
		expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
	});

	it("keeps the text of a diff with no hunk (a binary notice) as a notice", () => {
		const parsed = parseFile("Binary files a/x.png and b/x.png differ\n");
		expect(parsed.hunks).toEqual([]);
		expect(parsed.notice).toEqual(["Binary files a/x.png and b/x.png differ"]);
		expect(parseFile("").notice).toEqual([]);
	});
});

describe("hunk lookup", () => {
	const parsed = parseFile(DIFF);
	it("finds the hunk a row belongs to, headers included", () => {
		expect(hunkOfRow(parsed.hunks, 0)).toBe(0);
		expect(hunkOfRow(parsed.hunks, 5)).toBe(0);
		expect(hunkOfRow(parsed.hunks, 6)).toBe(1);
		expect(hunkOfRow(parsed.hunks, 11)).toBe(1);
		expect(hunkOfRow(parsed.hunks, 99)).toBe(-1);
	});

	it("selects the first to the last commentable row for a whole-hunk comment", () => {
		expect(hunkLineRange(parsed.rows, parsed.hunks[0]!)).toEqual({ first: 1, last: 5 });
		// the trailing `\ No newline` marker is not a line a comment can attach to
		expect(hunkLineRange(parsed.rows, parsed.hunks[1]!)).toEqual({ first: 7, last: 10 });
	});
});

describe("comments by hunk", () => {
	const parsed = parseFile(DIFF);
	const comment = (a: number, b: number, text: string, path = "src/a.ts") =>
		commentOnRows(parsed.rows, a, b, "pr", path, text)!;
	const at = (...list: ReviewComment[]) => Object.fromEntries(list.map(c => [`${c.from}>${c.to}`, c]));

	it("places a comment under the hunk it ends in, in row order, and marks its rows", () => {
		const late = comment(4, 5, "late");
		const early = comment(1, 2, "early");
		const other = comment(7, 7, "second hunk");
		const placed = commentsByHunk(parsed, at(late, early, other), "pr", "src/a.ts");
		expect(placed.byHunk.map(group => group.map(([, c]) => c.text))).toEqual([["early", "late"], ["second hunk"]]);
		expect(placed.orphans).toEqual([]);
		expect(Object.keys(placed.marked).map(Number)).toEqual([1, 2, 4, 5, 7]);
	});

	it("lists comments whose lines the diff lost, and ignores other files and scopes", () => {
		const gone: ReviewComment = { ...comment(1, 1, "stale"), from: "99:99", to: "99:99" };
		const elsewhere = comment(1, 1, "other file", "src/b.ts");
		const placed = commentsByHunk(parsed, at(gone, elsewhere), "pr", "src/a.ts");
		expect(placed.orphans.map(([, c]) => c.text)).toEqual(["stale"]);
		expect(placed.byHunk.flat()).toEqual([]);
		expect(commentsByHunk(parsed, at(comment(1, 1, "x")), "turn", "src/a.ts").byHunk.flat()).toEqual([]);
	});

	it("matches what commentLayout reports for the same comments", () => {
		const list = at(comment(1, 2, "a"), comment(7, 9, "b"));
		const flat = commentLayout(parsed.rows, list, "pr", "src/a.ts");
		expect(Object.keys(flat.after).map(Number)).toEqual([2, 9]);
	});
});

describe("pickRow", () => {
	const parsed = parseFile(DIFF);
	const step = (sel: RowSelection | null, i: number, extend = false) => pickRow(parsed.rows, sel, i, extend);

	it("picks a row, extends within the hunk, and clears on a second tap of the lone row", () => {
		const first = step(null, 1);
		expect(first).toEqual({ sel: { anchor: 1, head: 1 }, fresh: true });
		expect(step(first.sel, 3)).toEqual({ sel: { anchor: 1, head: 3 }, fresh: false });
		expect(step(first.sel, 1)).toEqual({ sel: null, fresh: true });
	});

	it("starts over in another hunk instead of spanning the header", () => {
		const first = step(null, 2);
		expect(step(first.sel, 8)).toEqual({ sel: { anchor: 8, head: 8 }, fresh: true });
		const range = step(first.sel, 3).sel;
		// a tap on a range without shift starts over, shift extends
		expect(step(range, 5)).toEqual({ sel: { anchor: 5, head: 5 }, fresh: true });
		expect(step(range, 5, true)).toEqual({ sel: { anchor: 2, head: 5 }, fresh: false });
	});
});

describe("notes", () => {
	const note = (hunk: string, text: string, extra: Partial<HunkNote> = {}): HunkNote => ({
		path: "src/a.ts",
		hunk,
		text,
		source: "generated",
		...extra,
	});

	it("finds a note by file and `@@` range whatever follows the header", () => {
		expect(hunkKey("@@ -3,4 +3,5 @@ function head()")).toBe("@@ -3,4 +3,5 @@");
		const index = indexNotes([note("@@ -3,4 +3,5 @@", "first"), note("@@ -3,4 +3,5 @@", "second")]);
		expect(notesOf(index, "src/a.ts", "@@ -3,4 +3,5 @@ function head()").map(n => n.text)).toEqual([
			"first",
			"second",
		]);
		expect(notesOf(index, "src/b.ts", "@@ -3,4 +3,5 @@")).toEqual([]);
		expect(notesOf(index, "src/a.ts", "@@ -20 +21,2 @@")).toEqual([]);
	});

	it("words where a note came from, a generated rewrite of a session note keeping its session", () => {
		expect(noteSource(note("@@ -1 +1 @@", "x"))).toBe("generated");
		expect(noteSource(note("@@ -1 +1 @@", "x", { source: "session", sessionTitle: "Fix auth", turn: 3 }))).toBe(
			"from session · Fix auth · turn 3",
		);
		expect(noteSource(note("@@ -1 +1 @@", "x", { source: "session" }))).toBe("from session");
		expect(
			noteSource(
				note("@@ -1 +1 @@", "x", { source: "generated", sessionId: "s1", sessionTitle: "Fix auth", turn: 3 }),
			),
		).toBe("generated from session · Fix auth · turn 3");
		expect(noteSource(note("@@ -1 +1 @@", "x", { source: "generated", turn: 2 }))).toBe(
			"generated from session · turn 2",
		);
	});
});

describe("diffVersion", () => {
	const a = { path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" };
	const b = { path: "b.ts", diff: "@@ -1 +1 @@\n-p\n+q\n" };
	it("is the same for the same diffs in any order, and differs when a diff or a path changes", () => {
		expect(diffVersion([a, b])).toBe(diffVersion([b, a]));
		expect(diffVersion([a, b])).not.toBe(diffVersion([a, { ...b, diff: `${b.diff}+r\n` }]));
		expect(diffVersion([a])).not.toBe(diffVersion([{ ...a, path: "c.ts" }]));
		// the boundary between path and diff matters
		expect(diffVersion([{ path: "ab", diff: "c" }])).not.toBe(diffVersion([{ path: "a", diff: "bc" }]));
	});
});

describe("boardLayout", () => {
	it("is four columns on a wide board, three on a medium one, stacked when narrow or on a phone", () => {
		expect(boardLayout(1200, false)).toBe("four");
		expect(boardLayout(1040, false)).toBe("four");
		expect(boardLayout(976, false)).toBe("three");
		expect(boardLayout(860, false)).toBe("three");
		expect(boardLayout(700, false)).toBe("stacked");
		expect(boardLayout(0, false)).toBe("stacked");
		expect(boardLayout(1600, true)).toBe("stacked");
	});
});

describe("conversions", () => {
	it("turns a turn's files into board files, binary counts as nothing", () => {
		const files: TurnDiffFile[] = [
			{ path: "a.ts", status: "typechange", added: 2, removed: 1, diff: "d", truncated: true },
			{ path: "b.png", status: "added", added: null, removed: null, diff: "" },
		];
		expect(turnFilesToBoard(files)).toEqual([
			{ path: "a.ts", status: "modified", diff: "d", added: 2, removed: 1, truncated: true },
			{ path: "b.png", status: "added", diff: "", added: 0, removed: 0 },
		]);
	});

	it("reads a branch file's status off its porcelain code", () => {
		const status = (code: string) =>
			reviewFileToBoard({ path: "p", status: code, added: 1, removed: 0 }, "d", false).status;
		expect(status(" M")).toBe("modified");
		expect(status("??")).toBe("added");
		expect(status("A ")).toBe("added");
		expect(status(" D")).toBe("deleted");
		expect(status("R ")).toBe("renamed");
		expect(reviewFileToBoard({ path: "p", status: " M", added: null, removed: null }, "d", true)).toEqual({
			path: "p",
			status: "modified",
			diff: "d",
			added: 0,
			removed: 0,
			truncated: true,
		});
	});

	it("scopes and keys a subject's comments apart from other subjects and sessions", () => {
		expect(boardScope({ kind: "pr", number: 1 })).toBe("pr");
		expect(boardScope({ kind: "branch" })).toBe("branch");
		expect(boardScope({ kind: "session" })).toBe("turn");
		expect(boardStorageKey("s1", { kind: "pr", number: 7 })).toBe("s1.board.pr:7");
		expect(boardStorageKey("s1", { kind: "session", entryId: "e" })).not.toBe(
			boardStorageKey("s1", { kind: "session" }),
		);
		expect(boardStorageKey("s1", { kind: "branch" })).not.toBe(boardStorageKey("s2", { kind: "branch" }));
	});
});

describe("highlightRows", () => {
	const rows = parseFile("@@ -1,2 +1,2 @@\n keep\n-old\n+new\n").rows;
	const fake: Highlighter = {
		getLanguage: name => (name === "typescript" ? {} : undefined),
		highlight: code => ({ value: `<${code}>` }),
	};
	it("highlights each line without its diff sign and leaves headers plain", () => {
		expect(highlightRows(fake, "typescript", rows)).toEqual([null, "<keep>", "<old>", "<new>"]);
	});
	it("stays plain for an unknown language, a missing one or an oversized diff", () => {
		expect(highlightRows(fake, "cobol", rows)).toEqual([null, null, null, null]);
		expect(highlightRows(fake, undefined, rows)).toEqual([null, null, null, null]);
		const big = parseFile(`@@ -1 +1 @@\n+${"x".repeat(HIGHLIGHT_MAX_CHARS)}\n`).rows;
		expect(highlightRows(fake, "typescript", big).every(html => html === null)).toBe(true);
	});
	it("falls back to plain for a line the highlighter chokes on", () => {
		const throwing: Highlighter = {
			getLanguage: () => ({}),
			highlight: code => {
				if (code === "old") throw new Error("boom");
				return { value: code };
			},
		};
		expect(highlightRows(throwing, "x", rows)).toEqual([null, "keep", null, "new"]);
	});
});

const PR2: StackPr = {
	number: 12,
	title: "Add retry",
	head: "feat/retry",
	base: "feat/client",
	url: "u",
	state: "open",
};
const PR1: StackPr = { number: 11, title: "Add client", head: "feat/client", base: "main", url: "u", state: "open" };

describe("boardHeading", () => {
	it("names a PR's place in its stack and what its diff is against", () => {
		const heading = boardHeading({
			subject: { kind: "pr", number: 12 },
			stack: { pr: PR2, index: 2, total: 3, below: PR1 },
		});
		expect(heading).toBe(
			'Review comments on PR #12 "Add retry" (feat/retry; part 2 of 3 in its stack, bottom first; only its own changes, against PR #11 "Add client" (feat/client)):',
		);
	});
	it("names a bottom or lone PR's base", () => {
		expect(boardHeading({ subject: { kind: "pr", number: 11 }, stack: { pr: PR1, index: 1, total: 3 } })).toContain(
			"against its base main",
		);
		expect(boardHeading({ subject: { kind: "pr", number: 11 }, stack: { pr: PR1, index: 1, total: 1 } })).toBe(
			'Review comments on PR #11 "Add client" (feat/client; against its base main):',
		);
		expect(boardHeading({ subject: { kind: "pr", number: 9 } })).toBe("Review comments on PR #9:");
	});
	it("names the branch, a turn and the whole session", () => {
		expect(boardHeading({ subject: { kind: "branch" }, branch: { name: "feat/x", base: "origin/main" } })).toBe(
			"Review comments on feat/x against origin/main:",
		);
		expect(boardHeading({ subject: { kind: "branch" }, branch: { name: null, base: null } })).toBe(
			"Review comments on the current branch:",
		);
		expect(
			boardHeading({ subject: { kind: "session", entryId: "e" }, turn: { turn: 4, label: "tighten the types" } }),
		).toBe('Review comments on the changes from turn 4 ("tighten the types"):');
		expect(boardHeading({ subject: { kind: "session" } })).toBe(
			"Review comments on the changes made in this session:",
		);
	});
});

describe("buildBoardPrompt", () => {
	const files = [file("src/a.ts", DIFF)];
	const parsed = parseFile(DIFF);
	const on = (a: number, b: number, text: string) => commentOnRows(parsed.rows, a, b, "pr", "src/a.ts", text)!;
	const notes: HunkNote[] = [
		{
			path: "src/a.ts",
			hunk: "@@ -3,4 +3,5 @@",
			text: "Retries with a cap.\nThe cap avoids a hot loop.",
			source: "session",
			sessionTitle: "Add retry",
			turn: 2,
			intent: "cap retries",
		},
	];

	it("carries each comment with its file lines, the quoted diff and the note on its hunk", () => {
		const prompt = buildBoardPrompt({
			subject: { kind: "pr", number: 12 },
			stack: { pr: PR2, index: 2, total: 2, below: PR1 },
			comments: [on(2, 3, "Why not exponential?")],
			files,
			notes,
		});
		expect(prompt).toBe(
			[
				'Review comments on PR #12 "Add retry" (feat/retry; part 2 of 2 in its stack, bottom first; only its own changes, against PR #11 "Add client" (feat/client)):',
				"",
				"src/a.ts:4",
				"```diff",
				"-old two",
				"+new two",
				"```",
				"Your note on this hunk (from session · Add retry · turn 2, intent: cap retries):",
				"> Retries with a cap.",
				"> The cap avoids a hot loop.",
				"",
				"My comment:",
				"Why not exponential?",
			].join("\n"),
		);
	});

	it("leaves a comment on an unexplained hunk as the plain review comment", () => {
		const prompt = buildBoardPrompt({
			subject: { kind: "branch" },
			branch: { name: "feat/x", base: "origin/main" },
			comments: [on(9, 9, "naming")],
			files,
			notes,
		});
		expect(prompt).toBe(
			[
				"Review comments on feat/x against origin/main:",
				"",
				"src/a.ts:21",
				"```diff",
				"+here",
				"```",
				"naming",
			].join("\n"),
		);
	});

	it("quotes a very long note only up to a limit", () => {
		const long: HunkNote = { ...notes[0]!, text: "w".repeat(5000) };
		const prompt = buildBoardPrompt({
			subject: { kind: "session" },
			comments: [on(1, 1, "hm")],
			files,
			notes: [long],
		});
		expect(prompt).toContain(`> ${"w".repeat(1199)}…`);
		expect(prompt).not.toContain("w".repeat(1200));
	});

	it("quotes every note a hunk has, each with its source", () => {
		const more: HunkNote[] = [
			...notes,
			{ ...notes[0]!, source: "generated", text: "Second view.", intent: undefined },
		];
		const prompt = buildBoardPrompt({ subject: { kind: "session" }, comments: [on(1, 1, "hm")], files, notes: more });
		expect(prompt).toContain("Your note on this hunk (from session · Add retry · turn 2, intent: cap retries):");
		expect(prompt).toContain("Your note on this hunk (generated from session · Add retry · turn 2):\n> Second view.");
	});
});
