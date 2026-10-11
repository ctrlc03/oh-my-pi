/**
 * Other vendors' coding agents (Claude Code, Codex, Cursor, Grok, OpenCode, custom ACP commands) beside omp, as the
 * app sees them: how a session list is filtered by agent, what a listed agent allows, and the custom-agent editor's
 * draft and its validation. Kept apart from the components so the decisions can be tested.
 */

import type { AgentRef, CompanionAgent, CustomAgentInput, ForeignPermission } from "./companion";
import { type FanoutModel, parseForeignSelector } from "./fanout";

/** What omp sessions are called wherever agents are listed: they carry no `agent` field. */
export const OMP_AGENT: AgentRef = { id: "omp", name: "omp" };

/** The agent behind a listed session: omp when the field is absent. */
export function agentRef(item: { agent?: AgentRef | null }): AgentRef {
	return item.agent ?? OMP_AGENT;
}

/** One choice of the agent filter: omp or an agent with at least one listed session. */
export interface AgentFilterOption {
	id: string;
	name: string;
	count: number;
}

/**
 * The choices of the All sessions filter: omp first, then each agent present in first-seen order. Empty when no
 * foreign session is listed, so the filter stays hidden for people who only use omp.
 */
export function agentFilterOptions(items: readonly { agent?: AgentRef | null }[]): AgentFilterOption[] {
	const counts = new Map<string, AgentFilterOption>();
	for (const item of items) {
		const agent = agentRef(item);
		const known = counts.get(agent.id);
		if (known) known.count += 1;
		else counts.set(agent.id, { id: agent.id, name: agent.name, count: 1 });
	}
	if (counts.size === 1 && counts.has(OMP_AGENT.id)) return [];
	const omp = counts.get(OMP_AGENT.id);
	return [...(omp ? [omp] : []), ...[...counts.values()].filter(option => option.id !== OMP_AGENT.id)];
}

/** `items` of the agent with id `filter`; every item for `null` (All). */
export function filterByAgent<T extends { agent?: AgentRef | null }>(items: readonly T[], filter: string | null): T[] {
	return filter === null ? [...items] : items.filter(item => agentRef(item).id === filter);
}

/** Whether an agent can start a session now. */
export type AgentReadiness = "ready" | "login" | "missing" | "error";

/** Missing wins over a probe error (nothing to probe), then an error over a sign-in prompt. */
export function agentReadiness(agent: CompanionAgent): AgentReadiness {
	if (!agent.installed) return "missing";
	if (agent.error !== undefined) return "error";
	if (agent.auth === "needed") return "login";
	return "ready";
}

/** A short status for an agent's row. */
export function agentStatusLabel(agent: CompanionAgent): string {
	switch (agentReadiness(agent)) {
		case "missing":
			return "Not installed";
		case "error":
			return "Cannot start";
		case "login":
			return agent.version === null ? "Sign in needed" : `v${agent.version} · sign in needed`;
		case "ready":
			return agent.version === null ? "Ready" : `v${agent.version}`;
	}
}

/** What to do before a session can start on this agent; null when it can start. */
export function agentSetupHint(agent: CompanionAgent): string | null {
	switch (agentReadiness(agent)) {
		case "ready":
			return null;
		case "missing":
			return agent.installable
				? `${agent.name} is not installed. Install it from Agents settings.`
				: `${agent.name} is not installed. Install it on your computer, then refresh.`;
		case "login":
			return agent.loginCommand === null
				? `${agent.name} needs a sign-in on your computer.`
				: `${agent.name} needs a sign-in. Run ${agent.loginCommand} on your computer, then refresh.`;
		case "error":
			return agent.error ?? `${agent.name} did not answer.`;
	}
}

/** Environment variable names the companion passes on as they are written. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_AGENT_NAME = 60;

let rowSeq = 0;

/** One argument row of the editor; `id` keeps the row's input when rows above it are removed. */
export interface ArgRow {
	id: number;
	value: string;
}

/** One environment variable row of the editor. */
export interface EnvRow {
	id: number;
	key: string;
	value: string;
}

export function newArgRow(value = ""): ArgRow {
	return { id: ++rowSeq, value };
}

export function newEnvRow(key = "", value = ""): EnvRow {
	return { id: ++rowSeq, key, value };
}

/** What the custom agent editor holds: the argv as a program and its arguments, and extra environment variables. */
export interface CustomAgentDraft {
	/** Absent for a new agent. */
	id?: string;
	name: string;
	command: string;
	args: ArgRow[];
	env: EnvRow[];
}

/** The editor's draft for a saved custom agent; an empty one without `agent`. */
export function customAgentDraft(agent?: CompanionAgent): CustomAgentDraft {
	if (agent === undefined) return { name: "", command: "", args: [], env: [] };
	const [command = "", ...args] = agent.command ?? [];
	return {
		id: agent.id,
		name: agent.name,
		command,
		args: args.map(arg => newArgRow(arg)),
		env: Object.entries(agent.env ?? {}).map(([key, value]) => newEnvRow(key, value)),
	};
}

export type CustomAgentResult = { ok: true; input: CustomAgentInput } | { ok: false; error: string };

/** The request a draft makes, or why it cannot be saved. Empty argument and environment rows are dropped. */
export function customAgentInput(draft: CustomAgentDraft): CustomAgentResult {
	const name = draft.name.trim();
	if (name === "") return { ok: false, error: "Name the agent." };
	if (Array.from(name).length > MAX_AGENT_NAME) {
		return { ok: false, error: `The name is longer than ${MAX_AGENT_NAME} characters.` };
	}
	const command = draft.command.trim();
	if (command === "") return { ok: false, error: "Enter the command to run." };
	const args = draft.args.map(arg => arg.value).filter(arg => arg !== "");
	const env: Record<string, string> = {};
	for (const row of draft.env) {
		const key = row.key.trim();
		if (key === "" && row.value === "") continue;
		if (!ENV_KEY_RE.test(key)) return { ok: false, error: `“${key || row.value}” is not a valid variable name.` };
		if (Object.hasOwn(env, key)) return { ok: false, error: `${key} is set twice.` };
		env[key] = row.value;
	}
	const input: CustomAgentInput = { name, command: [command, ...args] };
	if (draft.id !== undefined) input.id = draft.id;
	if (Object.keys(env).length > 0) input.env = env;
	return { ok: true, input };
}

/** The command line as a person would type it, for a list row (arguments with spaces are quoted). */
export function commandLine(command: readonly string[]): string {
	return command.map(part => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

/** The two ways a foreign session answers its agent's tool-permission requests. */
export const PERMISSIONS: readonly ForeignPermission[] = ["supervised", "full"];

export const PERMISSION_LABEL: Record<ForeignPermission, string> = {
	supervised: "Supervised",
	full: "Full access",
};

export const PERMISSION_HINT: Record<ForeignPermission, string> = {
	supervised: "Each tool call that changes something asks you first.",
	full: "Every command and edit runs without asking.",
};

/** Shown wherever Full access can be chosen. */
export const FULL_ACCESS_WARNING =
	"Full access lets the agent run any command and edit any file your user can, without asking. Use it only in a folder you can afford to lose.";

/** What a fan-out model selector reads as: a vendor model's id (a default when empty), else the omp selector itself. */
export function modelLabel(selector: string): string {
	const foreign = parseForeignSelector(selector);
	if (foreign === null) return selector;
	return foreign.model === "" ? "default model" : foreign.model;
}

/** A model of the picker as a chosen chip reads: a vendor model with its agent's name, an omp one by its selector. */
export function fanoutModelLabel(model: FanoutModel): string {
	return model.agent ? `${model.agent.name} · ${model.name}` : model.selector;
}

/** The models one agent runs, for the fan-out picker's sections. */
export interface ModelGroup {
	agent: AgentRef;
	models: FanoutModel[];
}

/** `models` grouped by the agent that runs them: omp's first, then each agent in first-seen order. */
export function groupModelsByAgent(models: readonly FanoutModel[]): ModelGroup[] {
	const groups = new Map<string, ModelGroup>();
	for (const model of models) {
		const agent = agentRef(model);
		const group = groups.get(agent.id);
		if (group) group.models.push(model);
		else groups.set(agent.id, { agent, models: [model] });
	}
	const omp = groups.get(OMP_AGENT.id);
	return [...(omp ? [omp] : []), ...[...groups.values()].filter(group => group.agent.id !== OMP_AGENT.id)];
}
