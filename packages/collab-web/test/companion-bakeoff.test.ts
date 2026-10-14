import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Bakeoff, BakeoffCreate } from "@oh-my-pi/pi-wire/bakeoff";
import type { RunInfo } from "../src/lib/companion";
import { type FanoutGroup, MAX_FANOUT_MODELS } from "../src/lib/fanout";
import type { AgentLaunch } from "../scripts/companion-agent";
import { checkBakeoffCreate, createBakeoffs, type Bakeoffs } from "../scripts/companion-bakeoff";
import type { BakeoffFanout, OpenedJudge } from "../scripts/companion-bakeoff-run";
import { fanoutBranch, parseFanoutRequest, startFanout } from "../scripts/companion-fanout";

let tmp: string;
let repo: string;

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
const PACKAGE = '{\n\t"name": "demo",\n\t"scripts": { "test": "bun test" }\n}\n';

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bakeoff-run-")));
	repo = path.join(tmp, "demo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_BEFORE);
	await fs.writeFile(path.join(repo, "package.json"), PACKAGE);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "checkout", "-q", "-b", "feature/typestate");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_AFTER);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "Make store access a type");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const METRICS: BakeoffCreate["metrics"] = [
	{ id: "simplicity", label: "Simplicity", weight: 3 },
	{ id: "migration-risk", label: "Migration risk", weight: 1 },
];
const MODELS = ["anthropic/claude-a", "openai/gpt-b"];

/** A write-up file in the shared template. */
function writeup(summary: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		summary,
		approach: "The access becomes a type parameter on the store.",
		tradeoffs: ["more generics"],
		risks: ["callers need the new type"],
		migration: "Callers change in one commit.",
		metrics: { simplicity: "one extra parameter", "migration-risk": "a compile error shows every caller" },
		refs: ["src/store.ts@1@Store"],
		...extra,
	});
}

interface Seen {
	launch: AgentLaunch;
	/** Every file under the folder it started in, relative, at start. */
	files: string[];
}

interface Options {
	/** Text a designer writes, by model and attempt; the default is a valid write-up that names its own model. */
	designer?(model: string | undefined, attempt: number): string;
	/** Text the reviewer writes, given the labels it reads and the attempt (1-based). */
	reviewer?(labels: string[], attempt: number): string;
	judge?: "ok" | "fails" | "slow";
	/** What a session costs, USD. */
	cost?: number;
	/** The session of this model never writes a file and stays busy until it is stopped. */
	hang?: string;
	/** Starting the session of this model throws. */
	failStart?: string;
}

interface Harness {
	bakeoffs: Bakeoffs;
	changes: string[];
	seen: Seen[];
	stopped: string[];
	/** How many judgments the fake judge was asked for. */
	judged: { calls: number };
	/** Resolves once a session on `model` has been started. */
	whenStarted(model: string): Promise<void>;
}

async function listing(dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (folder: string): Promise<void> => {
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			const full = path.join(folder, entry.name);
			out.push(path.relative(dir, full));
			if (entry.isDirectory()) await walk(full);
		}
	};
	await walk(dir).catch(() => undefined);
	return out;
}

function reviewerFile(labels: string[]): string {
	const sorted = [...labels].sort();
	return JSON.stringify({
		ranking: sorted,
		entries: Object.fromEntries(
			sorted.map((label, index) => [
				label,
				{
					scores: { simplicity: 5 - index, "migration-risk": 4 - index },
					strengths: [{ text: "The access is in the type.", refs: [`${label}/src/store.ts@1@Store`] }],
					weaknesses: [{ text: "A lock is missing.", refs: [`${label}/src/store.ts@3@Mutex`] }],
				},
			]),
		),
		verdict: `Entry ${sorted[0]} is simplest: \`${sorted[0]}/src/store.ts@1@Store\` shows it. Nothing here says how it migrates: \`${sorted[0]}/src/store.ts@2@Nothing\`.`,
		unsure: ["how it behaves under load"],
	});
}

/** The two summaries a pairwise question puts side by side. */
function digestsOf(state: unknown): { first: string; second: string } {
	if (typeof state !== "object" || state === null) return { first: "", second: "" };
	return {
		first: "first" in state && typeof state.first === "string" ? state.first : "",
		second: "second" in state && typeof state.second === "string" ? state.second : "",
	};
}

function harness(name: string, options: Options = {}): Harness {
	const changes: string[] = [];
	const seen: Seen[] = [];
	const stopped: string[] = [];
	const attempts = new Map<string, number>();
	const hosts = new Map<string, { sessionId: string; model: string | null; busy: boolean }>();
	let next = 0;
	const judged = { calls: 0 };
	const startedModels = new Set<string>();
	const waiting = new Map<string, (() => void)[]>();
	const whenStarted = (model: string): Promise<void> =>
		startedModels.has(model)
			? Promise.resolve()
			: new Promise<void>(resolve => waiting.set(model, [...(waiting.get(model) ?? []), resolve]));
	const judge: OpenedJudge | undefined =
		options.judge === undefined
			? undefined
			: {
					judge: {
						judge: async request => {
							judged.calls++;
							if (options.judge === "fails") throw new Error("judgment: connection refused");
							const answers: Record<string, { type: "choice" | "score"; choice?: string; score?: number }> = {};
							const { first, second } = digestsOf(request.state);
							for (const [id, question] of Object.entries(request.questions)) {
								answers[id] =
									question.type === "score"
										? { type: "score", score: 3 }
										: {
												type: "choice",
												choice:
													first.length === second.length
														? "tie"
														: first.length > second.length
															? "first"
															: "second",
											};
							}
							return { answers };
						},
					},
					native: true,
					describe: { kind: "native", explicit: true, label: "fake/judge" },
					close: () => undefined,
				};
	const bakeoffs = createBakeoffs({
		storeDir: path.join(tmp, name, "agent", "bakeoffs"),
		cacheDir: path.join(tmp, name, "cache", "bakeoffs"),
		sessionsDir: path.join(tmp, "sessions"),
		now: () => Date.now(),
		changed: id => changes.push(id),
		agent: {
			start: async launch => {
				if (options.failStart !== undefined && launch.model === options.failStart)
					throw new Error("omp did not start");
				seen.push({ launch, files: await listing(launch.cwd) });
				const id = `agent-${next++}`;
				hosts.set(id, { sessionId: `s-${id}`, model: launch.model ?? null, busy: false });
				if (launch.model !== undefined) {
					startedModels.add(launch.model);
					for (const resolve of waiting.get(launch.model) ?? []) resolve();
				}
				if (options.hang !== undefined && launch.model === options.hang) {
					hosts.get(id)!.busy = true;
					return id;
				}
				const prompt = launch.prompt;
				let text: string;
				if (prompt.includes("You are writing a better design")) {
					const key = `design:${launch.model}`;
					const attempt = (attempts.get(key) ?? 0) + 1;
					attempts.set(key, attempt);
					text = options.designer
						? options.designer(launch.model, attempt)
						: writeup(`A design from ${launch.model}, which makes the access a type.`);
				} else if (prompt.includes("neutral summary")) {
					text = writeup("The store gets its access from a type parameter and a writable subclass.");
				} else {
					const labels = /entries \(([A-E, ]+)\)/.exec(prompt)![1]!.split(", ");
					const key = "review";
					const attempt = (attempts.get(key) ?? 0) + 1;
					attempts.set(key, attempt);
					text = options.reviewer ? options.reviewer(labels, attempt) : reviewerFile(labels);
				}
				await fs.writeFile(launch.outFile, text);
				return id;
			},
			hosts: async () => [...hosts.entries()].map(([instanceId, host]) => ({ instanceId, ...host })),
			stop: async instanceId => {
				stopped.push(instanceId);
				hosts.delete(instanceId);
			},
			cost: async () => options.cost ?? 0.05,
		},
		fanout: null,
		openJudge: judge ? async () => judge : undefined,
		watch: { pollMs: 5, settleMs: 20, idleMs: 200, goneMs: 30, timeoutMs: 5_000 },
	});
	return { bakeoffs, changes, seen, stopped, judged, whenStarted };
}

async function done(h: Harness, id: string): Promise<Bakeoff> {
	await h.bakeoffs.idle();
	return h.bakeoffs.get(id);
}

const DESIGN: BakeoffCreate = {
	cwd: "",
	ref: "feature/typestate",
	base: "main",
	mode: "design",
	metrics: METRICS,
	models: MODELS,
	reviewer: "google/gemini-r",
	maxCostUsd: 3,
};

function request(extra: Partial<BakeoffCreate> = {}): BakeoffCreate {
	return { ...DESIGN, cwd: repo, ...extra };
}

describe("a design bake-off run", () => {
	it("has each challenger design, writes up the original, reviews blind, and ranks with verified citations", async () => {
		const h = harness("design", { judge: "ok" });
		const { id } = await h.bakeoffs.create(request());
		const bakeoff = await done(h, id);
		const [summary] = await h.bakeoffs.list(repo);
		expect(summary).toMatchObject({
			id,
			status: "ready",
			mode: "design",
			stage: "done",
			entryCount: 3,
			subject: "feature/typestate vs main",
		});
		expect(summary!.costUsd).toBeGreaterThan(0);
		expect(h.changes).toContain(id);

		// Three entries, A to C, shuffled by the seed; the original and two challengers.
		expect(bakeoff.entries.map(entry => entry.label)).toEqual(["A", "B", "C"]);
		expect(bakeoff.entries.filter(entry => entry.kind === "original")).toHaveLength(1);
		expect(
			bakeoff.entries
				.filter(entry => entry.kind === "challenger")
				.map(entry => entry.model)
				.sort(),
		).toEqual([...MODELS].sort());
		for (const entry of bakeoff.entries) expect(entry.status).toBe("ready");

		// A design may not name its model: the stored write-up is scrubbed.
		const designs = JSON.stringify(bakeoff.entries.map(entry => entry.writeup));
		expect(designs).not.toContain("claude-a");
		expect(designs).not.toContain("gpt-b");
		expect(designs).toContain("[model]");

		// Sessions: two designers (read-only tools, the challengers' models), one writer, one reviewer.
		const prompts = h.seen.map(seen => seen.launch.prompt);
		const designers = h.seen.filter(seen => seen.launch.prompt.includes("You are writing a better design"));
		expect(designers.map(seen => seen.launch.model).sort()).toEqual([...MODELS].sort());
		expect(prompts.filter(prompt => prompt.includes("neutral summary"))).toHaveLength(1);
		const reviewers = h.seen.filter(seen => seen.launch.prompt.includes("reviewer of a design bake-off"));
		expect(reviewers).toHaveLength(1);
		const reviewer = reviewers[0]!;
		expect(reviewer.launch.model).toBe("google/gemini-r");
		expect(reviewer.launch.tools).not.toContain("bash");

		// The reviewer is blind: no model name anywhere in what it is told or can read, and no git history.
		for (const word of ["claude-a", "gpt-b", "anthropic", "openai", "feature/typestate"])
			expect(reviewer.launch.prompt).not.toContain(word);
		expect(reviewer.files.some(file => file.split("/").includes(".git"))).toBe(false);
		expect(reviewer.files).toContain("code/src/store.ts");
		for (const label of ["A", "B", "C"]) expect(reviewer.files).toContain(`${label}/design.md`);

		// The verdict is checked against the code: the line that holds is kept, the one that does not is marked.
		const result = bakeoff.result!;
		expect(result.ranking).toHaveLength(3);
		expect(result.ranking.map(row => row.rank)).toEqual([1, 2, 3]);
		expect(result.verdict).toContain("(not checked against the code)");
		expect(result.findings.some(finding => finding.verified && finding.kind === "strength")).toBe(true);
		expect(result.findings.find(finding => finding.kind === "weakness")!.verified).toBe(false);
		expect(result.unsure).toEqual(["how it behaves under load"]);
		expect(result.reviewerModel).toBe("google/gemini-r");
		expect(result.judgeLabel).toBe("fake/judge");
		expect(result.judgeKind).toBe("native");
		expect(result.pairwise!.length).toBeGreaterThan(0);
		expect(result.consistency).toBe(1);

		// Nothing is left behind in the repository, and the work folder is gone.
		expect(await git(repo, "status", "--porcelain")).toBe("");
		expect(await fs.readdir(path.join(tmp, "design", "cache", "bakeoffs", "work")).catch(() => [])).toEqual([]);

		// An excerpt reads the original's commit.
		const [hit, gone] = await h.bakeoffs.excerpt(id, "A", [
			{ path: "src/store.ts", line: 1, token: "Store" },
			{ path: "nope.ts", line: 1, token: "x" },
		]);
		expect(hit!.lines[hit!.line - hit!.start]).toContain("Store");
		expect(gone).toBeNull();

		// Taking a design marks it; deleting the bake-off releases the commits it held.
		await h.bakeoffs.take({ id, entry: "B" });
		expect((await h.bakeoffs.get(id)).result!.taken).toBe("B");
		expect((await h.bakeoffs.list(repo))[0]!.taken).toBe("B");
		await h.bakeoffs.remove(id);
		expect(await h.bakeoffs.list(repo)).toEqual([]);
		expect(await git(repo, "for-each-ref", `refs/omp-blueprint/maps/${id}`)).toBe("");
	});

	it("shows the same labels whatever order the entries come in: the seed draws them, the original is not always A", async () => {
		const first = new Set<string>();
		for (const name of ["order1", "order2", "order3", "order4", "order5", "order6"]) {
			const h = harness(name);
			const { id } = await h.bakeoffs.create(request());
			const bakeoff = await done(h, id);
			first.add(bakeoff.entries.find(entry => entry.kind === "original")!.label);
		}
		expect(first.size).toBeGreaterThan(1);
	});

	it("retries a design whose file is not valid JSON once, with the reason, and keeps the one that works", async () => {
		const h = harness("retry", {
			designer: (model, attempt) =>
				model === MODELS[0] && attempt === 1 ? "{ not json" : writeup(`A design from ${model}.`),
		});
		const { id } = await h.bakeoffs.create(request());
		const bakeoff = await done(h, id);
		expect(bakeoff.entries.every(entry => entry.status === "ready")).toBe(true);
		const retried = h.seen.filter(seen => seen.launch.model === MODELS[0]);
		expect(retried).toHaveLength(2);
		expect(retried[1]!.launch.prompt).toContain("rejected");
		expect(retried[1]!.launch.prompt).toContain("not valid JSON");
	});

	it("fails an entry whose design is still unusable after the retry and reviews the rest", async () => {
		const h = harness("badentry", {
			designer: model => (model === MODELS[1] ? '{"summary": "x"}' : writeup("Fine.")),
		});
		const { id } = await h.bakeoffs.create(request());
		const bakeoff = await done(h, id);
		const failed = bakeoff.entries.find(entry => entry.model === MODELS[1])!;
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("could not be used");
		expect(bakeoff.result!.ranking).toHaveLength(2);
		expect(bakeoff.result!.ranking.map(row => row.label)).not.toContain(failed.label);
	});

	it("carries on when one challenger's session does not start", async () => {
		const h = harness("nostart", { failStart: MODELS[0] });
		const { id } = await h.bakeoffs.create(request());
		const bakeoff = await done(h, id);
		expect(bakeoff.entries.find(entry => entry.model === MODELS[0])!.status).toBe("failed");
		expect(bakeoff.result!.ranking).toHaveLength(2);
	});

	it("asks the reviewer again when its ranking leaves an entry out, and fails with the reason when it does so twice; Review again then works", async () => {
		let broken = true;
		const h = harness("badreview", {
			reviewer: labels =>
				broken
					? JSON.stringify({ ranking: [labels[0]], entries: {}, verdict: "x", unsure: [] })
					: reviewerFile(labels),
		});
		const { id } = await h.bakeoffs.create(request());
		await h.bakeoffs.idle();
		const [failed] = await h.bakeoffs.list(repo);
		expect(failed).toMatchObject({ status: "failed", stage: "review" });
		expect(failed!.error).toContain("exactly once");
		expect(h.seen.filter(seen => seen.launch.prompt.includes("reviewer of a design bake-off"))).toHaveLength(2);
		// The entries and their write-ups are kept.
		const kept = await h.bakeoffs.get(id);
		expect(kept.entries.every(entry => entry.writeup !== undefined)).toBe(true);
		broken = false;
		await h.bakeoffs.review(id);
		await h.bakeoffs.idle();
		expect((await h.bakeoffs.list(repo))[0]!.status).toBe("ready");
		expect((await h.bakeoffs.get(id)).result!.ranking).toHaveLength(3);
	});

	it("shows why there is no second opinion when the judge cannot be reached, and ranks on the reviewer alone", async () => {
		const h = harness("nojudge", { judge: "fails" });
		const { id } = await h.bakeoffs.create(request());
		const result = (await done(h, id)).result!;
		expect(result.agreement).toBe("reviewer-only");
		expect(result.judgeNote).toBe("No second opinion: fake/judge was unreachable (connection refused)");
		expect(result.pairwise).toBeUndefined();
		expect((await h.bakeoffs.list(repo))[0]!.note).toContain("No second opinion");
	});

	it("says so when no judge model is set up, and asks it nothing when the second opinion is off", async () => {
		const none = harness("nojudge-none");
		const first = (await done(none, (await none.bakeoffs.create(request())).id)).result!;
		expect(first.judgeNote).toContain("No second opinion");
		const off = harness("judge-off", { judge: "ok" });
		const second = (await done(off, (await off.bakeoffs.create(request({ judge: "off" }))).id)).result!;
		expect(second.judgeNote).toBeUndefined();
		expect(off.judged.calls).toBe(0);
	});

	it("runs the reviewer twice with the order reversed and the labels redrawn when asked, and keeps both verdicts", async () => {
		const h = harness("twopass");
		const { id } = await h.bakeoffs.create(request({ reviewerPasses: 2 }));
		const result = (await done(h, id)).result!;
		const reviewers = h.seen.filter(seen => seen.launch.prompt.includes("reviewer of a design bake-off"));
		expect(reviewers).toHaveLength(2);
		expect(result.passes).toHaveLength(2);
		const order = (prompt: string): string[] => [...prompt.matchAll(/## Entry ([A-E])/g)].map(match => match[1]!);
		expect(order(reviewers[1]!.launch.prompt)).not.toEqual(order(reviewers[0]!.launch.prompt));
		// The verdicts and findings are in the stored labels, whatever the reviewer read.
		expect(result.ranking).toHaveLength(3);
	});

	it("stops with an error when the spending limit is used up before a stage can start", async () => {
		const h = harness("limit", { cost: 5 });
		const { id } = await h.bakeoffs.create(request({ maxCostUsd: 1 }));
		await h.bakeoffs.idle();
		const [summary] = await h.bakeoffs.list(repo);
		expect(summary!.status).toBe("failed");
		expect(summary!.costUsd).toBeGreaterThan(1);
		expect(
			(await h.bakeoffs.get(id)).entries.some(
				entry => entry.status === "failed" || entry.flags.includes("no write-up"),
			),
		).toBe(true);
	});

	it("stops the whole run on request: sessions end, the bake-off is marked stopped and keeps what it made", async () => {
		const h = harness("stop", { hang: MODELS[0] });
		const { id } = await h.bakeoffs.create(request());
		await h.whenStarted(MODELS[0]!);
		await expect(h.bakeoffs.create(request())).rejects.toThrow("already running");
		await h.bakeoffs.stop(id, undefined);
		await h.bakeoffs.idle();
		const [summary] = await h.bakeoffs.list(repo);
		expect(summary).toMatchObject({ status: "failed", error: "Stopped." });
		expect(h.stopped.length).toBeGreaterThan(0);
		expect((await h.bakeoffs.get(id)).entries).toHaveLength(3);
	});

	it("stops one entry and goes on without it", async () => {
		const h = harness("stop-one", { hang: MODELS[0] });
		const { id } = await h.bakeoffs.create(request());
		await h.whenStarted(MODELS[0]!);
		const hung = (await h.bakeoffs.get(id)).entries.find(entry => entry.model === MODELS[0])!;
		await h.bakeoffs.stop(id, hung.label);
		const bakeoff = await done(h, id);
		expect(bakeoff.entries.find(entry => entry.label === hung.label)!.status).toBe("stopped");
		expect(bakeoff.result!.ranking).toHaveLength(2);
	});

	it("marks a bake-off a previous companion left running as interrupted, and ends its session", async () => {
		const dir = path.join(tmp, "interrupted", "agent", "bakeoffs");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "index.json"),
			JSON.stringify({
				v: 1,
				bakeoffs: [
					{
						id: "bk-aaaaaaaaaaaa",
						title: "t",
						repoRoot: repo,
						subject: "s",
						createdAt: 1,
						status: "running",
						instanceId: "left-over",
					},
				],
			}),
		);
		const h = harness("interrupted");
		await h.bakeoffs.init();
		expect((await h.bakeoffs.list(undefined))[0]).toMatchObject({ status: "failed" });
		expect(h.stopped).toEqual(["left-over"]);
	});
});

describe("a bake-off request", () => {
	const ok: Partial<BakeoffCreate> = { ...DESIGN, cwd: "/tmp/x" };

	it("is checked: models, metrics, inputs and the spending limit", () => {
		expect(checkBakeoffCreate(ok)).toMatchObject({
			mode: "design",
			reviewerPasses: 1,
			writer: "@default",
			judge: "auto",
			start: "original",
			maxCostUsd: 3,
		});
		const bad = (extra: Partial<BakeoffCreate>, message: string): void =>
			expect(() => checkBakeoffCreate({ ...ok, ...extra })).toThrow(message);
		bad({ models: ["a/b"] }, "Pick 2 to 4 models");
		bad({ models: Array.from({ length: MAX_FANOUT_MODELS + 1 }, (_, i) => `p/m${i}`) }, "Pick 2 to 4 models");
		bad({ models: ["a/b", "a/b"] }, "Pick different models");
		bad({ models: ["agent:claude/opus", "a/b"] }, "omp model");
		bad({ reviewer: "agent:claude/opus" }, "omp model");
		bad({ reviewer: "has space" }, "invalid reviewer");
		bad({ metrics: [] }, "Pick 1 to 6");
		bad(
			{
				metrics: [
					{ id: "simplicity", label: "S", weight: 3 },
					{ id: "simplicity", label: "S", weight: 1 },
				],
			},
			"listed twice",
		);
		bad({ metrics: [{ id: "lines-changed", label: "L", weight: 1 }] }, "comparing implementations");
		bad({ metrics: [{ id: "custom:1", label: "Mine", weight: 2 }] }, "Describe what a custom metric means");
		bad({ metrics: [{ id: "bogus" as "simplicity", label: "x", weight: 2 }] }, "invalid metric");
		bad({ metrics: [{ id: "simplicity", label: "S", weight: 4 as 1 }] }, "weight");
		bad({ test: { target: "package:test" } }, "no tests or benchmarks");
		bad({ ref: undefined }, "Pick a change or a design document");
		bad({ mode: "implementation", ref: undefined, doc: { text: "design" } }, "Pick the change");
		bad({ doc: { path: "../secrets" } }, "inside the repository");
		bad({ doc: { path: "/etc/passwd" } }, "inside the repository");
		bad({ maxCostUsd: 0 }, "spending limit");
		bad({ maxCostUsd: 1000 }, "spending limit");
		bad({ pr: 3 }, "not both");
		bad({ instructions: "x".repeat(5000) }, "instructions");
	});

	it("takes a pasted document or a path alone in design mode, and a test and benchmark in implementation mode", () => {
		expect(checkBakeoffCreate({ ...ok, ref: undefined, doc: { text: "A design", name: "d.md" } }).doc).toEqual({
			text: "A design",
			name: "d.md",
		});
		expect(checkBakeoffCreate({ ...ok, ref: undefined, doc: { path: "docs/design.md" } }).doc).toEqual({
			path: "docs/design.md",
		});
		const implementation = checkBakeoffCreate({
			...ok,
			mode: "implementation",
			metrics: [{ id: "lines-changed", label: "Lines", weight: 1 }],
			test: { target: "package:test", detail: "bun test" },
			bench: { target: "package:bench", better: "lower", valueRegex: "(\\d+) ms" },
		});
		expect(implementation.test).toEqual({ target: "package:test", detail: "bun test" });
		expect(implementation.bench).toMatchObject({ better: "lower", valueRegex: "(\\d+) ms" });
	});
});

describe("an implementation bake-off run", () => {
	function run(overrides: Partial<RunInfo>): RunInfo {
		return {
			runId: "r1",
			instanceId: "bk",
			targetId: "package:test",
			command: "bun run test",
			startedAt: 1_000,
			endedAt: 2_000,
			state: "exited",
			exitCode: 0,
			signal: null,
			...overrides,
		};
	}

	it("makes a worktree per challenger from the original, measures each against the same base, and keeps the one you take", async () => {
		const trees = path.join(tmp, "impl-trees");
		const h = harness("impl");
		const kept: unknown[] = [];
		let group: FanoutGroup | undefined;
		let startCommit = "";
		const fanout: BakeoffFanout = {
			start: async input => {
				startCommit = input.startCommit;
				group = await startFanout(
					parseFanoutRequest({
						cwd: input.cwd,
						prompt: input.prompt,
						models: input.models,
						budgetUsd: input.budgetUsd,
					}),
					{
						worktreesDir: trees,
						startCommit: input.startCommit,
						bakeoff: input.bakeoff,
						branchName: (index, model) => fanoutBranch(input.bakeoff, index, model, "omp/", "bake"),
						launch: async ({ cwd, model }) => {
							// What the "session" did: the first model adds a line, the second breaks the test script.
							if (model === MODELS[0]) await fs.appendFile(path.join(cwd, "src/store.ts"), "// docs\n");
							else await fs.writeFile(path.join(cwd, "package.json"), PACKAGE.replace("bun test", "true"));
							return `inst-${model === MODELS[0] ? 0 : 1}`;
						},
					},
				);
				return group;
			},
			group: id => (group?.id === id ? group : undefined),
			keep: async (_group, request) => {
				kept.push(request);
				return { removed: ["openai/gpt-b"], skipped: [] };
			},
			unlink: async () => undefined,
		};
		const targets = (
			root: string,
		): Promise<{ id: string; source: "package"; name: string; command: string; detail: string }[]> =>
			fs.readFile(path.join(root, "package.json"), "utf8").then(text => [
				{
					id: "package:test",
					source: "package",
					name: "test",
					command: "bun run test",
					detail: JSON.parse(text).scripts.test,
				},
			]);
		const started: string[] = [];
		const replaced = createBakeoffs({
			storeDir: path.join(tmp, "impl", "agent", "bakeoffs"),
			cacheDir: path.join(tmp, "impl", "cache", "bakeoffs"),
			sessionsDir: path.join(tmp, "sessions"),
			now: () => Date.now(),
			changed: () => undefined,
			agent: {
				start: async launch => {
					const id = `rw-${started.length}`;
					started.push(launch.prompt);
					const prompt = launch.prompt;
					const text = prompt.includes("neutral summary")
						? writeup("It changes the store.")
						: reviewerFile(/entries \(([A-E, ]+)\)/.exec(prompt)![1]!.split(", "));
					await fs.writeFile(launch.outFile, text);
					return id;
				},
				hosts: async () => [
					{ instanceId: "inst-0", sessionId: "s0", model: MODELS[0]!, busy: false },
					{ instanceId: "inst-1", sessionId: "s1", model: MODELS[1]!, busy: false },
					...started.map((_, index) => ({
						instanceId: `rw-${index}`,
						sessionId: `sw${index}`,
						model: null,
						busy: false,
					})),
				],
				stop: async () => undefined,
				cost: async () => 0.04,
			},
			fanout,
			measure: {
				runs: {
					targets,
					start: async (_key, root, targetId, detail) => {
						const text = await fs.readFile(path.join(root, "src/store.ts"), "utf8");
						expect(targetId).toBe("package:test");
						expect(detail).toBe("bun test");
						return run({ runId: `run-${root}`, exitCode: text.includes("// docs") ? 1 : 0 });
					},
					finished: async runId =>
						run({
							runId: String(runId),
							exitCode: (await Bun.file(path.join(String(runId).slice(4), "src/store.ts")).text()).includes(
								"// docs",
							)
								? 1
								: 0,
						}),
					stop: id => run({ runId: String(id) }),
					output: id => ({ run: run({ runId: String(id) }), text: "", from: 0, next: 0, truncated: false }),
				},
			},
			watch: { pollMs: 5, settleMs: 20, idleMs: 20, goneMs: 30, timeoutMs: 5_000 },
		});
		const { id } = await replaced.create({
			...request({
				mode: "implementation",
				metrics: [{ id: "lines-changed", label: "Lines changed", weight: 3 }, ...METRICS],
			}),
			test: { target: "package:test", detail: "bun test" },
		});
		await replaced.idle();
		const bakeoff = await replaced.get(id);
		expect(bakeoff.stage).toBe("done");
		expect(bakeoff.start).toBe("original");
		expect(bakeoff.group).toBe(group!.id);
		expect(group!.bakeoff).toBe(id);

		// Every worktree starts from the original's head, on a bake-off branch.
		const original = await git(repo, "rev-parse", "feature/typestate");
		expect(startCommit).toBe(original);
		for (const entry of bakeoff.entries.filter(entry => entry.kind === "challenger")) {
			expect(entry.branch).toMatch(/^omp\/bake-/);
			expect(entry.path).toContain("impl-trees");
		}

		// Facts come from git and the run target, not from the entry's own claims.
		const byModel = (model: string) => bakeoff.entries.find(entry => entry.model === model)!;
		const docs = byModel(MODELS[0]!);
		expect(docs.facts).toMatchObject({ files: 1, deltaFromOriginal: { files: 1, added: 1, removed: 0 } });
		expect(docs.facts!.tests).toMatchObject({ target: "package:test", ok: false });
		const tampered = byModel(MODELS[1]!);
		expect(tampered.facts!.tests).toMatchObject({ ok: null, reason: "the test script was changed in this entry" });
		expect(tampered.flags).toContain("test script changed");
		const originalEntry = bakeoff.entries.find(entry => entry.kind === "original")!;
		expect(originalEntry.facts).toMatchObject({
			deltaFromOriginal: { files: 0, added: 0, removed: 0 },
			tests: { ok: true },
		});

		// The test failing in an entry while the original passes makes it not eligible; one tap more to take it.
		const rows = Object.fromEntries(bakeoff.result!.ranking.map(row => [row.label, row]));
		expect(rows[docs.label]!.eligible).toBe(false);
		expect(rows[originalEntry.label]!.eligible).toBe(true);

		// Writers get an export of the code, never a worktree: no `.git` and no branch name in the reviewer's pack.
		expect(started.some(prompt => prompt.includes("omp/bake-"))).toBe(false);

		// Take keeps that worktree through the fan-out's keep.
		await replaced.take({ id, entry: docs.label, removeOthers: true });
		expect(kept).toEqual([{ group: group!.id, keep: "inst-0", removeOthers: true, discardDirty: false }]);
		expect((await replaced.get(id)).result!.taken).toBe(docs.label);
		await replaced.remove(id);
		expect(await git(repo, "for-each-ref", `refs/omp-blueprint/maps/${id}`)).toBe("");
	});
});

describe("a bake-off request with fields this companion does not know", () => {
	/** What the companion's dispatch hands the engine: the frame without `t` and `reqId`. */
	function fromFrame(frame: Record<string, unknown>): Partial<BakeoffCreate> {
		const { t: _t, reqId: _reqId, ...rest } = frame;
		return rest as Partial<BakeoffCreate>;
	}

	it("checks a bakeoff-create from a newer app like the same request without them, and keeps none of them", () => {
		const known = checkBakeoffCreate(request());
		const frame = {
			t: "bakeoff-create",
			reqId: 7,
			...request(),
			metrics: METRICS.map(metric => ({ ...metric, emphasis: "high" })),
			doc: undefined,
			futureOption: true,
			nested: { anything: [1, 2, 3] },
		};
		const checked = checkBakeoffCreate(fromFrame(frame));
		expect(checked).toEqual(known);
		const serialized = JSON.stringify(checked);
		for (const name of ["futureOption", "nested", "emphasis", "reqId"]) expect(serialized).not.toContain(name);
	});

	it("creates a bake-off from a bakeoff-create frame with unknown fields, and stores it as the plain request would be", async () => {
		const h = harness("unknown-fields", { judge: "ok" });
		const { id } = await h.bakeoffs.create(
			fromFrame({
				t: "bakeoff-create",
				reqId: 8,
				...request(),
				futureOption: "x",
				metrics: METRICS.map(metric => ({ ...metric, emphasis: "high" })),
			}),
		);
		const bakeoff = await done(h, id);
		expect((await h.bakeoffs.list(repo))[0]).toMatchObject({ id, status: "ready" });
		expect(bakeoff.entries.map(entry => entry.label)).toEqual(["A", "B", "C"]);
		const serialized = JSON.stringify(bakeoff);
		expect(serialized).not.toContain("futureOption");
		expect(serialized).not.toContain("emphasis");
	});

	it("answers a bakeoff-get by id alone, whatever else the frame carries", async () => {
		const h = harness("unknown-fields-get", { judge: "ok" });
		const { id } = await h.bakeoffs.create(request());
		const bakeoff = await done(h, id);
		// The dispatch reads `frame.id` and nothing else.
		const frame = { t: "bakeoff-get", reqId: 9, id, futureOption: true, entry: "A", cwd: 5 };
		expect(await h.bakeoffs.get(frame.id)).toEqual(bakeoff);
	});

	it("still refuses a field it does know when the value is wrong", () => {
		expect(() => checkBakeoffCreate(fromFrame({ ...request(), futureOption: true, mode: "bogus" }))).toThrow(
			"invalid mode",
		);
	});
});
