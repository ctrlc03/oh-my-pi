import { describe, expect, it } from "bun:test";
import type { Bakeoff, BakeoffEntry, BakeoffMetric, BakeoffResult, BakeoffWriteup } from "@oh-my-pi/pi-wire/bakeoff";
import {
	agreementSummary,
	canReviewAgain,
	canStopEntry,
	canTake,
	costLine,
	designMarkdown,
	diagramMarkdown,
	entryName,
	entryStatusWord,
	factItems,
	INELIGIBLE_NOTE,
	judgeRanking,
	pairRows,
	parseVerdictCitations,
	rankRows,
	rankText,
	resultNotes,
	reviewAgainNote,
	reviewerRanking,
	reviewerText,
	runState,
	scoreCell,
	scoreMetrics,
	stageIndex,
	stageWord,
	takeLines,
	takePlan,
	verdictCitations,
	verdictViews,
} from "../src/components/bakeoff/bakeoff-result-flow";

const metrics: BakeoffMetric[] = [
	{ id: "simplicity", label: "Simplicity", weight: 3 },
	{ id: "lines-changed", label: "Lines changed", weight: 1 },
];

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

const entry = (label: string, over: Partial<BakeoffEntry> = {}): BakeoffEntry => ({
	label,
	kind: "challenger",
	model: `prov/model-${label.toLowerCase()}`,
	status: "ready",
	flags: [],
	...over,
});

const result = (over: Partial<BakeoffResult> = {}): BakeoffResult => ({
	ranking: [
		{ label: "B", rank: 2, score: 0.61, reasons: ["Fewer parts"], eligible: true, flags: [] },
		{ label: "A", rank: 1, score: 0.8, reasons: ["Simplest", "Fast"], eligible: true, flags: [] },
		{ label: "C", rank: 2, score: 0.61, reasons: [], eligible: false, flags: ["test script changed"] },
	],
	verdict: "A is simplest.",
	findings: [],
	scores: {},
	agreement: "agreed",
	reviewerModel: "prov/rev",
	selfPreference: [],
	unsure: [],
	...over,
});

const facts = { files: 1, added: 1, removed: 0 };

const bakeoff = (over: Partial<Bakeoff> = {}): Bakeoff => ({
	v: 1,
	id: "bk-1",
	title: "Faster queue",
	repo: { root: "/work/repo", name: "repo" },
	createdAt: 1,
	mode: "implementation",
	metrics,
	entries: [
		entry("A", { kind: "original", model: undefined, facts }),
		entry("B", { instanceId: "i-b", facts }),
		entry("C", { instanceId: "i-c", facts }),
	],
	stage: "done",
	warnings: [],
	reviewer: "prov/rev",
	writer: "@default",
	judge: "auto",
	costs: { entries: 1, writeups: 0.5, review: 0.4, judge: 0.01 },
	...over,
});

describe("stage and status words", () => {
	it("says what each stage is doing, and a design has no measuring step", () => {
		expect(stageWord("preparing", "design")).toBe("Getting ready");
		expect(stageWord("entries", "implementation")).toBe("The entries are working");
		expect(stageWord("entries", "design")).toBe("The entries are writing their designs");
		expect(stageWord("facts", "implementation")).toBe("Measuring each entry");
		expect(stageWord("writeups", "design")).toBe("Writing up each entry");
		expect(stageWord("review", "design")).toBe("The reviewer is reading every entry");
		expect(stageWord("judge", "design")).toBe("Getting a second opinion");
		expect(stageIndex("review", "design")).toBe(3);
		expect(stageIndex("review", "implementation")).toBe(4);
		expect(stageIndex("facts", "design")).toBe(-1);
		expect(stageIndex("done", "design")).toBe(5);
	});

	it("names an entry status", () => {
		expect(entryStatusWord("writing-up")).toBe("Writing up");
		expect(entryStatusWord("failed")).toBe("Failed");
		expect(entryStatusWord("stopped")).toBe("Stopped");
	});

	it("only a working or waiting challenger can be stopped on its own", () => {
		expect(canStopEntry(entry("B", { status: "working" }))).toBe(true);
		expect(canStopEntry(entry("B", { status: "ready" }))).toBe(false);
		expect(canStopEntry(entry("A", { kind: "original", status: "working" }))).toBe(false);
	});
});

describe("entryName", () => {
	it("hides the model behind the label until the models are shown", () => {
		expect(entryName(entry("B"), false)).toBe("Entry B");
		expect(entryName(entry("B"), true)).toBe("Entry B (prov/model-b)");
		expect(entryName(entry("A", { kind: "original", model: undefined }), true)).toBe("Entry A (the original)");
		expect(entryName(entry("A", { kind: "original", model: undefined }), false)).toBe("Entry A");
	});
});

describe("runState and review again", () => {
	it("takes the companion's row, else what the document says", () => {
		expect(runState({ status: "failed" }, undefined)).toBe("failed");
		expect(runState(null, bakeoff({ result: result() }))).toBe("ready");
		expect(runState(undefined, bakeoff())).toBe("running");
	});

	it("is offered only when the run failed in the review or judge with two entries left", () => {
		const failed = bakeoff({ stage: "review" });
		expect(canReviewAgain("failed", failed)).toBe(true);
		expect(canReviewAgain("failed", bakeoff({ stage: "judge" }))).toBe(true);
		expect(canReviewAgain("ready", failed)).toBe(false);
		expect(canReviewAgain("running", failed)).toBe(false);
		expect(canReviewAgain("failed", bakeoff({ stage: "entries" }))).toBe(false);
		const one = bakeoff({
			stage: "review",
			entries: [
				entry("A", { status: "failed" }),
				entry("B", { writeup: writeup() }),
				entry("C", { status: "failed" }),
			],
		});
		expect(canReviewAgain("failed", one)).toBe(false);
		// an entry that is not failed but has neither a write-up nor facts cannot be read
		const empty = bakeoff({ stage: "review", entries: [entry("A", { writeup: writeup() }), entry("B")] });
		expect(canReviewAgain("failed", empty)).toBe(false);
	});

	it("says it costs again, and what the last try cost", () => {
		expect(reviewAgainNote(bakeoff())).toContain("costs again");
		expect(reviewAgainNote(bakeoff())).toContain("$0.410");
		expect(reviewAgainNote(bakeoff({ costs: { entries: 1, writeups: 0, review: 0, judge: 0 } }))).not.toContain(
			"last try",
		);
	});
});

describe("costLine", () => {
	it("shows spend against the limit when known", () => {
		expect(costLine(null, { costUsd: 1.2, maxCostUsd: 12 })).toBe("Spent $1.20 of $12.00");
		expect(costLine(bakeoff(), undefined)).toBe("Spent $1.91 so far");
		expect(costLine(null, undefined)).toBeNull();
		expect(costLine(bakeoff({ costs: { entries: 0, writeups: 0, review: 0, judge: 0 } }), undefined)).toBeNull();
		expect(costLine(null, { costUsd: 0, maxCostUsd: 5 })).toBe("Spent $0.00 of $5.00");
	});
});

describe("factItems", () => {
	it("lists size, delta, tests and benchmark in plain words", () => {
		const items = factItems({
			files: 3,
			added: 40,
			removed: 5,
			deltaFromOriginal: { files: 1, added: 2, removed: 0 },
			tests: { target: "test", ok: true },
			bench: { target: "bench", better: "lower", runs: [10, 12, 11], value: 11, unit: "ms" },
		});
		expect(items.map(item => item.text)).toEqual([
			"3 files, +40 \u22125",
			"Changes 1 file, +2 \u22120 from the original",
			"Tests passed",
			"Benchmark 11 ms (median of 3 runs)",
		]);
		expect(items[2]!.tone).toBe("ok");
	});

	it("marks failed and unverified tests, and a benchmark that did not run", () => {
		const items = factItems({
			files: 1,
			added: 1,
			removed: 0,
			deltaFromOriginal: { files: 0, added: 0, removed: 0 },
			tests: { target: "t", ok: null, reason: "the test script was changed in this entry" },
			bench: { target: "b", better: "higher", runs: [], value: null, reason: "timed out" },
		});
		expect(items.map(item => item.text)).toEqual([
			"1 file, +1 \u22120",
			"Tests not verified: the test script was changed in this entry",
			"Benchmark not measured: timed out",
		]);
		expect(items[1]!.tone).toBe("warn");
		expect(factItems({ files: 1, added: 1, removed: 1, tests: { target: "t", ok: false } })[1]).toEqual({
			key: "tests",
			text: "Tests failed",
			tone: "err",
		});
	});
});

describe("diagramMarkdown", () => {
	it("fences a bare diagram and keeps a fenced one as one block", () => {
		expect(diagramMarkdown("flowchart LR\n A-->B")).toBe("```mermaid\nflowchart LR\n A-->B\n```");
		expect(diagramMarkdown("```mermaid\nflowchart LR\n A-->B\n```")).toBe("```mermaid\nflowchart LR\n A-->B\n```");
	});
});

describe("ranking", () => {
	it("orders by rank then label, and marks ties, the top reason, ineligibility and the taken one", () => {
		const rows = rankRows(result({ taken: "B" }));
		expect(rows.map(row => row.label)).toEqual(["A", "B", "C"]);
		expect(rows.map(row => rankText(row))).toEqual(["1", "=2", "=2"]);
		expect(rows[0]).toMatchObject({ percent: 80, reason: "Simplest", taken: false, eligible: true });
		expect(rows[1]).toMatchObject({ taken: true, reason: "Fewer parts" });
		expect(rows[2]).toMatchObject({ eligible: false, reason: null, flags: ["test script changed"] });
	});

	it("derives each party's order from its scores, weighted, and prefers the reviewer's written order", () => {
		const scores = {
			A: { simplicity: { reviewer: 1, judge: 0.2 }, "lines-changed": { reviewer: 0, judge: 0.2 } },
			B: { simplicity: { reviewer: 0.5, judge: 0.9 }, "lines-changed": { reviewer: 1, judge: 0.9 } },
		};
		const base = result({ scores });
		// A: (3*1+0)/4 = .75, B: (3*.5+1)/4 = .625 for the reviewer; the judge prefers B.
		expect(reviewerRanking(base, metrics)).toEqual(["A", "B"]);
		expect(judgeRanking(base, metrics)).toEqual(["B", "A"]);
		const twice = result({
			scores,
			passes: [
				{ ranking: ["B", "A"], verdict: "x" },
				{ ranking: ["A", "B"], verdict: "y" },
			],
		});
		expect(reviewerRanking(twice, metrics)).toEqual(["B", "A"]);
		expect(judgeRanking(result(), metrics)).toBeNull();
		expect(reviewerRanking(result(), metrics)).toBeNull();
	});

	it("offers each reading beside the verdict only when the reviewer read twice", () => {
		expect(verdictViews(result()).map(view => view.label)).toEqual(["Verdict"]);
		const two = verdictViews(
			result({
				passes: [
					{ ranking: ["A"], verdict: "x" },
					{ ranking: ["B"], verdict: "y" },
				],
			}),
		);
		expect(two.map(view => view.label)).toEqual(["Verdict", "First reading", "Second reading"]);
		expect(two[2]).toMatchObject({ text: "y", ranking: ["B"] });
	});
});

describe("agreement and notes", () => {
	it("says whether the reviewer and the judge agree", () => {
		expect(agreementSummary({ agreement: "agreed" })).toMatchObject({ text: "Reviewer and judge agree", tone: "ok" });
		expect(agreementSummary({ agreement: "split", splitNote: "The judge liked C." })).toEqual({
			kind: "split",
			text: "Split verdict",
			tone: "warn",
			note: "The judge liked C.",
		});
		expect(agreementSummary({ agreement: "reviewer-only" }).text).toBe("Reviewer only");
	});

	it("states the judge note as given, a contradicting judge, consistency and self-preference", () => {
		const note = "No second opinion: prompted judge was unreachable (timeout)";
		expect(resultNotes({ judgeNote: note, judgeIgnored: false, consistency: undefined, selfPreference: [] })).toEqual(
			[{ key: "judge-note", tone: "info", text: note }],
		);
		expect(
			resultNotes({ judgeIgnored: true, consistency: 0.2, selfPreference: ["C"] }).map(item => item.text),
		).toEqual([
			"The second opinion contradicted itself, so it was not counted",
			"The reviewer's own model wrote entry C, so it may favour it",
		]);
		expect(resultNotes({ consistency: 0.875, selfPreference: ["A", "B", "C"] }).map(item => item.text)).toEqual([
			"The second opinion agreed with itself on 88% of its comparisons",
			"The reviewer's own model wrote entries A, B and C, so it may favour them",
		]);
	});
});

describe("scores and pairs", () => {
	it("formats the reviewer's score back to the 1 to 5 it gave", () => {
		expect(reviewerText(0.75)).toBe("4/5");
		expect(reviewerText(0.625)).toBe("3.5/5");
		expect(reviewerText(0)).toBe("1/5");
	});

	it("marks a measured score and leaves out what is missing", () => {
		expect(scoreCell({ reviewer: 0.75, judge: 0.62, combined: 0.7 })).toEqual({
			parts: [
				{ kind: "reviewer", text: "4/5" },
				{ kind: "judge", text: "62%" },
			],
			combined: "70%",
			measured: false,
		});
		expect(scoreCell({ measured: 1, combined: 1 })).toEqual({
			parts: [{ kind: "measured", text: "100%" }],
			combined: "100%",
			measured: true,
		});
		expect(scoreCell(undefined)).toEqual({ parts: [], combined: null, measured: false });
	});

	it("lists the metrics in the person's order, then any extra the scores carry", () => {
		expect(scoreMetrics({ scores: { A: { extra: {}, simplicity: {} } } }, metrics)).toEqual([
			{ id: "simplicity", label: "Simplicity" },
			{ id: "lines-changed", label: "Lines changed" },
			{ id: "extra", label: "extra" },
		]);
	});

	it("counts a pair whose two orders disagreed as a tie", () => {
		const rows = pairRows(
			[
				{ a: "A", b: "B", metric: "simplicity", winner: "A", consistent: true },
				{ a: "A", b: "C", metric: "simplicity", winner: "tie", consistent: true },
				{ a: "B", b: "C", metric: "lines-changed", winner: "B", consistent: false },
			],
			metrics,
		);
		expect(rows.map(row => [row.pair, row.metric, row.outcome])).toEqual([
			["A vs B", "Simplicity", "Entry A"],
			["A vs C", "Simplicity", "Tie"],
			["B vs C", "Lines changed", "Tie (the two orders disagreed)"],
		]);
	});
});

describe("parseVerdictCitations", () => {
	it("splits a verdict into text and citations", () => {
		const segments = parseVerdictCitations("A queues in `A/src/q.ts@41@enqueue`, B does not (`B/lib/x.ts@3@run`).");
		expect(segments).toEqual([
			{ kind: "text", text: "A queues in " },
			{ kind: "citation", raw: "`A/src/q.ts@41@enqueue`", label: "A", path: "src/q.ts", line: 41, token: "enqueue" },
			{ kind: "text", text: ", B does not (" },
			{ kind: "citation", raw: "`B/lib/x.ts@3@run`", label: "B", path: "lib/x.ts", line: 3, token: "run" },
			{ kind: "text", text: ")." },
		]);
	});

	it("reads a citation outside backticks without its trailing punctuation", () => {
		const segments = parseVerdictCitations("See C/src/a.ts@7@go.");
		expect(segments).toEqual([
			{ kind: "text", text: "See " },
			{ kind: "citation", raw: "C/src/a.ts@7@go", label: "C", path: "src/a.ts", line: 7, token: "go" },
			{ kind: "text", text: "." },
		]);
	});

	it("keeps a token with spaces inside backticks, and leaves unchecked citations and plain text alone", () => {
		expect(parseVerdictCitations("`A/src/q.ts@4@if (x)`")[0]).toMatchObject({ kind: "citation", token: "if (x)" });
		const plain = "`A/src/q.ts` (not checked against the code) and nothing else";
		expect(parseVerdictCitations(plain)).toEqual([{ kind: "text", text: plain }]);
		expect(parseVerdictCitations("")).toEqual([]);
	});

	it("lists each distinct citation once", () => {
		expect(
			verdictCitations("`A/a.ts@1@x` then `A/a.ts@1@x` and `B/a.ts@1@x`").map(c => `${c.label}/${c.path}`),
		).toEqual(["A/a.ts", "B/a.ts"]);
	});
});

describe("taking an entry", () => {
	it("needs a result, nothing taken yet, and for a challenger its session", () => {
		const done = bakeoff({ result: result() });
		expect(canTake(done, done.entries[1]!)).toBe(true);
		expect(canTake(done, done.entries[0]!)).toBe(true);
		expect(canTake(bakeoff(), bakeoff().entries[1]!)).toBe(false);
		expect(canTake(bakeoff({ result: result({ taken: "B" }) }), done.entries[1]!)).toBe(false);
		const noSession = bakeoff({
			result: result(),
			entries: [
				entry("A", { kind: "original", model: undefined, facts: { files: 1, added: 1, removed: 0 } }),
				entry("B", { facts: { files: 1, added: 1, removed: 0 } }),
			],
		});
		expect(canTake(noSession, noSession.entries[1]!)).toBe(false);
		expect(canTake(noSession, noSession.entries[0]!)).toBe(true);
	});

	it("plans what the confirmation says: worktrees to remove and why one more tap is needed", () => {
		const done = bakeoff({ result: result() });
		expect(takePlan(done, done.entries[1]!)).toEqual({ keepsWorktree: true, others: ["C"], ineligible: null });
		expect(takePlan(done, done.entries[2]!)).toEqual({
			keepsWorktree: true,
			others: ["B"],
			ineligible: INELIGIBLE_NOTE,
		});
		expect(takePlan(done, done.entries[0]!)).toEqual({ keepsWorktree: false, others: [], ineligible: null });
		const design = bakeoff({ mode: "design", result: result() });
		expect(takePlan(design, design.entries[1]!)).toMatchObject({ keepsWorktree: false, others: [] });
	});

	it("says what the keep did to the others, naming models only when shown", () => {
		const kept = { removed: ["prov/c"], skipped: [{ model: "prov/d", reason: "it has uncommitted changes" }] };
		expect(takeLines(kept, false)).toEqual([
			"Removed 1 other worktree.",
			"1 worktree stayed in place:",
			"it has uncommitted changes",
		]);
		expect(takeLines(kept, true)[2]).toBe("prov/d: it has uncommitted changes");
		expect(takeLines(undefined, true)).toEqual([]);
	});
});

describe("designMarkdown", () => {
	it("writes the write-up with headings, the diagram as a mermaid block and metric lines by label", () => {
		const text = designMarkdown(
			{ title: "Faster queue", metrics },
			entry("B", { writeup: writeup({ diagram: "flowchart LR\n A-->B" }) }),
		);
		expect(text).toBe(
			[
				"# Faster queue",
				"",
				"## Summary",
				"",
				"Queue the work.",
				"",
				"## Approach",
				"",
				"Use a queue.",
				"",
				"Drain it in order.",
				"",
				"## Diagram",
				"",
				"```mermaid",
				"flowchart LR",
				" A-->B",
				"```",
				"",
				"## Trade-offs",
				"",
				"- Needs a worker",
				"",
				"## Risks",
				"",
				"- Backlog grows",
				"",
				"## Migration",
				"",
				"None.",
				"",
				"## What matters",
				"",
				"- **Simplicity**: One file.",
				"",
				"## Code",
				"",
				"- `src/q.ts:41` (enqueue)",
				"",
			].join("\n"),
		);
	});

	it("says so when the entry has no write-up", () => {
		expect(designMarkdown({ title: "T", metrics }, entry("B"))).toBe("# T\n\nThis entry has no write-up.\n");
	});

	it("never names a model or a label", () => {
		const text = designMarkdown({ title: "T", metrics }, entry("B", { writeup: writeup() }));
		expect(text).not.toContain("model-b");
		expect(text).not.toContain("Entry B");
	});
});
