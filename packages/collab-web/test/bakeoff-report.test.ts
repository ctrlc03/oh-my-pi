import { describe, expect, it } from "bun:test";
import type { Bakeoff, BakeoffEntry, BakeoffResult, BakeoffWriteup } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintExcerpt } from "@oh-my-pi/pi-wire/blueprint";
import type { ExportedExcerpt } from "../src/components/architecture/blueprint-model";
import type { BakeoffCodeAccess } from "../src/components/bakeoff/BakeoffCode";
import {
	bakeoffReport,
	embedText,
	excerptKey,
	fence,
	inlineCode,
	loadReportExcerpts,
	REPORT_MAX_CITATIONS,
	reportCitations,
} from "../src/components/bakeoff/bakeoff-report";
import { designBody, designMarkdown, entryName, entryOrigin } from "../src/components/bakeoff/bakeoff-result-flow";

// ── a tiny Markdown scanner: fenced blocks and headings outside them ──────────

interface Block {
	info: string;
	content: string[];
	open: number;
	close: number;
}

/** Fences as CommonMark reads them: an opening run of 3+ backticks, closed by a run at least as long with nothing after it. */
function scan(markdown: string): { blocks: Block[]; headings: string[]; unclosed: boolean } {
	const blocks: Block[] = [];
	const headings: string[] = [];
	let current: Block | null = null;
	for (const line of markdown.split("\n")) {
		const run = /^ {0,3}(`{3,})(.*)$/.exec(line);
		if (current === null) {
			if (run !== null && !run[2]!.includes("`")) {
				current = { info: run[2]!.trim(), content: [], open: run[1]!.length, close: 0 };
				continue;
			}
			if (/^#{1,6} /.test(line)) headings.push(line);
			continue;
		}
		if (run !== null && run[1]!.length >= current.open && run[2]!.trim() === "") {
			current.close = run[1]!.length;
			blocks.push(current);
			current = null;
			continue;
		}
		current.content.push(line);
	}
	return { blocks, headings, unclosed: current !== null };
}

const writeup = (over: Partial<BakeoffWriteup> = {}): BakeoffWriteup => ({
	summary: "Queue the work.",
	approach: "Use a queue.\n\nDrain it in order.",
	tradeoffs: ["Needs a worker"],
	risks: ["Backlog grows"],
	migration: "None.",
	metrics: { simplicity: "One file." },
	refs: [{ path: "src/q.ts", line: 41, token: "enqueue" }],
	...over,
});

const FENCED = "```ts\nconst nested = 1;\n```";

const excerpt = (over: Partial<BlueprintExcerpt> = {}): BlueprintExcerpt => ({
	path: "src/q.ts",
	start: 39,
	lines: ["function a() {}", "export function enqueue() {", "\treturn `x`;", "}"],
	line: 40,
	side: "head",
	commit: "abc123",
	language: "ts",
	...over,
});

const entries = (): BakeoffEntry[] => [
	{
		label: "A",
		kind: "original",
		status: "ready",
		flags: [],
		branch: "SENTINEL-branch-a",
		path: "/SENTINEL/path/a",
		instanceId: "SENTINEL-instance-a",
		facts: { files: 2, added: 10, removed: 4 },
		costUsd: 0.2,
	},
	{
		label: "B",
		kind: "challenger",
		model: "prov/model-b",
		status: "ready",
		flags: ["test script changed"],
		branch: "SENTINEL-branch-b",
		path: "/SENTINEL/path/b",
		instanceId: "SENTINEL-instance-b",
		costUsd: 1.5,
		facts: {
			files: 3,
			added: 30,
			removed: 2,
			deltaFromOriginal: { files: 1, added: 5, removed: 1 },
			tests: { target: "npm test", ok: true },
			bench: { target: "bench:q", better: "lower", runs: [12, 14, 13], value: 13, unit: "ms" },
		},
	},
	{
		label: "C",
		kind: "challenger",
		model: "prov/model-c",
		status: "ready",
		flags: [],
		branch: "SENTINEL-branch-c",
		path: "/SENTINEL/path/c",
		instanceId: "SENTINEL-instance-c",
		facts: { files: 1, added: 1, removed: 0, tests: { target: "npm test", ok: false, reason: "2 tests failed" } },
	},
];

const result = (over: Partial<BakeoffResult> = {}): BakeoffResult => ({
	ranking: [
		{ label: "B", rank: 1, score: 0.82, reasons: ["Simplest of the three", "Fast"], eligible: true, flags: [] },
		{ label: "A", rank: 2, score: 0.6, reasons: ["Plain"], eligible: true, flags: [] },
		{ label: "C", rank: 3, score: 0.3, reasons: [], eligible: false, flags: ["hit its spending limit"] },
	],
	verdict:
		"# Overall\n\nB is simplest: see `B/src/q.ts@40@enqueue` and A/src/old.ts@7@drain.\n\n## Detail\n\nMore words.",
	findings: [
		{
			label: "B",
			kind: "strength",
			text: "One small file.",
			refs: [{ path: "src/q.ts", line: 40, token: "enqueue" }],
			verified: true,
		},
		{ label: "B", kind: "weakness", text: "No retry.", verified: false },
		{ label: "C", kind: "weakness", text: "Breaks the tests.", verified: true },
	],
	scores: {
		A: { simplicity: { reviewer: 0.5, judge: 0.6, combined: 0.55 } },
		B: { simplicity: { reviewer: 1, judge: 0.9, combined: 0.95 }, "lines-changed": { measured: 0.4, combined: 0.4 } },
	},
	pairwise: [{ a: "A", b: "B", metric: "simplicity", winner: "B", consistent: true }],
	agreement: "split",
	splitNote: "The judge preferred A on size.",
	reviewerModel: "SENTINEL-reviewer-model",
	judgeLabel: "SENTINEL-judge-label",
	judgeKind: "local",
	consistency: 0.8,
	selfPreference: ["B"],
	unsure: ["Whether the worker restarts cleanly"],
	taken: "B",
	...over,
});

const bakeoff = (over: Partial<Bakeoff> = {}): Bakeoff => ({
	v: 1,
	id: "bk-1",
	title: "Faster queue",
	repo: { root: "/SENTINEL/root", name: "repo", github: "SENTINEL-gh/repo" },
	createdAt: Date.UTC(2026, 3, 9, 12),
	mode: "implementation",
	start: "base",
	metrics: [
		{ id: "simplicity", label: "Simplicity", weight: 3 },
		{ id: "custom:1", label: "Our retries", text: "Works with\nour retry rules", weight: 1 },
	],
	instructions: "Keep the public API.\nUse this fence: ```",
	entries: entries(),
	stage: "done",
	group: "SENTINEL-group",
	result: result(),
	warnings: ["The judge was slow"],
	reviewer: "SENTINEL-reviewer-selector",
	writer: "SENTINEL-writer-selector",
	judge: "auto",
	costs: { entries: 1.7, writeups: 0.3, review: 0.4, judge: 0.01 },
	...over,
});

const excerpts = new Map<string, BlueprintExcerpt | null>([
	[excerptKey("B", { path: "src/q.ts", line: 40, token: "enqueue" }), excerpt()],
	[excerptKey("A", { path: "src/old.ts", line: 7, token: "drain" }), null],
]);

/** The `## ` headings of a report, outside any code fence. */
const sectionsOf = (report: string): string[] => scan(report).headings.filter(line => line.startsWith("## "));

describe("bakeoffReport sections", () => {
	it("holds every section of an implementation bake-off, in order", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), subject: "feature/x vs main", excerpts });
		expect(report.startsWith("# Faster queue\n")).toBe(true);
		expect(sectionsOf(report)).toEqual([
			"## What matters",
			"## Instructions given to every challenger",
			"## Entries",
			"## Ranking",
			"## What the reviewer found",
			"## Second opinion",
			"## How far to trust the result",
			"## Tests and benchmarks",
			"## What the reviewer could not tell",
			"## Cost",
			"## Notes from the run",
			"## Cited code",
		]);
		expect(report.endsWith("\n")).toBe(true);
	});

	it("lists the facts: subject, mode, where challengers started, the day, what was taken", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), subject: "feature/x vs main", excerpts });
		expect(report).toContain("- Subject: feature/x vs main");
		expect(report).toContain("- Mode: Implementation");
		expect(report).toContain("- Challengers started from: the base");
		expect(report).toContain("- Started: 2026-04-09");
		expect(report).toContain("- Taken: Entry B");
		const original = bakeoffReport({ bakeoff: bakeoff({ start: undefined }), excerpts });
		expect(original).toContain("- Challengers started from: the original's code");
		expect(original).not.toContain("- Subject:");
	});

	it("says a folder bake-off is about a folder that is not a git repository", () => {
		const report = bakeoffReport({
			bakeoff: bakeoff({ mode: "design", folder: true }),
			subject: "a design",
			excerpts,
		});
		expect(report).toContain("- Mode: Design only");
		expect(report).toContain("- About: a folder that is not a git repository");
		expect(report).not.toContain("Challengers started from");
		expect(bakeoffReport({ bakeoff: bakeoff(), excerpts })).not.toContain("not a git repository");
	});

	it("states what matters with weights and a custom metric's own text, and the instructions verbatim", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		expect(report).toContain("- **Simplicity** (weight 3 of 3)");
		expect(report).toContain("- **Our retries** (weight 1 of 3): Works with our retry rules");
		const instructions = scan(report).blocks.find(block => block.content.includes("Keep the public API."));
		expect(instructions?.content).toEqual(["Keep the public API.", "Use this fence: ```"]);
	});

	it("names each entry with its model, status, cost, flags and measured facts", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const entriesText = report.slice(report.indexOf("## Entries"), report.indexOf("## Ranking"));
		expect(entriesText).toContain("### Entry A (the original)");
		expect(entriesText).toContain("### Entry B (prov/model-b)");
		expect(entriesText).toContain("- Status: Ready");
		expect(entriesText).toContain("- Cost: $1.50");
		expect(entriesText).toContain("- Flags: test script changed");
		expect(entriesText).toContain("- Flags: hit its spending limit");
		expect(entriesText).toContain("- Tests passed");
		expect(entriesText).toContain("- Tests failed: 2 tests failed");
	});

	it("ranks with the reviewer's reasons, the percent, the not-eligible note and a taken marker", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const ranking = report.slice(report.indexOf("## Ranking"), report.indexOf("## What the reviewer found"));
		expect(ranking).toContain("- **1.** Entry B (prov/model-b) — 82% — taken");
		expect(ranking).toContain("  - Simplest of the three");
		expect(ranking).toContain("  - Fast");
		expect(ranking).toContain("- **2.** Entry A (the original) — 60%");
		expect(ranking).toContain("  - Tests fail \u2014 the original passes");
		expect(ranking.indexOf("Entry B")).toBeLessThan(ranking.indexOf("Entry A"));
	});

	it("writes the verdict with citations as path:line, findings with unverified ones marked", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const found = report.slice(report.indexOf("## What the reviewer found"), report.indexOf("## Second opinion"));
		expect(found).toContain("`B/src/q.ts:40`");
		expect(found).toContain("`A/src/old.ts:7`");
		expect(found).not.toContain("@40@");
		expect(found).toContain("### Entry B (prov/model-b)");
		expect(found).toContain("**Strengths**");
		expect(found).toContain("- One small file.");
		expect(found).toContain("- No retry. (not checked against code)");
		expect(found).toContain("- Breaks the tests.\n");
		expect(found).not.toContain("- Breaks the tests. (not checked");
	});

	it("keeps the reviewer's headings below the report's own", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const { headings } = scan(report);
		expect(headings).toContain("### Overall");
		expect(headings).toContain("#### Detail");
		expect(headings).not.toContain("# Overall");
		expect(headings.filter(line => line.startsWith("# "))).toEqual(["# Faster queue"]);
	});

	it("gives the second opinion: agreement, why they split, scores and pairwise rows", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const second = report.slice(report.indexOf("## Second opinion"), report.indexOf("## How far to trust"));
		expect(second).toContain("- Split verdict");
		expect(second).toContain("- Why they split: The judge preferred A on size.");
		expect(second).toContain("| Entry | Metric | Reviewer | Judge | Measured | Combined |");
		expect(second).toContain("| Entry B (prov/model-b) | Simplicity | 5/5 | 90% | – | 95% |");
		expect(second).toContain("| Entry B (prov/model-b) | lines-changed | – | – | 40% | 40% |");
		expect(second).toContain("| Pair | Metric | Better |");
		expect(second).toContain("| A vs B | Simplicity | Entry B |");
	});

	it("keeps the scores as their own section when no second opinion ran", () => {
		const report = bakeoffReport({
			bakeoff: bakeoff({
				result: result({
					agreement: "reviewer-only",
					judgeNote: "No second opinion: it was unreachable",
					pairwise: [],
				}),
			}),
			excerpts,
		});
		expect(sectionsOf(report)).toContain("## Scores");
		expect(sectionsOf(report)).not.toContain("## Second opinion");
		expect(report).toContain("- No second opinion: it was unreachable");
	});

	it("says how far to trust the result", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const trust = report.slice(report.indexOf("## How far to trust"), report.indexOf("## Tests and benchmarks"));
		expect(trust).toContain("- The second opinion agreed with itself on 80% of its comparisons");
		expect(trust).toContain("- The reviewer's own model wrote entry B, so it may favour it");
	});

	it("reports tests and the benchmark per entry, with the target and the runs", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const measured = report.slice(
			report.indexOf("## Tests and benchmarks"),
			report.indexOf("## What the reviewer could not"),
		);
		expect(measured).toContain("### Entry B (prov/model-b)");
		expect(measured).toContain("- Tests `npm test`: passed");
		expect(measured).toContain("- Benchmark `bench:q`: 13 ms (lower is better; runs: 12, 14, 13)");
		expect(measured).toContain("- Tests `npm test`: failed — 2 tests failed");
		expect(measured).not.toContain("Entry A");
	});

	it("lists what the reviewer could not tell, the cost by stage and the notes from the run", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		expect(report).toContain("- Whether the worker restarts cleanly");
		expect(report).toContain("- Total: $2.41");
		expect(report).toContain("- By stage: Entries $1.70 · Write-ups $0.300 · Review $0.400 · Second opinion $0.010");
		expect(report).toContain("- The judge was slow");
	});

	it("omits sections that are empty", () => {
		const report = bakeoffReport({
			bakeoff: bakeoff({
				metrics: [],
				instructions: undefined,
				warnings: [],
				costs: { entries: 0, writeups: 0, review: 0, judge: 0 },
				result: result({
					unsure: [],
					findings: [],
					scores: {},
					pairwise: undefined,
					agreement: "reviewer-only",
					consistency: undefined,
					selfPreference: [],
					verdict: "B wins.",
				}),
				entries: entries().map(entry => ({ ...entry, facts: undefined })),
			}),
			excerpts: new Map(),
		});
		expect(sectionsOf(report)).toEqual(["## Entries", "## Ranking", "## What the reviewer found"]);
	});

	it("shows both readings when the reviewer read twice", () => {
		const report = bakeoffReport({
			bakeoff: bakeoff({
				result: result({
					passes: [
						{ ranking: ["B", "A", "C"], verdict: "First: B is best." },
						{ ranking: ["B", "C", "A"], verdict: "Second: B again." },
					],
				}),
			}),
			excerpts,
		});
		expect(report).toContain("### First reading");
		expect(report).toContain("### Second reading");
		expect(report).toContain("First: B is best.");
		expect(report).toContain("Second: B again.");
		expect(report).toContain(
			"The reviewer's order: Entry B (prov/model-b), Entry A (the original), Entry C (prov/model-c)",
		);
	});
});

describe("cited code", () => {
	it("gives each fetched citation a heading and a fenced block with its language", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		expect(report).toContain("### Entry B — src/q.ts:40");
		const block = scan(report).blocks.find(item => item.info === "ts" && item.content[0] === "function a() {}");
		expect(block?.content).toEqual(excerpt().lines);
		expect(report).toContain("Lines 39–42; the cited line is 40.");
	});

	it("lists a citation whose code is missing, without a block", () => {
		const report = bakeoffReport({ bakeoff: bakeoff(), excerpts });
		const at = report.indexOf("### Entry A — src/old.ts:7");
		expect(at).toBeGreaterThan(-1);
		expect(report.slice(at)).toContain("The code was not available.");
		// a citation nobody fetched is listed the same way
		const none = bakeoffReport({ bakeoff: bakeoff(), excerpts: new Map() });
		expect(none).toContain("### Entry B — src/q.ts:40\n\nThe code was not available.");
	});

	it("caps the citations and says how many were left out", () => {
		const many = bakeoff({
			result: result({
				findings: Array.from({ length: REPORT_MAX_CITATIONS + 5 }, (_, at) => ({
					label: "B",
					kind: "strength" as const,
					text: `Point ${at}`,
					refs: [{ path: `src/f${at}.ts`, line: at + 1, token: "x" }],
					verified: true,
				})),
				verdict: "B wins.",
			}),
		});
		const cited = reportCitations(many);
		expect(cited.shown).toHaveLength(REPORT_MAX_CITATIONS);
		expect(cited.omitted).toBe(5);
		const report = bakeoffReport({ bakeoff: many, excerpts: new Map() });
		expect(report).toContain("5 more citations were left out of this report to keep it short.");
		expect(report.match(/^### Entry B — src\/f/gm)).toHaveLength(REPORT_MAX_CITATIONS);
		expect(bakeoffReport({ bakeoff: bakeoff(), excerpts })).not.toContain("left out of this report");
	});

	it("lists each distinct citation once, from the verdict and the findings", () => {
		const cited = reportCitations(bakeoff());
		expect(cited.shown.map(item => `${item.label}:${item.ref.path}:${item.ref.line}`)).toEqual([
			"B:src/q.ts:40",
			"A:src/old.ts:7",
		]);
		expect(cited.omitted).toBe(0);
		expect(reportCitations({ result: undefined })).toEqual({ shown: [], omitted: 0 });
	});
});

describe("fetching the excerpts", () => {
	const ref = (path: string, line: number) => ({ path, line, token: "t" });

	it("reuses the cache, asks once per entry, and keeps going when a read fails", async () => {
		const cache = new Map<string, ExportedExcerpt | null>();
		cache.set(excerptKey("A", ref("a.ts", 1)), excerpt({ path: "a.ts" }));
		const calls: { entry: string; refs: string[] }[] = [];
		const access: BakeoffCodeAccess = {
			cache,
			excerpts: async (entry, refs) => {
				calls.push({ entry, refs: refs.map(item => item.path) });
				if (entry === "C") throw new Error("the worktree is gone");
				return refs.map(item => excerpt({ path: item.path }));
			},
		};
		const got = await loadReportExcerpts(access, [
			{ label: "A", ref: ref("a.ts", 1) },
			{ label: "B", ref: ref("b.ts", 2) },
			{ label: "B", ref: ref("b2.ts", 3) },
			{ label: "C", ref: ref("c.ts", 4) },
		]);
		expect(calls).toEqual([
			{ entry: "B", refs: ["b.ts", "b2.ts"] },
			{ entry: "C", refs: ["c.ts"] },
		]);
		expect(got.get(excerptKey("A", ref("a.ts", 1)))?.path).toBe("a.ts");
		expect(got.get(excerptKey("B", ref("b2.ts", 3)))?.path).toBe("b2.ts");
		expect(got.get(excerptKey("C", ref("c.ts", 4)))).toBeNull();
		// what was read is kept for the code panels; what failed is not, so it can be tried again
		expect(cache.has(excerptKey("B", ref("b.ts", 2)))).toBe(true);
		expect(cache.has(excerptKey("C", ref("c.ts", 4)))).toBe(false);
	});
});

describe("what is withheld", () => {
	const sentinels = [
		"SENTINEL-reviewer-selector",
		"SENTINEL-writer-selector",
		"SENTINEL-reviewer-model",
		"SENTINEL-judge-label",
		"SENTINEL-branch",
		"SENTINEL/path",
		"SENTINEL-instance",
		"SENTINEL-group",
		"SENTINEL/root",
		"SENTINEL-gh",
		"bk-1",
	];

	it("never holds a reviewer, writer or judge model, a branch, path, session, group or repository", () => {
		for (const mode of ["implementation", "design"] as const) {
			const report = bakeoffReport({
				bakeoff: bakeoff({
					mode,
					entries: entries().map(entry => ({ ...entry, writeup: writeup() })),
				}),
				subject: "feature/x vs main",
				excerpts,
			});
			for (const sentinel of sentinels) expect(report).not.toContain(sentinel);
		}
	});

	it("takes the judge's and the reviewer's names out of the notes it prints", () => {
		const report = bakeoffReport({
			bakeoff: bakeoff({
				result: result({
					judgeNote: "No second opinion: SENTINEL-judge-label was unreachable",
					splitNote: "SENTINEL-reviewer-model liked A",
				}),
			}),
			excerpts,
		});
		expect(report).toContain("No second opinion: the judge was unreachable");
		expect(report).toContain("Why they split: the reviewer liked A");
		for (const sentinel of sentinels) expect(report).not.toContain(sentinel);
	});

	it("reveals the models of the entries and nothing more than the result view does after Show models", () => {
		const subject = bakeoff();
		const report = bakeoffReport({ bakeoff: subject, excerpts });
		for (const entry of subject.entries) {
			const origin = entryOrigin(entry, true);
			expect(report).toContain(entryName(entry, true));
			expect(origin).not.toBeNull();
		}
		// every provider/model-looking name in the report is an entry's model
		const named = new Set(report.match(/prov\/model-\w/g));
		expect([...named].sort()).toEqual(["prov/model-b", "prov/model-c"]);
	});

	it("needs no companion capability: it is built from the bake-off alone", () => {
		expect(() => bakeoffReport({ bakeoff: bakeoff(), excerpts: new Map() })).not.toThrow();
	});
});

describe("designs", () => {
	const designs = (): Bakeoff => {
		const base = bakeoff({ mode: "design", start: undefined, instructions: undefined });
		return {
			...base,
			entries: [
				{
					label: "A",
					kind: "original",
					status: "ready",
					flags: [],
					writeup: writeup({ summary: "Original design text." }),
				},
				{
					label: "B",
					kind: "challenger",
					model: "prov/model-b",
					status: "ready",
					flags: [],
					writeup: writeup({
						summary: "Use a ring buffer.",
						approach: "# Plan\n\nA ring.\n\n```text\nopen and never closed",
						tradeoffs: ["Fixed size"],
						diagram: "graph TD; A-->B",
					}),
				},
				{
					label: "C",
					kind: "challenger",
					model: "prov/model-c",
					status: "ready",
					flags: [],
					writeup: writeup({ summary: "Use a heap." }),
				},
			],
		};
	};

	it("holds each design under its entry with the headings demoted", () => {
		const report = bakeoffReport({ bakeoff: designs(), excerpts });
		const at = report.indexOf("## Designs");
		expect(at).toBeGreaterThan(-1);
		const text = report.slice(at);
		expect(text).toContain("### Entry A (the original)");
		expect(text).toContain("### Entry B (prov/model-b)");
		expect(text).toContain("### Entry C (prov/model-c)");
		for (const summary of ["Original design text.", "Use a ring buffer.", "Use a heap."])
			expect(text).toContain(summary);
		expect(text).toContain("#### Summary");
		expect(text).toContain("#### Trade-offs");
		expect(text).toContain("- Fixed size");
		expect(text).toContain("##### Plan");
		expect(text).toContain("```mermaid\ngraph TD; A-->B\n```");
		expect(scan(report).unclosed).toBe(false);
		expect(sectionsOf(report).at(-1)).toBe("## Designs");
	});

	it("closes a fence the designer left open, so the next entry stays an entry", () => {
		const report = bakeoffReport({ bakeoff: designs(), excerpts });
		expect(scan(report).unclosed).toBe(false);
		const headings = scan(report).headings;
		expect(headings).toContain("### Entry C (prov/model-c)");
		const open = scan(report).blocks.find(block => block.content.includes("open and never closed"));
		expect(open?.info).toBe("text");
	});

	it("leaves the Copy design text of an entry as it was, and nests the same body", () => {
		const subject = designs();
		const entry = subject.entries[2]!;
		const markdown = designMarkdown(subject, entry);
		expect(markdown.startsWith("# Faster queue\n\n## Summary\n\nUse a heap.\n\n## Approach")).toBe(true);
		expect(markdown).toBe(`# Faster queue\n\n${designBody(subject, entry)}\n`);
		expect(designBody(subject, entry, 4)).toContain("#### Summary\n\nUse a heap.");
		expect(designBody(subject, { ...entry, writeup: undefined })).toBe("This entry has no write-up.");
	});
});

describe("Markdown safety", () => {
	it("fences content with a run longer than any backtick run inside it", () => {
		expect(fence("plain")).toBe("```\nplain\n```");
		expect(fence("has ``` inside", "ts")).toBe("````ts\nhas ``` inside\n````");
		expect(fence("a ````` b")).toBe("``````\na ````` b\n``````");
		expect(fence("one ` tick\n\n")).toBe("```\none ` tick\n```");
	});

	it("quotes inline code with a delimiter longer than its backticks", () => {
		expect(inlineCode("a/b.ts:4")).toBe("`a/b.ts:4`");
		expect(inlineCode("a`b")).toBe("``a`b``");
		expect(inlineCode("`edge`")).toBe("`` `edge` ``");
	});

	it("demotes headings outside fences, never past six, and closes a fence left open", () => {
		expect(embedText("# One\n\ntext\n\n###### Six", 2)).toBe("### One\n\ntext\n\n###### Six");
		expect(embedText("```\n# not a heading\n```\n# real", 2)).toBe("```\n# not a heading\n```\n### real");
		expect(embedText("```ts\ncode", 0)).toBe("```ts\ncode\n```");
		expect(embedText("````\n```\ninner\n```\nstill inside", 0)).toBe("````\n```\ninner\n```\nstill inside\n````");
		expect(embedText("~~~\nx", 0)).toBe("~~~\nx\n~~~");
		// not a heading: no space after the hashes
		expect(embedText("#hashtag", 2)).toBe("#hashtag");
	});

	it("keeps each excerpt, the instructions and reviewer text in ONE fenced block when they hold ```", () => {
		const tricky = excerpt({ lines: ["const a = `x`;", "```", "console.log(a);", "````", "end"] });
		const subject = bakeoff({
			instructions: "Use ```js blocks\nand `````  too",
			result: result({
				verdict: "Look:\n\n```ts\nconst x = 1;\n```\n\nThen:\n\n```\nnever closed",
				unsure: ["It said ```\nand stopped"],
				findings: [
					{
						label: "B",
						kind: "weakness",
						text: "Wrote ```\nsomething",
						refs: [{ path: "src/q.ts", line: 40, token: "enqueue" }],
						verified: true,
					},
				],
			}),
		});
		const report = bakeoffReport({
			bakeoff: subject,
			excerpts: new Map([[excerptKey("B", { path: "src/q.ts", line: 40, token: "enqueue" }), tricky]]),
		});
		const scanned = scan(report);
		expect(scanned.unclosed).toBe(false);
		// the excerpt: one block whose fence is longer than its longest run (4) and whose content is all five lines
		const code = scanned.blocks.find(block => block.content[0] === "const a = `x`;");
		expect(code).toBeDefined();
		expect(code!.open).toBe(5);
		expect(code!.close).toBe(5);
		expect(code!.content).toEqual(tricky.lines);
		// the instructions: the fence beats the five-backtick run inside
		const instructions = scanned.blocks.find(block => block.content[0] === "Use ```js blocks");
		expect(instructions!.open).toBe(6);
		expect(instructions!.content).toEqual(["Use ```js blocks", "and `````  too"]);
		// reviewer text: its own fence stays a block, the one it forgot to close is closed, and sections still follow
		expect(scanned.blocks.some(block => block.info === "ts" && block.content[0] === "const x = 1;")).toBe(true);
		expect(scanned.blocks.some(block => block.content.includes("never closed"))).toBe(true);
		expect(report).toContain("- It said ```\n  and stopped");
		const sections = sectionsOf(report);
		expect(sections.at(-1)).toBe("## Cited code");
		expect(sections).toContain("## What the reviewer could not tell");
		expect(sections).toContain("## Cost");
	});
});
