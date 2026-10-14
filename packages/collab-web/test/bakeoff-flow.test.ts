import { describe, expect, it } from "bun:test";
import type { BakeoffSummary } from "@oh-my-pi/pi-wire/bakeoff";
import {
	addCustom,
	type BakeoffFormValues,
	buildBakeoffCreate,
	buildMetrics,
	costText,
	entryCountText,
	estimateBakeoffCost,
	estimateText,
	groupByRepo,
	judgeChoice,
	judgeOnByDefault,
	judgeView,
	limitPreview,
	type MetricPick,
	modeWord,
	pickForMode,
	presetsFor,
	rankText,
	removeCustom,
	rowStatus,
	statesGoal,
	toggleStar,
	togglePreset,
	validateBakeoff,
	withoutForeign,
} from "../src/components/bakeoff/bakeoff-flow";

const pick = (over: Partial<MetricPick> = {}): MetricPick => ({
	presets: ["simplicity"],
	customs: [],
	starred: null,
	...over,
});

const values = (over: Partial<BakeoffFormValues> = {}): BakeoffFormValues => ({
	cwd: "/work/repo",
	subject: { kind: "changes" },
	sessionId: "s-1",
	useConversation: true,
	doc: null,
	mode: "design",
	start: "original",
	goal: "",
	metrics: pick(),
	instructions: "",
	models: ["anthropic/a", "openai/b"],
	reviewer: "anthropic/r",
	judge: judgeView({ state: "native", label: "typesafe/jev", reachable: true }),
	judgeUse: null,
	judgeAdvisory: false,
	test: null,
	bench: null,
	limit: "12",
	...over,
});

const request = (over: Partial<BakeoffFormValues> = {}) => {
	const made = buildBakeoffCreate(values(over));
	if ("error" in made) throw new Error(made.error);
	return made.request;
};
const error = (over: Partial<BakeoffFormValues> = {}) => {
	const made = buildBakeoffCreate(values(over));
	return "error" in made ? made.error : null;
};

describe("metrics", () => {
	it("weighs presets 1, what was written 2 and the star 3", () => {
		const metrics = buildMetrics(
			pick({ presets: ["migration-risk", "simplicity"], customs: ["Easy to test"], starred: "simplicity" }),
		);
		expect(metrics.map(({ id, weight }) => [id, weight])).toEqual([
			["simplicity", 3],
			["migration-risk", 1],
			["custom:1", 2],
		]);
		expect(metrics[0]!.label).toBe("Simplicity");
		expect(metrics[2]).toMatchObject({ label: "Easy to test", text: "Easy to test" });
	});

	it("stars a written one", () => {
		const metrics = buildMetrics(pick({ presets: [], customs: ["a", "b"], starred: "custom:2" }));
		expect(metrics.map(metric => metric.weight)).toEqual([2, 3]);
	});

	it("shortens the label of a long custom metric but keeps its text whole", () => {
		const text = "x".repeat(100);
		const [metric] = buildMetrics(pick({ presets: [], customs: [text] }));
		expect(metric!.label.length).toBeLessThanOrEqual(40);
		expect(metric!.text).toBe(text);
	});

	it("hides what a design cannot use and drops it with its star", () => {
		expect(presetsFor("design").some(preset => preset.id === "lines-changed")).toBe(false);
		expect(presetsFor("implementation").some(preset => preset.id === "lines-changed")).toBe(true);
		const next = pickForMode(pick({ presets: ["simplicity", "lines-changed"], starred: "lines-changed" }), "design");
		expect(next.presets).toEqual(["simplicity"]);
		expect(next.starred).toBeNull();
	});

	it("toggles presets and moves the star", () => {
		const on = togglePreset(pick({ presets: [] }), "performance");
		expect(on.presets).toEqual(["performance"]);
		const starred = toggleStar(on, "performance");
		expect(starred.starred).toBe("performance");
		expect(togglePreset(starred, "performance")).toMatchObject({ presets: [], starred: null });
		expect(toggleStar(starred, "performance").starred).toBeNull();
	});

	it("adds trimmed text and renumbers when one goes", () => {
		expect(addCustom(pick(), "   ").customs).toEqual([]);
		const three = addCustom(addCustom(addCustom(pick(), " a "), "b"), "c");
		expect(three.customs).toEqual(["a", "b", "c"]);
		expect(removeCustom({ ...three, starred: "custom:3" }, 0)).toMatchObject({
			customs: ["b", "c"],
			starred: "custom:2",
		});
		expect(removeCustom({ ...three, starred: "custom:1" }, 0).starred).toBeNull();
		expect(removeCustom({ ...three, starred: "custom:1" }, 2).starred).toBe("custom:1");
	});
});

describe("the second opinion", () => {
	it("is on by default only for a judge that answered", () => {
		expect(judgeOnByDefault(judgeView({ state: "native", label: "typesafe/jev", reachable: true }))).toBe(true);
		expect(judgeOnByDefault(judgeView({ state: "endpoint", label: "laya/x" }))).toBe(true);
		expect(judgeOnByDefault(judgeView(null))).toBe(false);
	});

	it("says why an unreachable judge is off", () => {
		const view = judgeView({ state: "local", label: "local/m", reachable: false, reason: "connection refused" });
		expect(view).toEqual({
			kind: "unreachable",
			message: "The judge model local/m did not answer: connection refused",
		});
		expect(judgeChoice(view, true, true)).toEqual({ judge: "off" });
	});

	it("offers a fallback only as advice", () => {
		const view = judgeView({ state: "fallback", label: "anthropic/x", reachable: true, price: "$3 / $15" });
		expect(view).toEqual({ kind: "fallback", label: "anthropic/x", price: "$3 / $15" });
		expect(judgeChoice(view, true, false)).toEqual({ judge: "off" });
		expect(judgeChoice(view, false, true)).toEqual({ judge: "auto", judgeAdvisory: true });
	});

	it("greys out when there is none", () => {
		const view = judgeView({ state: "none" });
		expect(view).toEqual({ kind: "none", message: "No judge model is set. The reviewer will decide alone." });
		expect(judgeChoice(view, true, true)).toEqual({ judge: "off" });
	});

	it("goes with the toggle for a usable judge", () => {
		const view = judgeView({ state: "native", label: "typesafe/jev", reachable: true });
		expect(judgeChoice(view, true, false)).toEqual({ judge: "auto" });
		expect(judgeChoice(view, false, false)).toEqual({ judge: "off" });
	});
});

describe("buildBakeoffCreate", () => {
	it("names the session's changes with the conversation", () => {
		expect(request()).toMatchObject({
			cwd: "/work/repo",
			mode: "design",
			ref: "@worktree",
			base: "@default",
			sessionId: "s-1",
			models: ["anthropic/a", "openai/b"],
			reviewer: "anthropic/r",
			judge: "auto",
			maxCostUsd: 12,
		});
		expect(request({ useConversation: false }).sessionId).toBeUndefined();
		expect(request({ sessionId: null }).sessionId).toBeUndefined();
	});

	it("names a branch and a pull request, never both with a session", () => {
		const branch = request({ subject: { kind: "branch", name: " feature/x " } });
		expect(branch).toMatchObject({ ref: "feature/x", base: "@default" });
		expect(branch.sessionId).toBeUndefined();
		const pr = request({ subject: { kind: "pr", number: 12, title: "T" } });
		expect(pr.pr).toBe(12);
		expect(pr.ref).toBeUndefined();
		expect(pr.sessionId).toBeUndefined();
	});

	it("takes a design alone, pasted or from a file, and attached to a change", () => {
		const pasted = request({
			subject: { kind: "doc" },
			doc: { source: "paste", name: " Plan ", text: " the plan " },
		});
		expect(pasted.doc).toEqual({ text: "the plan", name: "Plan" });
		expect(pasted.ref).toBeUndefined();
		expect(request({ subject: { kind: "doc" }, doc: { source: "paste", name: "", text: "x" } }).doc).toEqual({
			text: "x",
		});
		expect(request({ subject: { kind: "doc" }, doc: { source: "file", path: " docs/d.md " } }).doc).toEqual({
			path: "docs/d.md",
		});
		const attached = request({ doc: { source: "file", path: "docs/d.md" } });
		expect(attached).toMatchObject({ ref: "@worktree", doc: { path: "docs/d.md" } });
	});

	it("leaves implementation fields out of a design", () => {
		const made = request({
			start: "base",
			goal: "solve it",
			test: { target: "package:test" },
			bench: { target: "package:bench", better: "lower", valueRegex: "" },
		});
		expect(made.start).toBeUndefined();
		expect(made.goal).toBeUndefined();
		expect(made.test).toBeUndefined();
		expect(made.bench).toBeUndefined();
	});

	it("builds an implementation with its start, goal, test and benchmark", () => {
		const made = request({
			mode: "implementation",
			start: "base",
			goal: " make it fast ",
			test: { target: "package:test", detail: "bun test" },
			bench: { target: "package:bench", better: "higher", valueRegex: " (\\d+) ops " },
			metrics: pick({ presets: ["performance", "lines-changed"], starred: "performance" }),
		});
		expect(made).toMatchObject({
			mode: "implementation",
			start: "base",
			goal: "make it fast",
			test: { target: "package:test", detail: "bun test" },
			bench: { target: "package:bench", better: "higher", valueRegex: "(\\d+) ops" },
		});
		expect(made.metrics.map(metric => metric.id)).toEqual(["performance", "lines-changed"]);
	});

	it("keeps the goal only when starting from the base, and a test without a body bare", () => {
		const made = request({
			mode: "implementation",
			goal: "ignored",
			test: { target: "make:test" },
			bench: { target: "make:bench", better: "lower", valueRegex: "" },
		});
		expect(made.start).toBe("original");
		expect(made.goal).toBeUndefined();
		expect(made.test).toEqual({ target: "make:test" });
		expect(made.bench).toEqual({ target: "make:bench", better: "lower" });
	});

	it("sets the judge from the choice", () => {
		expect(request({ judgeUse: false }).judge).toBe("off");
		const fallback = judgeView({ state: "fallback", label: "m/x", price: "$1" });
		expect(request({ judge: fallback }).judge).toBe("off");
		expect(request({ judge: fallback, judgeAdvisory: true })).toMatchObject({ judge: "auto", judgeAdvisory: true });
		expect(request({ judge: judgeView({ state: "none" }) }).judge).toBe("off");
	});

	it("trims the extra instructions and leaves them out when empty", () => {
		expect(request({ instructions: "  keep it small \n" }).instructions).toBe("keep it small");
		expect(request({ instructions: "   " }).instructions).toBeUndefined();
	});
});

describe("validateBakeoff", () => {
	it("passes a good form", () => {
		expect(validateBakeoff(values())).toEqual([]);
	});

	it("asks for what is missing in plain words", () => {
		expect(error({ cwd: "" })).toBe("There is no repository to compare in.");
		expect(error({ subject: { kind: "branch", name: " " } })).toBe("Pick a branch.");
		expect(error({ subject: { kind: "doc" } })).toBe("Add the design: paste it or name a file.");
		expect(error({ doc: { source: "paste", name: "", text: "  " } })).toBe("The design is empty.");
		expect(error({ doc: { source: "file", path: " " } })).toBe("Name the file of the design.");
		expect(error({ doc: { source: "file", path: "../secret" } })).toContain("inside the repository");
		expect(error({ doc: { source: "file", path: "/etc/passwd" } })).toContain("inside the repository");
		expect(error({ metrics: pick({ presets: [] }) })).toBe("Pick at least one thing that matters.");
		expect(error({ reviewer: "" })).toBe("Pick the reviewer.");
		expect(error({ models: ["a/b"] })).toBe("Pick 2 to 4 challengers.");
		expect(error({ models: ["a/1", "a/2", "a/3", "a/4", "a/5"] })).toBe("Pick 2 to 4 challengers.");
	});

	it("limits what the engine limits", () => {
		expect(error({ metrics: pick({ presets: ["simplicity"], customs: ["1", "2", "3", "4", "5", "6"] }) })).toBe(
			"Pick at most 6 things that matter.",
		);
		expect(error({ metrics: pick({ customs: ["x".repeat(601)] }) })).toContain("600 characters");
		expect(error({ instructions: "x".repeat(4_001) })).toContain("4,000 characters");
		expect(error({ doc: { source: "paste", name: "", text: "x".repeat(60_001) } })).toContain("60,000 characters");
		expect(error({ limit: "" })).toBe("The spending limit must be more than $0.");
		expect(error({ limit: "0" })).toBe("The spending limit must be more than $0.");
		expect(error({ limit: "101" })).toBe("The spending limit is at most $100.");
		expect(error({ limit: "100" })).toBeNull();
	});

	it("keeps vendors' agents out of designs and reviews", () => {
		const foreign = "agent:claude/sonnet";
		expect(error({ models: ["a/b", foreign] })).toContain("omp's own models");
		expect(error({ mode: "implementation", models: ["a/b", foreign] })).toBeNull();
		expect(error({ reviewer: foreign })).toContain("reviewer must be one of omp's own models");
		expect(withoutForeign(["a/b", foreign])).toEqual(["a/b"]);
	});

	it("needs a change for an implementation", () => {
		expect(
			validateBakeoff(
				values({ mode: "implementation", subject: { kind: "doc" }, doc: { source: "paste", name: "", text: "x" } }),
			),
		).toEqual([
			"An implementation needs a change to start from: pick this session's changes, a branch or a pull request.",
		]);
	});

	it("needs a goal to start from the base when nothing else states it", () => {
		const base = { mode: "implementation", start: "base" } as const;
		expect(error({ ...base, subject: { kind: "branch", name: "f" } })).toBe(
			"Starting fresh needs the goal: say what it should solve.",
		);
		expect(error({ ...base, subject: { kind: "branch", name: "f" }, goal: "do it" })).toBeNull();
		expect(error({ ...base, subject: { kind: "pr", number: 3, title: "" } })).toBeNull();
		expect(error({ ...base, useConversation: false })).toBe(
			"Starting fresh needs the goal: say what it should solve.",
		);
		expect(error({ ...base })).toBeNull();
		expect(error({ ...base, goal: "x".repeat(2_001) })).toContain("2,000 characters");
		// The original's code needs no goal.
		expect(error({ mode: "implementation", subject: { kind: "branch", name: "f" } })).toBeNull();
	});

	it("says whether the subject already states the goal", () => {
		expect(
			statesGoal({ subject: { kind: "branch", name: "f" }, doc: null, sessionId: "s", useConversation: true }),
		).toBe(false);
		expect(
			statesGoal({
				subject: { kind: "pr", number: 1, title: "" },
				doc: null,
				sessionId: null,
				useConversation: false,
			}),
		).toBe(true);
		expect(
			statesGoal({
				subject: { kind: "branch", name: "f" },
				doc: { source: "file", path: "d.md" },
				sessionId: null,
				useConversation: false,
			}),
		).toBe(true);
	});

	it("checks the benchmark's pattern", () => {
		const bench = { target: "package:b", better: "lower", valueRegex: "(" } as const;
		expect(error({ mode: "implementation", bench })).toBe(
			"The benchmark's pattern is not a valid regular expression.",
		);
		expect(error({ mode: "implementation", bench: { ...bench, valueRegex: "x".repeat(201) } })).toContain(
			"200 characters",
		);
		expect(error({ mode: "implementation", bench: { ...bench, valueRegex: "" } })).toBeNull();
	});
});

describe("cost", () => {
	it("estimates from prices and says nothing without them", () => {
		const price = { input: 3, output: 15 };
		const estimate = estimateBakeoffCost({ mode: "design", challengers: [price, price], reviewer: price });
		expect(estimate).toBeGreaterThan(0);
		const dearer = estimateBakeoffCost({ mode: "implementation", challengers: [price, price], reviewer: price });
		expect(dearer!).toBeGreaterThan(estimate!);
		expect(estimateBakeoffCost({ mode: "design", challengers: [price, undefined], reviewer: price })).toBeNull();
		expect(estimateBakeoffCost({ mode: "design", challengers: [price, price], reviewer: undefined })).toBeNull();
		expect(estimateBakeoffCost({ mode: "design", challengers: [], reviewer: price })).toBeNull();
	});

	it("says it in one sentence", () => {
		expect(estimateText(null, 12)).toBeNull();
		expect(estimateText(4.2, 12)).toBe(
			"A rough guess: about $4.20 for the models you picked. It stops at your limit of $12.00.",
		);
		expect(estimateText(0.001, null)).toBe("A rough guess: under 1 cent for the models you picked.");
	});

	it("previews the stages of a limit", () => {
		const split = { challengers: 5.4, writers: 1.2, reviewer: 3, judge: 0.24, reserve: 0.96 };
		expect(limitPreview("12", split)).toContain("Challengers $5.40");
		expect(limitPreview("", split)).toBeNull();
		expect(limitPreview("500", split)).toBeNull();
	});
});

describe("the list", () => {
	const row = (over: Partial<BakeoffSummary> = {}): BakeoffSummary => ({
		id: "b1",
		title: "T",
		repoRoot: "/work/repo",
		subject: "feature/x vs main",
		createdAt: 1,
		status: "ready",
		...over,
	});

	it("says how a bake-off stands", () => {
		expect(rowStatus(row({ status: "running", progress: "2 of 3 entries in" }))).toEqual({
			kind: "running",
			text: "2 of 3 entries in",
		});
		expect(rowStatus(row({ status: "running" })).text).toBe("Starting");
		expect(rowStatus(row({ status: "failed", error: "No tmux" }))).toEqual({ kind: "failed", text: "No tmux" });
		expect(rowStatus(row()).kind).toBe("ready");
	});

	it("names the mode, the entries, the result and the cost", () => {
		expect(modeWord("design")).toBe("Design");
		expect(modeWord("implementation")).toBe("Implementation");
		expect(modeWord(undefined)).toBeNull();
		expect(entryCountText(1)).toBe("1 entry");
		expect(entryCountText(3)).toBe("3 entries");
		expect(entryCountText(undefined)).toBeNull();
		expect(rankText(row())).toBeNull();
		expect(rankText(row({ top: "A" }))).toBe("A ranked first");
		expect(rankText(row({ top: "A", taken: "B" }))).toBe("You took B");
		expect(costText(row())).toBeNull();
		expect(costText(row({ maxCostUsd: 12 }))).toBe("Limit $12.00");
		expect(costText(row({ costUsd: 1.2 }))).toBe("$1.20");
		expect(costText(row({ costUsd: 1.2, maxCostUsd: 12 }))).toBe("$1.20 of $12.00");
	});

	it("groups by repository, newest first", () => {
		const groups = groupByRepo([
			row({ id: "old", createdAt: 1 }),
			row({ id: "other", repoRoot: "/work/other/", createdAt: 5 }),
			row({ id: "new", createdAt: 3 }),
		]);
		expect(groups.map(group => [group.name, group.bakeoffs.map(item => item.id)])).toEqual([
			["other", ["other"]],
			["repo", ["new", "old"]],
		]);
	});
});
