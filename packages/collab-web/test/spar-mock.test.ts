import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Spar, SparRun } from "@oh-my-pi/pi-wire/spar";
import { SPAR_DESIGN_PATH, SPAR_MAX_REPLY_CHARS, scoreSpar } from "@oh-my-pi/pi-wire/spar";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { MOCK_QUIZ_ROOT } from "../scripts/mock-quiz";
import { createMockSpar } from "../scripts/mock-spar";

function setup() {
	const pushed: string[] = [];
	const mock = createMockSpar({ instanceId: "inst-7", stageMs: 5, replyMs: 0, onChanged: id => pushed.push(id) });
	let reqId = 0;
	const ask = <T extends CompanionReply["t"]>(request: Record<string, unknown> & { t: string }, _expect?: T) =>
		mock.answer({ ...request, reqId: ++reqId } as unknown as CompanionRequest) as Promise<
			Extract<CompanionReply, { t: T }>
		>;
	const get = async (id: string): Promise<{ spar: Spar; runs: SparRun[] }> => {
		const { spar, runs } = await ask({ t: "spar-get", id }, "spar-get");
		return { spar, runs };
	};
	const reply = (id: string, point: string, text: string, run = "r1") =>
		ask({ t: "spar-reply", id, run, point, text }, "spar-reply");
	const row = async (id: string) => (await ask({ t: "spar-list" }, "spar-list")).spars.find(item => item.id === id)!;
	return { mock, pushed, ask, get, reply, row };
}

describe("the mock spar companion", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("advertises sparring and answers only spar requests", () => {
		const { mock } = setup();
		expect(mock.capabilities).toEqual({ canSpar: true });
		expect(mock.handles({ t: "spar-list", reqId: 1 })).toBe(true);
		expect(mock.handles({ t: "quiz-list", reqId: 1 })).toBe(false);
		mock.stop();
	});

	it("lists a finished spar, a design spar, a failed one and a running one, in the folder's repository", async () => {
		const { mock, ask } = setup();
		const all = (await ask({ t: "spar-list" }, "spar-list")).spars;
		const byId = new Map(all.map(row => [row.id, row]));
		expect(byId.get("sp-mock-finished")).toMatchObject({
			status: "ready",
			partCount: 2,
			pointCount: 5,
			runCount: 1,
			subject: "PRs #2244–#2245",
		});
		expect(byId.get("sp-mock-finished")?.latest).toMatchObject({
			held: 1,
			asked: 5,
			percentHeld: 30,
			finished: true,
		});
		expect(byId.get("sp-mock-doc")).toMatchObject({ status: "ready", subject: "a design document", pointCount: 4 });
		expect(byId.get("sp-mock-doc")?.latest).toMatchObject({ held: 0, asked: 4, percentHeld: 0, finished: false });
		expect(byId.get("sp-mock-failed")?.status).toBe("failed");
		expect(byId.get("sp-mock-failed")?.error).toBeTruthy();
		expect(byId.get("sp-mock-running")).toMatchObject({ status: "running", instanceId: "inst-7" });
		expect(byId.get("sp-mock-running")?.progress).toBeTruthy();
		const here = (await ask({ t: "spar-list", cwd: "/work/api-pagination" }, "spar-list")).spars;
		expect(here.every(row => row.repoRoot === MOCK_QUIZ_ROOT)).toBe(true);
		mock.stop();
	});

	it("shows every way a point ends in the finished spar, with a result that matches the records", async () => {
		const { mock, get } = setup();
		const { spar, runs } = await get("sp-mock-finished");
		expect(spar.parts.map(part => part.pr?.number)).toEqual([2244, 2245]);
		expect(spar.points.map(point => point.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
		const run = runs[0]!;
		expect(run.finishedAt).toBeDefined();
		const outcomes = Object.fromEntries(Object.entries(run.records).map(([id, record]) => [id, record.outcome]));
		expect(outcomes).toEqual({
			p1: { kind: "held", by: "partner" },
			p2: { kind: "partly", by: "partner" },
			p3: { kind: "lost", by: "you" },
			p4: { kind: "open", by: "limit" },
			p5: { kind: "open", by: "you", note: expect.stringContaining("upgrade") },
		});
		expect(run.records.p1!.turns.map(turn => turn.move)).toEqual([undefined, "push", undefined, "concede"]);
		expect(run.records.p4!.turns.filter(turn => turn.move === "push")).toHaveLength(3);
		expect(run.result).toEqual(scoreSpar(run));
		expect(run.result).toMatchObject({
			held: ["p1"],
			open: ["p2", "p4", "p5"],
			suggested: ["p2", "p3"],
			percentHeld: 30,
		});
		for (const record of Object.values(run.records)) expect(record.reveal?.strongestDefence).toBeTruthy();
		expect(run.records.p2!.reveal?.suggestion).toBeTruthy();
		expect(run.records.p3!.reveal?.suggestion).toBeTruthy();
		expect(run.records.p1!.reveal?.suggestion).toBeUndefined();
		expect(spar.points.some(point => point.refs.some(ref => ref.side === "base"))).toBe(true);
		mock.stop();
	});

	it("keeps the case files out of spar-get and shows nothing of a point before it closes", async () => {
		const { mock, ask, reply } = setup();
		const raw = JSON.stringify(await ask({ t: "spar-get", id: "sp-mock-doc" }, "spar-get"));
		expect(raw).not.toContain("strongestDefence");
		expect(raw).not.toContain("suggestion");
		const pushed = await reply("sp-mock-doc", "p1", "It is simpler.");
		expect(pushed.record.reveal).toBeUndefined();
		expect(JSON.stringify(pushed)).not.toContain("strongestDefence");
		mock.stop();
	});

	it("has a design spar of parts with no base, citing @design, every point new", async () => {
		const { mock, get } = setup();
		const { spar, runs } = await get("sp-mock-doc");
		expect(spar.doc).toMatchObject({ name: "provider-cache-design.md" });
		expect(spar.parts.every(part => part.base === undefined)).toBe(true);
		expect(spar.points.every(point => point.refs.some(ref => ref.path === SPAR_DESIGN_PATH))).toBe(true);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.records).toEqual({});
		expect(runs[0]!.finishedAt).toBeUndefined();
		expect(runs[0]!.result).toEqual(scoreSpar(runs[0]!));
		mock.stop();
	});

	it("pushes back twice, concedes to 'because', and counts the held point", async () => {
		const { mock, pushed, reply, get } = setup();
		const first = await reply("sp-mock-doc", "p1", "It is just simpler.");
		expect(first.turn).toMatchObject({ by: "partner", move: "push" });
		expect(first.record.outcome).toBeUndefined();
		expect(first.record.turns.map(turn => turn.by)).toEqual(["you", "partner"]);
		const second = await reply("sp-mock-doc", "p1", "Because readers join long after startup.");
		expect(second.turn.move).toBe("concede");
		expect(second.record.outcome).toEqual({ kind: "held", by: "partner" });
		expect(second.record.reveal?.strongestDefence).toBeTruthy();
		expect(second.run.result).toMatchObject({ held: ["p1"], percentHeld: 25 });
		expect(pushed.filter(id => id === "sp-mock-doc")).toHaveLength(2);
		const { runs } = await get("sp-mock-doc");
		expect(runs[0]!.records.p1).toEqual(second.record);
		mock.stop();
	});

	it("closes a point as open at the third push, and refuses a fourth defence", async () => {
		const { mock, reply, ask } = setup();
		await reply("sp-mock-doc", "p2", "It never fails.");
		const second = await reply("sp-mock-doc", "p2", "It still never fails.");
		expect(second.record.outcome).toBeUndefined();
		const third = await reply("sp-mock-doc", "p2", "Trust me.");
		expect(third.turn.move).toBe("push");
		expect(third.record.outcome).toEqual({ kind: "open", by: "limit" });
		expect(third.record.reveal?.strongestDefence).toBeTruthy();
		expect(third.run.result.open).toEqual(["p2"]);
		await expect(reply("sp-mock-doc", "p2", "One more?")).rejects.toThrow("already closed");
		await expect(ask({ t: "spar-close", id: "sp-mock-doc", run: "r1", point: "p2", as: "lost" })).rejects.toThrow(
			"already closed",
		);
		mock.stop();
	});

	it("answers 'partly' with a partly move that closes the point and suggests a change", async () => {
		const { mock, reply } = setup();
		const answer = await reply("sp-mock-doc", "p3", "That is partly true, we restart rarely.");
		expect(answer.turn.move).toBe("partly");
		expect(answer.record.outcome).toEqual({ kind: "partly", by: "partner" });
		expect(answer.record.reveal?.suggestion).toBeTruthy();
		expect(answer.run.result).toMatchObject({ open: ["p3"], suggested: ["p3"], percentHeld: 13 });
		mock.stop();
	});

	it("refuses empty, long, unknown and limit-hitting defences, and fails '/fail' once without using the round", async () => {
		const { mock, reply, get } = setup();
		await expect(reply("sp-mock-doc", "p1", "   ")).rejects.toThrow("defence");
		await expect(reply("sp-mock-doc", "p1", "x".repeat(SPAR_MAX_REPLY_CHARS + 1))).rejects.toThrow("longer");
		await expect(reply("sp-mock-doc", "p9", "hello")).rejects.toThrow("does not ask p9");
		await expect(reply("sp-mock-doc", "p1", "hello", "r9")).rejects.toThrow("no run r9");
		await expect(reply("sp-nope", "p1", "hello")).rejects.toThrow("no spar sp-nope");
		await expect(reply("sp-mock-failed", "p1", "hello")).rejects.toThrow("not ready");
		await expect(reply("sp-mock-doc", "p1", "/limit")).rejects.toThrow("spending limit");
		await expect(reply("sp-mock-doc", "p1", "/fail")).rejects.toThrow("round was not used");
		expect((await get("sp-mock-doc")).runs[0]!.records).toEqual({});
		const answer = await reply("sp-mock-doc", "p1", "/fail");
		expect(answer.turn.move).toBe("push");
		mock.stop();
	});

	it("closes a point as lost or as open with a note, with no model, and finishes the run when the last closes", async () => {
		const { mock, ask, reply } = setup();
		await expect(ask({ t: "spar-close", id: "sp-mock-doc", run: "r1", point: "p1", as: "held" })).rejects.toThrow(
			"lost or open",
		);
		const lost = await ask({ t: "spar-close", id: "sp-mock-doc", run: "r1", point: "p1", as: "lost" }, "spar-close");
		expect(lost.record.outcome).toEqual({ kind: "lost", by: "you" });
		expect(lost.record.reveal?.suggestion).toBeTruthy();
		const skipped = await ask(
			{ t: "spar-close", id: "sp-mock-doc", run: "r1", point: "p2", as: "open", note: "  Not now.  " },
			"spar-close",
		);
		expect(skipped.record.outcome).toEqual({ kind: "open", by: "you", note: "Not now." });
		expect(skipped.record.reveal?.suggestion).toBeUndefined();
		expect(skipped.run.finishedAt).toBeUndefined();
		await reply("sp-mock-doc", "p3", "Because restarts are rare.");
		const last = await ask({ t: "spar-close", id: "sp-mock-doc", run: "r1", point: "p4", as: "open" }, "spar-close");
		expect(last.run.finishedAt).toBeDefined();
		expect(last.run.result).toEqual(scoreSpar(last.run));
		expect(last.run.result).toMatchObject({ held: ["p3"], open: ["p2", "p4"], suggested: ["p1"], percentHeld: 25 });
		const row = (await ask({ t: "spar-list" }, "spar-list")).spars.find(item => item.id === "sp-mock-doc");
		expect(row?.latest?.finished).toBe(true);
		mock.stop();
	});

	it("spars again on the points not held, or on all of them, as a new run of the same spar", async () => {
		const { mock, ask, pushed } = setup();
		const unsettled = (await ask({ t: "spar-again", id: "sp-mock-finished" }, "spar-again")).run;
		expect(unsettled).toMatchObject({ id: "r2", retryOf: "r1", points: ["p2", "p3", "p4", "p5"], records: {} });
		expect(unsettled.finishedAt).toBeUndefined();
		expect(unsettled.result).toEqual({ held: [], open: [], suggested: [], percentHeld: 0 });
		const all = (await ask({ t: "spar-again", id: "sp-mock-finished", from: "r1", only: "all" }, "spar-again")).run;
		expect(all).toMatchObject({ id: "r3", retryOf: "r1", points: ["p1", "p2", "p3", "p4", "p5"] });
		expect(pushed.filter(id => id === "sp-mock-finished")).toHaveLength(2);
		const { spars } = await ask({ t: "spar-list" }, "spar-list");
		expect(spars.find(row => row.id === "sp-mock-finished")).toMatchObject({ runCount: 3 });
		expect(spars.find(row => row.id === "sp-mock-finished")?.latest?.asked).toBe(5);
		await expect(ask({ t: "spar-again", id: "sp-mock-finished", from: "r7" })).rejects.toThrow("no run r7");
		mock.stop();
	});

	it("refuses to spar again when every point of the run was held", async () => {
		const { mock, ask, reply } = setup();
		for (const point of ["p1", "p2", "p3", "p4"]) await reply("sp-mock-doc", point, "Because it holds.");
		await expect(ask({ t: "spar-again", id: "sp-mock-doc" })).rejects.toThrow("held");
		mock.stop();
	});

	it("reads the lines of the design for @design citations, and the repository for the others", async () => {
		const { mock, ask, get } = setup();
		const { spar } = await get("sp-mock-doc");
		const designRef = spar.points[1]!.refs.find(ref => ref.path === SPAR_DESIGN_PATH)!;
		const code = spar.points[0]!.refs.find(ref => ref.path !== SPAR_DESIGN_PATH)!;
		const { excerpts } = await ask(
			{
				t: "spar-excerpt",
				id: "sp-mock-doc",
				part: 0,
				refs: [designRef, code, { path: SPAR_DESIGN_PATH, line: 999, token: "x" }],
			},
			"spar-excerpt",
		);
		expect(excerpts).toHaveLength(3);
		expect(excerpts[0]).toMatchObject({ path: SPAR_DESIGN_PATH, line: designRef.line, side: "head" });
		expect(excerpts[0]!.lines[designRef.line - excerpts[0]!.start]).toContain(designRef.token);
		expect(excerpts[1]).toMatchObject({ path: code.path, line: code.line });
		expect(excerpts[1]!.lines.join("\n")).toContain("attach");
		expect(excerpts[2]).toBeNull();
		await expect(ask({ t: "spar-excerpt", id: "sp-mock-doc", part: 3, refs: [] })).rejects.toThrow("no part 3");
		mock.stop();
	});

	it("reads every citation of every point of the finished spar, base citations as the code before", async () => {
		const { mock, ask, get } = setup();
		const { spar } = await get("sp-mock-finished");
		for (const point of spar.points) {
			const { excerpts } = await ask(
				{ t: "spar-excerpt", id: spar.id, part: point.part, refs: point.refs },
				"spar-excerpt",
			);
			point.refs.forEach((ref, at) => {
				const excerpt = excerpts[at];
				expect(excerpt).not.toBeNull();
				expect(excerpt!.side).toBe(ref.side ?? "head");
				expect(excerpt!.lines[ref.line - excerpt!.start]).toContain(ref.token);
			});
		}
		mock.stop();
	});

	it("writes a spar that turns ready after its stages with three points, and pushes each step", async () => {
		vi.useFakeTimers();
		const { mock, pushed, ask, get, row } = setup();
		const { id } = await ask(
			{ t: "spar-create", cwd: MOCK_QUIZ_ROOT, stack: [2244, 2245], maxCostUsd: 2 },
			"spar-create",
		);
		expect(await row(id)).toMatchObject({
			status: "running",
			subject: "PRs #2244–#2245",
			maxCostUsd: 2,
			instanceId: "inst-7",
			progress: "Reading the changes",
		});
		await expect(ask({ t: "spar-get", id })).rejects.toThrow("not ready");
		vi.advanceTimersByTime(5);
		expect((await row(id)).progress).toBe("Writing the points");
		vi.advanceTimersByTime(10);
		const done = await row(id);
		expect(done).toMatchObject({ status: "ready", pointCount: 3, partCount: 2, runCount: 1 });
		expect(done.progress).toBeUndefined();
		expect(done.instanceId).toBeUndefined();
		expect(pushed.filter(item => item === id)).toHaveLength(4);
		const { spar, runs } = await get(id);
		expect(spar.points).toHaveLength(3);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.records).toEqual({});
		expect(spar.points.every(point => point.part < spar.parts.length)).toBe(true);
		mock.stop();
	});

	it("makes a spar of a design document alone, refuses an empty request, and fails the model mock/fail", async () => {
		vi.useFakeTimers();
		const { mock, ask, get, row } = setup();
		await expect(ask({ t: "spar-create", cwd: MOCK_QUIZ_ROOT })).rejects.toThrow("Choose what to challenge");
		const doc = await ask(
			{ t: "spar-create", cwd: MOCK_QUIZ_ROOT, doc: { text: "# Plan", name: "plan.md" } },
			"spar-create",
		);
		const failing = await ask(
			{ t: "spar-create", cwd: MOCK_QUIZ_ROOT, ref: "feature/x", model: "mock/fail" },
			"spar-create",
		);
		vi.advanceTimersByTime(15);
		expect(await row(doc.id)).toMatchObject({ status: "ready", subject: "a design document" });
		const { spar } = await get(doc.id);
		expect(spar.doc?.name).toBe("plan.md");
		expect(spar.points).toHaveLength(4);
		expect(await row(failing.id)).toMatchObject({ status: "failed", subject: "feature/x vs main" });
		expect((await row(failing.id)).error).toBeTruthy();
		mock.stop();
	});

	it("turns the canned running spar ready after a few ticks", async () => {
		vi.useFakeTimers();
		const { mock, row } = setup();
		expect(await row("sp-mock-running")).toMatchObject({ status: "running", progress: "Reading the changes" });
		vi.advanceTimersByTime(10);
		expect((await row("sp-mock-running")).progress).toBe("Writing the points (2 of 6)");
		vi.advanceTimersByTime(10);
		expect(await row("sp-mock-running")).toMatchObject({ status: "running" });
		vi.advanceTimersByTime(5);
		expect(await row("sp-mock-running")).toMatchObject({ status: "ready", pointCount: 3, runCount: 1 });
		mock.stop();
	});

	it("deletes spars, and stop clears every timer", async () => {
		vi.useFakeTimers();
		const { mock, pushed, ask, row } = setup();
		await ask({ t: "spar-delete", id: "sp-mock-finished" }, "spar-delete");
		expect(pushed).toContain("sp-mock-finished");
		const ids = (await ask({ t: "spar-list" }, "spar-list")).spars.map(item => item.id);
		expect(ids).not.toContain("sp-mock-finished");
		await expect(ask({ t: "spar-get", id: "sp-mock-finished" })).rejects.toThrow("no spar");
		mock.stop();
		const seen = pushed.length;
		vi.advanceTimersByTime(100);
		expect(pushed).toHaveLength(seen);
		expect((await row("sp-mock-running")).status).toBe("running");
	});
});
