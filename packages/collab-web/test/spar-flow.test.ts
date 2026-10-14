import { describe, expect, it } from "bun:test";
import {
	scoreSpar,
	type Spar,
	type SparPoint,
	type SparRecord,
	type SparRun,
	type SparSummary,
} from "@oh-my-pi/pi-wire/spar";
import {
	buildSparCreate,
	canSendDefence,
	firstOpen,
	groupByRepo,
	heldBand,
	landingOf,
	latestRun,
	nextPoint,
	objectionOf,
	outcomeLook,
	outcomeText,
	recordOf,
	refLabel,
	roundsLeft,
	roundsUsed,
	rowStatus,
	runPoints,
	type SparFormValues,
	sparMarkdown,
	subjectOf,
	summaryOf,
} from "../src/components/spar/spar-flow";

const values = (over: Partial<SparFormValues> = {}): SparFormValues => ({
	cwd: "/work/repo",
	subject: { kind: "changes" },
	sessionId: "s-1",
	useConversation: true,
	stack: [],
	scope: "stack",
	doc: null,
	limit: "6",
	model: "",
	replyModel: "",
	...over,
});

describe("buildSparCreate", () => {
	it("asks for the session's changes against the default branch, with the conversation when wanted", () => {
		expect(buildSparCreate(values())).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, ref: "@worktree", base: "@default", sessionId: "s-1" },
		});
		expect(buildSparCreate(values({ useConversation: false }))).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, ref: "@worktree", base: "@default" },
		});
	});

	it("names a branch, a pull request or a stack, and the models when typed", () => {
		expect(
			buildSparCreate(values({ subject: { kind: "branch", name: "feature/x" }, model: " m ", replyModel: "@smol" })),
		).toEqual({
			request: {
				cwd: "/work/repo",
				maxCostUsd: 6,
				ref: "feature/x",
				base: "@default",
				model: "m",
				replyModel: "@smol",
			},
		});
		expect(buildSparCreate(values({ subject: { kind: "branch", name: " " } }))).toEqual({ error: "Pick a branch." });
		const pr = { kind: "pr", number: 7, title: "Seven" } as const;
		expect(buildSparCreate(values({ subject: pr }))).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, pr: 7 },
		});
		const stack = [
			{ number: 6, title: "Six", head: "a", base: "main" },
			{ number: 7, title: "Seven", head: "b", base: "a" },
		];
		expect(buildSparCreate(values({ subject: pr, stack }))).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, stack: [6, 7] },
		});
		expect(buildSparCreate(values({ subject: pr, stack, scope: "single" }))).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, pr: 7 },
		});
	});

	it("takes a design alone, pasted or from a file, or attached to a change", () => {
		const doc = { kind: "doc" } as const;
		expect(buildSparCreate(values({ subject: doc }))).toEqual({ error: "Add the design: paste it or name a file." });
		expect(
			buildSparCreate(values({ subject: doc, doc: { source: "paste", name: " Plan ", text: " # Plan\n" } })),
		).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, doc: { text: "# Plan", name: "Plan" }, sessionId: "s-1" },
		});
		expect(
			buildSparCreate(values({ subject: doc, sessionId: null, doc: { source: "file", path: " docs/x.md " } })),
		).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 6, doc: { path: "docs/x.md" } },
		});
		expect(buildSparCreate(values({ doc: { source: "paste", name: "", text: "text" } }))).toEqual({
			request: {
				cwd: "/work/repo",
				maxCostUsd: 6,
				ref: "@worktree",
				base: "@default",
				sessionId: "s-1",
				doc: { text: "text" },
			},
		});
		expect(buildSparCreate(values({ doc: { source: "paste", name: "", text: "  " } }))).toEqual({
			error: "The design is empty.",
		});
		expect(buildSparCreate(values({ doc: { source: "file", path: " " } }))).toEqual({
			error: "Name the file of the design.",
		});
		expect(buildSparCreate(values({ doc: { source: "paste", name: "", text: "x".repeat(60_001) } }))).toEqual({
			error: "The design is longer than 60,000 characters.",
		});
	});

	it("refuses a missing repository or a limit that is not money", () => {
		expect(buildSparCreate(values({ cwd: "" }))).toEqual({ error: "There is no repository to spar about." });
		expect(buildSparCreate(values({ limit: "0" }))).toEqual({ error: "The cost limit must be more than $0." });
		expect(buildSparCreate(values({ limit: "abc" }))).toEqual({ error: "The cost limit must be more than $0." });
	});
});

function point(id: string, part = 0, over: Partial<SparPoint> = {}): SparPoint {
	return {
		id,
		part,
		kind: "failure",
		title: `Point ${id}`,
		challenge: "Lead-in.\n\nThe real **objection** is here.",
		severity: 2,
		refs: [{ path: "src/a.ts", line: 4, token: "a" }],
		...over,
	};
}

function spar(points: SparPoint[], over: Partial<Spar> = {}): Spar {
	return {
		v: 1,
		id: "sp-1",
		title: "demo @ feature vs main",
		repo: { root: "/work/repo", name: "repo" },
		createdAt: 1,
		parts: [{ index: 0, title: "What changed", head: { commit: "c" }, base: { commit: "b" } }],
		points,
		warnings: [],
		...over,
	};
}

function run(id: string, points: string[], records: Record<string, SparRecord>, over: Partial<SparRun> = {}): SparRun {
	return { id, startedAt: 10, points, records, result: scoreSpar({ points, records }), ...over };
}

const DEFENDED: SparRecord = {
	turns: [
		{ by: "you", text: "Because.", at: 1 },
		{ by: "partner", text: "Why?", move: "push", at: 2 },
		{ by: "you", text: "Because of the compiler.", at: 3 },
		{ by: "partner", text: "Fair.", move: "concede", at: 4 },
	],
	outcome: { kind: "held", by: "partner" },
	reveal: { strongestDefence: "The compiler." },
};

describe("points and rounds", () => {
	const points = [point("p1"), point("p2"), point("p3")];
	const records: Record<string, SparRecord> = {
		p1: DEFENDED,
		p2: {
			turns: [
				{ by: "you", text: "x", at: 1 },
				{ by: "partner", text: "y", move: "push", at: 2 },
			],
		},
	};
	const current = run("r1", ["p1", "p2", "p3"], records);

	it("counts the rounds a point has used and has left", () => {
		expect(roundsUsed(DEFENDED)).toBe(2);
		expect(roundsLeft(DEFENDED)).toBe(0);
		expect(roundsUsed(recordOf(current, "p2"))).toBe(1);
		expect(roundsLeft(recordOf(current, "p2"))).toBe(2);
		expect(roundsLeft(recordOf(current, "p3"))).toBe(3);
		expect(recordOf(current, "p3")).toEqual({ turns: [] });
		expect(recordOf(current, "constructor")).toEqual({ turns: [] });
	});

	it("goes to the next open point, then back to the first one left", () => {
		expect(firstOpen(points, current)).toBe(1);
		expect(nextPoint(points, current, "p1")!.id).toBe("p2");
		expect(nextPoint(points, current, "p2")!.id).toBe("p3");
		expect(nextPoint(points, current, "p3")!.id).toBe("p2");
		const done = run("r1", ["p1"], { p1: DEFENDED });
		expect(firstOpen(runPoints(spar(points), done), done)).toBe(-1);
		expect(nextPoint(runPoints(spar(points), done), done, "p1")).toBeNull();
	});

	it("lands on the first open point of the latest run, or the summary", () => {
		const s = spar(points);
		expect(landingOf(s, [])).toBeNull();
		expect(landingOf(s, [current])).toEqual({ kind: "point", run: "r1", point: "p2" });
		const finished = run("r2", ["p1"], { p1: DEFENDED }, { startedAt: 20, finishedAt: 30 });
		expect(landingOf(s, [current, finished])).toEqual({ kind: "summary", run: "r2" });
		expect(latestRun([finished, current])!.id).toBe("r2");
		expect(runPoints(s, run("r3", ["p3", "nope", "p1"], {})).map(item => item.id)).toEqual(["p3", "p1"]);
	});

	it("allows a defence with text within the limit", () => {
		expect(canSendDefence("  ", 10)).toBe(false);
		expect(canSendDefence("abc", 10)).toBe(true);
		expect(canSendDefence("a".repeat(11), 10)).toBe(false);
	});
});

describe("how things are said", () => {
	it("words outcomes, and cites the design as design", () => {
		expect(outcomeLook("lost")).toEqual({ label: "Conceded", tone: "lost" });
		expect(outcomeText({ kind: "open", by: "limit" })).toContain("rounds ran out");
		expect(outcomeText({ kind: "open", by: "you" })).toContain("accepted the risk");
		expect(refLabel({ path: "@design", line: 3, token: "x" })).toBe("design:3");
		expect(refLabel({ path: "src/a.ts", line: 3, token: "x" })).toBe("src/a.ts:3");
		expect(heldBand(95)).toBe("Your decisions held up");
		expect(heldBand(10)).toBe("Worth another look at these decisions");
		expect(objectionOf(point("p1"))).toBe("The real objection is here.");
	});
});

describe("the summary", () => {
	const points = [point("p1"), point("p2", 0, { kind: "cost", severity: 3 }), point("p3"), point("p4"), point("p5")];
	const records: Record<string, SparRecord> = {
		p1: DEFENDED,
		p2: {
			turns: [],
			outcome: { kind: "lost", by: "you" },
			reveal: {
				strongestDefence: "d",
				suggestion: "Add a limit.",
				refs: [{ path: "src/b.ts", line: 2, token: "b" }],
			},
		},
		p3: {
			turns: [],
			outcome: { kind: "partly", by: "partner" },
			reveal: { strongestDefence: "d", suggestion: "Narrow it." },
		},
		p4: { turns: [], outcome: { kind: "open", by: "you", note: "Tracked in the backlog." } },
	};
	const finished = run("r1", ["p1", "p2", "p3", "p4", "p5"], records);
	const s = spar(points);

	it("lists what held, what stays open and what the partner suggests", () => {
		const model = summaryOf(s, finished);
		expect(model.held.map(item => item.point.id)).toEqual(["p1"]);
		expect(model.open.map(item => item.point.id)).toEqual(["p3", "p4"]);
		expect(model.suggested.map(item => item.point.id)).toEqual(["p2", "p3"]);
		expect(model.unfinished.map(item => item.point.id)).toEqual(["p5"]);
		expect(model).toMatchObject({ asked: 5, percentHeld: 30, unsettled: 4 });
	});

	it("writes Markdown with a heading per list, the objection, how it ended and references", () => {
		const text = sparMarkdown(s, finished);
		expect(text).toContain("# Sparring: demo @ feature vs main");
		expect(text).toContain("Held 1 of 5 points (30%). 1 not yet answered.");
		expect(text).toContain("## Held\n\n- **Point p1**: the partner conceded. (`src/a.ts:4`)");
		expect(text).toContain("## Open risks");
		expect(text).toContain(
			"**Point p4** (Failure, worth fixing): The real objection is here. You accepted the risk or skipped it. Your note: Tracked in the backlog.",
		);
		expect(text).toContain("**Point p2**: Add a limit. (`src/b.ts:2`)");
		expect(text.endsWith("\n")).toBe(true);
		expect(sparMarkdown(s, run("r2", ["p5"], {}))).toContain("Nothing was held.");
	});
});

describe("the list", () => {
	const summary = (over: Partial<SparSummary>): SparSummary => ({
		id: "sp-1",
		title: "t",
		repoRoot: "/w/a",
		subject: "s",
		createdAt: 1,
		status: "ready",
		...over,
	});

	it("says how each spar stands", () => {
		expect(rowStatus(summary({ status: "running" }))).toEqual({ kind: "generating", text: "Preparing…" });
		expect(rowStatus(summary({ status: "failed" }))).toEqual({ kind: "failed", text: "Failed" });
		expect(rowStatus(summary({}))).toEqual({ kind: "new", text: "Not started" });
		expect(rowStatus(summary({ latest: { held: 1, asked: 4, percentHeld: 25, finished: false, at: 1 } }))).toEqual({
			kind: "progress",
			text: "In progress",
		});
		expect(rowStatus(summary({ latest: { held: 3, asked: 4, percentHeld: 88, finished: true, at: 1 } }))).toEqual({
			kind: "score",
			text: "3/4 held · 88%",
			percent: 88,
		});
	});

	it("groups by repository, newest group first", () => {
		const groups = groupByRepo([
			summary({ id: "a", repoRoot: "/w/a", createdAt: 1 }),
			summary({ id: "b", repoRoot: "/w/b/", createdAt: 5 }),
			summary({ id: "c", repoRoot: "/w/a", createdAt: 3 }),
		]);
		expect(groups.map(group => [group.name, group.spars.map(item => item.id)])).toEqual([
			["b", ["b"]],
			["a", ["c", "a"]],
		]);
	});

	it("offers the subject of a spar for another like it", () => {
		expect(subjectOf(spar([]))).toEqual({ kind: "changes" });
		const withPr = spar([], {
			parts: [
				{
					index: 0,
					title: "Add x",
					head: { commit: "c" },
					base: { commit: "b" },
					pr: { number: 9, head: "h", base: "m" },
				},
			],
		});
		expect(subjectOf(withPr)).toEqual({ kind: "pr", number: 9, title: "Add x" });
		const design = spar([], { parts: [{ index: 0, title: "Design", head: { commit: "c" } }] });
		expect(subjectOf(design)).toEqual({ kind: "doc" });
	});
});

describe("scoreSpar", () => {
	it("counts a held point as one, a partly held one as half, and leaves unanswered points as asked", () => {
		const records: Record<string, SparRecord> = {
			a: { turns: [], outcome: { kind: "held", by: "partner" } },
			b: { turns: [], outcome: { kind: "partly", by: "partner" } },
			c: { turns: [], outcome: { kind: "lost", by: "you" } },
			d: { turns: [], outcome: { kind: "open", by: "limit" } },
		};
		expect(scoreSpar({ points: ["a", "b", "c", "d", "e"], records })).toEqual({
			held: ["a"],
			open: ["b", "d"],
			suggested: ["b", "c"],
			percentHeld: 30,
		});
		expect(scoreSpar({ points: [], records: {} })).toEqual({ held: [], open: [], suggested: [], percentHeld: 0 });
	});
});
