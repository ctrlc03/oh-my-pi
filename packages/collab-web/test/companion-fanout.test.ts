import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RunInfo } from "../src/lib/companion";
import type { FanoutGroup } from "../src/lib/fanout";
import { hostFanout, splitBudget } from "../src/lib/fanout";
import {
	type CompareHost,
	compareGroup,
	fanoutBranch,
	keepRun,
	loadGroups,
	MAX_GROUPS,
	parseFanoutRequest,
	parseKeepRequest,
	parseModelList,
	pickVerify,
	saveGroups,
	startFanout,
	withGroup,
} from "../scripts/companion-fanout";

let tmp: string;
let repo: string;
let worktrees: string;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err);
	return out.trim();
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-fanout-")));
	repo = path.join(tmp, "repo");
	worktrees = path.join(tmp, "worktrees");
	await fs.mkdir(repo);
	await run(repo, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(repo, "git", "config", key, value);
	}
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "init");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const request = (over: Record<string, unknown> = {}) => ({
	cwd: "/tmp/x",
	prompt: "fix it",
	models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
	...over,
});

describe("parseFanoutRequest", () => {
	it("takes 2 to 4 distinct models and a prompt", () => {
		expect(parseFanoutRequest(request()).models).toHaveLength(2);
		const four = ["a/1", "b/2", "c/3", "d/4"];
		expect(parseFanoutRequest(request({ models: four })).models).toEqual(four);
		for (const bad of [
			{ models: ["a/1"] },
			{ models: ["a/1", "b/2", "c/3", "d/4", "e/5"] },
			{ models: ["a/1", "a/1"] },
		]) {
			expect(() => parseFanoutRequest(request(bad))).toThrow();
		}
		expect(() => parseFanoutRequest(request({ prompt: "  " }))).toThrow("prompt");
		expect(() => parseFanoutRequest(request({ cwd: "relative" }))).toThrow("absolute");
	});

	it("refuses models that would read as flags or carry spaces", () => {
		for (const model of ["--yolo", "a b/c", "", "x\n/y"]) {
			expect(() => parseFanoutRequest(request({ models: [model, "b/2"] }))).toThrow("invalid model");
		}
	});

	it("checks the budget and that each session gets at least a cent", () => {
		expect(parseFanoutRequest(request({ budgetUsd: 3 })).budgetUsd).toBe(3);
		for (const budgetUsd of [0, -1, Number.NaN, "5", 20_000, 0.01]) {
			expect(() => parseFanoutRequest(request({ budgetUsd }))).toThrow();
		}
	});

	it("splits the budget evenly in whole cents, rounding down", () => {
		expect(splitBudget(10, 3)).toBe(3.33);
		expect(splitBudget(2, 4)).toBe(0.5);
	});
});

describe("parseKeepRequest", () => {
	it("needs removeOthers for discardDirty", () => {
		const keep = { group: "abc123", keep: "inst1", removeOthers: true, discardDirty: true };
		expect(parseKeepRequest(keep)).toEqual(keep);
		expect(() => parseKeepRequest({ ...keep, removeOthers: false })).toThrow();
		expect(() => parseKeepRequest({ ...keep, group: "../x" })).toThrow("group");
	});
});

describe("fanoutBranch", () => {
	it("is a valid unique branch name whatever the model id holds", async () => {
		const names = ["anthropic/claude-sonnet-4-5", "bedrock/anthropic.claude-3:0", "x/@@@"].map((model, i) =>
			fanoutBranch("0123456789ab", i, model),
		);
		expect(new Set(names).size).toBe(3);
		for (const name of names) await run(repo, "git", "check-ref-format", "--branch", name);
	});
});

describe("startFanout", () => {
	it("makes one worktree per model, starts one session each with its model and share of the budget", async () => {
		const launched: { cwd: string; model: string; prompt: string; maxCostUsd?: number }[] = [];
		const group = await startFanout(
			parseFanoutRequest({ cwd: repo, prompt: "fix it", models: ["a/1", "b/2", "c/3"], budgetUsd: 10 }),
			{
				worktreesDir: worktrees,
				launch: async input => {
					launched.push(input);
					return `inst${launched.length}`;
				},
			},
		);
		expect(group.runs.map(r => r.model)).toEqual(["a/1", "b/2", "c/3"]);
		expect(new Set(group.runs.map(r => r.path)).size).toBe(3);
		expect(new Set(group.runs.map(r => r.branch)).size).toBe(3);
		for (const r of group.runs) {
			expect(await run(r.path, "git", "symbolic-ref", "--short", "HEAD")).toBe(r.branch);
			expect(r.maxCostUsd).toBe(3.33);
		}
		expect(launched.map(l => l.model).sort()).toEqual(["a/1", "b/2", "c/3"]);
		expect(new Set(launched.map(l => l.cwd))).toEqual(new Set(group.runs.map(r => r.path)));
		expect(launched.every(l => l.prompt === "fix it" && l.maxCostUsd === 3.33)).toBe(true);
		expect(group.runs.map(r => r.instanceId).every(Boolean)).toBe(true);
		expect(Object.keys(hostFanout([group])).sort()).toEqual(["inst1", "inst2", "inst3"]);
	});

	it("uses the branch prefix, runs the setup in each tree before its session and drops a run whose setup fails", async () => {
		const setUp: string[] = [];
		const launched: string[] = [];
		const group = await startFanout(parseFanoutRequest({ cwd: repo, prompt: "p", models: ["u/ok", "u/bad"] }), {
			worktreesDir: worktrees,
			branchPrefix: "team/",
			setup: async tree => {
				setUp.push(tree.path);
				if (tree.branch.endsWith("-u-bad")) throw new Error("install failed");
			},
			launch: async input => {
				launched.push(input.model);
				return "u-ok";
			},
		});
		expect(group.runs.every(r => r.branch.startsWith("team/fan-"))).toBe(true);
		expect(setUp).toHaveLength(2);
		expect(launched).toEqual(["u/ok"]);
		const bad = group.runs.find(r => r.model === "u/bad");
		expect(bad?.error).toContain("install failed");
		expect(bad?.instanceId).toBeUndefined();
	});

	it("records a session that failed to start and discards only its worktree and branch", async () => {
		const group = await startFanout(parseFanoutRequest({ cwd: repo, prompt: "p", models: ["f/ok", "f/bad"] }), {
			worktreesDir: worktrees,
			launch: async input => {
				if (input.model === "f/bad") throw new Error("omp did not start");
				return "okinst";
			},
		});
		const [ok, bad] = group.runs;
		expect(ok!.instanceId).toBe("okinst");
		expect(bad!.error).toBe("omp did not start");
		expect(await fs.stat(ok!.path).catch(() => null)).not.toBeNull();
		expect(await fs.stat(bad!.path).catch(() => null)).toBeNull();
		expect(await run(repo, "git", "branch", "--list", bad!.branch)).toBe("");
		expect(hostFanout([group])).toEqual({ okinst: { group: group.id, model: "f/ok" } });
	});

	it("rejects and leaves nothing behind when no session starts or the folder is no repository", async () => {
		const before = await run(repo, "git", "branch", "--format=%(refname:short)");
		await expect(
			startFanout(parseFanoutRequest({ cwd: repo, prompt: "p", models: ["x/1", "y/2"] }), {
				worktreesDir: worktrees,
				launch: async () => {
					throw new Error("tmux is not installed");
				},
			}),
		).rejects.toThrow("tmux is not installed");
		expect(await run(repo, "git", "branch", "--format=%(refname:short)")).toBe(before);
		await expect(
			startFanout(parseFanoutRequest({ cwd: tmp, prompt: "p", models: ["x/1", "y/2"] }), {
				worktreesDir: worktrees,
				launch: async () => "never",
			}),
		).rejects.toThrow("not a git repository");
	});

	it("mixes omp models and vendor agents: each run records its agent, and the launch knows the group", async () => {
		const claude = { id: "claude", name: "Claude Code" };
		const models = [
			"anthropic/claude-sonnet-4-5",
			"agent:claude/sonnet",
			"agent:opencode/anthropic/claude-sonnet-4-5[1m]",
		];
		const launched: { model: string; group: string }[] = [];
		const group = await startFanout(parseFanoutRequest({ cwd: repo, prompt: "p", models, budgetUsd: 3 }), {
			worktreesDir: worktrees,
			agentRef: model =>
				model.startsWith("agent:claude/")
					? claude
					: model.startsWith("agent:")
						? { id: "opencode", name: "OpenCode" }
						: undefined,
			launch: async input => {
				launched.push({ model: input.model, group: input.group });
				// Concurrent launches finish in any order: the id follows the model, not the arrival.
				return `mix${models.indexOf(input.model) + 1}`;
			},
		});
		expect(group.runs.map(r => [r.model, r.agent?.id])).toEqual([
			[models[0], undefined],
			[models[1], "claude"],
			[models[2], "opencode"],
		]);
		expect(launched.map(l => l.model).sort()).toEqual([...models].sort());
		expect(new Set(launched.map(l => l.group))).toEqual(new Set([group.id]));
		// Every member gets its share of the budget, vendor agent or not.
		expect(group.runs.map(r => r.maxCostUsd)).toEqual([1, 1, 1]);
		const byHost = hostFanout([group]);
		expect(byHost.mix1).toEqual({ group: group.id, model: models[0] });
		expect(byHost.mix2).toEqual({ group: group.id, model: models[1], agent: claude });
		const compare = await compareGroup(group, {
			hosts: () => [],
			cost: () => null,
			review: async () => null,
			runs: () => [],
		});
		expect(compare.runs.map(r => r.agent?.id)).toEqual([undefined, "claude", "opencode"]);
	});
});

describe("keepRun and compareGroup", () => {
	let group: FanoutGroup;
	let hosts: CompareHost[];

	const host = (instanceId: string, cwd: string, over: Partial<CompareHost> = {}): CompareHost => ({
		instanceId,
		cwd,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	});

	beforeAll(async () => {
		group = await startFanout(
			parseFanoutRequest({ cwd: repo, prompt: "keep test", models: ["k/one", "k/two", "k/three"] }),
			{ worktreesDir: worktrees, launch: async input => `k-${input.model.split("/")[1]}` },
		);
	});

	const keepDeps = (stopped: string[]) => ({
		worktreesDir: worktrees,
		hosts: async () => hosts,
		runningCwds: async () => hosts.map(h => h.cwd),
		dirty: async (folder: string) => {
			if (!(await fs.stat(folder).catch(() => null))) return null;
			return (await run(folder, "git", "status", "--porcelain=v1", "-uall")) !== "";
		},
		stop: async (instanceId: string) => {
			stopped.push(instanceId);
			hosts = hosts.filter(h => h.instanceId !== instanceId);
		},
		sleep: async () => {},
	});

	it("compares status, spend, changed files and the verify result", async () => {
		const [one, two, three] = group.runs;
		hosts = [
			host("k-one", one!.path, { busy: true }),
			host("k-two", two!.path, { inputRequired: true }),
			host("k-three", three!.path),
		];
		await fs.writeFile(path.join(one!.path, "a.txt"), "one\ntwo\nthree\nfour\n");
		await fs.writeFile(path.join(one!.path, "new.txt"), "x\n");
		const passing: RunInfo = {
			runId: "r1",
			instanceId: "k-three",
			targetId: "package:test",
			command: "bun test",
			startedAt: 5,
			endedAt: 9,
			state: "exited",
			exitCode: 0,
			signal: null,
		};
		const compare = await compareGroup(group, {
			hosts: () => hosts,
			cost: folder => (folder === one!.path ? 0.42 : null),
			review: async folder => {
				const files = (await run(folder, "git", "status", "--porcelain=v1", "-uall")).split("\n").filter(Boolean);
				return {
					dirty: files.length > 0,
					files: files.map(() => ({ added: 1, removed: 0 })),
					pr: null,
				};
			},
			runs: instanceId => (instanceId === "k-three" ? [passing] : []),
		});
		expect(compare.runs.map(r => r.status)).toEqual(["working", "needs-input", "idle"]);
		expect(compare.runs[0]).toMatchObject({
			costUsd: 0.42,
			files: 2,
			added: 2,
			removed: 0,
			dirty: true,
			verify: null,
		});
		expect(compare.runs[2]).toMatchObject({
			costUsd: null,
			files: 0,
			dirty: false,
			verify: { command: "bun test", ok: true },
		});
		expect(compare.kept).toBeNull();
	});

	it("keeps the winner, removes clean others, and refuses dirty ones without a discard confirmation", async () => {
		const [one, two, three] = group.runs;
		// `one` is dirty (written above), `two` and `three` are clean.
		const stopped: string[] = [];
		hosts = [host("k-one", one!.path), host("k-two", two!.path), host("k-three", three!.path)];
		const result = await keepRun(
			group,
			{ group: group.id, keep: "k-two", removeOthers: true, discardDirty: false },
			keepDeps(stopped),
		);
		expect(group.kept).toBe("k-two");
		expect(result.removed).toEqual(["k/three"]);
		expect(result.skipped).toEqual([{ model: "k/one", reason: expect.stringContaining("uncommitted") }]);
		expect(stopped).toEqual(["k-three"]);
		expect(await fs.stat(three!.path).catch(() => null)).toBeNull();
		expect(await run(repo, "git", "branch", "--list", three!.branch)).toContain(three!.branch);
		// The dirty worktree and its file are untouched, and its session is still running.
		expect(await fs.readFile(path.join(one!.path, "new.txt"), "utf8")).toBe("x\n");
		expect(hosts.map(h => h.instanceId)).toEqual(["k-one", "k-two"]);
		expect(group.runs[2]!.removed).toBe(true);
		expect(hostFanout([group])).not.toHaveProperty("k-three");
	});

	it("removes a dirty worktree only when told to discard, ending its session first", async () => {
		const [one, two] = group.runs;
		const stopped: string[] = [];
		const result = await keepRun(
			group,
			{ group: group.id, keep: "k-two", removeOthers: true, discardDirty: true },
			keepDeps(stopped),
		);
		expect(result.removed).toEqual(["k/one"]);
		expect(stopped).toEqual(["k-one"]);
		expect(await fs.stat(one!.path).catch(() => null)).toBeNull();
		expect(await fs.stat(two!.path).catch(() => null)).not.toBeNull();
	});

	it("keeps without removing anything, and refuses a session outside the group", async () => {
		const result = await keepRun(
			group,
			{ group: group.id, keep: "k-two", removeOthers: false, discardDirty: false },
			keepDeps([]),
		);
		expect(result).toEqual({ removed: [], skipped: [] });
		await expect(
			keepRun(group, { group: group.id, keep: "other", removeOthers: true, discardDirty: true }, keepDeps([])),
		).rejects.toThrow("not part of this group");
	});

	it("never removes a worktree a session is still running in when it would not end", async () => {
		const fresh = await startFanout(parseFanoutRequest({ cwd: repo, prompt: "p", models: ["s/a", "s/b"] }), {
			worktreesDir: worktrees,
			launch: async input => `s-${input.model.split("/")[1]}`,
		});
		hosts = fresh.runs.map(r => host(r.instanceId!, r.path));
		const stubborn = { ...keepDeps([]), stop: async () => {}, stopWaitMs: 50, sleep: Bun.sleep };
		const result = await keepRun(
			fresh,
			{ group: fresh.id, keep: "s-a", removeOthers: true, discardDirty: false },
			stubborn,
		);
		expect(result.removed).toEqual([]);
		expect(result.skipped[0]!.reason).toContain("still running");
		expect(await fs.stat(fresh.runs[1]!.path).catch(() => null)).not.toBeNull();
	}, 20_000);
});

describe("pickVerify", () => {
	const base: RunInfo = {
		runId: "r",
		instanceId: "i",
		targetId: "package:build",
		command: "bun run build",
		startedAt: 1,
		endedAt: 2,
		state: "exited",
		exitCode: 0,
		signal: null,
	};
	it("takes the newest finished test-like run and reads its exit code", () => {
		expect(pickVerify([base])).toBeNull();
		const older = { ...base, targetId: "package:test", command: "bun test", startedAt: 3, state: "exited" as const };
		const newer = {
			...older,
			command: "bun run typecheck",
			targetId: "package:typecheck",
			startedAt: 9,
			exitCode: 2,
		};
		expect(pickVerify([older, newer])).toEqual({ command: "bun run typecheck", ok: false });
		expect(pickVerify([{ ...older, state: "running", exitCode: null }])).toBeNull();
		expect(pickVerify([{ ...older, state: "stopped", exitCode: null }])).toEqual({ command: "bun test", ok: false });
	});
});

describe("group storage", () => {
	it("round-trips groups, drops malformed ones and keeps the newest MAX_GROUPS", async () => {
		const file = path.join(tmp, "fanout.json");
		const make = (id: string): FanoutGroup => ({
			id,
			root: repo,
			prompt: "p",
			createdAt: 1,
			runs: [{ model: "a/1", branch: "b", path: "/x", instanceId: "i1" }],
		});
		let groups: FanoutGroup[] = [];
		for (let i = 0; i < MAX_GROUPS + 3; i++) groups = withGroup(groups, make(`g${i}`));
		expect(groups).toHaveLength(MAX_GROUPS);
		expect(groups[0]!.id).toBe(`g${MAX_GROUPS + 2}`);
		await saveGroups(file, groups);
		expect(await loadGroups(file)).toEqual(groups);
		await fs.writeFile(
			file,
			JSON.stringify({ groups: [{ id: "bad id!" }, make("ok"), { ...make("x"), runs: [1] }] }),
		);
		expect((await loadGroups(file)).map(g => g.id)).toEqual(["ok"]);
		await fs.writeFile(file, "not json");
		expect(await loadGroups(file)).toEqual([]);
	});

	it("keeps the agent of a run, and reads groups saved before there were agents", async () => {
		const file = path.join(tmp, "fanout-agents.json");
		const group: FanoutGroup = {
			id: "ag1",
			root: repo,
			prompt: "p",
			createdAt: 1,
			runs: [
				{ model: "a/1", branch: "b1", path: "/x1", instanceId: "i1" },
				{
					model: "agent:codex/",
					agent: { id: "codex", name: "Codex" },
					branch: "b2",
					path: "/x2",
					instanceId: "i2",
				},
			],
		};
		await saveGroups(file, [group]);
		const [loaded] = await loadGroups(file);
		expect(loaded?.runs.map(r => r.agent)).toEqual([undefined, { id: "codex", name: "Codex" }]);
		await fs.writeFile(
			file,
			JSON.stringify({ groups: [{ ...group, runs: [{ ...group.runs[1], agent: { id: 5 } }] }] }),
		);
		expect((await loadGroups(file))[0]?.runs[0]?.agent).toBeUndefined();
	});
});

describe("parseModelList", () => {
	it("reads `omp models --json` and skips unusable selectors", () => {
		const json = JSON.stringify({
			models: [
				{ provider: "anthropic", id: "claude", selector: "anthropic/claude", name: "Claude" },
				{ provider: "x", id: "weird id", selector: "x/weird id", name: "Bad" },
				{ provider: "openai", id: "gpt-5" },
			],
		});
		expect(parseModelList(json)).toEqual([
			{ selector: "anthropic/claude", provider: "anthropic", name: "Claude" },
			{ selector: "openai/gpt-5", provider: "openai", name: "gpt-5" },
		]);
		expect(parseModelList("nope")).toEqual([]);
	});
});
