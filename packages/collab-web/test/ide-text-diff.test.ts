import { describe, expect, it } from "bun:test";
import { diffText, type TextEdit } from "../src/components/ide/text-diff";

/** Apply edits given in `before` coordinates, the way CodeMirror applies one change set. */
function apply(before: string, edits: TextEdit[]): string {
	let out = "";
	let at = 0;
	for (const edit of edits) {
		expect(edit.from).toBeGreaterThanOrEqual(at);
		out += before.slice(at, edit.from) + edit.insert;
		at = edit.to;
	}
	return out + before.slice(at);
}

describe("diffText", () => {
	const cases: [string, string, string, number[]][] = [
		["replaced line", "a\nb\nc\n", "a\nB\nc\n", [2]],
		["inserted lines", "a\nc\n", "a\nb1\nb2\nc\n", [2, 3]],
		["deleted line marks where it was", "a\nb\nc\n", "a\nc\n", [2]],
		["deleted last lines", "a\nb\nc\n", "a\n", [2]],
		["no trailing newline", "a\nb", "a\nb\nc", [2, 3]],
		["identical", "same\n", "same\n", []],
		["from empty", "", "x\ny\n", [1, 2]],
	];
	for (const [name, before, after, lines] of cases) {
		it(name, () => {
			const { edits, changedLines } = diffText(before, after);
			expect(apply(before, edits)).toBe(after);
			expect(changedLines).toEqual(lines);
		});
	}
});
