import { describe, expect, it } from "bun:test";
import {
	type CitationStats,
	checkCitations,
	fileKey,
	parseRefs,
	parseRefText,
	readCitedFiles,
	type Side,
	Warnings,
} from "../scripts/companion-citations";

const FILES: Record<Side, Record<string, string[]>> = {
	head: {
		"src/a.ts": ["import { b } from './b';", "", "export function run() {", "\treturn b();", "}"],
		"src/b.ts": ["export function b() {", "\treturn 1;", "}", "", "// b again", "export const other = b;"],
	},
	base: { "src/gone.ts": ["export const gone = 1;"] },
};

async function check(
	refs: Parameters<typeof checkCitations>[0],
	sideOf: (ref: { side?: Side }) => Side = ref => ref.side ?? "head",
) {
	const files = await readCitedFiles(
		refs.map(ref => ({ side: sideOf(ref), path: ref.path })),
		async (side, path) => (Object.hasOwn(FILES[side], path) ? FILES[side][path]! : null),
	);
	const stats: CitationStats = { verified: 0, moved: 0, dropped: 0 };
	const warnings = new Warnings();
	const kept = checkCitations(refs, "question 1", sideOf, files, stats, warnings);
	return { kept, stats, warnings: warnings.list() };
}

describe("parsing citations", () => {
	it("reads path@line@token, with a token that contains @, and base: for the removed side", () => {
		expect(parseRefText("src/a.ts@3@export function run")).toEqual({
			path: "src/a.ts",
			line: 3,
			token: "export function run",
		});
		expect(parseRefText("src/a.ts@4@@Injectable()")).toEqual({ path: "src/a.ts", line: 4, token: "@Injectable()" });
		expect(parseRefText("base:src/gone.ts@1@gone")).toEqual({
			path: "src/gone.ts",
			line: 1,
			token: "gone",
			side: "base",
		});
		for (const bad of ["", "src/a.ts", "src/a.ts@x@y", "../a.ts@1@x", "/abs.ts@1@x", "a.ts@0@x", "a.ts@1@"])
			expect(parseRefText(bad)).toBeUndefined();
	});

	it("accepts objects and strings, drops repeats and caps the list", () => {
		const refs = parseRefs([
			"src/a.ts@3@run",
			{ path: "src/a.ts", line: 3, token: "run" },
			{ path: "src/b.ts", line: "1", token: "b" },
			{ path: "src/b.ts", line: 1, token: "multi\nline" },
			42,
		]);
		expect(refs).toEqual([
			{ path: "src/a.ts", line: 3, token: "run" },
			{ path: "src/b.ts", line: 1, token: "b" },
		]);
		expect(parseRefs(Array.from({ length: 20 }, (_, i) => `src/a.ts@${i + 1}@t${i}`))).toHaveLength(6);
		expect(parseRefs("nope")).toEqual([]);
	});
});

describe("checking citations", () => {
	it("keeps a citation whose token is on its line", async () => {
		const { kept, stats } = await check([{ path: "src/a.ts", line: 3, token: "export function run" }]);
		expect(kept).toEqual([{ path: "src/a.ts", line: 3, token: "export function run" }]);
		expect(stats).toEqual({ verified: 1, moved: 0, dropped: 0 });
	});

	it("moves a citation to the one line that has the token, or the one near it", async () => {
		const unique = await check([{ path: "src/a.ts", line: 1, token: "return b" }]);
		expect(unique.kept[0]!.line).toBe(4);
		expect(unique.stats.moved).toBe(1);
		// `b()` occurs on three lines of b.ts, only one within 20 lines of... all are: ambiguous, so dropped.
		const ambiguous = await check([{ path: "src/b.ts", line: 3, token: "b" }]);
		expect(ambiguous.kept).toEqual([]);
		expect(ambiguous.stats.dropped).toBe(1);
		expect(ambiguous.warnings[0]).toContain("none clearly the one meant");
	});

	it("drops a citation whose token or file is not there, and says so", async () => {
		const { kept, stats, warnings } = await check([
			{ path: "src/a.ts", line: 2, token: "nowhere" },
			{ path: "src/missing.ts", line: 1, token: "x" },
		]);
		expect(kept).toEqual([]);
		expect(stats.dropped).toBe(2);
		expect(warnings.join("\n")).toContain("the token is not in the file");
		expect(warnings.join("\n")).toContain("the file is not readable at that commit");
	});

	it("reads a base citation from the base side and marks it, and deduplicates", async () => {
		const { kept } = await check([
			{ path: "src/gone.ts", line: 1, token: "gone", side: "base" },
			{ path: "src/a.ts", line: 3, token: "export function run" },
			{ path: "src/a.ts", line: 4, token: "export function run" },
		]);
		expect(kept).toEqual([
			{ path: "src/gone.ts", line: 1, token: "gone", side: "base" },
			{ path: "src/a.ts", line: 3, token: "export function run" },
		]);
	});

	it("reads each file once and keys them by side", async () => {
		let reads = 0;
		const files = await readCitedFiles(
			[
				{ side: "head", path: "a" },
				{ side: "head", path: "a" },
				{ side: "base", path: "a" },
			],
			async () => {
				reads++;
				return ["x"];
			},
		);
		expect(reads).toBe(2);
		expect([...files.keys()].sort()).toEqual([fileKey("base", "a"), fileKey("head", "a")].sort());
	});

	it("lists a few warnings per kind and counts the rest", () => {
		const warnings = new Warnings();
		for (let i = 0; i < 15; i++) warnings.add("ref", `w${i}`, n => `${n} more`);
		const list = warnings.list();
		expect(list).toHaveLength(13);
		expect(list.at(-1)).toBe("3 more");
	});
});
