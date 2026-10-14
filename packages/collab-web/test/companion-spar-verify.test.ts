import { describe, expect, it } from "bun:test";
import { SPAR_MAX_POINTS } from "@oh-my-pi/pi-wire/spar";
import {
	capPoints,
	MAX_POINTS_PER_PART,
	type ParsedPoint,
	parseSparOutput,
	verifySpar,
} from "../scripts/companion-spar-verify";

const CASE = {
	strongest_defence: "It is checked at compile time.",
	concede_when: ["The developer names the compiler."],
	counters: [{ if_defence: "Convention", counter: "A cast defeats it.", refs: ["a.ts@2@gone"] }],
	suggestion: "Seal the constructor.",
	suggestion_refs: ["a.ts@1@alpha"],
};

function point(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "failure",
		title: "A point",
		challenge: "Why?\n\nBecause.",
		refs: ["a.ts@1@alpha"],
		case: CASE,
		...over,
	};
}

describe("parseSparOutput", () => {
	it("reads points per part, numbering parts from 1, and splits the case file", () => {
		const warnings: string[] = [];
		const parsed = parseSparOutput(
			{
				parts: [
					{ part: 1, points: [point({ severity: 3 }), point({ title: "Second", severity: "9" })] },
					{ points: [point()] },
				],
			},
			2,
			warnings,
		);
		expect(parsed.map(item => [item.part, item.title, item.severity])).toEqual([
			[0, "A point", 3],
			[0, "Second", 2],
			[1, "A point", 2],
		]);
		expect(parsed[0]!.case).toMatchObject({
			strongestDefence: "It is checked at compile time.",
			concedeWhen: ["The developer names the compiler."],
			counters: [{ ifDefence: "Convention", counter: "A cast defeats it." }],
			suggestion: "Seal the constructor.",
		});
		expect(warnings).toEqual([]);
	});

	it("accepts a flat list and drops what cannot be used, saying so", () => {
		const warnings: string[] = [];
		const parsed = parseSparOutput(
			{
				points: [
					point({ part: 1 }),
					point({ part: 7, title: "Nowhere" }),
					point({ part: 1, kind: "style", title: "Wrong kind" }),
					point({ part: 1, title: undefined }),
					point({ part: 1, title: "No case", case: { strongestDefence: "x" } }),
				],
			},
			1,
			warnings,
		);
		expect(parsed).toHaveLength(1);
		expect(warnings.join("\n")).toContain("no such part");
		expect(warnings.join("\n")).toContain("needs a title");
		expect(warnings.join("\n")).toContain('Skipped the point "No case"');
	});

	it("cuts a part to its strongest points", () => {
		const many = Array.from({ length: MAX_POINTS_PER_PART + 2 }, (_, at) => point({ title: `P${at}` }));
		const warnings: string[] = [];
		expect(parseSparOutput({ parts: [{ points: many }] }, 1, warnings)).toHaveLength(MAX_POINTS_PER_PART);
		expect(warnings.join(" ")).toContain("were cut");
	});

	it("throws for a file that is not a spar", () => {
		expect(() => parseSparOutput([], 1, [])).toThrow(/not a JSON object/);
		expect(() => parseSparOutput({}, 1, [])).toThrow(/no points/);
		expect(() => parseSparOutput({ points: [{ nonsense: true }] }, 1, [])).toThrow(/None of the agent's points/);
	});
});

const FILES: Record<string, string[]> = {
	"a.ts": ["alpha line", "beta line", "gamma line"],
	"@design": ["# Design", "We use Redis."],
};

const io = {
	lines: async (_part: number, _side: string, path: string): Promise<string[] | null> =>
		Object.hasOwn(FILES, path) ? FILES[path]! : null,
};

function parsed(over: Partial<ParsedPoint> & { refs: ParsedPoint["refs"] }): ParsedPoint {
	return {
		part: 0,
		kind: "cost",
		title: "T",
		challenge: "C\n\nD",
		severity: 2,
		case: { strongestDefence: "s", concedeWhen: ["c"], counters: [], suggestionRefs: [] },
		...over,
	};
}

describe("verifySpar", () => {
	it("drops points with no citation that holds, moves a citation to its line, and numbers the survivors", async () => {
		const result = await verifySpar(
			[
				parsed({ title: "Moved", refs: [{ path: "a.ts", line: 3, token: "alpha" }] }),
				parsed({ title: "Gone", refs: [{ path: "a.ts", line: 1, token: "nothing" }] }),
				parsed({ title: "Design", refs: [{ path: "@design", line: 2, token: "Redis" }] }),
				parsed({ title: "Uncited", refs: [] }),
			],
			io,
		);
		expect(result.points.map(item => [item.id, item.title])).toEqual([
			["p1", "Moved"],
			["p2", "Design"],
		]);
		expect(result.points[0]!.refs).toEqual([{ path: "a.ts", line: 1, token: "alpha" }]);
		expect(result.points[1]!.refs).toEqual([{ path: "@design", line: 2, token: "Redis" }]);
		expect(result.stats.pointsDropped).toBe(2);
		expect(result.warnings.join("\n")).toContain('Dropped the point "Gone"');
		expect(Object.keys(result.cases)).toEqual(["p1", "p2"]);
	});

	it("loses the failing citations of counters and the suggestion but keeps them", async () => {
		const result = await verifySpar(
			[
				parsed({
					refs: [{ path: "a.ts", line: 1, token: "alpha" }],
					case: {
						strongestDefence: "s",
						concedeWhen: ["c"],
						counters: [{ ifDefence: "i", counter: "c", refs: [{ path: "a.ts", line: 2, token: "missing" }] }],
						suggestion: "Do it.",
						suggestionRefs: [{ path: "a.ts", line: 2, token: "beta" }],
					},
				}),
			],
			io,
		);
		expect(result.cases.p1!.counters[0]!.refs).toEqual([]);
		expect(result.cases.p1!.suggestionRefs).toEqual([{ path: "a.ts", line: 2, token: "beta" }]);
	});

	it("keeps at most the strongest points of every part", async () => {
		const list = Array.from({ length: SPAR_MAX_POINTS + 4 }, (_, at) =>
			parsed({ part: at % 2, title: `P${at}`, refs: [{ path: "a.ts", line: 1, token: "alpha" }] }),
		);
		const result = await verifySpar(list, io);
		expect(result.points).toHaveLength(SPAR_MAX_POINTS);
		expect(result.points.filter(item => item.part === 0)).toHaveLength(SPAR_MAX_POINTS / 2);
		expect(result.warnings.join(" ")).toContain("strongest");
	});
});

describe("capPoints", () => {
	it("takes points in turns across the parts and keeps the original order", () => {
		const list = [
			{ part: 0, id: "a1" },
			{ part: 0, id: "a2" },
			{ part: 0, id: "a3" },
			{ part: 1, id: "b1" },
			{ part: 2, id: "c1" },
		];
		expect(capPoints(list, 4).map(item => item.id)).toEqual(["a1", "a2", "b1", "c1"]);
		expect(capPoints(list, 9)).toEqual(list);
	});
});
