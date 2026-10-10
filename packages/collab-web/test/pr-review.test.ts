import { describe, expect, it } from "bun:test";
import { prReviewPrompt, toReviewComment, toReviewComments } from "../src/lib/pr-review";
import { commentId, commentOnRows, parseUnifiedDiff, type ReviewComment } from "../src/lib/review-comments";

const DIFF = [
	"@@ -10,5 +10,5 @@",
	" ctx a", // old 10 / new 10
	"-old b", // old 11
	"-old c", // old 12
	"+new b", // new 11
	"+new c", // new 12
	" ctx d", // old 13 / new 13
].join("\n");

const rows = parseUnifiedDiff(DIFF);

/** Comment on diff rows `a`..`b` (indexes into the parsed rows, hunk header = 0). */
function on(a: number, b: number, text = "note"): ReviewComment {
	const comment = commentOnRows(rows, a, b, "pr", "src/a.ts", text);
	if (comment === null) throw new Error("no comment");
	return comment;
}

describe("toReviewComment", () => {
	it("puts a single added or context line on the right side at its new-file number", () => {
		expect(toReviewComment(on(4, 4))).toEqual({ path: "src/a.ts", line: 11, side: "RIGHT", body: "note" });
		expect(toReviewComment(on(1, 1))).toEqual({ path: "src/a.ts", line: 10, side: "RIGHT", body: "note" });
	});

	it("puts removed lines on the left side with old-file numbers", () => {
		expect(toReviewComment(on(2, 2))).toEqual({ path: "src/a.ts", line: 11, side: "LEFT", body: "note" });
		expect(toReviewComment(on(2, 3))).toEqual({
			path: "src/a.ts",
			line: 12,
			side: "LEFT",
			startLine: 11,
			body: "note",
		});
	});

	it("sends a range of added lines as start_line..line on the right", () => {
		expect(toReviewComment(on(4, 5))).toEqual({
			path: "src/a.ts",
			line: 12,
			side: "RIGHT",
			startLine: 11,
			body: "note",
		});
	});

	it("takes new-file numbers when a selection mixes removed and added lines", () => {
		// Rows 2..5 are two removals then two additions: GitHub wants the new-file range on the right.
		expect(toReviewComment(on(2, 5))).toEqual({
			path: "src/a.ts",
			line: 12,
			side: "RIGHT",
			startLine: 11,
			body: "note",
		});
		// Selected from the bottom up: same comment.
		expect(toReviewComment(on(5, 1))).toEqual({
			path: "src/a.ts",
			line: 12,
			side: "RIGHT",
			startLine: 10,
			body: "note",
		});
	});

	it("trims the comment text", () => {
		expect(toReviewComment(on(4, 4, "  spaced \n")).body).toBe("spaced");
	});
});

describe("toReviewComments / prReviewPrompt", () => {
	const a = on(4, 4, "first");
	const b = on(1, 1, "second");
	const other: ReviewComment = { ...on(1, 1, "third"), path: "a/b.ts" };
	const all = { [commentId(a)]: a, [commentId(b)]: b, [commentId(other)]: other };

	it("orders comments by file, then line", () => {
		expect(toReviewComments(all).map(c => `${c.path}:${c.line}`)).toEqual([
			"a/b.ts:10",
			"src/a.ts:10",
			"src/a.ts:11",
		]);
	});

	it("names the pull request and quotes each commented line", () => {
		const prompt = prReviewPrompt(42, all);
		expect(prompt.startsWith("Address these review comments on PR #42:")).toBe(true);
		expect(prompt).toContain("src/a.ts:11");
		expect(prompt).toContain("+new b");
		expect(prompt).toContain("first");
	});
});
