import { describe, expect, it } from "bun:test";
import {
	agentFilterOptions,
	agentReadiness,
	agentSetupHint,
	agentStatusLabel,
	commandLine,
	customAgentDraft,
	customAgentInput,
	fanoutModelLabel,
	filterByAgent,
	groupModelsByAgent,
	modelLabel,
	newArgRow,
	newEnvRow,
} from "../src/lib/agents";
import type { CompanionAgent } from "../src/lib/companion";
import { foreignSelector } from "../src/lib/fanout";

const claude = { id: "claude", name: "Claude Code" };
const codex = { id: "codex", name: "Codex" };

function agent(over: Partial<CompanionAgent>): CompanionAgent {
	return {
		id: "claude",
		name: "Claude Code",
		kind: "builtin",
		installed: true,
		version: "2.1.0",
		auth: "ok",
		installable: true,
		installCommand: "npm i -g adapter",
		loginCommand: "claude auth login",
		...over,
	};
}

describe("agent filter", () => {
	it("stays empty while only omp sessions are listed", () => {
		expect(agentFilterOptions([{}, { agent: undefined }, { agent: null }])).toEqual([]);
		expect(agentFilterOptions([])).toEqual([]);
	});

	it("lists omp first, then each agent in first-seen order, with counts", () => {
		const items = [{ agent: codex }, {}, { agent: claude }, { agent: codex }];
		expect(agentFilterOptions(items)).toEqual([
			{ id: "omp", name: "omp", count: 1 },
			{ id: "codex", name: "Codex", count: 2 },
			{ id: "claude", name: "Claude Code", count: 1 },
		]);
	});

	it("lists a lone agent without omp", () => {
		expect(agentFilterOptions([{ agent: codex }])).toEqual([{ id: "codex", name: "Codex", count: 1 }]);
	});

	it("filters by agent id, treating a missing agent as omp, and keeps everything for All", () => {
		const items = [{ n: 1 }, { n: 2, agent: codex }, { n: 3, agent: claude }, { n: 4 }];
		expect(filterByAgent(items, null)).toEqual(items);
		expect(filterByAgent(items, "omp").map(item => item.n)).toEqual([1, 4]);
		expect(filterByAgent(items, "codex").map(item => item.n)).toEqual([2]);
		expect(filterByAgent(items, "grok")).toEqual([]);
	});
});

describe("fan-out models", () => {
	const models = [
		{ selector: foreignSelector("claude", "sonnet"), name: "Sonnet", provider: "Anthropic", agent: claude },
		{ selector: "openai/gpt-5", name: "GPT-5", provider: "openai" },
		{ selector: foreignSelector("codex", "gpt-5-codex"), name: "GPT-5 Codex", provider: "OpenAI", agent: codex },
		{ selector: foreignSelector("claude", "opus"), name: "Opus", provider: "Anthropic", agent: claude },
	];

	it("groups by agent with omp first", () => {
		const groups = groupModelsByAgent(models);
		expect(groups.map(group => group.agent.id)).toEqual(["omp", "claude", "codex"]);
		expect(groups[1]?.models.map(model => model.name)).toEqual(["Sonnet", "Opus"]);
	});

	it("makes no omp group when no omp model is listed", () => {
		expect(groupModelsByAgent(models.filter(model => model.agent)).map(group => group.agent.id)).toEqual([
			"claude",
			"codex",
		]);
	});

	it("labels vendor models without their selector prefix", () => {
		expect(modelLabel(foreignSelector("claude", "sonnet"))).toBe("sonnet");
		expect(modelLabel(foreignSelector("claude", ""))).toBe("default model");
		expect(modelLabel("openai/gpt-5")).toBe("openai/gpt-5");
		expect(fanoutModelLabel(models[0]!)).toBe("Claude Code · Sonnet");
		expect(fanoutModelLabel(models[1]!)).toBe("openai/gpt-5");
	});
});

describe("agent readiness", () => {
	it("ranks missing over error over sign-in", () => {
		expect(agentReadiness(agent({ installed: false, error: "x", auth: "needed" }))).toBe("missing");
		expect(agentReadiness(agent({ error: "x", auth: "needed" }))).toBe("error");
		expect(agentReadiness(agent({ auth: "needed" }))).toBe("login");
		expect(agentReadiness(agent({ auth: "unknown" }))).toBe("ready");
	});

	it("words the status and the setup hint", () => {
		expect(agentStatusLabel(agent({}))).toBe("v2.1.0");
		expect(agentStatusLabel(agent({ version: null }))).toBe("Ready");
		expect(agentStatusLabel(agent({ auth: "needed" }))).toBe("v2.1.0 · sign in needed");
		expect(agentStatusLabel(agent({ installed: false }))).toBe("Not installed");
		expect(agentSetupHint(agent({}))).toBeNull();
		expect(agentSetupHint(agent({ auth: "needed" }))).toContain("claude auth login");
		expect(agentSetupHint(agent({ installed: false }))).toContain("Install it from Agents settings");
		expect(agentSetupHint(agent({ installed: false, installable: false }))).toContain("then refresh");
		expect(agentSetupHint(agent({ error: "boom" }))).toBe("boom");
	});
});

describe("custom agent editor", () => {
	it("turns a draft into a request, dropping empty rows", () => {
		const result = customAgentInput({
			name: "  My agent ",
			command: " my-acp ",
			args: [newArgRow("--stdio"), newArgRow(""), newArgRow("a b")],
			env: [newEnvRow("TOKEN", "x"), newEnvRow("", "")],
		});
		expect(result).toEqual({
			ok: true,
			input: { name: "My agent", command: ["my-acp", "--stdio", "a b"], env: { TOKEN: "x" } },
		});
	});

	it("omits env when empty and keeps the id of an edit", () => {
		const draft = customAgentDraft(
			agent({ id: "custom-1", name: "Mine", kind: "custom", command: ["run", "--acp"], env: {} }),
		);
		expect(draft.command).toBe("run");
		expect(draft.args.map(arg => arg.value)).toEqual(["--acp"]);
		expect(customAgentInput(draft)).toEqual({
			ok: true,
			input: { id: "custom-1", name: "Mine", command: ["run", "--acp"] },
		});
	});

	it("rejects a missing name or command, bad or repeated variable names, and long names", () => {
		const base = { name: "n", command: "c", args: [], env: [] };
		expect(customAgentInput({ ...base, name: " " }).ok).toBe(false);
		expect(customAgentInput({ ...base, command: "" }).ok).toBe(false);
		expect(customAgentInput({ ...base, env: [newEnvRow("1BAD", "x")] }).ok).toBe(false);
		expect(customAgentInput({ ...base, env: [newEnvRow("", "orphan")] }).ok).toBe(false);
		expect(customAgentInput({ ...base, env: [newEnvRow("A", "1"), newEnvRow("A", "2")] }).ok).toBe(false);
		expect(customAgentInput({ ...base, name: "x".repeat(61) }).ok).toBe(false);
		expect(customAgentInput({ ...base, name: "x".repeat(60) }).ok).toBe(true);
	});

	it("quotes only the arguments that need it", () => {
		expect(commandLine(["npx", "-y", "@scope/pkg", "--flag=1"])).toBe("npx -y @scope/pkg --flag=1");
		expect(commandLine(["run", "two words", ""])).toBe('run "two words" ""');
	});
});
