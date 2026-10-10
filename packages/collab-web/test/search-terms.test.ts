import { describe, expect, it } from "bun:test";
import { setJumpIntent, takeJumpIntent } from "../src/lib/jump-intent";
import { groupBySession, queryTerms, searchable, splitMatches } from "../src/lib/search-terms";

describe("splitMatches", () => {
	it("marks every term in any case and keeps the text in between", () => {
		const parts = splitMatches("Fix the Flaky test, fix it", queryTerms("fix flaky"));
		expect(parts.filter(p => p.hit).map(p => p.text)).toEqual(["Fix", "Flaky", "fix"]);
		expect(parts.map(p => p.text).join("")).toBe("Fix the Flaky test, fix it");
	});

	it("treats regex characters in a term literally and prefers the longer term", () => {
		expect(splitMatches("call a.b(c) now", ["a.b(c)"]).filter(p => p.hit)).toEqual([{ text: "a.b(c)", hit: true }]);
		expect(splitMatches("a.b", ["a.b"]).filter(p => p.hit)).toHaveLength(1);
		expect(splitMatches("axb", ["a.b"]).some(p => p.hit)).toBe(false);
		expect(
			splitMatches("testing", ["test", "testing"])
				.filter(p => p.hit)
				.map(p => p.text),
		).toEqual(["testing"]);
	});

	it("returns the text whole without terms", () => {
		expect(splitMatches("plain", [])).toEqual([{ text: "plain", hit: false }]);
	});
});

describe("searchable", () => {
	it("needs two characters once trimmed", () => {
		expect(searchable("a")).toBe(false);
		expect(searchable("  a ")).toBe(false);
		expect(searchable("ab")).toBe(true);
		expect(searchable("日本")).toBe(true);
	});
});

describe("groupBySession", () => {
	it("groups in order of first appearance, keeping each group's order", () => {
		const hits = [
			{ sessionId: "b", n: 1 },
			{ sessionId: "a", n: 2 },
			{ sessionId: "b", n: 3 },
		];
		expect(groupBySession(hits).map(group => group.map(hit => hit.n))).toEqual([[1, 3], [2]]);
	});
});

describe("jump intent", () => {
	it("applies once, only to the session it names, and can be cancelled", () => {
		setJumpIntent({ sessionId: "s1", entryId: "e1" });
		expect(takeJumpIntent("other")).toBeNull();
		expect(takeJumpIntent("s1")).toBe("e1");
		expect(takeJumpIntent("s1")).toBeNull();
		setJumpIntent({ sessionId: "s1", entryId: "e2" });
		setJumpIntent(null);
		expect(takeJumpIntent("s1")).toBeNull();
	});
});
