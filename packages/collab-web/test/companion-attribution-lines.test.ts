import { describe, expect, it } from "bun:test";
import {
	type AttributionEdit,
	attributeLines,
	type LineChange,
	parseLineChanges,
} from "../scripts/companion-attribution-lines";

/** An edit that wrote `added` at `at` of a file that had `removed` lines there. */
function change(oldStart: number, removed: number, newStart: number, added: string[]): LineChange {
	return { oldStart, removed, newStart, added };
}

const edit = (key: string, ...changes: LineChange[]): AttributionEdit => ({ key, changes });

describe("parseLineChanges", () => {
	it("reads a replacement: removed lines by old number, added lines by new number", () => {
		const diff = [" 200|return {", " 201|proposal,", "-202|old,", "+202|new,", " 203|};"].join("\n");
		expect(parseLineChanges(diff)).toEqual([change(202, 1, 202, ["new,"])]);
	});

	it("places a pure insertion in the old file and a pure deletion in the new one by the net lines before them", () => {
		const diff = [
			" 2|b",
			"+3|x",
			"+4|y",
			" 3|c",
			" 4|d",
			// Two lines were added above, so the old line 7 is line 9 now.
			"-7|gone",
			" 8|h",
			"",
			" 20|t",
			"+23|late",
		].join("\n");
		expect(parseLineChanges(diff)).toEqual([
			change(3, 0, 3, ["x", "y"]),
			change(7, 1, 9, []),
			// Net +2 -1 = +1 so far: new line 23 went in before old line 22.
			change(22, 0, 23, ["late"]),
		]);
	});

	it("splits changes at unchanged lines and hunk gaps, and keeps `|` inside the text", () => {
		const diff = ["-1|a | b", "+1|a || b", " 2|same", "-3|c", "", "+4|d"].join("\n");
		// The added line follows a deleted one: the old file's line 5 is line 4 now.
		expect(parseLineChanges(diff)).toEqual([change(1, 1, 1, ["a || b"]), change(3, 1, 3, []), change(5, 0, 4, ["d"])]);
	});

	it("is empty for text that is not an edit result", () => {
		expect(parseLineChanges("diff --git a/x b/x\n--- a/x\n+++ b/x")).toEqual([]);
	});
});

describe("attributeLines", () => {
	const file = ["alpha", "beta", "gamma", "delta", "epsilon"];

	it("marks the lines an edit wrote while the file still has them", () => {
		const ranges = attributeLines(file, [edit("t1", change(2, 1, 2, ["beta", "gamma"]))]);
		expect(ranges).toEqual([{ start: 2, end: 3, key: "t1" }]);
	});

	it("flips a line back when a person changed it, and keeps the rest of the run", () => {
		const typed = ["alpha", "beta", "gamma edited by hand", "delta", "epsilon"];
		const ranges = attributeLines(typed, [edit("t1", change(2, 0, 2, ["beta", "gamma", "delta"]))]);
		expect(ranges).toEqual([
			{ start: 2, end: 2, key: "t1" },
			{ start: 4, end: 4, key: "t1" },
		]);
	});

	it("does not count a change of indentation as a human edit", () => {
		const ranges = attributeLines(["    beta();"], [edit("t1", change(1, 0, 1, ["\t\tbeta();"]))]);
		expect(ranges).toEqual([{ start: 1, end: 1, key: "t1" }]);
	});

	it("follows lines a later edit moved by inserting and removing lines above them", () => {
		// Turn 1 wrote lines 3-4. Turn 2 then put two lines at the top and removed the old line 2, so they moved to 4-5.
		const first = edit("t1", change(3, 0, 3, ["one", "two"]));
		const second = edit("t2", change(1, 0, 1, ["top1", "top2"]), change(2, 1, 4, []));
		expect(attributeLines(["top1", "top2", "x", "one", "two", "tail"], [first, second])).toEqual([
			{ start: 1, end: 2, key: "t2" },
			{ start: 4, end: 5, key: "t1" },
		]);
	});

	it("gives lines a later turn rewrote to that turn, and keeps what it left to the first", () => {
		const current = ["a", "B2", "c", "d"];
		const ranges = attributeLines(current, [
			edit("t1", change(1, 0, 1, ["a", "b", "c", "d"])),
			edit("t2", change(2, 1, 2, ["B2"])),
		]);
		expect(ranges).toEqual([
			{ start: 1, end: 1, key: "t1" },
			{ start: 2, end: 2, key: "t2" },
			{ start: 3, end: 4, key: "t1" },
		]);
	});

	it("drops lines a later edit deleted, and the ones it deleted from a file written whole", () => {
		const written: AttributionEdit = { key: "t1", rewrite: true, changes: [change(1, 0, 1, ["one", "two", "three"])] };
		const deleted = edit("t2", change(2, 1, 2, []));
		expect(attributeLines(["one", "three"], [written, deleted])).toEqual([{ start: 1, end: 2, key: "t1" }]);
		// A later whole-file write leaves nothing of the first.
		const again: AttributionEdit = { key: "t3", rewrite: true, changes: [change(1, 0, 1, ["fresh"])] };
		expect(attributeLines(["fresh"], [written, again])).toEqual([{ start: 1, end: 1, key: "t3" }]);
	});

	it("joins runs of edits with one key, and leaves blank lines out of a range's ends", () => {
		const current = ["", "one", "", "two", ""];
		const ranges = attributeLines(current, [edit("t1", change(1, 0, 1, ["", "one", ""])), edit("t1", change(4, 0, 4, ["two", ""]))]);
		expect(ranges).toEqual([{ start: 2, end: 4, key: "t1" }]);
		expect(attributeLines(["", ""], [edit("t1", change(1, 0, 1, ["", ""]))])).toEqual([]);
	});

	it("finds a run again when something outside the edits moved it", () => {
		const wrote = edit("t1", change(2, 0, 2, ["const total = sum(items);", "return total;"]));
		// A person added three lines on top: the replay puts the run at 2-3, the file has it at 5-6.
		const moved = ["h1", "h2", "h3", "head", "const total = sum(items);", "return total;", "}"];
		expect(attributeLines(moved, [wrote])).toEqual([{ start: 5, end: 6, key: "t1" }]);
	});

	it("does not guess where a run is when two places match equally or only brackets do", () => {
		const twice = ["x();", "y();", "gap", "x();", "y();"];
		expect(attributeLines(twice, [edit("t1", change(20, 0, 20, ["x();", "y();"]))])).toEqual([]);
		expect(attributeLines(["a", "}", "b"], [edit("t1", change(9, 0, 9, ["}"]))])).toEqual([]);
	});

	it("marks nothing for a file that no edit touched or that is empty", () => {
		expect(attributeLines(file, [])).toEqual([]);
		expect(attributeLines([], [edit("t1", change(1, 0, 1, ["gone"]))])).toEqual([]);
	});
});
