/**
 * The vendor-agent requests (`agents`, `agent-install`, `agent-custom-save`, `agent-custom-delete`) and the vendor
 * sessions for scripts/mock-companion.ts, so Claude Code, Codex and the other agents can be tried in a browser without
 * any of them installed. The request checks are the companion's (./companion-foreign): who may be installed or
 * deleted, what a custom agent's argv may hold. Only the agents are fake: some installed, some needing sign-in, one that
 * needs its CLI installed first, one custom with a command and environment. The sessions are canned too: two live hosts,
 * and ended ones that the sessions list, the folders and the search offer to resume.
 */

import type {
	AgentRef,
	CompanionAgent,
	CompanionHost,
	CompanionReply,
	CompanionRequest,
	CustomAgentInput,
	RecentFolder,
	SessionOverview,
} from "../src/lib/companion";
import { type FanoutModel, parseForeignSelector } from "../src/lib/fanout";
import { createAgentHandlers, foreignFanoutModels } from "./companion-foreign";
import { builtinAgentDescriptors } from "./foreign/agents";

const HOUR = 60 * 60 * 1000;
/** How long an install "takes": long enough to see the busy state in the sheet. */
const INSTALL_MS = 1_200;

/** What the detection says per built-in agent on the mock computer: the demo's states; everything else comes from the real descriptors. */
const MOCK_STATUS: Record<string, Pick<CompanionAgent, "installed" | "version" | "auth">> = {
	claude: { installed: true, version: "2.1.294", auth: "ok" },
	codex: { installed: true, version: "0.161.0", auth: "needed" },
	cursor: { installed: false, version: null, auth: "unknown" },
	grok: { installed: false, version: null, auth: "unknown" },
	opencode: { installed: true, version: "2.0.6", auth: "unknown" },
};

/** What every custom agent shares: the companion only runs its command, so there is nothing to install or sign in to. */
const CUSTOM_AGENT = {
	kind: "custom",
	installed: true,
	version: null,
	auth: "unknown",
	installable: false,
	installCommand: null,
	loginCommand: null,
} satisfies Partial<CompanionAgent>;

/** The agents as the mock computer starts: what each state of the agents sheet looks like. */
function initialAgents(): CompanionAgent[] {
	const builtins = builtinAgentDescriptors().map(({ hasAdapter, ...descriptor }): CompanionAgent => {
		if (!Object.hasOwn(MOCK_STATUS, descriptor.id)) throw new Error(`the mock has no status for ${descriptor.id}`);
		return { ...descriptor, kind: "builtin", installable: hasAdapter, ...MOCK_STATUS[descriptor.id]! };
	});
	return [
		...builtins,
		{
			...CUSTOM_AGENT,
			id: "custom:team-agent",
			name: "Team agent",
			command: ["team-agent", "acp", "--stdio"],
			env: { TEAM_AGENT_PROFILE: "review" },
		},
	];
}

/** `custom:<slug>` of an agent name, like the companion's. */
function customId(name: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "agent";
	return `custom:${slug}`;
}

interface CannedMessage {
	role: "user" | "assistant";
	text: string;
}

/** An ended vendor session the mock offers to resume. */
interface DormantSession {
	sessionId: string;
	agentId: string;
	title: string;
	folder: string;
	startedAt: number;
	endedAt: number;
	model: string;
	cost: number;
	messages: CannedMessage[];
}

function dormantSessions(now: number): DormantSession[] {
	return [
		{
			sessionId: "claude-3f9a1c5e7b2d4a60",
			agentId: "claude",
			title: "Split the billing module",
			folder: "/work/billing",
			startedAt: now - 20 * HOUR,
			endedAt: now - 19 * HOUR,
			model: "sonnet",
			cost: 0.86,
			messages: [
				{ role: "user", text: "Split the billing module into invoices and subscriptions." },
				{
					role: "assistant",
					text: "Moved the invoice code into invoices/ and left the subscription code in place.",
				},
			],
		},
		{
			sessionId: "opencode-8d2e6b1f0c9a3e47",
			agentId: "opencode",
			title: "Explain the retry queue",
			folder: "/work/api-gateway",
			startedAt: now - 52 * HOUR,
			endedAt: now - 51 * HOUR,
			model: "anthropic/claude-sonnet-4-5",
			cost: 0.31,
			messages: [
				{ role: "user", text: "Why does the retry queue drop jobs after a deploy?" },
				{ role: "assistant", text: "The queue keeps its jobs in memory, so a restart loses what was waiting." },
			],
		},
	];
}

/** The live vendor sessions of the mock computer: one working, one waiting on an answer. */
export function mockForeignHosts(now: number): CompanionHost[] {
	const base = {
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
	};
	return [
		{
			...base,
			instanceId: "inst-f1",
			sessionId: "claude-b41c0d9e27a85f36",
			sessionName: "refactor-parser",
			cwd: "/work/parser",
			model: "sonnet",
			startedAt: now - 2 * HOUR,
			busy: true,
			agent: { id: "claude", name: "Claude Code" },
		},
		{
			...base,
			instanceId: "inst-f2",
			sessionId: "codex-6e0b93a4d1c75f28",
			sessionName: "tidy-tests",
			cwd: "/work/tidy-tests",
			model: null,
			startedAt: now - 3 * HOUR,
			inputRequired: true,
			agent: { id: "codex", name: "Codex" },
		},
	];
}

/** What a vendor `start` asks for beyond omp's: the agent, its model and how it answers tool permissions. */
export interface MockForeignPlan {
	agent: AgentRef;
	/** The resumed session: its id, folder and title. */
	resumed?: { sessionId: string; cwd: string; title: string };
	model?: string;
}

export interface MockForeign {
	/** Fields the mock companion's `hosts` frame needs for the app to offer vendor agents. */
	capabilities: { canForeign: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
	/** The vendor agent a `start` runs (refused when it is not installed or signed in), or null for omp. */
	plan(request: Extract<CompanionRequest, { t: "start" }>): MockForeignPlan | null;
	/** Ended sessions without a live host: what the sessions list and the search offer to resume. */
	searchable(): { overview: SessionOverview; messages: CannedMessage[] }[];
	/** `folders` with the ended sessions' folders added. */
	folders(base: RecentFolder[]): RecentFolder[];
	/** The models of the agents that can run, for model comparison. */
	fanoutModels(): FanoutModel[];
	/** The agent a model selector of `fanoutModels` runs. */
	agentRef(selector: string): AgentRef | undefined;
}

export function createMockForeign(options: {
	/** The mock companion's live session list: a resumed session leaves the ended ones when its host appears here. */
	hosts: readonly CompanionHost[];
}): MockForeign {
	const now = Date.now();
	let agents = initialAgents();
	const dormant = dormantSessions(now);
	const ref = (agent: AgentRef): AgentRef => ({ id: agent.id, name: agent.name });
	const agentOf = (id: string): CompanionAgent | undefined => agents.find(agent => agent.id === id);

	const handlers = createAgentHandlers({
		ready: async () => true,
		list: async () => structuredClone(agents),
		install: async id => {
			await Bun.sleep(INSTALL_MS);
			agents = agents.map(agent =>
				agent.id === id ? { ...agent, installed: true, version: agent.version ?? "1.0.0" } : agent,
			);
			return structuredClone(agents);
		},
		saveCustom: async (input: CustomAgentInput) => {
			const id = input.id ?? customId(input.name);
			const saved: CompanionAgent = {
				...CUSTOM_AGENT,
				id,
				name: input.name,
				command: input.command,
				env: input.env,
			};
			agents = agents.some(agent => agent.id === id)
				? agents.map(agent => (agent.id === id ? saved : agent))
				: [...agents, saved];
			return structuredClone(agents);
		},
		deleteCustom: async id => {
			agents = agents.filter(agent => agent.id !== id);
			return structuredClone(agents);
		},
	});

	const live = (sessionId: string): boolean => options.hosts.some(host => host.sessionId === sessionId);
	const ended = (): DormantSession[] => dormant.filter(session => !live(session.sessionId));

	return {
		capabilities: { canForeign: true },
		handles: request =>
			request.t === "agents" ||
			request.t === "agent-install" ||
			request.t === "agent-custom-save" ||
			request.t === "agent-custom-delete",
		async answer(request) {
			switch (request.t) {
				case "agents":
					return { t: "agents", reqId: request.reqId, agents: await handlers.list(request.refresh) };
				case "agent-install":
					return { t: "agents", reqId: request.reqId, agents: await handlers.install(request.id) };
				case "agent-custom-save":
					return { t: "agents", reqId: request.reqId, agents: await handlers.saveCustom(request.agent) };
				case "agent-custom-delete":
					return { t: "agents", reqId: request.reqId, agents: await handlers.deleteCustom(request.id) };
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
		plan(request) {
			const row =
				request.resume === undefined ? undefined : dormant.find(session => session.sessionId === request.resume);
			const id = row?.agentId ?? request.agent;
			if (id === undefined) return null;
			const agent = agentOf(id);
			if (!agent) throw new Error("unknown agent");
			if (!agent.installed) throw new Error(`${agent.name} is not installed on this computer`);
			if (agent.auth === "needed")
				throw new Error(
					`${agent.name} needs signing in: run ${agent.loginCommand ?? "its sign-in"} on the computer`,
				);
			if (request.sandboxed === true) throw new Error(`${agent.name} cannot run sandboxed`);
			return {
				agent: ref(agent),
				resumed: row && { sessionId: row.sessionId, cwd: row.folder, title: row.title },
				model: request.model ?? row?.model,
			};
		},
		searchable: () =>
			ended().map(session => ({
				overview: {
					sessionId: session.sessionId,
					title: session.title,
					folder: session.folder,
					startedAt: session.startedAt,
					endedAt: session.endedAt,
					requests: 6,
					toolCalls: 14,
					subagents: 0,
					tokens: 90_000,
					cost: session.cost,
					models: [session.model],
					agent: ref(agentOf(session.agentId) ?? { id: session.agentId, name: session.agentId }),
				},
				messages: session.messages,
			})),
		folders(base) {
			const folders = base.map(folder => ({ ...folder, sessions: [...folder.sessions] }));
			for (const session of ended()) {
				let folder = folders.find(f => f.cwd === session.folder);
				if (!folder) {
					folder = { cwd: session.folder, lastActive: session.endedAt, sessions: [] };
					folders.push(folder);
				}
				folder.sessions.push({
					id: session.sessionId,
					title: session.title,
					lastActive: session.endedAt,
					agent: ref(agentOf(session.agentId) ?? { id: session.agentId, name: session.agentId }),
				});
				folder.lastActive = Math.max(folder.lastActive, session.endedAt);
			}
			return folders.sort((a, b) => b.lastActive - a.lastActive);
		},
		fanoutModels: () => foreignFanoutModels(agents),
		agentRef: selector => {
			const parsed = parseForeignSelector(selector);
			const agent = parsed && agentOf(parsed.agent);
			return agent ? ref(agent) : undefined;
		},
	};
}
