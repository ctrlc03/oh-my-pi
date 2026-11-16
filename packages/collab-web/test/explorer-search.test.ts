import { describe, expect, it } from "bun:test";
import {
	compileHighlighter,
	groupLocations,
	groupMatches,
	type Highlighter,
	type MatchOptions,
	resultCounts,
	splitBySpans,
	windowLine,
} from "../src/components/ide/explorer/search-model";
import type { FileSearchMatch, LspLocation } from "../src/lib/repo-intel";

const options = (query: string, rest: Partial<MatchOptions> = {}): MatchOptions => ({
	query,
	regex: false,
	caseSensitive: false,
	wholeWord: false,
	...rest,
});

function spans(opts: MatchOptions, text: string): [number, number][] {
	const highlighter: Highlighter | null = compileHighlighter(opts);
	if (highlighter === null || !highlighter.ok) throw new Error("expected a valid highlighter");
	return highlighter.spans(text).map(([a, b]) => [a, b]);
}

describe("compileHighlighter", () => {
	it("has nothing to highlight for an empty query", () => {
		expect(compileHighlighter(options(""))).toBeNull();
	});

	it("matches case-insensitively by default and exactly with caseSensitive", () => {
		expect(spans(options("foo"), "Foo foo FOO")).toEqual([
			[0, 3],
			[4, 7],
			[8, 11],
		]);
		expect(spans(options("foo", { caseSensitive: true }), "Foo foo FOO")).toEqual([[4, 7]]);
	});

	it("takes plain text literally, regex characters included", () => {
		expect(spans(options("a.b(c)"), "a.b(c) axb(c)")).toEqual([[0, 6]]);
		expect(spans(options("[x]"), "a[x]b")).toEqual([[1, 4]]);
	});

	it("matches whole words only", () => {
		expect(spans(options("cat", { wholeWord: true }), "cat concat cat_ cats (cat) cat")).toEqual([
			[0, 3],
			[22, 25],
			[27, 30],
		]);
	});

	it("treats letters of any script as word characters", () => {
		expect(spans(options("é", { wholeWord: true }), "é aé é")).toEqual([
			[0, 1],
			[5, 6],
		]);
	});

	it("applies whole word to a whole alternation, not to one branch", () => {
		expect(spans(options("a|b", { regex: true, wholeWord: true }), "a ab b")).toEqual([
			[0, 1],
			[5, 6],
		]);
	});

	it("reads the query as a regular expression", () => {
		expect(spans(options(String.raw`fo+\b`, { regex: true }), "fo foo fooo x")).toEqual([
			[0, 2],
			[3, 6],
			[7, 11],
		]);
		expect(spans(options("^\\s*const", { regex: true }), "  const a")).toEqual([[0, 7]]);
	});

	it("finds several matches on one line, in order and without overlap", () => {
		expect(spans(options("aa"), "aaaa aa")).toEqual([
			[0, 2],
			[2, 4],
			[5, 7],
		]);
	});

	it("skips zero-width matches", () => {
		expect(spans(options("a*", { regex: true }), "baab")).toEqual([[1, 3]]);
		expect(spans(options("x?", { regex: true }), "abc")).toEqual([]);
	});

	it("reports an invalid regular expression instead of throwing", () => {
		const highlighter = compileHighlighter(options("(unclosed", { regex: true }));
		expect(highlighter?.ok).toBe(false);
		if (highlighter !== null && !highlighter.ok) expect(highlighter.message).toContain("Invalid regular expression");
		expect(compileHighlighter(options("[", { regex: true }))?.ok).toBe(false);
		// The same text as a plain query is fine.
		expect(compileHighlighter(options("(unclosed"))?.ok).toBe(true);
	});

	it("accepts regex syntax that is only valid without the unicode flag", () => {
		expect(spans(options(String.raw`a\-b`, { regex: true }), "a-b")).toEqual([[0, 3]]);
	});

	it("reports offsets in UTF-16 code units, as the editors do", () => {
		// "😀" is two code units; the match after it starts at 3.
		const text = "😀 hit";
		expect(spans(options("hit"), text)).toEqual([[3, 6]]);
		expect(text.slice(3, 6)).toBe("hit");
		// An emoji in the query is two code units wide.
		expect(spans(options("😀"), "a😀b")).toEqual([[1, 3]]);
	});

	it("caps the matches of one line", () => {
		expect(spans(options("a"), "a".repeat(500)).length).toBe(50);
	});

	it("can be reused: each line starts from its own beginning", () => {
		const highlighter = compileHighlighter(options("x"));
		if (highlighter === null || !highlighter.ok) throw new Error("expected ok");
		expect(highlighter.spans("xx")).toEqual([
			[0, 1],
			[1, 2],
		]);
		expect(highlighter.spans("x")).toEqual([[0, 1]]);
	});
});

describe("splitBySpans", () => {
	it("cuts a line into plain and matched runs", () => {
		expect(
			splitBySpans("a foo b foo", [
				[2, 5],
				[8, 11],
			]),
		).toEqual([
			{ text: "a ", hit: false },
			{ text: "foo", hit: true },
			{ text: " b ", hit: false },
			{ text: "foo", hit: true },
		]);
	});

	it("is the whole line without matches", () => {
		expect(splitBySpans("abc", [])).toEqual([{ text: "abc", hit: false }]);
		expect(splitBySpans("", [])).toEqual([]);
	});
});

describe("windowLine", () => {
	it("drops the indentation and moves the matches with the text", () => {
		const view = windowLine("    return foo;", [[11, 14]]);
		expect(view.text).toBe("return foo;");
		expect(view.spans).toEqual([[7, 10]]);
		expect(view.text.slice(7, 10)).toBe("foo");
	});

	it("cuts a long line so the first match is near the start, marking the cut", () => {
		const text = `${"x".repeat(100)}needle tail`;
		const view = windowLine(text, [[100, 106]]);
		expect(view.text.startsWith("…")).toBe(true);
		expect(view.text.slice(view.spans[0]![0], view.spans[0]![1])).toBe("needle");
		expect(view.spans[0]![0]).toBeLessThan(30);
	});

	it("leaves a line whose match is near the start alone", () => {
		expect(windowLine("find me", [[0, 4]])).toEqual({ text: "find me", spans: [[0, 4]] });
	});

	it("keeps later matches after a cut", () => {
		const text = `${" ".repeat(2)}${"y".repeat(60)}ab ab`;
		const view = windowLine(text, [
			[62, 64],
			[65, 67],
		]);
		expect(view.spans.map(([a, b]) => view.text.slice(a, b))).toEqual(["ab", "ab"]);
	});
});

describe("groupMatches", () => {
	const match = (path: string, line: number, character?: number): FileSearchMatch => ({
		path,
		line,
		character,
		text: `${path}:${line}`,
	});

	it("groups by file, files by path and matches by line", () => {
		const groups = groupMatches([
			match("src/b.ts", 9),
			match("src/a.ts", 20),
			match("src/b.ts", 2),
			match("src/a.ts", 3),
			match("src/a.ts", 3, 5),
		]);
		expect(groups.map(g => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(groups[0]!.items.map(m => [m.line, m.character])).toEqual([
			[3, undefined],
			[3, 5],
			[20, undefined],
		]);
		expect(groups[1]!.items.map(m => m.line)).toEqual([2, 9]);
	});

	it("is empty without matches", () => {
		expect(groupMatches([])).toEqual([]);
	});
});

describe("groupLocations", () => {
	const at = (path: string, line: number, inRepo = true, character = 0): LspLocation => ({
		path,
		inRepo,
		range: { start: { line, character }, end: { line, character: character + 3 } },
	});

	it("lists the repository's files first, then outside ones, each by path and line", () => {
		const groups = groupLocations([
			at("/usr/lib/z.d.ts", 1, false),
			at("src/b.ts", 8),
			at("src/a.ts", 40),
			at("src/a.ts", 4, true, 9),
			at("src/a.ts", 4, true, 2),
			at("/opt/dep/index.ts", 7, false),
		]);
		expect(groups.map(g => g.path)).toEqual(["src/a.ts", "src/b.ts", "/opt/dep/index.ts", "/usr/lib/z.d.ts"]);
		expect(groups[0]!.items.map(l => [l.range.start.line, l.range.start.character])).toEqual([
			[4, 2],
			[4, 9],
			[40, 0],
		]);
		expect(groups.map(g => g.items[0]!.inRepo)).toEqual([true, true, false, false]);
	});
});

describe("resultCounts", () => {
	it("pluralises", () => {
		expect(resultCounts(1, 1)).toBe("1 result in 1 file");
		expect(resultCounts(12, 3)).toBe("12 results in 3 files");
		expect(resultCounts(0, 0)).toBe("0 results in 0 files");
	});
});
