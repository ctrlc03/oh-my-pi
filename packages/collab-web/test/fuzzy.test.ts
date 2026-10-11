import { describe, expect, it } from "bun:test";
import { fuzzyMatch, highlightRuns, queryWords, substringMatch } from "../src/lib/fuzzy";

const score = (query: string, text: string): number => fuzzyMatch(query, text)?.score ?? Number.NEGATIVE_INFINITY;

describe("fuzzyMatch", () => {
	it("matches a subsequence in any case and reports where", () => {
		const found = fuzzyMatch("gsh", "Open GitHub sheet");
		expect(found).not.toBeNull();
		const text = "Open GitHub sheet";
		expect(found!.positions.map(at => text[at]!.toLowerCase()).join("")).toBe("gsh");
	});

	it("rejects text that lacks a character, or has them in the wrong order", () => {
		expect(fuzzyMatch("xyz", "Open GitHub sheet")).toBeNull();
		expect(fuzzyMatch("hs", "sh")).toBeNull();
		expect(fuzzyMatch("abcd", "abc")).toBeNull();
	});

	it("needs every word of the query, in any order", () => {
		expect(fuzzyMatch("sheet open", "Open GitHub sheet")).not.toBeNull();
		expect(fuzzyMatch("open banana", "Open GitHub sheet")).toBeNull();
	});

	it("takes an empty query as matching everything", () => {
		expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
	});

	it("ranks a contiguous word start above a scattered match", () => {
		expect(score("git", "Open GitHub sheet")).toBeGreaterThan(score("git", "Digital inspector tool"));
		expect(score("git", "GitHub")).toBeGreaterThan(score("git", "Navigate to it"));
	});

	it("ranks a prefix above the same letters further in", () => {
		expect(score("use", "Use the light theme")).toBeGreaterThan(score("use", "Browse the files"));
		expect(score("tim", "Timeline")).toBeGreaterThan(score("tim", "Runtime"));
	});

	it("prefers the shorter text when the match is equal", () => {
		expect(score("usage", "Usage")).toBeGreaterThan(score("usage", "Usage: spend and tokens"));
	});

	it("marks word starts of camelCase and separators", () => {
		expect(score("sd", "sessionDetails")).toBeGreaterThan(score("sd", "passwords"));
		expect(score("pr", "open-pr")).toBeGreaterThan(score("pr", "happroved"));
	});

	it("never panics on a query longer than the text or on odd characters", () => {
		expect(fuzzyMatch("a".repeat(40), "a")).toBeNull();
		expect(fuzzyMatch("(", "f(x)")?.positions).toEqual([1]);
		expect(fuzzyMatch("i", "İstanbul")).toBeNull();
	});
});

describe("queryWords / highlightRuns", () => {
	it("lower-cases, splits and drops duplicates", () => {
		expect(queryWords("  Open  open GIT ")).toEqual(["open", "git"]);
	});

	it("cuts text into matched and unmatched runs", () => {
		expect(highlightRuns("abcd", [1, 2])).toEqual([
			{ text: "a", hit: false },
			{ text: "bc", hit: true },
			{ text: "d", hit: false },
		]);
		expect(highlightRuns("abc", [])).toEqual([{ text: "abc", hit: false }]);
	});
});

describe("substringMatch", () => {
	it("needs each word as a whole substring, so a long description is not matched by scattered letters", () => {
		expect(substringMatch("mod", "Switch this session's model")).not.toBeNull();
		expect(substringMatch("git", "Redo the turn the last undo removed, until something new is sent")).toBeNull();
		expect(fuzzyMatch("git", "Redo the turn the last undo removed, until something new is sent")).not.toBeNull();
	});

	it("takes the words in any order and prefers a word start", () => {
		expect(substringMatch("model switch", "Switch this session's model")).not.toBeNull();
		expect(substringMatch("mod", "model")!.score).toBeGreaterThan(substringMatch("mod", "commodity")!.score);
	});
});
