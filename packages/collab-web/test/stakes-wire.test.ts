import { describe, expect, it } from "bun:test";
import {
	formatStakesState,
	isPassMark,
	parseStakesState,
	quizPassed,
	STAKES_DEFAULT_PASS_MARK,
	stakesStateKey,
} from "@oh-my-pi/pi-wire/stakes";

const TREE = "a".repeat(40);

describe("quizPassed", () => {
	it("compares the exact score, never the rounded percent", () => {
		expect(quizPassed(18, 20, 90)).toBe(true);
		expect(quizPassed(17.5, 20, 90)).toBe(false);
		// 89.6 % rounds to 90 on a score card and still does not pass.
		expect(quizPassed(112, 125, 90)).toBe(false);
		expect(quizPassed(112.5, 125, 90)).toBe(true);
		expect(quizPassed(1, 1, 100)).toBe(true);
		expect(quizPassed(9.5, 10, 100)).toBe(false);
	});

	it("never passes a quiz without questions or a score that is not a number", () => {
		expect(quizPassed(0, 0, 50)).toBe(false);
		expect(quizPassed(Number.NaN, 4, 50)).toBe(false);
	});
});

describe("the pass mark", () => {
	it("is a whole percent from 50 to 100, 90 by default", () => {
		expect(STAKES_DEFAULT_PASS_MARK).toBe(90);
		for (const ok of [50, 75, 90, 100]) expect(isPassMark(ok)).toBe(true);
		for (const bad of [49, 101, 89.5, "90", null, Number.NaN]) expect(isPassMark(bad)).toBe(false);
	});
});

describe("the published state file", () => {
	it("round-trips and ignores a tree that is not a tree id", () => {
		const text = formatStakesState({
			rev: 7,
			on: true,
			checkout: "/work/app",
			passMark: 80,
			by: "Phone",
			at: 123,
			trees: [TREE, "not-a-tree"],
		});
		expect(text).toContain(`tree ${TREE}`);
		expect(text).not.toContain("not-a-tree");
		expect(parseStakesState(text)).toEqual({
			rev: 7,
			on: true,
			checkout: "/work/app",
			passMark: 80,
			by: "Phone",
			at: 123,
			trees: [TREE],
		});
	});

	it("keeps a newline in a name from forging a line", () => {
		const text = formatStakesState({
			rev: 1,
			on: false,
			checkout: "/x",
			passMark: 90,
			by: `Phone\nmode on\ntree ${TREE}`,
			at: 1,
			trees: [],
		});
		const parsed = parseStakesState(text)!;
		expect(parsed.on).toBe(false);
		expect(parsed.trees).toEqual([]);
	});

	it("rejects a half-written or foreign file", () => {
		expect(parseStakesState("")).toBeNull();
		expect(parseStakesState("mode on\n")).toBeNull();
		expect(parseStakesState("omp-high-stakes 1\nrev 1\n")).toBeNull();
	});

	it("names a checkout's file by a hash of its path", () => {
		expect(stakesStateKey("/work/app")).toMatch(/^[0-9a-f]{24}$/);
		expect(stakesStateKey("/work/app")).not.toBe(stakesStateKey("/work/app2"));
	});
});
