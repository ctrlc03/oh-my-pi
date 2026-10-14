import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BAKEOFF_LABELS,
	type BakeoffFacts,
	type BakeoffMetric,
	isMeasuredMetric,
	splitBakeoffBudget,
} from "@oh-my-pi/pi-wire/bakeoff";
import type { RunInfo, RunTarget } from "../src/lib/companion";
import { createScrubber } from "../scripts/companion-bakeoff-anonymise";
import { type JudgeLike, type JudgeQuestion, runJudgePass } from "../scripts/companion-bakeoff-judge";
import {
	captureValue,
	compileValueRegex,
	measureBench,
	measureTests,
	numstat,
	scriptChanged,
} from "../scripts/companion-bakeoff-measure";
import { definitionOf, renderMetrics } from "../scripts/companion-bakeoff-metrics";
import { drawLabels, exportCommit, presentation } from "../scripts/companion-bakeoff-pack";
import { combine, consistencyOf, JUDGE_MIN_CONSISTENCY, type RankInput } from "../scripts/companion-bakeoff-rank";
import { parseReview, remapLabels, verifyReview } from "../scripts/companion-bakeoff-review";
import { factsLine, judgeDigest, parseWriteup, scrubWriteup, verifyWriteup } from "../scripts/companion-bakeoff-write";

describe("the scrubber", () => {
	const scrub = createScrubber(
		[
			{ selector: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
			{ selector: "openai/gpt-5", name: "GPT-5" },
		],
		["omp/bake-1a2b-1-claude-sonnet-4-5"],
	);

	it("replaces selectors, display names, providers and however the separators are written, with [model]", () => {
		const table: [string, string][] = [
			["Written by anthropic/claude-sonnet-4-5.", "Written by [model]."],
			["claude sonnet 4.5 would split it", "[model] would split it"],
			["As Claude_Sonnet_4_5 argued", "As [model] argued"],
			["per GPT-5 and Anthropic", "per [model] and [model]"],
			["gpt-45 is another model", "gpt-45 is another model"],
			["The gpt-5s are many", "The gpt-5s are many"],
		];
		for (const [input, expected] of table) expect(scrub(input).text).toBe(expected);
	});

	it("replaces branch names, their folder form and anything shaped like a bake-off branch, and the roles", () => {
		const table: [string, string][] = [
			["on omp/bake-1a2b-1-claude-sonnet-4-5 now", "on [entry] now"],
			["in omp-bake-1a2b-1-claude-sonnet-4-5/src", "in [entry]/src"],
			["see omp/bake-9999-2-other", "see [entry]"],
			["The original is smaller than the challenger", "[entry] is smaller than the [entry]"],
			["The original design keeps it", "[entry] keeps it"],
		];
		for (const [input, expected] of table) expect(scrub(input).text).toBe(expected);
		expect(scrub("nothing to hide").hits).toBe(0);
		expect(scrub("openai/gpt-5 and gpt-5").hits).toBe(2);
	});
});

describe("labels and presentation", () => {
	it("draws the same labels for the same bake-off and a permutation of A.. for the entries made", () => {
		expect(drawLabels("bk-1", 4)).toEqual(drawLabels("bk-1", 4));
		for (const id of ["bk-1", "bk-2", "bk-3", "bk-4"])
			expect([...drawLabels(id, 5)].sort().join("")).toBe(BAKEOFF_LABELS);
		expect(
			new Set(["bk-1", "bk-2", "bk-3", "bk-4", "bk-5", "bk-6", "bk-7"].map(id => drawLabels(id, 3)[0])).size,
		).toBeGreaterThan(1);
		expect(() => drawLabels("bk-1", 6)).toThrow("invalid entry count");
	});

	it("reads the entries under their labels in pass 0 and in the reverse order under redrawn labels in pass 1", () => {
		const labels = ["A", "B", "C", "D"];
		for (const seed of ["bk-a", "bk-b", "bk-c", "bk-d", "bk-e"]) {
			const first = presentation(seed, 0, labels);
			const second = presentation(seed, 1, labels);
			expect(first.packLabel).toEqual({ A: "A", B: "B", C: "C", D: "D" });
			expect([...first.order].sort()).toEqual(labels);
			expect(second.order).toEqual([...first.order].reverse());
			expect([...Object.values(second.packLabel)].sort()).toEqual(labels);
			for (const label of labels) expect(second.packLabel[label]).not.toBe(label);
			expect(presentation(seed, 1, labels)).toEqual(second);
		}
	});
});

describe("exporting code for a reviewer", () => {
	let tmp: string;
	let repo: string;
	let commit: string;

	async function git(...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
		return out.trim();
	}

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bakeoff-export-")));
		repo = path.join(tmp, "repo");
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		await git("init", "-q", "-b", "omp/bake-secret");
		await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 1;\n");
		await fs.writeFile(path.join(repo, "notes.txt"), "kept in git\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "the model said so");
		commit = await git("rev-parse", "HEAD");
		await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 2;\n");
	});
	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("unpacks the commit's files, not the working tree, with no .git, no branch name and no history", async () => {
		const dest = path.join(tmp, "out", "A");
		await exportCommit(repo, commit, dest);
		expect(await fs.readFile(path.join(dest, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		const names: string[] = [];
		for (const entry of await fs.readdir(dest, { recursive: true })) names.push(entry);
		expect(names.some(name => name.split("/").includes(".git"))).toBe(false);
		const text = (
			await Promise.all(names.map(name => fs.readFile(path.join(dest, name), "utf8").catch(() => "")))
		).join("\n");
		expect(text).not.toContain("omp/bake-secret");
		expect(text).not.toContain("the model said so");
	});

	it("refuses anything that is not a full commit id, and an unknown one", async () => {
		await expect(exportCommit(repo, "HEAD", path.join(tmp, "x"))).rejects.toThrow("invalid commit");
		await expect(exportCommit(repo, "0".repeat(40), path.join(tmp, "y"))).rejects.toThrow();
	});

	it("counts the files and lines of a diff from git, per the same base", async () => {
		const base = await git("rev-parse", "HEAD");
		await git("commit", "-q", "-am", "two");
		const head = await git("rev-parse", "HEAD");
		expect(await numstat(repo, base, head)).toEqual({ files: 1, added: 1, removed: 1 });
		expect(await numstat(repo, head, head)).toEqual({ files: 0, added: 0, removed: 0 });
	});
});

const METRICS: BakeoffMetric[] = [
	{ id: "simplicity", label: "Simplicity", weight: 3 },
	{ id: "migration-risk", label: "Migration risk", weight: 1 },
];

function ranked(overrides: Partial<RankInput> = {}): RankInput {
	return {
		metrics: METRICS,
		labels: ["A", "B", "C"],
		originalLabel: "A",
		reviewer: {
			A: { simplicity: 0.25, "migration-risk": 0.5 },
			B: { simplicity: 1, "migration-risk": 0.75 },
			C: { simplicity: 0.5, "migration-risk": 0.5 },
		},
		reviewerRankings: [["B", "C", "A"]],
		facts: {},
		hasBench: false,
		hasTestTarget: false,
		findings: [],
		flags: {},
		selfPreference: [],
		...overrides,
	};
}

describe("combining the reviewer, the judge and the measurements", () => {
	it("ranks on the reviewer alone when there is no second opinion", () => {
		const result = combine(ranked());
		expect(result.ranking.map(row => row.label)).toEqual(["B", "C", "A"]);
		expect(result.ranking.map(row => row.rank)).toEqual([1, 2, 3]);
		expect(result.agreement).toBe("reviewer-only");
		expect(result.ranking[0]!.score).toBeCloseTo((3 * 1 + 0.75) / 4);
	});

	it("weighs the reviewer 0.7 and the judge 0.3 per metric, and says whether they agree", () => {
		const judge = {
			A: { simplicity: 1, "migration-risk": 1 },
			B: { simplicity: 0, "migration-risk": 0 },
			C: { simplicity: 0.5, "migration-risk": 0.5 },
		};
		const result = combine(ranked({ judge: { scores: judge, consistency: 1 } }));
		expect(result.scores.A!.simplicity).toMatchObject({ reviewer: 0.25, judge: 1 });
		expect(result.scores.A!.simplicity!.combined).toBeCloseTo(0.7 * 0.25 + 0.3 * 1);
		// The judge would put A first, the reviewer put B first: split, with the reason in words.
		expect(result.agreement).toBe("split");
		expect(result.splitNote).toBe("The reviewer put B first and the judge put A first.");
		// B totals about 0.66 and A about 0.52: inside the margin the totals order, so A (0.52) stays ahead of C (0.50).
		expect(result.ranking.map(row => row.label)).toEqual(["B", "A", "C"]);

		const same = combine(
			ranked({
				judge: { scores: { A: { simplicity: 0 }, B: { simplicity: 1 }, C: { simplicity: 0.5 } }, consistency: 1 },
			}),
		);
		expect(same.agreement).toBe("agreed");
		expect(same.splitNote).toBeUndefined();
	});

	it("lets the totals order entries inside the margin, whatever the reviewer's order says", () => {
		const close = {
			A: { simplicity: 0.5, "migration-risk": 0.5 },
			B: { simplicity: 0.55, "migration-risk": 0.5 },
			C: { simplicity: 0.1, "migration-risk": 0.1 },
		};
		const result = combine(ranked({ reviewer: close, reviewerRankings: [["A", "B", "C"]] }));
		// A and B are within 0.15: B's total is higher, so B goes first; C is far behind.
		expect(result.ranking.map(row => row.label)).toEqual(["B", "A", "C"]);
	});

	it("gives a judge that contradicts itself no weight, and says so", () => {
		const judge = {
			A: { simplicity: 1, "migration-risk": 1 },
			B: { simplicity: 0, "migration-risk": 0 },
			C: { simplicity: 0, "migration-risk": 0 },
		};
		const result = combine(ranked({ judge: { scores: judge, consistency: JUDGE_MIN_CONSISTENCY - 0.1 } }));
		expect(result.judgeIgnored).toBe(true);
		expect(result.agreement).toBe("reviewer-only");
		expect(result.scores.A!.simplicity!.judge).toBeUndefined();
		expect(result.ranking.map(row => row.label)).toEqual(["B", "C", "A"]);
	});

	it("lets a measured metric win: lines changed come from the diff, not the reviewer", () => {
		const metrics: BakeoffMetric[] = [{ id: "lines-changed", label: "Lines changed", weight: 3 }, ...METRICS];
		const facts: Record<string, BakeoffFacts> = {
			A: { files: 1, added: 100, removed: 0 },
			B: { files: 1, added: 10, removed: 0 },
			C: { files: 1, added: 55, removed: 5 },
		};
		const result = combine(
			ranked({
				metrics,
				facts,
				reviewer: {
					A: { "lines-changed": 1, simplicity: 0.5, "migration-risk": 0.5 },
					B: { "lines-changed": 0, simplicity: 0.5, "migration-risk": 0.5 },
					C: { "lines-changed": 0.5, simplicity: 0.5, "migration-risk": 0.5 },
				},
			}),
		);
		expect(result.scores.B!["lines-changed"]).toMatchObject({ reviewer: 0, measured: 1, combined: 1 });
		expect(result.scores.A!["lines-changed"]).toMatchObject({ measured: 0, combined: 0 });
		expect(result.scores.C!["lines-changed"]!.measured).toBeCloseTo((100 - 60) / 90);
	});

	it("performance is measured only with a benchmark, and one measurement alone says nothing", () => {
		const performance: BakeoffMetric = { id: "performance", label: "Performance", weight: 2 };
		expect(isMeasuredMetric(performance, false)).toBe(false);
		expect(isMeasuredMetric(performance, true)).toBe(true);
		const bench = (value: number | null): BakeoffFacts => ({
			files: 1,
			added: 1,
			removed: 0,
			bench: { target: "package:bench", better: "lower", runs: [1, 2, 3], value },
		});
		const result = combine(
			ranked({
				metrics: [performance],
				hasBench: true,
				facts: { A: bench(10), B: bench(20), C: bench(null) },
				reviewer: { A: { performance: 0.5 }, B: { performance: 0.5 }, C: { performance: 0.5 } },
			}),
		);
		expect(result.scores.A!.performance!.measured).toBe(1);
		expect(result.scores.B!.performance!.measured).toBe(0);
		expect(result.scores.C!.performance!.measured).toBeUndefined();
		const alone = combine(
			ranked({
				metrics: [performance],
				hasBench: true,
				facts: { A: bench(10) },
				reviewer: { A: { performance: 0.5 }, B: { performance: 0.5 }, C: { performance: 0.5 } },
			}),
		);
		expect(alone.scores.A!.performance!.measured).toBeUndefined();
	});

	it("marks an entry whose tests fail while the original's pass as not eligible", () => {
		const tests = (ok: boolean | null): BakeoffFacts => ({
			files: 1,
			added: 1,
			removed: 0,
			tests: { target: "package:test", ok },
		});
		const result = combine(
			ranked({ hasTestTarget: true, facts: { A: tests(true), B: tests(false), C: tests(null) } }),
		);
		const rows = Object.fromEntries(result.ranking.map(row => [row.label, row.eligible]));
		expect(rows).toEqual({ A: true, B: false, C: true });
		// Without a test target nothing is gated; with a failing original nothing is either.
		expect(combine(ranked({ facts: { A: tests(true), B: tests(false) } })).ranking.every(row => row.eligible)).toBe(
			true,
		);
		expect(
			combine(ranked({ hasTestTarget: true, facts: { A: tests(false), B: tests(false) } })).ranking.every(
				row => row.eligible,
			),
		).toBe(true);
	});

	it("is split when the reviewer favours its own model's entry and the judge does not, and when two passes disagree", () => {
		const judge = {
			A: { simplicity: 1, "migration-risk": 1 },
			B: { simplicity: 0, "migration-risk": 0 },
			C: { simplicity: 0, "migration-risk": 0 },
		};
		const self = combine(ranked({ selfPreference: ["B"], judge: { scores: judge, consistency: 1 } }));
		expect(self.splitNote).toContain("an entry written by its own model");
		const twoPasses = combine(
			ranked({
				reviewerRankings: [
					["B", "C", "A"],
					["C", "B", "A"],
				],
			}),
		);
		expect(twoPasses.agreement).toBe("split");
		expect(twoPasses.splitNote).toBe("The two reviewer passes did not agree on the first entry.");
	});

	it("shows each entry's reasons: the findings first, then a line per metric", () => {
		const result = combine(
			ranked({ findings: [{ label: "B", kind: "strength", text: "One extra parameter.", verified: true }] }),
		);
		expect(result.ranking[0]!.reasons[0]).toBe("Strength: One extra parameter.");
		expect(result.ranking[0]!.reasons.join("\n")).toContain("Simplicity: reviewer 5/5");
	});

	it("measures the share of pairwise answers that agreed across the swap", () => {
		expect(consistencyOf([])).toBe(1);
		expect(
			consistencyOf([{ consistent: true }, { consistent: false }, { consistent: true }, { consistent: true }]),
		).toBe(0.75);
	});
});

describe("the budget split", () => {
	it("gives the reviewer a quarter, the judge 2% and a reserve of 8%, and shares the rest with the writers", () => {
		expect(splitBakeoffBudget(12, "implementation")).toEqual({
			challengers: 5.4,
			writers: 2.4,
			reviewer: 3,
			judge: 0.24,
			reserve: 0.96,
		});
		expect(splitBakeoffBudget(12, "design")).toEqual({
			challengers: 6.6,
			writers: 1.2,
			reviewer: 3,
			judge: 0.24,
			reserve: 0.96,
		});
		for (const mode of ["design", "implementation"] as const) {
			const parts = splitBakeoffBudget(3, mode);
			expect(parts.challengers + parts.writers + parts.reviewer + parts.judge + parts.reserve).toBeLessThanOrEqual(
				3,
			);
			expect(parts.challengers + parts.writers + parts.reviewer + parts.judge + parts.reserve).toBeGreaterThan(2.95);
		}
	});
});

describe("metric definitions", () => {
	it("render with the weights and a note on the measured ones, custom text verbatim", () => {
		const custom: BakeoffMetric = { id: "custom:1", label: "Mine", text: "Works offline", weight: 2 };
		expect(definitionOf(custom).definition).toBe("Works offline");
		const text = renderMetrics(
			[...METRICS, { id: "lines-changed", label: "Lines changed", weight: 1 }, custom],
			new Set(["lines-changed"]),
		);
		expect(text).toContain("`simplicity` — Simplicity (weight 3 of 3)");
		expect(text).toContain("Works offline");
		expect(text).toContain("also measured");
	});
});

describe("write-ups", () => {
	const lines = async (file: string): Promise<string[] | null> =>
		file === "src/a.ts" ? ["export class Store {", "\tget(key) {}", "}"] : null;

	it("parses the template, keeps the metrics asked for and drops the rest", () => {
		const parsed = parseWriteup(
			{
				summary: "S",
				approach: "A",
				tradeoffs: ["t"],
				risks: [],
				migration: "m",
				metrics: { simplicity: "x", other: "y" },
				refs: ["src/a.ts@1@Store"],
			},
			["simplicity"],
		);
		expect(parsed).toMatchObject({ summary: "S", metrics: { simplicity: "x" }, refsGiven: 1 });
		expect(parsed.metrics).not.toHaveProperty("other");
		expect(() => parseWriteup({ approach: "A" }, [])).toThrow("no summary");
		expect(() => parseWriteup("nope", [])).toThrow("not a JSON object");
	});

	it("keeps a citation that holds, drops one that does not, and refuses a file whose citations all fail", async () => {
		const good = parseWriteup({ summary: "S", approach: "A", refs: ["src/a.ts@1@Store", "src/a.ts@2@missing"] }, []);
		const warnings: string[] = [];
		const verified = await verifyWriteup(good, lines, warnings);
		expect(verified.refs).toEqual([{ path: "src/a.ts", line: 1, token: "Store" }]);
		const bad = parseWriteup({ summary: "S", approach: "A", refs: ["src/a.ts@2@missing"] }, []);
		await expect(verifyWriteup(bad, lines, [])).rejects.toThrow();
		const none = parseWriteup({ summary: "S", approach: "A" }, []);
		expect((await verifyWriteup(none, lines, [])).refs).toEqual([]);
	});

	it("scrubs every text of a write-up and renders a digest that is cut to size", () => {
		const writeup = {
			summary: "By claude-x",
			approach: "claude-x says so",
			tradeoffs: ["claude-x"],
			risks: [],
			migration: "",
			metrics: { simplicity: "claude-x" },
			refs: [],
		};
		const scrub = createScrubber([{ selector: "p/claude-x" }], []);
		const scrubbed = scrubWriteup(writeup, text => scrub(text).text);
		expect(JSON.stringify(scrubbed)).not.toContain("claude-x");
		expect(factsLine(undefined)).toBe("No measured facts.");
		const facts: BakeoffFacts = {
			files: 2,
			added: 5,
			removed: 1,
			tests: { target: "t", ok: false, reason: "it exited with code 1" },
		};
		expect(factsLine(facts)).toBe("2 files, +5 −1 against the base; tests failed (it exited with code 1).");
		expect(judgeDigest(scrubbed, facts, { simplicity: "Simplicity" }, 120).length).toBeLessThanOrEqual(120);
	});
});

describe("the reviewer's file", () => {
	const labels = ["A", "B", "C"];
	const ids = ["simplicity"];
	const entries = (score: unknown = 4): Record<string, unknown> =>
		Object.fromEntries(
			labels.map(label => [label, { scores: { simplicity: score }, strengths: [], weaknesses: [] }]),
		);

	it("needs a ranking that lists every label once, and scores from 1 to 5", () => {
		const ok = { ranking: ["B", "a", "C"], entries: entries(), verdict: "V", unsure: [] };
		expect(parseReview(ok, labels, ids).ranking).toEqual(["B", "A", "C"]);
		const bad = (raw: unknown, message: string): void => expect(() => parseReview(raw, labels, ids)).toThrow(message);
		bad({ ...ok, ranking: ["A", "B"] }, "exactly once");
		bad({ ...ok, ranking: ["A", "A", "B"] }, "exactly once");
		bad({ ...ok, ranking: ["A", "B", "D"] }, "exactly once");
		expect(parseReview({ ...ok, entries: entries(9) }, labels, ids).entries.A!.scores).toEqual({});
		expect(parseReview(ok, labels, ids).entries.A!.scores).toEqual({ simplicity: 4 });
		bad(null, "not a JSON object");
	});

	it("rewrites the labels the reviewer read to the entries', in prose and in backticked citations", () => {
		const toEntry = { A: "C", B: "A", C: "B" };
		expect(remapLabels("Entry A beats Entries B and C: `A/src/x.ts@1@x`", toEntry)).toBe(
			"Entry C beats Entries A and B: `C/src/x.ts@1@x`",
		);
	});

	it("checks a finding's citation against the code of the entry it names, not of another", async () => {
		const code: Record<string, string[]> = { A: ["export const a = 1;"], B: ["export const b = 2;"] };
		const io = { lines: async (label: string, file: string) => (file === "x.ts" ? (code[label] ?? null) : null) };
		const parsed = parseReview(
			{
				ranking: ["A", "B"],
				entries: {
					A: {
						scores: { simplicity: 5 },
						strengths: [{ text: "a is a constant", refs: ["A/x.ts@1@a = 1"] }],
						weaknesses: [{ text: "claims b's line", refs: ["A/x.ts@1@b = 2"] }],
					},
					B: { scores: { simplicity: 1 }, strengths: [], weaknesses: [] },
				},
				verdict: "A is better: `A/x.ts@1@a = 1` while `B/x.ts@1@a = 1` is not there.",
				unsure: [],
			},
			["A", "B"],
			ids,
		);
		const warnings: string[] = [];
		const verified = await verifyReview(parsed, { A: "A", B: "B" }, io, warnings);
		expect(verified.ranking).toEqual(["A", "B"]);
		expect(verified.scores.A!.simplicity).toBe(1);
		expect(verified.scores.B!.simplicity).toBe(0);
		expect(verified.findings.find(f => f.kind === "strength")).toMatchObject({ label: "A", verified: true });
		expect(verified.findings.find(f => f.kind === "weakness")).toMatchObject({ label: "A", verified: false });
		expect(verified.verdict).toContain("`A/x.ts@1@a = 1`");
		expect(verified.verdict).toContain("(not checked against the code)");
	});

	it("maps what was read under redrawn labels back to the stored entries", async () => {
		const io = { lines: async (label: string) => (label === "C" ? ["const z = 1;"] : null) };
		const parsed = parseReview(
			{
				ranking: ["B", "A"],
				entries: {
					A: { scores: { simplicity: 2 }, strengths: [], weaknesses: [] },
					B: { scores: { simplicity: 5 }, strengths: [{ text: "z", refs: ["B/x.ts@1@z = 1"] }], weaknesses: [] },
				},
				verdict: "Entry B wins.",
				unsure: [],
			},
			["A", "B"],
			ids,
		);
		// The reviewer read stored entry C as B, and stored entry D as A.
		const verified = await verifyReview(parsed, { B: "C", A: "D" }, io, []);
		expect(verified.ranking).toEqual(["C", "D"]);
		expect(verified.findings[0]).toMatchObject({ label: "C", verified: true });
		expect(verified.verdict).toBe("Entry C wins.");
	});
});

describe("the judge pass", () => {
	const entries = [
		{ label: "A", digest: "aaaa" },
		{ label: "B", digest: "bb" },
		{ label: "C", digest: "c" },
	];
	const metrics: BakeoffMetric[] = [{ id: "simplicity", label: "Simplicity", weight: 1 }];

	/** Prefers the longer digest, in whichever position it is shown. */
	function longer(calls: { type: string }[] = []): JudgeLike {
		return {
			judge: async request => {
				const state = request.state as { first?: string; second?: string };
				const answers: Record<string, { type: "choice" | "score"; choice?: string; score?: number }> = {};
				for (const [id, question] of Object.entries(request.questions)) {
					calls.push({ type: question.type });
					answers[id] =
						question.type === "score"
							? { type: "score", score: 4 }
							: {
									type: "choice",
									choice: (state.first?.length ?? 0) >= (state.second?.length ?? 0) ? "first" : "second",
								};
				}
				return { answers };
			},
		};
	}

	it("asks each pair twice with the entries swapped and reads a consistent answer as a win", async () => {
		const result = await runJudgePass({
			judge: longer(),
			native: false,
			problem: "p",
			entries,
			metrics,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(result.pairs).toHaveLength(3);
		expect(result.pairs.every(pair => pair.consistent)).toBe(true);
		expect(result.pairs.find(pair => pair.a === "A" && pair.b === "B")!.winner).toBe("A");
		expect(result.consistency).toBe(1);
		// Pairwise win share alone: A won twice, B once and lost once, C lost twice.
		expect(result.scores.A!.simplicity).toBe(1);
		expect(result.scores.B!.simplicity).toBe(0.5);
		expect(result.scores.C!.simplicity).toBe(0);
	});

	it("keys a custom metric's question without a colon, which a text judge's reply could not carry", async () => {
		const custom: BakeoffMetric[] = [
			{ id: "simplicity", label: "Simplicity", weight: 1 },
			{ id: "custom:1", label: "Easy to debug", text: "Easy to see why a job ran again.", weight: 1 },
		];
		const asked: string[] = [];
		const judge: JudgeLike = {
			judge: async request => {
				// A text judge answers one `<key>: <answer>` line per question and reads the key up to the first colon.
				for (const id of Object.keys(request.questions)) {
					asked.push(id);
					if (id.includes(":")) throw new Error(`no answer line for question ${id}`);
				}
				return {
					answers: Object.fromEntries(
						Object.keys(request.questions).map(id => [id, { type: "choice", choice: "first" }]),
					),
				};
			},
		};
		const result = await runJudgePass({
			judge,
			native: false,
			problem: "p",
			entries,
			metrics: custom,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(new Set(asked)).toEqual(new Set(["simplicity", "custom-1"]));
		expect(result.pairs.filter(pair => pair.metric === "custom:1")).toHaveLength(3);
		expect(result.scores.A!["custom:1"]).toBeDefined();
	});

	it("counts an answer that depends on the order as a tie, marked inconsistent", async () => {
		const first: JudgeLike = {
			judge: async request => ({
				answers: Object.fromEntries(
					Object.keys(request.questions).map(id => [id, { type: "choice", choice: "first" }]),
				),
			}),
		};
		const result = await runJudgePass({
			judge: first,
			native: false,
			problem: "p",
			entries,
			metrics,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(result.pairs.every(pair => !pair.consistent && pair.winner === "tie")).toBe(true);
		expect(result.consistency).toBe(0);
	});

	it("asks for absolute scores only of a native judge", async () => {
		const plain: { type: string }[] = [];
		await runJudgePass({
			judge: longer(plain),
			native: false,
			problem: "p",
			entries,
			metrics,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(plain.some(call => call.type === "score")).toBe(false);
		const native: { type: string }[] = [];
		const result = await runJudgePass({
			judge: longer(native),
			native: true,
			problem: "p",
			entries,
			metrics,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(native.filter(call => call.type === "score")).toHaveLength(3);
		expect(result.scores.A!.simplicity).toBe((1 + 1) / 2);
	});

	it("stops asking once the spending limit is reached, and throws when the first question fails", async () => {
		let asked = 0;
		const judge: JudgeLike = {
			judge: async request => {
				asked++;
				return longer().judge(request);
			},
		};
		const stopped = await runJudgePass({
			judge,
			native: false,
			problem: "p",
			entries,
			metrics,
			spent: () => (asked >= 2 ? 1 : 0),
			budgetUsd: 1,
		});
		expect(asked).toBe(2);
		expect(stopped.pairs).toHaveLength(1);
		expect(stopped.unjudged).toBe(4);
		const broken: JudgeLike = {
			judge: async () => {
				throw new Error("judgment: no key");
			},
		};
		await expect(
			runJudgePass({ judge: broken, native: false, problem: "p", entries, metrics, spent: () => 0, budgetUsd: 1 }),
		).rejects.toThrow("no key");
	});

	it("keeps the answers it has when the judge fails part way", async () => {
		let asked = 0;
		const flaky: JudgeLike = {
			judge: async request => {
				if (++asked > 2) throw new Error("rate limited");
				return longer().judge(request);
			},
		};
		const result = await runJudgePass({
			judge: flaky,
			native: false,
			problem: "p",
			entries,
			metrics,
			spent: () => 0,
			budgetUsd: 1,
		});
		expect(result.pairs).toHaveLength(1);
		expect(result.unjudged).toBe(4);
	});
});

describe("measuring tests and benchmarks", () => {
	const target = (detail: string): RunTarget => ({
		id: "package:test",
		source: "package",
		name: "test",
		command: "bun run test",
		detail,
	});
	const info = (overrides: Partial<RunInfo> = {}): RunInfo => ({
		runId: "r1",
		instanceId: "bk",
		targetId: "package:test",
		command: "bun run test",
		startedAt: 1_000,
		endedAt: 1_250,
		state: "exited",
		exitCode: 0,
		signal: null,
		...overrides,
	});
	const runs = (results: RunInfo[], entryTargets: RunTarget[], output = "") => {
		let next = 0;
		return {
			targets: async () => entryTargets,
			start: async () => ({ ...info(), runId: `r${next}` }),
			finished: async () => results[next++] ?? info(),
			stop: () => info({ state: "stopped" }),
			output: () => ({ run: info(), text: output, from: 0, next: output.length, truncated: false }),
		};
	};

	it("tells a script edited in the entry from one the person confirmed", () => {
		expect(scriptChanged([target("bun test")], [target("bun test")], { target: "package:test" })).toBe(false);
		expect(scriptChanged([target("bun test")], [target("true")], { target: "package:test" })).toBe(true);
		expect(scriptChanged([target("bun test")], [], { target: "package:test" })).toBe(true);
	});

	it("records a pass, a failure and an unverified entry, never counting a script change as a pass", async () => {
		const base = {
			key: "bk-1-A",
			root: "/tmp/x",
			choice: { target: "package:test" },
			reference: [target("bun test")],
			baseOnly: false,
		};
		const pass = await measureTests({ ...base, deps: { runs: runs([info()], [target("bun test")]) } });
		expect(pass.tests).toEqual({ target: "package:test", ok: true });
		const fail = await measureTests({ ...base, deps: { runs: runs([info({ exitCode: 2 })], [target("bun test")]) } });
		expect(fail.tests).toEqual({ target: "package:test", ok: false, reason: "it exited with code 2" });
		const edited = await measureTests({ ...base, deps: { runs: runs([info()], [target("true")]) } });
		expect(edited.tests).toMatchObject({ ok: null, reason: "the test script was changed in this entry" });
		expect(edited.flags).toEqual(["test script changed"]);
		const baseOnly = await measureTests({
			...base,
			baseOnly: true,
			deps: { runs: runs([info()], [target("bun test")]) },
		});
		expect(baseOnly.tests).toMatchObject({ ok: true, note: "ran the base's tests only" });
		const refused = await measureTests({
			...base,
			deps: {
				runs: runs([info()], [target("bun test")]),
				checkRoot: async () => {
					throw new Error("a sandboxed session works here");
				},
			},
		});
		expect(refused.tests).toMatchObject({ ok: null, reason: "a sandboxed session works here" });
	});

	it("stops a run that outlasts its time and records it as timed out", async () => {
		let stopped = 0;
		const slow = {
			...runs([info({ state: "stopped", exitCode: null, signal: "SIGTERM" })], [target("bun test")]),
			finished: async () => {
				if (stopped === 0) return new Promise<RunInfo>(() => undefined);
				return info({ state: "stopped", exitCode: null });
			},
			stop: () => {
				stopped++;
				return info({ state: "stopped" });
			},
		};
		const measured = await measureTests({
			deps: { runs: slow, sleep: async () => undefined },
			key: "k",
			root: "/tmp/x",
			choice: { target: "package:test" },
			reference: [target("bun test")],
			baseOnly: false,
		});
		expect(measured.tests).toMatchObject({ ok: null, reason: "timed out" });
		expect(stopped).toBe(1);
	});

	it("runs a benchmark three times and takes the median wall time, or a number from the end of the output", async () => {
		const base = {
			key: "bk-1-A",
			root: "/tmp/x",
			choice: { target: "package:test" },
			reference: [target("bun test")],
			better: "lower" as const,
		};
		const timed = await measureBench({
			...base,
			deps: {
				runs: runs(
					[info({ endedAt: 1_300 }), info({ endedAt: 1_100 }), info({ endedAt: 1_200 })],
					[target("bun test")],
				),
			},
		});
		expect(timed.bench).toMatchObject({ runs: [300, 100, 200], value: 200, unit: "ms", better: "lower" });
		const printed = await measureBench({
			...base,
			valueRegex: "took (\\d+) ms",
			deps: { runs: runs([info(), info(), info()], [target("bun test")], "warmup took 9 ms\nrun took 42 ms\n") },
		});
		expect(printed.bench).toMatchObject({ runs: [42, 42, 42], value: 42 });
		const none = await measureBench({
			...base,
			valueRegex: "took (\\d+) ms",
			deps: { runs: runs([info()], [target("bun test")], "nothing") },
		});
		expect(none.bench).toMatchObject({ value: null, reason: "it printed no number matching the pattern" });
		const failed = await measureBench({
			...base,
			deps: { runs: runs([info(), info({ exitCode: 1 })], [target("bun test")]) },
		});
		expect(failed.bench).toMatchObject({ value: null, reason: "it exited with code 1" });
		const bad = await measureBench({ ...base, valueRegex: "(", deps: { runs: runs([], [target("bun test")]) } });
		expect(bad.bench.reason).toContain("not valid");
	});

	it("reads a number from the last match of a pattern and refuses a pattern that is too long or invalid", () => {
		const regex = compileValueRegex("score: ([\\d,.]+)")!;
		expect(captureValue("score: 1\nscore: 2,500.5\n", regex)).toBe(2500.5);
		expect(captureValue("no numbers", regex)).toBeNull();
		expect(compileValueRegex("(")).toBeUndefined();
		expect(compileValueRegex("x".repeat(201))).toBeUndefined();
		expect(compileValueRegex(undefined)).toBeUndefined();
	});
});

describe("question types", () => {
	it("are stable: choice questions carry the three options the judge answers", () => {
		const question: JudgeQuestion = {
			type: "choice",
			instructions: "x",
			criteria: { first: null, second: null, tie: "t" },
		};
		expect(Object.keys(question.criteria)).toEqual(["first", "second", "tie"]);
	});
});
