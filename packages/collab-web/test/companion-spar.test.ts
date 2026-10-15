import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SparMove } from "@oh-my-pi/pi-wire/spar";
import type { AgentLaunch } from "../scripts/companion-agent";
import type { RunOmp } from "../scripts/companion-headless";
import { createSpars, type Spars } from "../scripts/companion-spar";

let tmp: string;
let repo: string;
let designRepo: string;
const sessionsDir = (): string => path.join(tmp, "sessions");

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
}

const STORE_BEFORE =
	"export class Store {\n\tprivate items = new Map<string, string>();\n\n\tget(key: string): string | undefined {\n\t\treturn this.items.get(key);\n\t}\n}\n";
const STORE_AFTER =
	"export class Store<S extends Access> {\n\tprivate items = new Map<string, string>();\n\n\tget(key: string): string | undefined {\n\t\treturn this.items.get(key);\n\t}\n}\n\nexport class Writable extends Store<ReadWrite> {\n\tput(key: string, value: string): void {\n\t\tthis.items.set(key, value);\n\t}\n}\n";
const RUNTIME =
	'import { Writable } from "./store";\n\nexport function startRuntime(): Writable {\n\treturn new Writable();\n}\n';
const DESIGN =
	"# Session cache\n\nWe keep sessions in Redis.\nThe time to live is five minutes.\nWriters invalidate on every save.\n";

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spar-run-")));
	await fs.mkdir(sessionsDir(), { recursive: true });
	repo = path.join(tmp, "demo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_BEFORE);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "checkout", "-q", "-b", "feature/typestate");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_AFTER);
	await fs.writeFile(path.join(repo, "src/runtime.ts"), RUNTIME);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "Make store access a type");

	designRepo = path.join(tmp, "design");
	await fs.mkdir(path.join(designRepo, "docs"), { recursive: true });
	await git(designRepo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(designRepo, "docs/cache.md"), DESIGN);
	await fs.writeFile(path.join(designRepo, "app.ts"), "export const TTL = 300;\n");
	await git(designRepo, "add", "-A");
	await git(designRepo, "commit", "-q", "-m", "init");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const CASE = {
	strongestDefence: "The permission is a type parameter, so a read-only holder cannot call put at compile time.",
	concedeWhen: ["The defence says the check is made by the compiler, not at runtime."],
	counters: [
		{
			ifDefence: "It is only a convention",
			counter: "Nothing stops a caller from casting.",
			refs: ["src/runtime.ts@1@Writable", "src/runtime.ts@1@Nonexistent"],
		},
	],
	suggestion: "Seal the constructor so only the runtime can make a Writable.",
	suggestionRefs: ["src/runtime.ts@4@new Writable"],
};

const SPAR_FILE = {
	parts: [
		{
			part: 1,
			points: [
				{
					kind: "alternative",
					title: "Why a type parameter and not a flag?",
					challenge: "A runtime flag would be simpler.\n\nWhat does the parameter buy that a flag does not?",
					severity: 3,
					refs: ["src/store.ts@1@Store<S"],
					case: CASE,
				},
				{
					kind: "failure",
					title: "A second writer",
					challenge: "Two Writables share one map.\n\nWhat keeps them from racing?",
					severity: 2,
					refs: ["src/runtime.ts@3@startRuntime"],
					case: { ...CASE, suggestion: undefined, suggestionRefs: [] },
				},
				{
					kind: "cost",
					title: "A lock that is not there",
					challenge: "Why is there a mutex?\n\nIt is invented.",
					severity: 1,
					refs: ["src/store.ts@3@Mutex"],
					case: CASE,
				},
				{
					kind: "assumption",
					title: "No case file",
					challenge: "Anything.\n\nAt all.",
					refs: ["src/store.ts@1@Store<S"],
				},
			],
		},
	],
};

const DESIGN_FILE = {
	parts: [
		{
			part: 1,
			points: [
				{
					kind: "failure",
					title: "Five minutes of stale data",
					challenge:
						"The time to live is five minutes.\n\nWhat happens to a reader who gets a value just before a write?",
					severity: 2,
					refs: ["@design@4@time to live", "app.ts@1@TTL"],
					case: { ...CASE, counters: [], suggestionRefs: ["@design@5@invalidate"] },
				},
				{
					kind: "alternative",
					title: "Cited in the wrong place",
					challenge: "Why Redis?\n\nNo reason is given.",
					refs: ["@design@3@Redis"],
					case: CASE,
				},
			],
		},
	],
};

interface Replies {
	move: SparMove;
	cost: number;
	fails?: boolean;
	message?: string;
}

interface Harness {
	spars: Spars;
	changes: string[];
	launches: AgentLaunch[];
	calls: { argv: string[]; stdin: string }[];
	reply: Replies;
}

function harness(name: string, options: { file?: unknown; replyModel?: string } = {}): Harness {
	const changes: string[] = [];
	const launches: AgentLaunch[] = [];
	const calls: Harness["calls"] = [];
	const reply: Replies = { move: "push", cost: 0.01 };
	const run: RunOmp = async (argv, stdin) => {
		calls.push({ argv, stdin });
		if (reply.fails) return { code: 1, out: "", err: "400 stub says no\n" };
		const text = JSON.stringify({
			move: reply.move,
			message: reply.message ?? `Move: ${reply.move}. Look at \`src/runtime.ts:1\`.`,
			refs: ["src/runtime.ts@1@Writable", "src/runtime.ts@1@nothing_like_this"],
			checked: [{ claim: "put only exists on Writable", holds: true }],
		});
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				model: "stub-model",
				content: [{ type: "text", text }],
				usage: { cost: { total: reply.cost } },
			},
		};
		return { code: 0, out: `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify(event)}\n`, err: "" };
	};
	const spars = createSpars({
		storeDir: path.join(tmp, name, "agent", "spars"),
		cacheDir: path.join(tmp, name, "cache", "spars"),
		sessionsDir: sessionsDir(),
		now: () => Date.now(),
		changed: id => changes.push(id),
		agent: {
			start: async launch => {
				launches.push(launch);
				const file = options.file ?? SPAR_FILE;
				await fs.writeFile(launch.outFile, typeof file === "string" ? file : JSON.stringify(file));
				return "agent-1";
			},
			hosts: async () => [{ instanceId: "agent-1", sessionId: "s-1", model: "stub/stub-model", busy: false }],
			stop: async () => undefined,
			cost: async () => 0.4,
		},
		ompBin: "omp",
		replyModel: options.replyModel,
		run,
		watch: { pollMs: 10, settleMs: 30 },
	});
	return { spars, changes, launches, calls, reply };
}

async function ready(h: Harness, request: Parameters<Spars["create"]>[0]): Promise<string> {
	const { id } = await h.spars.create(request);
	await h.spars.idle();
	return id;
}

const CHANGE = { cwd: "", ref: "feature/typestate", base: "main" };

describe("a spar run", () => {
	it("writes points from the diff, verifies their citations, and keeps the case file to itself", async () => {
		const h = harness("run1");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		const [summary] = await h.spars.list(repo);
		expect(summary).toMatchObject({
			id,
			status: "ready",
			pointCount: 2,
			partCount: 1,
			runCount: 1,
			costUsd: 0.4,
			maxCostUsd: 6,
		});
		expect(summary!.subject).toBe("feature/typestate vs main");
		expect(h.changes).toContain(id);

		const launch = h.launches[0]!;
		expect(launch.prompt).toContain("### src/runtime.ts (added)");
		expect(launch.prompt).toContain("export class Writable extends Store<ReadWrite>");
		// Generation takes its share of the limit; replies get the rest.
		expect(launch.maxCostUsd).toBeCloseTo(2.4, 6);
		expect(launch.tools).toEqual(expect.arrayContaining(["ast_grep", "trace", "flow"]));

		const { spar, runs } = await h.spars.get(id);
		expect(spar.points.map(point => [point.id, point.kind, point.severity])).toEqual([
			["p1", "alternative", 3],
			["p2", "failure", 2],
		]);
		// The point citing a lock that does not exist is dropped, and so is the one with no case file.
		expect(spar.warnings.join(" ")).toContain("Dropped the point");
		expect(spar.warnings.join(" ")).toContain("no case file");
		expect(spar.points[0]!.refs).toEqual([{ path: "src/store.ts", line: 1, token: "Store<S" }]);
		const wire = JSON.stringify({ spar, runs });
		expect(wire).not.toContain("strongestDefence");
		expect(wire).not.toContain("concedeWhen");
		expect(wire).not.toContain("Seal the constructor");
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ id: "r1", points: ["p1", "p2"], records: {}, result: { percentHeld: 0 } });

		expect(await git(repo, "status", "--porcelain")).toBe("");
		expect(await fs.readdir(path.dirname(launch.cwd)).catch(() => [])).toEqual([]);

		const [hit, gone] = await h.spars.excerpt(id, 0, [
			spar.points[0]!.refs[0]!,
			{ path: "nope.ts", line: 1, token: "x" },
		]);
		expect(hit!.lines[hit!.line - hit!.start]).toContain("Store<S");
		expect(gone).toBeNull();

		await h.spars.remove(id);
		expect(await h.spars.list(repo)).toEqual([]);
		expect(await git(repo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("answers a defence with one small call on the default role, and applies the round rule itself", async () => {
		const h = harness("run2");
		const id = await ready(h, { ...CHANGE, cwd: repo });

		// A first push: the thread grows, the point stays open, and the case file stays hidden.
		const first = await h.spars.reply({ id, run: "r1", point: "p1", text: "It is checked by `src/runtime.ts:1`." });
		expect(first.turn).toMatchObject({ by: "partner", move: "push" });
		expect(first.record.turns.map(turn => turn.by)).toEqual(["you", "partner"]);
		expect(first.record.outcome).toBeUndefined();
		expect(first.record.reveal).toBeUndefined();
		// The hint that did not hold is dropped; the one that did is kept.
		expect(first.turn.refs).toEqual([{ path: "src/runtime.ts", line: 1, token: "Writable" }]);
		expect(first.turn.checked).toEqual([{ claim: "put only exists on Writable", holds: true }]);
		const call = h.calls[0]!;
		expect(call.argv).toEqual(
			expect.arrayContaining(["--no-tools", "--no-session", "--mode", "json", "--model", "@default"]),
		);
		expect(call.stdin).toContain("The permission is a type parameter");
		expect(call.stdin).toContain("The defence says the check is made by the compiler");
		expect(call.stdin).toContain("It is checked by");
		expect(call.stdin).toContain("export class Writable extends Store<ReadWrite>");

		// A concession closes the point as held and reveals the partner's side.
		h.reply.move = "concede";
		const second = await h.spars.reply({ id, run: "r1", point: "p1", text: "The compiler makes the check." });
		expect(second.record.outcome).toEqual({ kind: "held", by: "partner" });
		expect(second.record.reveal?.strongestDefence).toContain("type parameter");
		expect(second.record.reveal?.suggestion).toBeUndefined();
		expect(second.run.result).toMatchObject({ held: ["p1"], percentHeld: 50 });
		await expect(h.spars.reply({ id, run: "r1", point: "p1", text: "More." })).rejects.toThrow(/already closed/);

		// Three pushes in a row: the last closes the point as open, by the limit.
		h.reply.move = "push";
		for (let round = 1; round <= 3; round++) {
			const answered = await h.spars.reply({ id, run: "r1", point: "p2", text: `Defence ${round}.` });
			expect(answered.record.outcome === undefined).toBe(round < 3);
		}
		const { runs } = await h.spars.get(id);
		const record = runs[0]!.records.p2!;
		expect(record.turns).toHaveLength(6);
		expect(record.outcome).toEqual({ kind: "open", by: "limit" });
		expect(runs[0]!.finishedAt).toBeDefined();
		expect(runs[0]!.result).toMatchObject({ held: ["p1"], open: ["p2"], percentHeld: 50 });

		const [summary] = await h.spars.list(repo);
		expect(summary).toMatchObject({ latest: { held: 1, asked: 2, percentHeld: 50, finished: true } });
		expect(summary!.costUsd).toBeCloseTo(0.4 + 5 * 0.01, 6);
	});

	it("takes the reply model from the request, then the companion's setting", async () => {
		const h = harness("run2b", { replyModel: "@smol" });
		const id = await ready(h, { ...CHANGE, cwd: repo });
		await h.spars.reply({ id, run: "r1", point: "p1", text: "A." });
		expect(h.calls[0]!.argv[h.calls[0]!.argv.indexOf("--model") + 1]).toBe("@smol");
		const other = await ready(h, { ...CHANGE, cwd: repo, replyModel: "anthropic/claude-haiku-4-5" });
		await h.spars.reply({ id: other, run: "r1", point: "p1", text: "A." });
		expect(h.calls[1]!.argv[h.calls[1]!.argv.indexOf("--model") + 1]).toBe("anthropic/claude-haiku-4-5");
		await expect(h.spars.create({ ...CHANGE, cwd: repo, replyModel: "--evil" })).rejects.toThrow(/invalid model/);
	});

	it("keeps a partly held point's suggestion for the end, and reveals it on a lost one", async () => {
		const h = harness("run3");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		h.reply.move = "partly";
		const partly = await h.spars.reply({ id, run: "r1", point: "p1", text: "Partly the compiler." });
		expect(partly.record.outcome).toEqual({ kind: "partly", by: "partner" });
		expect(partly.record.reveal?.suggestion).toContain("Seal the constructor");

		const lost = await h.spars.close({ id, run: "r1", point: "p2", as: "lost" });
		expect(lost.record.outcome).toEqual({ kind: "lost", by: "you" });
		// That point's case file has no suggestion, so only the defence is shown.
		expect(lost.record.reveal).toMatchObject({ strongestDefence: expect.any(String) });
		expect(lost.record.reveal?.suggestion).toBeUndefined();
		expect(lost.run.finishedAt).toBeDefined();
		expect(lost.run.result).toMatchObject({ held: [], open: ["p1"], suggested: ["p1", "p2"], percentHeld: 25 });
		await expect(h.spars.close({ id, run: "r1", point: "p2", as: "open" })).rejects.toThrow(/already closed/);
		await expect(h.spars.close({ id, run: "r1", point: "p9", as: "open" })).rejects.toThrow(/not in this run/);
		await expect(h.spars.close({ id, run: "r1", point: "p1", as: "held" as never })).rejects.toThrow(
			/invalid outcome/,
		);
	});

	it("keeps a note when a risk is accepted, and no model call is made to close a point", async () => {
		const h = harness("run4");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		const closed = await h.spars.close({
			id,
			run: "r1",
			point: "p1",
			as: "open",
			note: "  Tracked in the backlog.  ",
		});
		expect(closed.record.outcome).toEqual({ kind: "open", by: "you", note: "Tracked in the backlog." });
		expect(h.calls).toHaveLength(0);
	});

	it("stops answering once the limit is used up, and lets you close points anyway", async () => {
		const h = harness("run5");
		const id = await ready(h, { ...CHANGE, cwd: repo, maxCostUsd: 0.41 });
		h.reply.cost = 0.02;
		await h.spars.reply({ id, run: "r1", point: "p1", text: "First." });
		// The cap of the call was what was left of the limit.
		expect(h.calls[0]!.argv[h.calls[0]!.argv.indexOf("--max-cost") + 1]).toBe("0.01");
		await expect(h.spars.reply({ id, run: "r1", point: "p1", text: "Second." })).rejects.toThrow(
			/used up its spending limit/,
		);
		const closed = await h.spars.close({ id, run: "r1", point: "p1", as: "lost" });
		expect(closed.record.outcome?.kind).toBe("lost");
	});

	it("says why a defence could not be answered and records nothing, but counts what the call cost", async () => {
		const h = harness("run6");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		h.reply.fails = true;
		await expect(h.spars.reply({ id, run: "r1", point: "p1", text: "Because." })).rejects.toThrow(
			/The reply could not be read: omp exited with 1: 400 stub says no/,
		);
		const { runs } = await h.spars.get(id);
		expect(runs[0]!.records).toEqual({});
		await expect(h.spars.reply({ id, run: "r1", point: "p1", text: "   " })).rejects.toThrow(/Write your defence/);
		await expect(h.spars.reply({ id, run: "r1", point: "p1", text: "x".repeat(4_001) })).rejects.toThrow(
			/longer than 4000/,
		);
	});

	it("asks the points again in a new run: the ones not held, or all of them", async () => {
		const h = harness("run7");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		await expect(h.spars.again({ id, only: "unsettled" })).resolves.toMatchObject({
			run: { id: "r2", retryOf: "r1", points: ["p1", "p2"], records: {} },
		});
		h.reply.move = "concede";
		await h.spars.reply({ id, run: "r2", point: "p1", text: "The compiler makes the check." });
		const third = await h.spars.again({ id, only: "unsettled" });
		expect(third.run).toMatchObject({ id: "r3", retryOf: "r2", points: ["p2"] });
		const everything = await h.spars.again({ id, only: "all", from: "r1" });
		expect(everything.run).toMatchObject({ id: "r4", retryOf: "r1", points: ["p1", "p2"] });
		const { runs } = await h.spars.get(id);
		expect(runs.map(run => run.id)).toEqual(["r1", "r2", "r3", "r4"]);
		// Answers of one run do not touch another's.
		expect(runs[0]!.records).toEqual({});
		await h.spars.reply({ id, run: "r3", point: "p2", text: "Compiler." });
		await expect(h.spars.again({ id, only: "unsettled", from: "r1" })).resolves.toBeDefined();
		await h.spars.close({ id, run: "r4", point: "p1", as: "lost" });
		await expect(h.spars.again({ id, only: "maybe" as never })).rejects.toThrow(/invalid repeat/);
		await expect(h.spars.again({ id, from: "r9" })).rejects.toThrow(/no such run/);
	});

	it("says there is nothing to repeat when every point was held", async () => {
		const h = harness("run8");
		const id = await ready(h, { ...CHANGE, cwd: repo });
		h.reply.move = "concede";
		await h.spars.reply({ id, run: "r1", point: "p1", text: "A." });
		await h.spars.reply({ id, run: "r1", point: "p2", text: "B." });
		await expect(h.spars.again({ id, only: "unsettled" })).rejects.toThrow(/every point was held/);
	});

	it("fails the spar, with the reason, when nothing the agent wrote holds up", async () => {
		const h = harness("run9", {
			file: {
				parts: [
					{
						part: 1,
						points: [{ kind: "cost", title: "T", challenge: "C", refs: ["src/store.ts@1@Nope"], case: CASE }],
					},
				],
			},
		});
		const id = await ready(h, { ...CHANGE, cwd: repo });
		const [summary] = await h.spars.list(repo);
		expect(summary).toMatchObject({ id, status: "failed" });
		expect(summary!.error).toContain("None of the agent's points held up");
		await expect(h.spars.get(id)).rejects.toThrow(/failed/);
		expect(await git(repo, "for-each-ref", `refs/omp-blueprint/maps/${id}`)).toBe("");
	});

	it("fails the spar when the agent's file is not JSON", async () => {
		const h = harness("run10", { file: "[" });
		const id = await ready(h, { ...CHANGE, cwd: repo });
		const [summary] = await h.spars.list(repo);
		expect(summary!.status).toBe("failed");
		expect(summary!.error).toContain("not valid JSON");
		await h.spars.remove(id);
	});

	it("refuses requests a device must not be able to make", async () => {
		const h = harness("run11");
		await expect(h.spars.create({ cwd: "relative" })).rejects.toThrow(/invalid folder/);
		await expect(h.spars.create({ cwd: repo })).rejects.toThrow(/Pick something to challenge/);
		await expect(h.spars.create({ cwd: repo, stack: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).rejects.toThrow(
			/at most|between 1 and 8/,
		);
		await expect(h.spars.create({ cwd: repo, pr: 0 })).rejects.toThrow(/invalid pull request number/);
		await expect(h.spars.create({ cwd: repo, sessionId: "../../etc/passwd", ref: "main" })).rejects.toThrow(
			/invalid session/,
		);
		await expect(h.spars.create({ cwd: repo, maxCostUsd: -1, ref: "main" })).rejects.toThrow(
			/invalid spending limit/,
		);
		await expect(h.spars.create({ cwd: repo, doc: { text: "   " } })).rejects.toThrow(/empty/);
		await expect(h.spars.create({ cwd: repo, doc: { text: "x".repeat(60_001) } })).rejects.toThrow(/longer than/);
		await expect(h.spars.create({ cwd: repo, doc: { path: "../secret" } })).rejects.toThrow(/invalid document path/);
		await expect(h.spars.create({ cwd: repo, doc: { path: "docs/missing.md" } })).rejects.toThrow(
			/not in the repository/,
		);
		await expect(h.spars.create({ cwd: repo, doc: 4 as never })).rejects.toThrow(/invalid document/);
		await expect(h.spars.get("../x")).rejects.toThrow();
		await expect(h.spars.reply({ id: "sp-000000000000", run: "r1", point: "p1", text: "x" })).rejects.toThrow(
			/no such spar/,
		);
		expect(await h.spars.list(repo)).toEqual([]);
	});

	it("refuses to spar on changes it has nothing to compare with", async () => {
		const h = harness("run12");
		await expect(h.spars.create({ cwd: designRepo, ref: "main" })).rejects.toThrow(/nothing to compare/);
	});

	it("marks a spar being written as interrupted when the companion shuts down", async () => {
		const changes: string[] = [];
		const gate = Promise.withResolvers<void>();
		const spars = createSpars({
			storeDir: path.join(tmp, "run13", "agent", "spars"),
			cacheDir: path.join(tmp, "run13", "cache", "spars"),
			sessionsDir: sessionsDir(),
			now: () => Date.now(),
			changed: id => changes.push(id),
			agent: {
				start: async () => {
					await gate.promise;
					return "agent-1";
				},
				hosts: async () => [{ instanceId: "agent-1", sessionId: "s-1", model: "stub/stub-model", busy: true }],
				stop: async () => undefined,
				cost: async () => 0,
			},
			ompBin: "omp",
			watch: { pollMs: 10, settleMs: 30 },
		});
		const { id } = await spars.create({ cwd: repo, ref: "feature/typestate", base: "main" });
		expect((await spars.list(repo))[0]).toMatchObject({ id, status: "running" });
		await spars.shutdown();
		gate.resolve();
		await spars.idle();
		expect((await spars.list(repo))[0]).toMatchObject({ id, status: "failed", error: "interrupted" });

		// A fresh companion reads the same store and keeps it.
		const again = createSpars({
			storeDir: path.join(tmp, "run13", "agent", "spars"),
			cacheDir: path.join(tmp, "run13", "cache", "spars"),
			sessionsDir: sessionsDir(),
			now: () => Date.now(),
			changed: () => undefined,
			agent: null,
			ompBin: "omp",
		});
		await again.init();
		expect((await again.list(repo))[0]).toMatchObject({ id, status: "failed" });
		await expect(again.create({ cwd: repo, ref: "main", base: "main" })).rejects.toThrow(/cannot run/);
	});
});

describe("a spar on a design", () => {
	it("challenges pasted text with citations of its lines, next to code, and serves excerpts of the document", async () => {
		const h = harness("doc1", { file: DESIGN_FILE });
		const id = await ready(h, { cwd: designRepo, doc: { text: DESIGN, name: "Session cache" } });
		const { spar, runs } = await h.spars.get(id);
		expect(spar.doc).toEqual({ name: "Session cache", chars: DESIGN.length });
		expect(spar.points.map(point => point.title)).toEqual(["Five minutes of stale data", "Cited in the wrong place"]);
		expect(spar.points[0]!.refs).toEqual([
			{ path: "@design", line: 4, token: "time to live" },
			{ path: "app.ts", line: 1, token: "TTL" },
		]);
		// A design alone has nothing to compare: no diff, no base.
		expect(spar.parts[0]!.base).toBeUndefined();
		expect(runs[0]!.points).toHaveLength(2);
		const prompt = h.launches[0]!.prompt;
		expect(prompt).toContain("We keep sessions in Redis.");
		expect(prompt).toContain("4  The time to live is five minutes.");
		expect(prompt).not.toContain("### app.ts (added)");

		const [fromDesign, fromCode] = await h.spars.excerpt(id, 0, [
			{ path: "@design", line: 4, token: "time to live" },
			{ path: "app.ts", line: 1, token: "TTL" },
		]);
		expect(fromDesign!.lines[fromDesign!.line - fromDesign!.start]).toContain("time to live");
		expect(fromCode!.lines[0]).toContain("TTL");

		// A request without a range gets the default window; with one, the stored document is read wider.
		const designLines = DESIGN.trimEnd().split("\n").length;
		expect(fromDesign).toMatchObject({ start: 1, total: designLines, commit: "document" });
		const [wider, aboveTheTop, many] = await h.spars.excerpt(id, 0, [
			{ path: "@design", line: 4, token: "time to live", from: 2, to: 5 },
			{ path: "@design", line: 4, token: "time to live", from: -10, to: 4 },
			{ path: "app.ts", line: 1, token: "TTL", from: 1, to: 500 },
		]);
		expect([wider!.start, wider!.lines.length]).toEqual([2, 4]);
		expect(aboveTheTop).toMatchObject({ start: 1, total: designLines });
		expect(aboveTheTop!.lines).toHaveLength(4);
		expect(many).toMatchObject({ start: 1, total: 1, lines: ["export const TTL = 300;"] });

		// The partner reads the design as code too.
		h.reply.move = "partly";
		const answered = await h.spars.reply({
			id,
			run: "r1",
			point: "p1",
			text: "Writers invalidate on every save, see @design:5.",
		});
		expect(h.calls[0]!.stdin).toContain("Writers invalidate on every save");
		expect(answered.record.reveal?.refs).toEqual([{ path: "@design", line: 5, token: "invalidate" }]);
		await h.spars.remove(id);
		expect(await git(designRepo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("reads a design from a file of the repository, working-tree changes included", async () => {
		await fs.appendFile(path.join(designRepo, "docs/cache.md"), "A sixth line, not yet committed.\n");
		try {
			const h = harness("doc2", { file: DESIGN_FILE });
			const id = await ready(h, { cwd: designRepo, doc: { path: "docs/cache.md" } });
			const { spar } = await h.spars.get(id);
			expect(spar.doc?.name).toBe("docs/cache.md");
			expect(h.launches[0]!.prompt).toContain("A sixth line, not yet committed.");
			const [summary] = await h.spars.list(designRepo);
			expect(summary!.subject).toContain("docs/cache.md");
		} finally {
			await git(designRepo, "checkout", "-q", "docs/cache.md");
		}
	});

	it("puts a design next to the changes it is attached to", async () => {
		const h = harness("doc3", { file: DESIGN_FILE });
		const id = await ready(h, { ...CHANGE, cwd: repo, doc: { text: DESIGN } });
		const { spar } = await h.spars.get(id);
		expect(spar.doc?.name).toBe("Pasted design");
		expect(h.launches[0]!.prompt).toContain("### src/runtime.ts (added)");
		expect(h.launches[0]!.prompt).toContain("We keep sessions in Redis.");
		expect(spar.parts[0]!.base).toBeDefined();
	});
});
