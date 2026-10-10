import { describe, expect, it } from "bun:test";
import {
	buildReviewPrompt,
	commentId,
	commentOnRows,
	type DiffRow,
	parseStoredComments,
	parseUnifiedDiff,
	type ReviewComment,
	sameHunk,
} from "../src/lib/review-comments";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
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

const lines = (rows: readonly DiffRow[]) => rows.map(row => `${row.kind}:${row.oldLine ?? "-"}:${row.newLine ?? "-"}`);

describe("parseUnifiedDiff", () => {
	it("numbers old and new lines per hunk and drops the file preamble", () => {
		const rows = parseUnifiedDiff(DIFF);
		expect(rows[0]?.text).toStartWith("@@ -3,4 +3,5 @@");
		expect(lines(rows)).toEqual([
			"hunk:-:-",
			"ctx:3:3",
			"del:4:-",
			"add:-:4",
			"add:-:5",
			"ctx:5:6",
			"hunk:-:-",
			"del:20:-",
			"hunk:-:-",
			"add:-:21",
			"add:-:22",
			"hunk:-:-",
		]);
	});

	it("does not count the no-newline marker as a line", () => {
		const rows = parseUnifiedDiff(DIFF);
		const marker = rows.filter(row => row.text.startsWith("\\"));
		expect(marker).toHaveLength(2);
		expect(marker.every(row => row.kind === "hunk" && row.newLine === undefined)).toBe(true);
		// the `+here` after the first marker still gets the next new line number
		expect(rows.find(row => row.text === "+here")?.newLine).toBe(21);
	});

	it("reads a header without a count as one line", () => {
		const rows = parseUnifiedDiff("@@ -7 +7 @@\n-a\n+b\n");
		expect(lines(rows)).toEqual(["hunk:-:-", "del:7:-", "add:-:7"]);
	});

	it("keeps a blank context line that a tool stripped to nothing", () => {
		const rows = parseUnifiedDiff("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
		expect(lines(rows)).toEqual(["hunk:-:-", "ctx:1:1", "ctx:2:2", "del:3:-", "add:-:3"]);
	});

	it("does not read lines past a hunk's counts as changes", () => {
		const rows = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n");
		expect(lines(rows)).toEqual(["hunk:-:-", "del:1:-", "add:-:1", "hunk:-:-", "hunk:-:-", "hunk:-:-"]);
	});

	it("shows a diff without hunks (binary notice) as plain uncommentable rows", () => {
		const rows = parseUnifiedDiff("Binary files a/x and b/x differ\n");
		expect(lines(rows)).toEqual(["hunk:-:-"]);
	});
});

describe("sameHunk", () => {
	it("is false across a hunk header", () => {
		const rows = parseUnifiedDiff(DIFF);
		expect(sameHunk(rows, 1, 5)).toBe(true);
		expect(sameHunk(rows, 5, 1)).toBe(true);
		expect(sameHunk(rows, 5, 7)).toBe(false);
	});
});

describe("commentOnRows", () => {
	const rows = parseUnifiedDiff(DIFF);

	it("labels a range by new-file lines and quotes its diff lines", () => {
		const c = commentOnRows(rows, 2, 4, "tree", "src/a.ts", "why")!;
		expect(c).toMatchObject({ start: 4, end: 5, removed: false, from: "4:", to: ":5" });
		expect(c.lines).toEqual(["-old two", "+new two", "+new two b"]);
	});

	it("falls back to old-file lines when every row was deleted", () => {
		const c = commentOnRows(rows, 2, 2, "branch", "src/a.ts", "x")!;
		expect(c).toMatchObject({ start: 4, end: 4, removed: true });
	});

	it("ignores header and marker rows inside the range, and refuses a range with no line", () => {
		const c = commentOnRows(rows, 7, 9, "tree", "src/a.ts", "x")!;
		expect(c.lines).toEqual(["-gone", "+here"]);
		expect(commentOnRows(rows, 0, 0, "tree", "src/a.ts", "x")).toBeNull();
	});

	it("gives the same id to the same lines of the same file and tab only", () => {
		const a = commentOnRows(rows, 3, 3, "tree", "src/a.ts", "one")!;
		expect(commentId(commentOnRows(rows, 3, 3, "tree", "src/a.ts", "two")!)).toBe(commentId(a));
		expect(commentId(commentOnRows(rows, 3, 3, "branch", "src/a.ts", "one")!)).not.toBe(commentId(a));
		expect(commentId(commentOnRows(rows, 3, 3, "tree", "src/b.ts", "one")!)).not.toBe(commentId(a));
	});
});

describe("buildReviewPrompt", () => {
	const rows = parseUnifiedDiff(DIFF);

	it("quotes each comment's lines under path:line, grouped by file and ordered by line", () => {
		const late = commentOnRows(rows, 10, 10, "tree", "src/a.ts", "  late note \n")!;
		const early = commentOnRows(rows, 3, 4, "tree", "src/a.ts", "early note")!;
		const other = commentOnRows(rows, 1, 1, "tree", "src/b.ts", "other file")!;
		expect(buildReviewPrompt([late, other, early])).toBe(
			[
				"Review comments on the changes:",
				"src/a.ts:4-5\n```diff\n+new two\n+new two b\n```\nearly note",
				"src/a.ts:22\n```diff\n+and here\n```\nlate note",
				"src/b.ts:3\n```diff\n keep one\n```\nother file",
			].join("\n\n"),
		);
	});

	it("marks removed-only lines and widens the fence around quoted backticks", () => {
		const removed = commentOnRows(rows, 2, 2, "tree", "src/a.ts", "drop it")!;
		const fenced: ReviewComment = {
			...removed,
			start: 1,
			end: 1,
			removed: false,
			lines: ["+```", "+code", "+```"],
			text: "nested",
		};
		const prompt = buildReviewPrompt([removed, fenced]);
		expect(prompt).toContain("src/a.ts:4 (removed)\n```diff\n-old two\n```\ndrop it");
		expect(prompt).toContain("src/a.ts:1\n````diff\n+```\n+code\n+```\n````\nnested");
	});
});

describe("parseStoredComments", () => {
	it("keeps well-formed comments by id and drops everything else", () => {
		const good = commentOnRows(parseUnifiedDiff(DIFF), 3, 3, "tree", "src/a.ts", "keep")!;
		const stored = parseStoredComments([
			good,
			{ ...good, text: "   " },
			{ ...good, scope: "agent" },
			{ ...good, lines: [1] },
			"junk",
			null,
		]);
		expect(Object.keys(stored)).toEqual([commentId(good)]);
		expect(parseStoredComments({ not: "an array" })).toEqual({});
	});
});
