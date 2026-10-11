import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRef, CompanionAgent, CompanionHost, SessionOverview, UsageReport } from "../src/lib/companion";
import {
	createAgentDirectory,
	createAgentHandlers,
	createForeignCatalog,
	fanoutArg,
	type ForeignRow,
	type ForeignRows,
	type ForeignStartDeps,
	foreignFanoutModels,
	foreignMaxCost,
	mergeForeignUsage,
	mergeOverviews,
	parseCustomAgentInput,
	parseTranscript,
	planForeignStart,
	usageRangeStart,
	mergeFileSessions,
	withAgents,
	withForeignRows,
	withForeignSpend,
} from "../scripts/companion-foreign";

const DAY = 24 * 60 * 60 * 1000;

function agent(over: Partial<CompanionAgent> & { id: string }): CompanionAgent {
	return {
		name: over.id,
		kind: over.id.startsWith("custom:") ? "custom" : "builtin",
		installed: true,
		version: "1.0.0",
		auth: "ok",
		installable: false,
		installCommand: null,
		loginCommand: null,
		...over,
	};
}

function row(over: Partial<ForeignRow> = {}): ForeignRow {
	return {
		agent: "claude",
		nativeId: null,
		cwd: "/work/app",
		title: null,
		model: null,
		createdAt: 1_000,
		lastActive: 2_000,
		permission: "supervised",
		worktree: false,
		adapterVersion: null,
		...over,
	};
}

function host(over: Partial<CompanionHost> & { sessionId: string }): CompanionHost {
	return {
		instanceId: `inst-${over.sessionId}`,
		sessionName: null,
		cwd: "/work/app",
		model: null,
		startedAt: 1_000,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

describe("agent requests", () => {
	function recorder(ready: boolean) {
		const calls: string[] = [];
		const list = [agent({ id: "claude" })];
		const handlers = createAgentHandlers({
			ready: async () => ready,
			list: async refresh => {
				calls.push(`list:${refresh}`);
				return list;
			},
			install: async id => {
				calls.push(`install:${id}`);
				return list;
			},
			saveCustom: async input => {
				calls.push(`save:${JSON.stringify(input)}`);
				return list;
			},
			deleteCustom: async id => {
				calls.push(`delete:${id}`);
				return list;
			},
		});
		return { calls, handlers, list };
	}

	it("answers with the agent list when the computer can run agents", async () => {
		const { calls, handlers, list } = recorder(true);
		expect(await handlers.list(undefined)).toBe(list);
		expect(await handlers.list(true)).toBe(list);
		expect(calls).toEqual(["list:false", "list:true"]);
	});

	it("refuses every request when tmux or the host entry is missing", async () => {
		const { calls, handlers } = recorder(false);
		const refusal = /cannot run other agents/;
		await expect(handlers.list(false)).rejects.toThrow(refusal);
		await expect(handlers.install("claude")).rejects.toThrow(refusal);
		await expect(handlers.saveCustom({ name: "x", command: ["x"] })).rejects.toThrow(refusal);
		await expect(handlers.deleteCustom("custom:x")).rejects.toThrow(refusal);
		expect(calls).toEqual([]);
	});

	it("installs only the built-in agents, by exact id", async () => {
		const { calls, handlers } = recorder(true);
		await handlers.install("opencode");
		await expect(handlers.install("custom:mine")).rejects.toThrow("not installed by the companion");
		for (const bad of ["claude; rm -rf ~", "Claude", "", 5, undefined, "claude\n"])
			await expect(handlers.install(bad)).rejects.toThrow("unknown agent");
		expect(calls).toEqual(["install:opencode"]);
	});

	it("removes only custom agents", async () => {
		const { calls, handlers } = recorder(true);
		await handlers.deleteCustom("custom:mine");
		await expect(handlers.deleteCustom("claude")).rejects.toThrow("only a custom agent");
		await expect(handlers.deleteCustom("custom:UP")).rejects.toThrow("unknown agent");
		expect(calls).toEqual(["delete:custom:mine"]);
	});

	it("refuses a refresh that is not a boolean", async () => {
		const { handlers } = recorder(true);
		await expect(handlers.list("yes")).rejects.toThrow("invalid request");
	});

	it("saves a custom agent as an argument list that no shell sees", async () => {
		const { calls, handlers } = recorder(true);
		await handlers.saveCustom({
			id: "custom:mine",
			name: "  Mine  ",
			command: ["my-agent", "--flag", "a value; rm -rf ~", "$(touch pwned)"],
			env: { TOKEN_FILE: "/tmp/t" },
		});
		expect(JSON.parse(calls[0]!.slice("save:".length))).toEqual({
			id: "custom:mine",
			name: "Mine",
			command: ["my-agent", "--flag", "a value; rm -rf ~", "$(touch pwned)"],
			env: { TOKEN_FILE: "/tmp/t" },
		});
	});

	it("rejects a custom agent whose command is a shell string, empty, or malformed", () => {
		expect(() => parseCustomAgentInput({ name: "x", command: "my-agent --flag" })).toThrow("list of arguments");
		expect(() => parseCustomAgentInput({ name: "x", command: [] })).toThrow("list of arguments");
		expect(() => parseCustomAgentInput({ name: "x", command: [1] })).toThrow("list of arguments");
		expect(() => parseCustomAgentInput({ name: "x", command: ["a\0b"] })).toThrow("list of arguments");
		expect(() => parseCustomAgentInput({ name: "x", command: ["  "] })).toThrow("the command is empty");
		expect(() => parseCustomAgentInput({ name: "", command: ["x"] })).toThrow("short name");
		expect(() => parseCustomAgentInput({ name: "a\nb", command: ["x"] })).toThrow("short name");
		expect(() => parseCustomAgentInput({ id: "claude", name: "x", command: ["x"] })).toThrow("invalid agent id");
		expect(() => parseCustomAgentInput({ name: "x", command: ["x"], env: { "A B": "1" } })).toThrow(
			"invalid environment",
		);
		expect(() => parseCustomAgentInput({ name: "x", command: ["x"], env: { A: 1 } })).toThrow("invalid environment");
		expect(() => parseCustomAgentInput(null)).toThrow("invalid agent");
	});
});

describe("agent names", () => {
	it("names agents as last listed and falls back to the id", () => {
		const names = createAgentDirectory();
		expect(names.ref("codex")).toEqual({ id: "codex", name: "codex" });
		names.remember([{ id: "codex", name: "Codex" }]);
		expect(names.ref("codex")).toEqual({ id: "codex", name: "Codex" });
	});
});

describe("foreignMaxCost", () => {
	const none = { limits: null, spentTodayUsd: 0, spentBySessionUsd: 0 };

	it("is undefined when nothing limits the session", () => {
		expect(foreignMaxCost(none)).toBeUndefined();
		expect(foreignMaxCost({ ...none, limits: { dailyUsd: null, sessionUsd: null } })).toBeUndefined();
	});

	it("takes the requested cap as it is", () => {
		expect(foreignMaxCost({ ...none, requestedUsd: 1.5 })).toBe(1.5);
	});

	it("is what the per-session limit leaves, in whole cents", () => {
		const limits = { dailyUsd: null, sessionUsd: 2 };
		expect(foreignMaxCost({ ...none, limits })).toBe(2);
		expect(foreignMaxCost({ ...none, limits, spentBySessionUsd: 0.505 })).toBe(1.49);
	});

	it("is what today's limit leaves", () => {
		expect(foreignMaxCost({ ...none, limits: { dailyUsd: 10, sessionUsd: null }, spentTodayUsd: 7.25 })).toBe(2.75);
	});

	it("is the smallest of the caps", () => {
		const limits = { dailyUsd: 10, sessionUsd: 3 };
		expect(foreignMaxCost({ limits, spentTodayUsd: 9, spentBySessionUsd: 0, requestedUsd: 5 })).toBe(1);
		expect(foreignMaxCost({ limits, spentTodayUsd: 0, spentBySessionUsd: 0, requestedUsd: 0.5 })).toBe(0.5);
		expect(foreignMaxCost({ limits, spentTodayUsd: 0, spentBySessionUsd: 0, requestedUsd: 5 })).toBe(3);
	});

	it("refuses a start when a limit is used up", () => {
		expect(() =>
			foreignMaxCost({ limits: { dailyUsd: 5, sessionUsd: null }, spentTodayUsd: 5, spentBySessionUsd: 0 }),
		).toThrow("today's spend limit");
		expect(() =>
			foreignMaxCost({ limits: { dailyUsd: null, sessionUsd: 1 }, spentTodayUsd: 0, spentBySessionUsd: 0.995 }),
		).toThrow("per-session spend limit");
	});
});

describe("planForeignStart", () => {
	const agents = [
		agent({ id: "claude", name: "Claude Code" }),
		agent({ id: "codex", name: "Codex", auth: "needed", loginCommand: "codex login" }),
		agent({ id: "cursor", name: "Cursor", installed: false }),
		agent({ id: "opencode", name: "OpenCode" }),
	];
	const rows: ForeignRows = {
		"claude-0123456789abcdef": row({ agent: "claude", cwd: "/work/old", permission: "full" }),
		"opencode-fedcba9876543210": row({ agent: "opencode", cwd: "/work/other" }),
	};

	function deps(over: Partial<ForeignStartDeps> = {}): ForeignStartDeps {
		return {
			agents: async () => agents,
			rows: async () => rows,
			limits: () => null,
			spentToday: async () => 0,
			sessionSpend: async () => 0,
			...over,
		};
	}

	it("leaves an omp start alone", async () => {
		expect(await planForeignStart({ cwd: "/work/app" }, deps())).toBeNull();
		expect(await planForeignStart({ cwd: "/work/app", resume: "0123abcd" }, deps())).toBeNull();
	});

	it("refuses a model or permission without an agent", async () => {
		await expect(planForeignStart({ cwd: "/w", model: "sonnet" }, deps())).rejects.toThrow("invalid request");
		await expect(planForeignStart({ cwd: "/w", permission: "full" }, deps())).rejects.toThrow("invalid request");
	});

	it("plans a new session of an installed agent, supervised unless told otherwise", async () => {
		const plan = await planForeignStart({ agent: "claude", cwd: "/work/app", model: "sonnet" }, deps());
		expect(plan).toMatchObject({
			cwd: "/work/app",
			model: "sonnet",
			permission: "supervised",
			maxCostUsd: undefined,
		});
		expect(plan?.agent.id).toBe("claude");
		expect(plan?.resume).toBeUndefined();
		expect((await planForeignStart({ agent: "claude", cwd: "/w", permission: "full" }, deps()))?.permission).toBe(
			"full",
		);
		expect((await planForeignStart({ agent: "claude", cwd: "/w", model: "" }, deps()))?.model).toBeUndefined();
	});

	it("refuses an agent that is missing, unknown, or not signed in, with what to do about it", async () => {
		await expect(planForeignStart({ agent: "cursor", cwd: "/w" }, deps())).rejects.toThrow("Cursor is not installed");
		await expect(planForeignStart({ agent: "codex", cwd: "/w" }, deps())).rejects.toThrow("`codex login`");
		await expect(planForeignStart({ agent: "grok", cwd: "/w" }, deps())).rejects.toThrow("unknown agent");
		await expect(planForeignStart({ agent: "nope", cwd: "/w" }, deps())).rejects.toThrow("unknown agent");
		await expect(planForeignStart({ agent: "claude; id", cwd: "/w" }, deps())).rejects.toThrow("unknown agent");
		await expect(planForeignStart({ agent: 5, cwd: "/w" }, deps())).rejects.toThrow("invalid request");
	});

	it("takes only models and permissions that cannot be an option or a command", async () => {
		for (const model of ["-rf", "a b", "$(id)", "x;y", "a\nb", `${"m".repeat(300)}`])
			await expect(planForeignStart({ agent: "claude", cwd: "/w", model }, deps())).rejects.toThrow("invalid model");
		await expect(planForeignStart({ agent: "claude", cwd: "/w", model: 4 }, deps())).rejects.toThrow("invalid model");
		await expect(planForeignStart({ agent: "claude", cwd: "/w", permission: "root" }, deps())).rejects.toThrow(
			"invalid permission",
		);
		const plan = await planForeignStart(
			{ agent: "opencode", cwd: "/w", model: "anthropic/claude-sonnet-4-5" },
			deps(),
		);
		expect(plan?.model).toBe("anthropic/claude-sonnet-4-5");
	});

	it("refuses a sandboxed start: other agents run unsandboxed for now", async () => {
		for (const id of ["claude", "opencode"])
			await expect(planForeignStart({ agent: id, cwd: "/w", sandboxed: true }, deps())).rejects.toThrow(
				"cannot run sandboxed",
			);
		await expect(
			planForeignStart({ resume: "claude-0123456789abcdef", cwd: "/w", sandboxed: true }, deps()),
		).rejects.toThrow("cannot run sandboxed");
		expect(await planForeignStart({ agent: "claude", cwd: "/w", sandboxed: false }, deps())).not.toBeNull();
	});

	it("resumes a session of the index in its own folder, with its own agent and permission", async () => {
		const plan = await planForeignStart({ resume: "claude-0123456789abcdef", cwd: "/elsewhere" }, deps());
		expect(plan).toMatchObject({ cwd: "/work/old", resume: "claude-0123456789abcdef", permission: "full" });
		expect(plan?.agent.id).toBe("claude");
		const asked = await planForeignStart(
			{ resume: "claude-0123456789abcdef", agent: "claude", cwd: "/elsewhere", permission: "supervised" },
			deps(),
		);
		expect(asked?.permission).toBe("supervised");
	});

	it("refuses to resume with another agent, or a session the index does not have", async () => {
		await expect(
			planForeignStart({ resume: "claude-0123456789abcdef", agent: "opencode", cwd: "/w" }, deps()),
		).rejects.toThrow("belongs to another agent");
		await expect(
			planForeignStart({ resume: "claude-aaaaaaaaaaaaaaaa", agent: "claude", cwd: "/w" }, deps()),
		).rejects.toThrow("not one of this computer's agent sessions");
		await expect(planForeignStart({ resume: "__proto__", agent: "claude", cwd: "/w" }, deps())).rejects.toThrow(
			"not one of this computer's agent sessions",
		);
	});

	it("caps the spend from the limits", async () => {
		const limits = { dailyUsd: 10, sessionUsd: 4 };
		const plan = await planForeignStart(
			{ agent: "claude", cwd: "/w", maxCostUsd: 8 },
			deps({ limits: () => limits, spentToday: async () => 7 }),
		);
		expect(plan?.maxCostUsd).toBe(3);
		const resumed = await planForeignStart(
			{ resume: "claude-0123456789abcdef", cwd: "/w" },
			deps({ limits: () => limits, sessionSpend: async () => 3.5 }),
		);
		expect(resumed?.maxCostUsd).toBe(0.5);
		await expect(
			planForeignStart({ agent: "claude", cwd: "/w" }, deps({ limits: () => limits, spentToday: async () => 10 })),
		).rejects.toThrow("today's spend limit");
	});

	it("does not read the spend when no limit is set", async () => {
		const plan = await planForeignStart(
			{ agent: "claude", cwd: "/w" },
			deps({
				spentToday: async () => {
					throw new Error("read");
				},
				sessionSpend: async () => {
					throw new Error("read");
				},
			}),
		);
		expect(plan?.maxCostUsd).toBeUndefined();
	});
});

describe("fan-out of vendor agents", () => {
	it("offers the models of ready agents, tagged with their agent, and a default for those without a list", () => {
		const models = foreignFanoutModels([
			agent({
				id: "claude",
				name: "Claude Code",
				models: [
					{ id: "sonnet", name: "Sonnet" },
					{ id: "bad model", name: "x" },
				],
			}),
			agent({ id: "codex", name: "Codex", auth: "needed" }),
			agent({ id: "cursor", name: "Cursor", installed: false }),
			agent({ id: "opencode", name: "OpenCode" }),
		]);
		expect(models).toEqual([
			{
				selector: "agent:claude/sonnet",
				name: "Sonnet",
				provider: "Claude Code",
				agent: { id: "claude", name: "Claude Code" },
			},
			{
				selector: "agent:opencode/",
				name: "OpenCode (default model)",
				provider: "OpenCode",
				agent: { id: "opencode", name: "OpenCode" },
			},
		]);
	});

	it("records the group, the selector and the agent a member host belongs to", () => {
		expect(JSON.parse(fanoutArg("g1", "agent:claude/sonnet", { id: "claude", name: "Claude Code" }))).toEqual({
			group: "g1",
			model: "agent:claude/sonnet",
			agent: { id: "claude", name: "Claude Code" },
		});
	});
});

function transcript(...lines: object[]): string {
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

function assistant(at: string, model: string, cost: number | undefined, tools = 0, tokens = 10) {
	return {
		type: "message",
		id: at,
		timestamp: at,
		message: {
			role: "assistant",
			model,
			content: [
				{ type: "text", text: "ok" },
				...Array.from({ length: tools }, () => ({ type: "toolCall", name: "bash" })),
			],
			usage: {
				input: tokens,
				output: tokens,
				cacheRead: 0,
				cacheWrite: 0,
				...(cost === undefined ? {} : { cost: { total: cost } }),
			},
		},
	};
}

describe("parseTranscript", () => {
	it("counts requests, tool calls, cost and the title of omp-shaped entries", () => {
		const stats = parseTranscript(
			transcript(
				{ type: "session", id: "s", title: "Header" },
				{ type: "message", timestamp: "2026-03-01T10:00:00.000Z", message: { role: "user", content: "hi" } },
				assistant("2026-03-01T10:01:00.000Z", "sonnet", 0.25, 2),
				{ type: "title_change", title: "Renamed" },
				assistant("2026-03-01T10:02:00.000Z", "sonnet", undefined, 1),
			) + '{"type":"message","timestamp":"2026',
		);
		expect(stats.title).toBe("Renamed");
		expect(stats.toolCalls).toBe(3);
		expect(stats.events.map(e => [e.model, e.cost, e.input + e.output])).toEqual([
			["sonnet", 0.25, 20],
			["sonnet", null, 20],
		]);
		expect(stats.lastAt).toBe(Date.parse("2026-03-01T10:02:00.000Z"));
	});

	it("prefers the title slot over later changes", () => {
		expect(
			parseTranscript(transcript({ type: "title", title: "Slot" }, { type: "title_change", title: "Other" })).title,
		).toBe("Slot");
		expect(parseTranscript(transcript({ type: "session", id: "s", title: "Header" })).title).toBe("Header");
		expect(parseTranscript("").title).toBeNull();
	});
});

describe("foreign catalog", () => {
	let root: string;
	let workDir: string;
	const now = Date.parse("2026-03-10T12:00:00.000Z");
	const rows: ForeignRows = {};
	const ids = {
		billing: "claude-3f9a1c5e7b2d4a60",
		retry: "opencode-8d2e6b1f0c9a3e47",
		gone: "codex-0000000000000000",
		empty: "claude-1111111111111111",
	};

	function catalog() {
		const names = createAgentDirectory();
		names.remember([
			{ id: "claude", name: "Claude Code" },
			{ id: "opencode", name: "OpenCode" },
		]);
		return createForeignCatalog({ transcriptsDir: root, readRows: async () => rows, agentRef: names.ref });
	}

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "foreign-catalog-")));
		workDir = path.join(root, "work");
		await fs.mkdir(workDir);
		Object.assign(rows, {
			[ids.billing]: row({
				agent: "claude",
				cwd: workDir,
				title: "Split billing",
				model: "sonnet",
				createdAt: now - 5 * DAY,
				lastActive: now - 5 * DAY + 60_000,
			}),
			[ids.retry]: row({
				agent: "opencode",
				cwd: workDir,
				title: null,
				createdAt: now - 3_600_000,
				lastActive: now - 1_000,
			}),
			[ids.gone]: row({
				agent: "codex",
				cwd: path.join(root, "deleted"),
				title: "Old",
				createdAt: 5,
				lastActive: 6,
			}),
			[ids.empty]: row({
				agent: "claude",
				cwd: workDir,
				title: null,
				createdAt: now - 10_000,
				lastActive: now - 9_000,
			}),
		} satisfies ForeignRows);
		await Bun.write(
			path.join(root, `${ids.billing}.jsonl`),
			transcript(
				{ type: "session", id: ids.billing },
				assistant(new Date(now - 5 * DAY).toISOString(), "sonnet", 0.5, 2, 100),
				assistant(new Date(now - 5 * DAY + 60_000).toISOString(), "opus", 1, 0, 50),
			),
		);
		await Bun.write(
			path.join(root, `${ids.retry}.jsonl`),
			transcript(
				{ type: "title_change", title: "Explain the retry queue" },
				assistant(new Date(now - 7_200_000).toISOString(), "gpt-5", 0.125, 1, 20),
				assistant(new Date(now - 1_000).toISOString(), "gpt-5", undefined, 0, 5),
			),
		);
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("lists every session with what its transcript says, newest first once merged", async () => {
		const overviews = await catalog().overviews({}, { hosts: [] });
		const billing = overviews.find(o => o.sessionId === ids.billing);
		expect(billing).toMatchObject({
			title: "Split billing",
			folder: workDir,
			requests: 2,
			toolCalls: 2,
			tokens: 300,
			cost: 1.5,
			models: ["opus", "sonnet"],
			agent: { id: "claude", name: "Claude Code" },
		});
		expect(billing?.instanceId).toBeUndefined();
		expect(billing?.endedAt).toBe(now - 5 * DAY + 60_000);
		const retry = overviews.find(o => o.sessionId === ids.retry);
		expect(retry?.title).toBe("Explain the retry queue");
		expect(retry?.agent).toEqual({ id: "opencode", name: "OpenCode" });
		// A row whose transcript is missing still lists, with nothing counted.
		expect(overviews.find(o => o.sessionId === ids.empty)).toMatchObject({ requests: 0, cost: 0, title: null });
	});

	it("marks a session that hosts, and filters by title or folder", async () => {
		const live = host({ sessionId: ids.retry, instanceId: "inst-9" });
		const overviews = await catalog().overviews({ q: "RETRY" }, { hosts: [live] });
		expect(overviews.map(o => [o.sessionId, o.instanceId, o.live])).toEqual([[ids.retry, "inst-9", "host"]]);
		expect((await catalog().overviews({ q: "/work" }, { hosts: [] })).length).toBe(3);
		expect(await catalog().overviews({ q: "no such thing" }, { hosts: [] })).toEqual([]);
	});

	it("names the agent of a foreign session only", async () => {
		const found = catalog();
		expect(await found.agentOf(ids.billing)).toEqual({ id: "claude", name: "Claude Code" });
		expect(await found.agentOf("0123abcd")).toBeUndefined();
		expect(await found.agentOf("__proto__")).toBeUndefined();
		const hits = await withAgents<{ sessionId: string; n: number; agent?: AgentRef }>(
			[
				{ sessionId: ids.retry, n: 1 },
				{ sessionId: "abcd1234", n: 2 },
			],
			found,
		);
		expect(hits).toEqual([
			{ sessionId: ids.retry, n: 1, agent: { id: "opencode", name: "OpenCode" } },
			{ sessionId: "abcd1234", n: 2 },
		]);
	});

	it("merges a file scan's sessions: foreign ones from the catalog, the rest from omp, in the scan's order", async () => {
		const omp = { sessionId: "omp-1" };
		const scan = [omp, { sessionId: ids.billing }, { sessionId: "gone-1" }];
		const asked: string[][] = [];
		const rows = await mergeFileSessions(scan, catalog(), { hosts: [] }, async found => {
			asked.push(found.map(s => s.sessionId));
			return found.flatMap(s =>
				s.sessionId === "omp-1"
					? [
							{
								sessionId: "omp-1",
								title: "omp one",
								folder: workDir,
								startedAt: 1,
								endedAt: 2,
								requests: 0,
								toolCalls: 0,
								subagents: 0,
								tokens: 0,
								cost: 0,
								models: [],
							},
						]
					: [],
			);
		});
		expect(asked).toEqual([["omp-1", "gone-1"]]);
		expect(rows.map(r => [r.sessionId, r.agent?.id, r.cost])).toEqual([
			["omp-1", undefined, 0],
			[ids.billing, "claude", 1.5],
		]);
	});

	it("merges the sessions into the recent folders, only where the folder still exists", async () => {
		const folders = await catalog().folders([
			{ cwd: workDir, lastActive: 3, sessions: [{ id: "omp-1", title: "omp one", lastActive: 3 }] },
			{ cwd: "/other", lastActive: 1, sessions: [] },
		]);
		const ours = folders.find(f => f.cwd === workDir);
		expect(ours?.sessions.map(s => [s.id, s.agent?.id])).toEqual([
			[ids.retry, "opencode"],
			[ids.empty, "claude"],
			[ids.billing, "claude"],
			["omp-1", undefined],
		]);
		expect(folders.some(f => f.cwd.endsWith("deleted"))).toBe(false);
		expect(folders.map(f => f.cwd)).toEqual([workDir, "/other"]);
	});

	it("reports the requests since a time, with their folder and agent", async () => {
		const events = await catalog().usageSince(now - DAY);
		expect(events.map(e => [e.model, e.cost, e.folder, e.agentId])).toEqual([
			["gpt-5", 0.125, workDir, "opencode"],
			["gpt-5", null, workDir, "opencode"],
		]);
		expect((await catalog().usageSince(0)).length).toBe(4);
	});

	it("adds up the spend of a session, and of every session since a time", async () => {
		const found = catalog();
		expect(await found.sessionSpend(ids.billing)).toBe(1.5);
		expect(await found.sessionSpend(ids.empty)).toBe(0);
		expect(await found.sessionSpend("../etc/passwd")).toBe(0);
		expect(await found.spentSince(now - DAY)).toBe(0.125);
		expect(await found.spentSince(0)).toBe(1.625);
	});

	it("reads a transcript again when it grows", async () => {
		const found = catalog();
		expect(await found.sessionSpend(ids.empty)).toBe(0);
		await Bun.write(
			path.join(root, `${ids.empty}.jsonl`),
			transcript(assistant(new Date(now).toISOString(), "sonnet", 2)),
		);
		expect(await found.sessionSpend(ids.empty)).toBe(2);
		await Bun.write(
			path.join(root, `${ids.empty}.jsonl`),
			transcript(
				assistant(new Date(now).toISOString(), "sonnet", 2),
				assistant(new Date(now).toISOString(), "sonnet", 1),
			),
		);
		expect(await found.sessionSpend(ids.empty)).toBe(3);
	});
});

describe("merging with omp's rows", () => {
	const overview = (sessionId: string, startedAt: number, endedAt: number | null): SessionOverview => ({
		sessionId,
		title: null,
		folder: "/f",
		startedAt,
		endedAt,
		requests: 0,
		toolCalls: 0,
		subagents: 0,
		tokens: 0,
		cost: 0,
		models: [],
	});

	it("orders by last activity and cuts at the limit", () => {
		const merged = mergeOverviews(
			[overview("omp-a", 10, 50), overview("omp-b", 90, null)],
			[overview("foreign-a", 20, 80), overview("foreign-b", 1, 2)],
			3,
		);
		expect(merged.map(o => o.sessionId)).toEqual(["omp-b", "foreign-a", "omp-a"]);
	});

	it("shows a hosting vendor session as unrestricted when its index row exists", () => {
		const hosts = [
			host({ sessionId: "claude-0123456789abcdef", agent: { id: "claude", name: "Claude Code" }, sandboxed: true }),
			host({ sessionId: "omp-session", sandboxed: true }),
		];
		const shown = withForeignRows(hosts, { "claude-0123456789abcdef": row(), "omp-session": row() });
		expect(shown.map(h => h.sandboxed)).toEqual([false, true]);
		expect(shown[1]).toBe(hosts[1]!);
	});

	it("holds back a vendor host whose row is missing, or whose index could not be read", () => {
		const hosts = [
			host({ sessionId: "claude-0123456789abcdef", agent: { id: "claude", name: "Claude Code" }, sandboxed: false }),
			host({ sessionId: "__proto__", agent: { id: "claude", name: "Claude Code" }, sandboxed: false }),
			host({ sessionId: "omp-session", sandboxed: false }),
		];
		expect(withForeignRows(hosts, {}).map(h => h.sandboxed)).toEqual([true, true, false]);
		const others = { "claude-aaaaaaaaaaaaaaaa": row() };
		expect(withForeignRows(hosts, others).map(h => h.sandboxed)).toEqual([true, true, false]);
	});
});

describe("spend of vendor sessions", () => {
	const reading = { dailyUsd: 1, sessions: [{ sessionId: "omp-1", instanceId: "i1", title: "omp", usd: 0.5 }] };
	const catalogOf = (spent: Record<string, number>, today: number) => ({
		spentSince: async () => today,
		sessionSpend: async (id: string) => spent[id] ?? 0,
	});
	const input = (limits: { dailyUsd: number | null; sessionUsd: number | null }) => ({
		catalog: catalogOf({ "claude-0123456789abcdef": 2.5 }, 4),
		hosts: [
			host({
				sessionId: "claude-0123456789abcdef",
				instanceId: "i2",
				sessionName: "refactor",
				agent: { id: "claude", name: "Claude Code" },
			}),
			host({ sessionId: "omp-1", instanceId: "i1" }),
		],
		limits,
		now: Date.parse("2026-03-10T12:00:00.000Z"),
	});

	it("adds today's vendor spend to the daily total when a daily limit is set", async () => {
		expect((await withForeignSpend(reading, input({ dailyUsd: 10, sessionUsd: null }))).dailyUsd).toBe(5);
		expect((await withForeignSpend(reading, input({ dailyUsd: null, sessionUsd: null }))).dailyUsd).toBe(1);
	});

	it("adds each hosting vendor session when a per-session limit is set", async () => {
		const withLimit = await withForeignSpend(reading, input({ dailyUsd: null, sessionUsd: 3 }));
		expect(withLimit.sessions).toEqual([
			reading.sessions[0]!,
			{ sessionId: "claude-0123456789abcdef", instanceId: "i2", title: "refactor", usd: 2.5 },
		]);
		expect((await withForeignSpend(reading, input({ dailyUsd: 10, sessionUsd: null }))).sessions).toEqual(
			reading.sessions,
		);
	});
});

describe("usage of vendor agents", () => {
	const report = (): UsageReport => ({
		range: "7d",
		syncedAt: 0,
		overall: {
			requests: 2,
			cost: 1,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 100,
			cacheWriteTokens: 0,
			totalTokens: 220,
			cacheRate: 0.5,
			unpricedRequests: 0,
		},
		series: [
			{ t: 0, cost: 0.4, tokens: 100, requests: 1 },
			{ t: 1_000, cost: 0.6, tokens: 120, requests: 1 },
		],
		byModel: [{ model: "claude-sonnet-5-5", provider: "anthropic", cost: 1, requests: 2, tokens: 220 }],
		byProject: [{ folder: "/work/app", cost: 1, requests: 2, tokens: 220 }],
	});
	const event = (
		over: Partial<{
			at: number;
			model: string;
			cost: number | null;
			input: number;
			folder: string;
			agentId: string;
		}> = {},
	) => ({
		at: 1_500,
		model: "sonnet",
		cost: 0.5,
		input: 10,
		output: 5,
		cacheRead: 5,
		cacheWrite: 0,
		folder: "/work/app",
		agentId: "claude",
		...over,
	});
	const ref = (id: string) => ({ id, name: id === "claude" ? "Claude Code" : id });

	it("leaves the report as it is when there are no vendor requests", () => {
		const original = report();
		expect(mergeForeignUsage(original, [], ref)).toBe(original);
	});

	it("adds requests to the totals, the chart, the models and the projects", () => {
		const merged = mergeForeignUsage(
			report(),
			[event(), event({ at: 500, model: "opus", cost: null, folder: "/work/new", agentId: "codex", input: 0 })],
			ref,
		);
		expect(merged.overall).toMatchObject({
			requests: 4,
			cost: 1.5,
			inputTokens: 110,
			outputTokens: 30,
			cacheReadTokens: 110,
			totalTokens: 220 + 20 + 10,
			unpricedRequests: 1,
		});
		expect(merged.overall.cacheRate).toBeCloseTo(0.5);
		expect(merged.series).toEqual([
			{ t: 0, cost: 0.4, tokens: 110, requests: 2 },
			{ t: 1_000, cost: 1.1, tokens: 140, requests: 2 },
		]);
		expect(merged.byModel.map(m => [m.provider, m.model, m.requests])).toEqual([
			["anthropic", "claude-sonnet-5-5", 2],
			["Claude Code", "sonnet", 1],
			["codex", "opus", 1],
		]);
		expect(merged.byProject).toEqual([
			{ folder: "/work/app", cost: 1.5, requests: 3, tokens: 220 + 20 },
			{ folder: "/work/new", cost: 0, requests: 1, tokens: 10 },
		]);
	});

	it("does not change the report it was given", () => {
		const original = report();
		mergeForeignUsage(original, [event()], ref);
		expect(original).toEqual(report());
	});

	it("reaches back as far as the range says", () => {
		const now = 10 * DAY;
		expect(usageRangeStart("24h", now)).toBe(9 * DAY);
		expect(usageRangeStart("7d", now)).toBe(3 * DAY);
		expect(usageRangeStart("all", now)).toBe(0);
	});
});
