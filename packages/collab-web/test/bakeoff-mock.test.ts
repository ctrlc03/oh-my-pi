import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Bakeoff, BakeoffCreate, BakeoffSummary } from "@oh-my-pi/pi-wire/bakeoff";
import { BAKEOFF_LABELS } from "@oh-my-pi/pi-wire/bakeoff";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import type { MockBakeoffJudge } from "../scripts/mock-bakeoff";
import { createMockBakeoff } from "../scripts/mock-bakeoff";
import { cite, MOCK_QUIZ_ROOT } from "../scripts/mock-quiz";

function setup(judge?: MockBakeoffJudge) {
	const pushed: string[] = [];
	const mock = createMockBakeoff({ instanceId: "inst-7", stageMs: 5, judge, onChanged: id => pushed.push(id) });
	let reqId = 0;
	const ask = <T extends CompanionReply["t"]>(request: Record<string, unknown> & { t: string }, _expect?: T) =>
		mock.answer({ ...request, reqId: ++reqId } as unknown as CompanionRequest) as Promise<
			Extract<CompanionReply, { t: T }>
		>;
	const get = async (id: string): Promise<Bakeoff> => (await ask({ t: "bakeoff-get", id }, "bakeoff-get")).bakeoff;
	const row = async (id: string): Promise<BakeoffSummary> => {
		const found = (await ask({ t: "bakeoff-list" }, "bakeoff-list")).bakeoffs.find(item => item.id === id);
		if (found === undefined) throw new Error(`no row ${id}`);
		return found;
	};
	const create = (over: Partial<BakeoffCreate> = {}) =>
		ask(
			{
				t: "bakeoff-create",
				cwd: MOCK_QUIZ_ROOT,
				mode: "design",
				doc: { text: "# Share the providers", name: "providers.md" },
				metrics: [
					{ id: "simplicity", label: "Simplicity", weight: 2 },
					{ id: "custom:1", label: "Our retries", text: "Works with our retry rules", weight: 1 },
				],
				models: ["anthropic/claude-haiku-5", "openai/gpt-mini", "google/gemini-flash"],
				reviewer: "anthropic/claude-sonnet-5-5",
				...over,
			},
			"bakeoff-create",
		);
	return { mock, pushed, ask, get, row, create };
}

/** Citations a reviewer's markdown makes: `A/path@line@token`. */
function citationsOf(text: string): { label: string; path: string; line: number; token: string }[] {
	return [...text.matchAll(/`([A-E])\/([^@`]+)@(\d+)@([^`]+)`/g)].map(match => ({
		label: match[1]!,
		path: match[2]!,
		line: Number(match[3]),
		token: match[4]!,
	}));
}

describe("the mock bake-off companion", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("advertises bake-offs and answers only bakeoff requests", () => {
		const { mock } = setup();
		expect(mock.capabilities).toEqual({ canBakeoff: true, canBakeoffPatch: true, canBakeoffFolder: true });
		expect(mock.handles({ t: "bakeoff-list", reqId: 1 })).toBe(true);
		expect(mock.handles({ t: "spar-list", reqId: 1 })).toBe(false);
		mock.stop();
	});

	it("lists the six canned bake-offs of the folder's repository with their statuses, and the seventh under the scratch folder", async () => {
		const { mock, ask } = setup();
		const all = (await ask({ t: "bakeoff-list" }, "bakeoff-list")).bakeoffs;
		const byId = new Map(all.map(item => [item.id, item]));
		expect(all.map(item => item.id).sort()).toEqual([
			"bk-mock-failed",
			"bk-mock-folder",
			"bk-mock-impl",
			"bk-mock-impl-pruned",
			"bk-mock-nojudge",
			"bk-mock-running",
			"bk-mock-split",
		]);
		expect(byId.get("bk-mock-split")).toMatchObject({
			status: "ready",
			mode: "design",
			stage: "done",
			entryCount: 3,
		});
		expect(byId.get("bk-mock-split")?.top).toBeDefined();
		expect(byId.get("bk-mock-nojudge")).toMatchObject({
			status: "ready",
			note: "No second opinion: laya/mock-judge was unreachable (connection refused)",
		});
		expect(byId.get("bk-mock-impl")).toMatchObject({ status: "ready", mode: "implementation", entryCount: 4 });
		expect(byId.get("bk-mock-running")).toMatchObject({
			status: "running",
			stage: "entries",
			instanceId: "inst-7",
			entryCount: 4,
		});
		expect(byId.get("bk-mock-running")?.progress).toBeTruthy();
		expect(byId.get("bk-mock-running")?.costUsd).toBeGreaterThan(0);
		expect(byId.get("bk-mock-failed")).toMatchObject({ status: "failed", stage: "review" });
		expect(byId.get("bk-mock-failed")?.error).toBeTruthy();
		expect(all.every(item => item.maxCostUsd !== undefined && item.costUsd !== undefined)).toBe(true);
		const here = (await ask({ t: "bakeoff-list", cwd: "/work/api-pagination" }, "bakeoff-list")).bakeoffs;
		expect(here.every(item => item.repoRoot === MOCK_QUIZ_ROOT)).toBe(true);
		expect(all.map(item => item.createdAt)).toEqual([...all.map(item => item.createdAt)].sort((a, b) => b - a));
		mock.stop();
	});

	it("answers the judge probe per its flag, a usable endpoint by default", async () => {
		const expected: Record<MockBakeoffJudge, object> = {
			endpoint: { state: "endpoint", label: "laya/mock-judge", reachable: true },
			native: { state: "native", reachable: true },
			local: { state: "local", reachable: true },
			fallback: { state: "fallback", reachable: true, price: expect.stringContaining("per million tokens") },
			none: { state: "none", reason: expect.stringContaining("No judge model") },
			unreachable: { state: "endpoint", reachable: false, reason: "connection refused" },
		};
		for (const [flag, judge] of Object.entries(expected)) {
			const { mock, ask } = setup(flag as MockBakeoffJudge);
			expect((await ask({ t: "bakeoff-judge" }, "bakeoff-judge")).judge).toMatchObject(judge);
			mock.stop();
		}
		const { mock, ask } = setup();
		expect((await ask({ t: "bakeoff-judge" }, "bakeoff-judge")).judge.state).toBe("endpoint");
		expect((await ask({ t: "bakeoff-judge" }, "bakeoff-judge")).judge.reachable).toBe(true);
		mock.stop();
	});

	it("shows a split verdict whose rankings, citations and reasons all hold together", async () => {
		const { mock, get } = setup();
		const bakeoff = await get("bk-mock-split");
		const labels = bakeoff.entries.map(entry => entry.label);
		expect(labels).toEqual(["A", "B", "C"]);
		expect(bakeoff.entries.filter(entry => entry.kind === "original")).toHaveLength(1);
		expect(bakeoff.entries.filter(entry => entry.kind === "challenger").every(entry => entry.model)).toBe(true);
		const result = bakeoff.result!;
		expect(result).toMatchObject({
			agreement: "split",
			judgeKind: "endpoint",
			reviewerModel: "openai/gpt-mini",
			selfPreference: ["C"],
		});
		expect(result.judgeLabel).toContain("laya/mock-judge");
		expect(result.splitNote).toBeTruthy();
		expect(result.unsure.length).toBeGreaterThan(0);
		expect(result.consistency).toBeGreaterThan(0);
		expect(result.consistency).toBeLessThan(1);
		expect(result.passes).toHaveLength(2);
		expect(result.ranking.map(item => item.rank)).toEqual([1, 2, 3]);
		for (const item of result.ranking) {
			expect(labels).toContain(item.label);
			expect(item.reasons.length).toBeGreaterThan(0);
			expect(item.score).toBeGreaterThanOrEqual(0);
			expect(item.score).toBeLessThanOrEqual(1);
		}
		for (const pass of result.passes!) expect(pass.ranking.every(label => labels.includes(label))).toBe(true);
		// The two disagree about who is first.
		const judgeFirst = result.pairwise!.filter(pair => pair.winner !== "tie").map(pair => pair.winner);
		expect(judgeFirst).toContain("B");
		expect(result.ranking[0]!.label).not.toBe("B");
		expect(result.pairwise!.some(pair => !pair.consistent && pair.winner === "tie")).toBe(true);
		for (const pair of result.pairwise!) {
			expect(labels).toContain(pair.a);
			expect(labels).toContain(pair.b);
			expect(bakeoff.metrics.map((metric): string => metric.id)).toContain(pair.metric);
		}
		// Every entry has a score for every metric, with the reviewer, the judge and the combination.
		for (const label of labels)
			for (const metric of bakeoff.metrics)
				expect(result.scores[label]![metric.id]).toMatchObject({
					reviewer: expect.any(Number),
					judge: expect.any(Number),
					combined: expect.any(Number),
				});
		// Citations of the verdict, of both passes and of the findings point at entries and at code they cite.
		for (const text of [result.verdict, ...result.passes!.map(pass => pass.verdict)]) {
			const found = citationsOf(text);
			expect(found.length).toBeGreaterThan(0);
			for (const citation of found) {
				const entry = bakeoff.entries.find(item => item.label === citation.label);
				expect(entry).toBeDefined();
				expect(
					entry!.writeup!.refs.some(
						ref => ref.path === citation.path && ref.line === citation.line && ref.token === citation.token,
					),
				).toBe(true);
			}
		}
		expect(result.findings.filter(finding => !finding.verified)).toHaveLength(1);
		expect(result.findings.filter(finding => !finding.verified)[0]!.refs).toBeUndefined();
		expect(result.findings.every(finding => labels.includes(finding.label))).toBe(true);
		expect(result.findings.some(finding => finding.kind === "strength")).toBe(true);
		// A write-up has its refs, a metric line for each thing that matters and one entry has a diagram.
		for (const entry of bakeoff.entries) {
			expect(entry.writeup!.refs.length).toBeGreaterThan(0);
			expect(Object.keys(entry.writeup!.metrics).sort()).toEqual(bakeoff.metrics.map(metric => metric.id).sort());
		}
		expect(bakeoff.entries.some(entry => entry.writeup!.diagram?.startsWith("flowchart"))).toBe(true);
		expect(bakeoff.entries.every(entry => entry.facts === undefined && entry.instanceId === undefined)).toBe(true);
		mock.stop();
	});

	it("shows a finished bake-off whose judge was unreachable as reviewer-only", async () => {
		const { mock, get } = setup();
		const { result } = await get("bk-mock-nojudge");
		expect(result).toMatchObject({
			agreement: "reviewer-only",
			judgeNote: "No second opinion: laya/mock-judge was unreachable (connection refused)",
		});
		expect(result!.judgeLabel).toBeUndefined();
		expect(result!.pairwise).toBeUndefined();
		expect(result!.consistency).toBeUndefined();
		expect(
			Object.values(result!.scores).every(row => Object.values(row).every(score => score.judge === undefined)),
		).toBe(true);
		expect(result!.ranking.map(item => item.rank)).toEqual([1, 2, 3]);
		mock.stop();
	});

	it("shows an implementation bake-off with facts, a failing entry and a changed test script", async () => {
		const { mock, get } = setup();
		const bakeoff = await get("bk-mock-impl");
		expect(bakeoff).toMatchObject({ mode: "implementation", start: "original", group: expect.any(String) });
		expect(bakeoff.entries).toHaveLength(4);
		expect(bakeoff.entries.filter(entry => entry.kind === "original")).toHaveLength(1);
		expect(bakeoff.entries.filter(entry => entry.kind === "challenger")).toHaveLength(3);
		const challengers = bakeoff.entries.filter(entry => entry.kind === "challenger");
		for (const entry of bakeoff.entries) {
			expect(entry.path).toBeTruthy();
			expect(entry.branch).toBeTruthy();
			expect(entry.facts).toMatchObject({
				files: expect.any(Number),
				added: expect.any(Number),
				removed: expect.any(Number),
			});
			expect(entry.facts!.tests).toBeDefined();
			expect(entry.facts!.bench).toMatchObject({ better: "lower", value: expect.any(Number) });
		}
		expect(challengers.every(entry => entry.instanceId && entry.model && entry.facts!.deltaFromOriginal)).toBe(true);
		expect(new Set(challengers.map(entry => entry.instanceId)).size).toBe(3);
		const failing = bakeoff.entries.filter(entry => entry.facts!.tests!.ok === false);
		expect(failing).toHaveLength(1);
		const result = bakeoff.result!;
		expect(result.agreement).toBe("agreed");
		const ineligible = result.ranking.filter(item => !item.eligible);
		expect(ineligible.map(item => item.label)).toEqual([failing[0]!.label]);
		expect(result.ranking.flatMap(item => item.flags)).toEqual(["test script changed"]);
		expect(bakeoff.entries.flatMap(entry => entry.flags)).toEqual(["test script changed"]);
		// Lines changed is measured from the facts, not scored.
		const measured = Object.values(result.scores).map(row => row["lines-changed"]!.measured);
		expect(measured.every(value => typeof value === "number")).toBe(true);
		expect(Math.max(...(measured as number[]))).toBe(1);
		mock.stop();
	});

	it("answers excerpts of cited code, null for refs it does not have, and refuses an unknown entry", async () => {
		const { mock, ask, get } = setup();
		const bakeoff = await get("bk-mock-split");
		const refs = [
			...bakeoff.entries[0]!.writeup!.refs,
			{ path: "crates/nothing/src/lib.rs", line: 3, token: "missing" },
			{ path: "crates/evm/src/provider_cache.rs", line: 9999, token: "far" },
			cite("crates/evm/src/helpers.rs", "pub async fn create_provider", "base"),
		];
		const { excerpts } = await ask(
			{ t: "bakeoff-excerpt", id: "bk-mock-split", entry: "A", refs },
			"bakeoff-excerpt",
		);
		expect(excerpts).toHaveLength(refs.length);
		const first = excerpts[0]!;
		expect(first.lines[first.line - first.start]).toContain(refs[0]!.token);
		expect(first).toMatchObject({ side: "head", language: "rust" });
		expect(excerpts[refs.length - 3]).toBeNull();
		expect(excerpts[refs.length - 2]).toBeNull();
		expect(excerpts[refs.length - 1]).toMatchObject({ side: "base" });
		await expect(ask({ t: "bakeoff-excerpt", id: "bk-mock-split", entry: "Z", refs })).rejects.toThrow(
			"no such entry",
		);
		await expect(ask({ t: "bakeoff-excerpt", id: "bk-nope", entry: "A", refs })).rejects.toThrow("no such bake-off");
		mock.stop();
	});

	it("checks a request like the engine does", async () => {
		const { mock, create } = setup();
		await expect(create({ models: ["anthropic/claude-haiku-5"] })).rejects.toThrow("Pick 2 to 4 models");
		await expect(create({ models: ["a/one", "a/two", "a/three", "a/four", "a/five"] })).rejects.toThrow(
			"Pick 2 to 4 models",
		);
		await expect(create({ models: ["a/one", "a/one"] })).rejects.toThrow("Pick different models");
		await expect(create({ metrics: [] })).rejects.toThrow("things that matter");
		await expect(create({ reviewer: undefined })).rejects.toThrow("invalid reviewer");
		await expect(create({ doc: undefined })).rejects.toThrow("Pick a change or a design document");
		await expect(create({ metrics: [{ id: "lines-changed", label: "Lines changed", weight: 1 }] })).rejects.toThrow(
			"only makes sense when comparing implementations",
		);
		mock.stop();
	});

	it("runs a design bake-off through its stages, one entry at a time, and ends with a verdict of its models and metrics", async () => {
		vi.useFakeTimers();
		const { mock, pushed, get, row, create } = setup();
		const { id } = await create({ instructions: "Keep it small.", reviewerPasses: 2 });
		const statuses = async () => (await get(id)).entries.map(entry => entry.status);
		expect(await row(id)).toMatchObject({
			status: "running",
			stage: "preparing",
			progress: "Waiting to start",
			instanceId: "inst-7",
			subject: "a design",
			mode: "design",
			maxCostUsd: 12,
		});
		expect((await get(id)).entries.map(entry => entry.label).sort()).toEqual(["A", "B", "C", "D"]);
		expect((await statuses()).every(status => status === "waiting")).toBe(true);
		const seen: string[] = [];
		for (let tick = 0; tick < 13; tick++) {
			vi.advanceTimersByTime(5);
			const now = await get(id);
			seen.push(`${now.stage}:${now.entries.map(entry => entry.status[0]).join("")}`);
			const live = now.entries.filter(entry => entry.status === "working" || entry.status === "writing-up");
			expect(live.length).toBeLessThanOrEqual(1);
		}
		expect(seen[0]).toMatch(/^entries:/);
		expect(seen.some(item => item.startsWith("review:"))).toBe(true);
		expect(seen.some(item => item.startsWith("judge:"))).toBe(true);
		expect(seen[seen.length - 1]!.startsWith("done:")).toBe(true);
		const done = await get(id);
		expect(await row(id)).toMatchObject({
			status: "ready",
			stage: "done",
			entryCount: 4,
			top: done.result!.ranking[0]!.label,
		});
		expect((await row(id)).progress).toBeUndefined();
		expect((await row(id)).instanceId).toBeUndefined();
		expect(pushed.filter(item => item === id).length).toBeGreaterThanOrEqual(13);
		expect(done.instructions).toBe("Keep it small.");
		expect(
			done.entries
				.map(entry => entry.model)
				.filter(Boolean)
				.sort(),
		).toEqual(["anthropic/claude-haiku-5", "google/gemini-flash", "openai/gpt-mini"]);
		expect(done.entries.every(entry => entry.status === "ready" && entry.writeup)).toBe(true);
		expect(done.entries.filter(entry => entry.kind === "challenger").every(entry => (entry.costUsd ?? 0) > 0)).toBe(
			true,
		);
		expect(done.metrics.map(metric => metric.id)).toEqual(["simplicity", "custom:1"]);
		const result = done.result!;
		expect(result).toMatchObject({
			agreement: "agreed",
			reviewerModel: "anthropic/claude-sonnet-5-5",
			judgeKind: "endpoint",
		});
		expect(result.passes).toHaveLength(2);
		expect(result.ranking.map(item => item.label).sort()).toEqual(["A", "B", "C", "D"]);
		for (const item of result.ranking) expect(item.reasons.length).toBeGreaterThan(0);
		for (const label of "ABCD") expect(Object.keys(result.scores[label]!).sort()).toEqual(["custom:1", "simplicity"]);
		expect(done.costs.review).toBeGreaterThan(0);
		for (const citation of citationsOf(result.verdict))
			expect(done.entries.find(entry => entry.label === citation.label)).toBeDefined();
		mock.stop();
	});

	it("draws labels from the labels a bake-off has and turns the original into a different letter each time", async () => {
		vi.useFakeTimers();
		const { mock, get, create } = setup();
		const originals = new Set<string>();
		for (let at = 0; at < 4; at++) {
			const { id } = await create({ models: ["a/one", "a/two"] });
			const entries = (await get(id)).entries;
			expect(entries.map(entry => entry.label)).toEqual(["A", "B", "C"]);
			originals.add(entries.find(entry => entry.kind === "original")!.label);
		}
		expect([...originals].every(label => BAKEOFF_LABELS.includes(label))).toBe(true);
		expect(originals.size).toBeGreaterThan(1);
		mock.stop();
	});

	it("gives a bake-off started without a usable judge no second opinion, and none when the person turned it off", async () => {
		vi.useFakeTimers();
		for (const [flag, note] of [
			["unreachable", "No second opinion: laya/mock-judge was unreachable (connection refused)"],
			["none", "No second opinion: no judge model is set up on this computer."],
			["fallback", "No second opinion: openai/gpt-mini was not set up as a judge, so it was not used."],
		] as const) {
			const { mock, get, row, create } = setup(flag);
			const { id } = await create();
			vi.advanceTimersByTime(100);
			const done = await get(id);
			expect(done.result).toMatchObject({ agreement: "reviewer-only", judgeNote: note });
			expect(done.result!.pairwise).toBeUndefined();
			expect((await row(id)).note).toBe(note);
			mock.stop();
		}
		const { mock, get, create } = setup();
		const off = await create({ judge: "off" });
		vi.advanceTimersByTime(100);
		expect((await get(off.id)).result).toMatchObject({
			agreement: "reviewer-only",
			judgeNote: expect.stringContaining("turned off"),
		});
		mock.stop();
	});

	it("uses an unassigned judge only when the request says so, and then only compares in pairs", async () => {
		vi.useFakeTimers();
		const { mock, get, create } = setup("fallback");
		const { id } = await create({ judgeAdvisory: true });
		vi.advanceTimersByTime(100);
		const result = (await get(id)).result!;
		expect(result.judgeLabel).toContain("advisory");
		expect(result.judgeKind).toBe("fallback");
		expect(result.pairwise!.length).toBeGreaterThan(0);
		expect(
			Object.values(result.scores).every(row => Object.values(row).every(score => score.judge === undefined)),
		).toBe(true);
		mock.stop();
	});

	it("runs an implementation bake-off through facts and write-ups, with worktrees for the challengers", async () => {
		vi.useFakeTimers();
		const { mock, get, row, create } = setup();
		const { id } = await create({
			mode: "implementation",
			doc: undefined,
			ref: "feature/x",
			metrics: [
				{ id: "lines-changed", label: "Lines changed", weight: 1 },
				{ id: "simplicity", label: "Simplicity", weight: 2 },
			],
			models: ["a/one", "a/two"],
			test: { target: "package:test" },
		});
		expect(await row(id)).toMatchObject({ subject: "feature/x vs main", mode: "implementation" });
		const stages = new Set<string>();
		for (let tick = 0; tick < 12; tick++) {
			vi.advanceTimersByTime(5);
			stages.add((await get(id)).stage);
		}
		expect([...stages]).toEqual(["entries", "facts", "writeups", "review", "judge", "done"]);
		const done = await get(id);
		expect(done.group).toBeTruthy();
		const challengers = done.entries.filter(entry => entry.kind === "challenger");
		expect(challengers.every(entry => entry.instanceId && entry.branch && entry.path && entry.facts)).toBe(true);
		expect(done.entries.every(entry => entry.writeup)).toBe(true);
		expect(Object.values(done.result!.scores).every(row => typeof row["lines-changed"]!.measured === "number")).toBe(
			true,
		);
		mock.stop();
	});

	it("leaves a failing entry out of the review, and fails the review once for the reviewer mock/fail", async () => {
		vi.useFakeTimers();
		const { mock, get, row, ask, create } = setup();
		const { id } = await create({ models: ["a/one", "mock-lab/fail"], reviewer: "mock/fail" });
		vi.advanceTimersByTime(100);
		const failed = await row(id);
		expect(failed).toMatchObject({ status: "failed", stage: "review", error: expect.stringContaining("ranking") });
		const entries = (await get(id)).entries;
		expect(entries.filter(entry => entry.status === "failed")).toHaveLength(1);
		expect(entries.find(entry => entry.status === "failed")).toMatchObject({
			model: "mock-lab/fail",
			error: expect.any(String),
			flags: ["no write-up"],
		});
		await ask({ t: "bakeoff-review", id }, "bakeoff-review");
		vi.advanceTimersByTime(100);
		const done = await get(id);
		expect(await row(id)).toMatchObject({ status: "ready", stage: "done" });
		expect(done.result!.ranking.map(item => item.label)).not.toContain(
			entries.find(entry => entry.status === "failed")!.label,
		);
		expect(done.result!.ranking).toHaveLength(2);
		mock.stop();
	});

	it("fails with fewer than two entries to compare", async () => {
		vi.useFakeTimers();
		const { mock, row, create } = setup();
		const { id } = await create({ models: ["x/fail", "y/fail"] });
		vi.advanceTimersByTime(100);
		expect(await row(id)).toMatchObject({ status: "failed", error: "Fewer than two entries are left to compare." });
		mock.stop();
	});

	it("reviews a failed bake-off again, turning it ready through the review and the judge", async () => {
		vi.useFakeTimers();
		const { mock, pushed, ask, get, row } = setup();
		await expect(ask({ t: "bakeoff-review", id: "bk-mock-split" })).rejects.toThrow(
			"Only a bake-off whose review failed",
		);
		const before = await get("bk-mock-failed");
		expect(before.result).toBeUndefined();
		expect(before.entries.every(entry => entry.status === "ready")).toBe(true);
		const count = pushed.filter(item => item === "bk-mock-failed").length;
		await ask({ t: "bakeoff-review", id: "bk-mock-failed" }, "bakeoff-review");
		expect(await row("bk-mock-failed")).toMatchObject({ status: "running", progress: "Waiting to start" });
		expect((await row("bk-mock-failed")).error).toBeUndefined();
		vi.advanceTimersByTime(5);
		expect(await row("bk-mock-failed")).toMatchObject({
			stage: "review",
			progress: "The reviewer is reading every entry",
		});
		vi.advanceTimersByTime(5);
		expect(await row("bk-mock-failed")).toMatchObject({ stage: "judge" });
		vi.advanceTimersByTime(5);
		expect(await row("bk-mock-failed")).toMatchObject({ status: "ready", stage: "done" });
		expect((await get("bk-mock-failed")).result!.ranking).toHaveLength(3);
		expect(pushed.filter(item => item === "bk-mock-failed").length - count).toBe(4);
		mock.stop();
	});

	it("ticks the canned running bake-off to ready", async () => {
		vi.useFakeTimers();
		const { mock, get, row } = setup();
		const before = await get("bk-mock-running");
		expect(before.entries.map(entry => entry.status)).toEqual(["ready", "ready", "writing-up", "working"]);
		expect(before.entries[2]!.writeup).toBeUndefined();
		vi.advanceTimersByTime(5);
		expect((await get("bk-mock-running")).entries.map(entry => entry.status)).toEqual([
			"ready",
			"ready",
			"ready",
			"working",
		]);
		vi.advanceTimersByTime(100);
		const done = await get("bk-mock-running");
		expect(done.entries.every(entry => entry.status === "ready")).toBe(true);
		expect(await row("bk-mock-running")).toMatchObject({ status: "ready", stage: "done" });
		expect(done.result).toBeDefined();
		mock.stop();
	});

	it("takes an entry of a design: marks it, shows it in the list, and refuses to remove worktrees there", async () => {
		const { mock, pushed, ask, get, row } = setup();
		await expect(ask({ t: "bakeoff-take", id: "bk-mock-running", entry: "A" })).rejects.toThrow("still running");
		await expect(ask({ t: "bakeoff-take", id: "bk-mock-failed", entry: "A" })).rejects.toThrow("has no result");
		await expect(ask({ t: "bakeoff-take", id: "bk-mock-split", entry: "Z" })).rejects.toThrow(
			"no such entry to take",
		);
		await expect(ask({ t: "bakeoff-take", id: "bk-mock-split", entry: "A", removeOthers: true })).rejects.toThrow(
			"nothing to remove",
		);
		const count = pushed.length;
		const taken = await ask({ t: "bakeoff-take", id: "bk-mock-split", entry: "C" }, "bakeoff-take");
		expect(taken.result).toBeUndefined();
		expect((await get("bk-mock-split")).result!.taken).toBe("C");
		expect(await row("bk-mock-split")).toMatchObject({ taken: "C" });
		expect(pushed.slice(count)).toEqual(["bk-mock-split"]);
		mock.stop();
	});

	it("takes a challenger of an implementation and reports what the keep did to the other worktrees", async () => {
		const { mock, ask, get } = setup();
		const bakeoff = await get("bk-mock-impl");
		const keep = bakeoff.entries.find(
			entry => entry.kind === "challenger" && entry.facts!.tests!.ok === true && !entry.flags.length,
		)!;
		await expect(
			ask({ t: "bakeoff-take", id: "bk-mock-impl", entry: keep.label, discardDirty: true }),
		).rejects.toThrow("invalid request");
		const alone = await ask({ t: "bakeoff-take", id: "bk-mock-impl", entry: keep.label }, "bakeoff-take");
		expect(alone.result).toEqual({ removed: [], skipped: [] });
		const kept = await ask(
			{ t: "bakeoff-take", id: "bk-mock-impl", entry: keep.label, removeOthers: true },
			"bakeoff-take",
		);
		const others = bakeoff.entries.filter(entry => entry.kind === "challenger" && entry !== keep);
		expect(kept.result!.skipped).toEqual([{ model: expect.any(String), reason: "it has uncommitted changes" }]);
		expect(kept.result!.removed.length + kept.result!.skipped.length).toBe(others.length);
		const forced = await ask(
			{ t: "bakeoff-take", id: "bk-mock-impl", entry: keep.label, removeOthers: true, discardDirty: true },
			"bakeoff-take",
		);
		expect(forced.result!.skipped).toEqual([]);
		expect(forced.result!.removed).toHaveLength(others.length);
		// The original is a branch, not a worktree: taking it answers nothing.
		const original = bakeoff.entries.find(entry => entry.kind === "original")!;
		expect(
			(await ask({ t: "bakeoff-take", id: "bk-mock-impl", entry: original.label }, "bakeoff-take")).result,
		).toBeUndefined();
		expect((await get("bk-mock-impl")).result!.taken).toBe(original.label);
		mock.stop();
	});

	it("stops the whole run, leaving what was made, and one entry of a run that goes on", async () => {
		vi.useFakeTimers();
		const { mock, pushed, ask, get, row, create } = setup();
		await expect(ask({ t: "bakeoff-stop", id: "bk-mock-split" })).rejects.toThrow("not running");
		const one = await create();
		vi.advanceTimersByTime(10);
		const label = (await get(one.id)).entries.find(entry => entry.kind === "challenger")!.label;
		await ask({ t: "bakeoff-stop", id: one.id, entry: label }, "bakeoff-stop");
		expect((await get(one.id)).entries.find(entry => entry.label === label)!.status).toBe("stopped");
		await expect(ask({ t: "bakeoff-stop", id: one.id, entry: "Z" })).rejects.toThrow("no such entry to stop");
		vi.advanceTimersByTime(200);
		const finished = await get(one.id);
		expect(finished.stage).toBe("done");
		expect(finished.entries.find(entry => entry.label === label)!.status).toBe("stopped");
		expect(finished.result!.ranking.map(item => item.label)).not.toContain(label);
		const whole = await create();
		vi.advanceTimersByTime(12);
		const count = pushed.length;
		await ask({ t: "bakeoff-stop", id: whole.id }, "bakeoff-stop");
		expect(await row(whole.id)).toMatchObject({ status: "failed", error: "Stopped." });
		const statuses = (await get(whole.id)).entries.map(entry => entry.status);
		expect(statuses).toContain("stopped");
		expect(statuses).toContain("ready");
		expect(statuses.some(status => status === "working" || status === "writing-up" || status === "waiting")).toBe(
			false,
		);
		expect(pushed.length).toBeGreaterThan(count);
		const after = pushed.length;
		vi.advanceTimersByTime(100);
		expect(pushed.length).toBe(after);
		mock.stop();
	});

	it("deletes a bake-off, running ones included, and stop clears every timer", async () => {
		vi.useFakeTimers();
		const { mock, pushed, ask, create } = setup();
		await ask({ t: "bakeoff-delete", id: "bk-mock-split" }, "bakeoff-delete");
		await expect(ask({ t: "bakeoff-get", id: "bk-mock-split" })).rejects.toThrow("no such bake-off");
		expect(pushed.at(-1)).toBe("bk-mock-split");
		const { id } = await create();
		await ask({ t: "bakeoff-delete", id }, "bakeoff-delete");
		vi.advanceTimersByTime(100);
		expect(pushed.filter(item => item === id)).toHaveLength(2);
		expect((await ask({ t: "bakeoff-list" }, "bakeoff-list")).bakeoffs.some(item => item.id === id)).toBe(false);
		mock.stop();
		const quiet = pushed.length;
		vi.advanceTimersByTime(100);
		expect(pushed.length).toBe(quiet);
	});

	it("marks which entries of an implementation can still be exported, and gives a patch for those that can", async () => {
		const { mock, ask, get } = setup();
		const kept = await get("bk-mock-impl");
		expect(kept.entries.map(entry => entry.patch)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
		const patch = (await ask({ t: "bakeoff-patch", id: "bk-mock-impl", entry: "A" }, "bakeoff-patch")).patch;
		expect(patch).toContain("diff --git a/crates/evm/src/provider_cache.rs b/crates/evm/src/provider_cache.rs");
		const original = (await ask({ t: "bakeoff-patch", id: "bk-mock-impl", entry: "C" }, "bakeoff-patch")).patch;
		expect(original).toContain("GIT binary patch");

		const pruned = await get("bk-mock-impl-pruned");
		expect(pruned.entries.map(entry => [entry.label, entry.patch?.ok])).toEqual([
			["A", false],
			["B", false],
			["C", true],
			["D", true],
		]);
		await expect(ask({ t: "bakeoff-patch", id: "bk-mock-impl-pruned", entry: "A" })).rejects.toThrow(
			"no longer kept",
		);
		await expect(ask({ t: "bakeoff-patch", id: "bk-mock-impl-pruned", entry: "D" })).rejects.toThrow(
			"larger than 5 MB",
		);
		await expect(ask({ t: "bakeoff-patch", id: "bk-mock-impl", entry: "Z" })).rejects.toThrow("no such entry");
		await expect(ask({ t: "bakeoff-patch", id: "bk-mock-split", entry: "A" })).rejects.toThrow(
			"Only an implementation has code to export.",
		);
		expect((await get("bk-mock-split")).entries.every(entry => entry.patch === undefined)).toBe(true);
		mock.stop();
	});

	it("lists a scratch folder's bake-offs under it alone, says it is no git repository, and refuses an implementation there", async () => {
		const { mock, ask, get, create } = setup();
		const scratch = "/work/config/scratch/2026-10-14-fhe-statistics-ab12cd";
		const here = (await ask({ t: "bakeoff-list", cwd: scratch }, "bakeoff-list")).bakeoffs;
		expect(here.map(item => item.id)).toEqual(["bk-mock-folder"]);
		expect(here[0]!.repoRoot).toBe(scratch);
		expect(await get("bk-mock-folder")).toMatchObject({ folder: true, mode: "design" });
		expect((await ask({ t: "bakeoff-folder", cwd: scratch }, "bakeoff-folder")).folder).toMatchObject({
			git: false,
			files: 2,
		});
		expect((await ask({ t: "bakeoff-folder", cwd: MOCK_QUIZ_ROOT }, "bakeoff-folder")).folder.git).toBe(true);
		await expect(create({ cwd: scratch, mode: "implementation" })).rejects.toThrow("not a git repository");
		const started = await create({ cwd: scratch, doc: { path: "notes/design.md" } });
		const made = await get(started.id);
		expect(made).toMatchObject({ folder: true, mode: "design" });
		expect((await ask({ t: "bakeoff-list", cwd: scratch }, "bakeoff-list")).bakeoffs).toHaveLength(2);
		expect(
			(await ask({ t: "bakeoff-list", cwd: MOCK_QUIZ_ROOT }, "bakeoff-list")).bakeoffs.some(
				item => item.id === started.id,
			),
		).toBe(false);
		mock.stop();
	});

	it("refuses other requests", async () => {
		const { mock, ask } = setup();
		await expect(ask({ t: "quiz-list" })).rejects.toThrow("does not answer");
		mock.stop();
	});
});
