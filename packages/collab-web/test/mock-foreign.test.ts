import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanionHost, CompanionReply, CompanionRequest } from "../src/lib/companion";
import { createMockForeign, mockForeignHosts } from "../scripts/mock-foreign";
import { builtinAgentDescriptors } from "../scripts/foreign/agents";
import { createMockStart } from "../scripts/mock-start";

function agentsOf(reply: CompanionReply) {
	if (reply.t !== "agents") throw new Error(`answered ${reply.t}`);
	return reply.agents;
}

describe("mock vendor agents", () => {
	const mock = () => createMockForeign({ hosts: [] });
	const ask = (request: Omit<Extract<CompanionRequest, { t: "agents" }>, "reqId">) => ({ ...request, reqId: 1 });

	it("serves agents in every state the agents sheet shows", async () => {
		const agents = agentsOf(await mock().answer(ask({ t: "agents" })));
		const by = Object.fromEntries(agents.map(agent => [agent.id, agent]));
		expect(by.claude).toMatchObject({ installed: true, auth: "ok" });
		expect(by.claude?.models?.length).toBeGreaterThan(0);
		expect(by.codex).toMatchObject({ installed: true, auth: "needed", loginCommand: "codex login" });
		expect(by.cursor).toMatchObject({ installed: false });
		expect(by.cursor?.installCommand).toBeTruthy();
		for (const descriptor of builtinAgentDescriptors()) {
			expect(by[descriptor.id]).toMatchObject({
				name: descriptor.name,
				installCommand: descriptor.installCommand,
				loginCommand: descriptor.loginCommand,
				installable: descriptor.hasAdapter,
				models: descriptor.models,
			});
		}
		expect(by["custom:team-agent"]).toMatchObject({ kind: "custom", command: ["team-agent", "acp", "--stdio"] });
		expect(by["custom:team-agent"]?.env).toEqual({ TEAM_AGENT_PROFILE: "review" });
	});

	it("installs an agent and keeps a saved custom one until it is removed", async () => {
		const foreign = mock();
		const installed = agentsOf(await foreign.answer({ t: "agent-install", reqId: 2, id: "grok" }));
		expect(installed.find(agent => agent.id === "grok")?.installed).toBe(true);
		const saved = agentsOf(
			await foreign.answer({
				t: "agent-custom-save",
				reqId: 3,
				agent: { name: "My Tool", command: ["my-tool", "--acp"], env: { A: "1" } },
			}),
		);
		expect(saved.find(agent => agent.id === "custom:my-tool")).toMatchObject({
			name: "My Tool",
			command: ["my-tool", "--acp"],
		});
		const removed = agentsOf(await foreign.answer({ t: "agent-custom-delete", reqId: 4, id: "custom:my-tool" }));
		expect(removed.some(agent => agent.id === "custom:my-tool")).toBe(false);
		expect(removed.some(agent => agent.id === "grok")).toBe(true);
	});

	it("keeps the companion's checks: no shell string as a command, no removing a built-in agent", async () => {
		const foreign = mock();
		await expect(
			foreign.answer({
				t: "agent-custom-save",
				reqId: 5,
				agent: { name: "x", command: "my-tool --acp" as unknown as string[] },
			}),
		).rejects.toThrow("list of arguments");
		await expect(foreign.answer({ t: "agent-custom-delete", reqId: 6, id: "claude" })).rejects.toThrow(
			"only a custom agent",
		);
		await expect(foreign.answer({ t: "agent-install", reqId: 7, id: "custom:team-agent" })).rejects.toThrow(
			"not installed by the companion",
		);
	});

	it("refuses to start an agent that is not installed or signed in, or sandboxed", () => {
		const foreign = mock();
		const start = (over: Partial<Extract<CompanionRequest, { t: "start" }>>) =>
			foreign.plan({ t: "start", reqId: 1, cwd: "/work/app", ...over });
		expect(start({})).toBeNull();
		expect(start({ agent: "claude", model: "opus" })).toMatchObject({
			agent: { id: "claude", name: "Claude Code" },
			model: "opus",
		});
		expect(() => start({ agent: "cursor" })).toThrow("not installed");
		expect(() => start({ agent: "codex" })).toThrow("needs signing in");
		expect(() => start({ agent: "claude", sandboxed: true })).toThrow("cannot run sandboxed");
		expect(() => start({ agent: "nope" })).toThrow("unknown agent");
	});

	it("offers the models of agents that can run, tagged with their agent", () => {
		const foreign = mock();
		const models = foreign.fanoutModels();
		expect(models.map(model => model.selector)).toContain("agent:claude/opus");
		expect(models.some(model => model.agent?.id === "codex" || model.agent?.id === "cursor")).toBe(false);
		expect(foreign.agentRef("agent:claude/opus")).toEqual({ id: "claude", name: "Claude Code" });
		expect(foreign.agentRef("anthropic/claude-sonnet-5-5")).toBeUndefined();
		expect(foreign.agentRef("agent:nope/x")).toBeUndefined();
	});

	it("lists ended sessions in the sessions and folders, until a host for one appears", () => {
		const hosts: CompanionHost[] = [];
		const foreign = createMockForeign({ hosts });
		const ended = foreign.searchable().map(entry => entry.overview);
		expect(ended.length).toBeGreaterThan(1);
		expect(ended.every(overview => overview.agent !== undefined && overview.endedAt !== null)).toBe(true);
		const folders = foreign.folders([{ cwd: "/work/billing", lastActive: 1, sessions: [] }]);
		const billing = folders.find(folder => folder.cwd === "/work/billing");
		expect(billing?.sessions.map(session => session.agent?.id)).toEqual(["claude"]);
		hosts.push({ ...mockForeignHosts(Date.now())[0]!, sessionId: ended[0]!.sessionId });
		expect(foreign.searchable().some(entry => entry.overview.sessionId === ended[0]!.sessionId)).toBe(false);
	});
});

describe("mock start of a vendor agent", () => {
	let dir: string;
	const hosts: CompanionHost[] = [];

	beforeAll(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mock-foreign-")));
	});
	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const starts = () =>
		createMockStart({
			dir,
			hosts,
			baseFolders: async () => [],
			onChange: () => {},
			foreign: createMockForeign({ hosts }),
		});

	it("starts a host that carries its agent and model, and resumes an ended session once", async () => {
		const start = starts();
		const first = await start.answer({ t: "start", reqId: 1, cwd: dir, agent: "claude", model: "opus" });
		if (first.t !== "started") throw new Error("not started");
		expect(hosts.find(host => host.instanceId === first.instanceId)).toMatchObject({
			agent: { id: "claude", name: "Claude Code" },
			model: "opus",
		});
		const resumed = await start.answer({ t: "start", reqId: 2, cwd: "", resume: "claude-3f9a1c5e7b2d4a60" });
		if (resumed.t !== "started") throw new Error("not started");
		expect(hosts.find(host => host.instanceId === resumed.instanceId)).toMatchObject({
			sessionId: "claude-3f9a1c5e7b2d4a60",
			cwd: "/work/billing",
			agent: { id: "claude" },
		});
		const again = await start.answer({ t: "start", reqId: 3, cwd: "", resume: "claude-3f9a1c5e7b2d4a60" });
		expect(again).toEqual({ t: "started", reqId: 3, instanceId: resumed.instanceId });
		expect(hosts.filter(host => host.sessionId === "claude-3f9a1c5e7b2d4a60")).toHaveLength(1);
	});

	it("refuses an agent that cannot run", async () => {
		await expect(starts().answer({ t: "start", reqId: 4, cwd: dir, agent: "codex" })).rejects.toThrow(
			"needs signing in",
		);
	});
});

describe("mock vendor hosts", () => {
	it("are one working and one waiting on an answer, each with its agent", () => {
		const hosts = mockForeignHosts(Date.now());
		expect(hosts.map(host => [host.agent?.id, host.busy, host.inputRequired])).toEqual([
			["claude", true, false],
			["codex", false, true],
		]);
		expect(new Set(hosts.map(host => host.instanceId)).size).toBe(2);
	});
});
