/**
 * The companion's side of vendor agent sessions (Claude Code, Codex, Cursor, Grok, OpenCode, custom ACP commands):
 * everything it needs besides the host processes themselves (`./foreign/host-main.ts`, which keep a session alive
 * across companion restarts).
 *
 * - the `agents` requests, validated and answered from `./foreign/agents.ts`;
 * - the plan of a foreign `start` (which agent, where, with which cap) and the cap derived from the spend limits;
 * - the session index (`<config>/agent/collab-foreign.json`, written by the hosts, read here) and the transcripts
 *   (`<config>/agent/collab-foreign/sessions/<id>.jsonl`, omp's entry schema) turned into the same rows omp
 *   sessions have: the all-sessions list, the recent folders a start offers to resume in, usage and spend;
 * - the models vendor agents add to a model comparison.
 *
 * Effects (reading the index, listing agents) arrive as options, so all of it is testable without tmux or a vendor.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentRef } from "@oh-my-pi/pi-wire";
import type {
	CompanionAgent,
	CompanionHost,
	CustomAgentInput,
	ForeignPermission,
	RecentFolder,
	SessionOverview,
	SpendLimits,
	UsageRange,
	UsageReport,
} from "../src/lib/companion";
import { type FanoutModel, foreignSelector } from "../src/lib/fanout";
import { isRecord } from "../src/tool-render/util";
import { AGENT_ID_RE, FOREIGN_MODEL_RE } from "./companion-start";
import { SAFE_ID_RE } from "./companion-sessions";
import { dayStart, type SpendReading } from "./companion-spend";

/** One session of the foreign index, as the host process wrote it (`collab-foreign.json`). */
export interface ForeignRow {
	agent: string;
	nativeId: string | null;
	cwd: string;
	title: string | null;
	model: string | null;
	createdAt: number;
	lastActive: number;
	permission: ForeignPermission;
	worktree: boolean;
	adapterVersion: string | null;
	fanout?: { group: string; model: string; agent?: AgentRef };
}

/** Foreign session id → its index row. */
export type ForeignRows = Record<string, ForeignRow>;

// ── agent requests ───────────────────────────────────────────────────────────

const MAX_CUSTOM_NAME_CHARS = 60;
const MAX_COMMAND_ARGS = 64;
const MAX_COMMAND_ARG_CHARS = 4096;
const MAX_ENV_VARS = 64;
const MAX_ENV_VALUE_CHARS = 4096;
const CUSTOM_ID_RE = /^custom:[a-z0-9-]{1,32}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A custom agent a device sent, checked: a name, the argv to run (no shell), optional environment, optionally the id to replace. */
export function parseCustomAgentInput(input: unknown): CustomAgentInput {
	if (!isRecord(input)) throw new Error("invalid agent");
	const { id, name, command, env } = input;
	if (id !== undefined && (typeof id !== "string" || !CUSTOM_ID_RE.test(id))) throw new Error("invalid agent id");
	if (typeof name !== "string" || name.trim() === "" || name.length > MAX_CUSTOM_NAME_CHARS || /[\0\n\r]/.test(name))
		throw new Error("an agent needs a short name");
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		command.length > MAX_COMMAND_ARGS ||
		command.some(arg => typeof arg !== "string" || arg.length > MAX_COMMAND_ARG_CHARS || arg.includes("\0"))
	)
		throw new Error("the command must be a list of arguments");
	if ((command[0] as string).trim() === "") throw new Error("the command is empty");
	let checkedEnv: Record<string, string> | undefined;
	if (env !== undefined) {
		if (!isRecord(env) || Object.keys(env).length > MAX_ENV_VARS) throw new Error("invalid environment");
		checkedEnv = {};
		for (const [key, value] of Object.entries(env)) {
			if (
				!ENV_NAME_RE.test(key) ||
				typeof value !== "string" ||
				value.length > MAX_ENV_VALUE_CHARS ||
				value.includes("\0")
			)
				throw new Error("invalid environment");
			checkedEnv[key] = value;
		}
	}
	return {
		...(id !== undefined ? { id } : {}),
		name: name.trim(),
		command: command as string[],
		...(checkedEnv ? { env: checkedEnv } : {}),
	};
}

/** The agent id of an `agent-install` or `agent-custom-delete` request. */
export function parseAgentId(value: unknown): string {
	if (typeof value !== "string" || !AGENT_ID_RE.test(value)) throw new Error("unknown agent");
	return value;
}

export interface AgentOperations {
	/** This computer can run vendor agents (the host entry exists and tmux is available). */
	ready(): Promise<boolean>;
	list(refresh: boolean): Promise<CompanionAgent[]>;
	install(id: string): Promise<CompanionAgent[]>;
	saveCustom(agent: CustomAgentInput): Promise<CompanionAgent[]>;
	deleteCustom(id: string): Promise<CompanionAgent[]>;
}

/** The four agent requests, each refused when this computer cannot run vendor agents and answered with the agent list as it is afterwards. */
export function createAgentHandlers(ops: AgentOperations): {
	list(refresh: unknown): Promise<CompanionAgent[]>;
	install(id: unknown): Promise<CompanionAgent[]>;
	saveCustom(agent: unknown): Promise<CompanionAgent[]>;
	deleteCustom(id: unknown): Promise<CompanionAgent[]>;
} {
	const guard = async <T>(work: () => Promise<T>): Promise<T> => {
		if (!(await ops.ready())) throw new Error("This computer cannot run other agents (tmux is missing).");
		return await work();
	};
	return {
		list: async refresh => {
			if (refresh !== undefined && typeof refresh !== "boolean") throw new Error("invalid request");
			return await guard(() => ops.list(refresh === true));
		},
		install: async id => {
			const checked = parseAgentId(id);
			if (checked.startsWith("custom:")) throw new Error("a custom agent is not installed by the companion");
			return await guard(() => ops.install(checked));
		},
		saveCustom: async agent => {
			const checked = parseCustomAgentInput(agent);
			return await guard(() => ops.saveCustom(checked));
		},
		deleteCustom: async id => {
			const checked = parseAgentId(id);
			if (!checked.startsWith("custom:")) throw new Error("only a custom agent can be removed");
			return await guard(() => ops.deleteCustom(checked));
		},
	};
}

/** Display names of the agents as last listed, for rows that only know an agent id. */
export function createAgentDirectory(): {
	remember(agents: readonly { id: string; name: string }[]): void;
	ref(id: string): AgentRef;
} {
	const names = new Map<string, string>();
	return {
		remember(agents) {
			for (const agent of agents) names.set(agent.id, agent.name);
		},
		ref: id => ({ id, name: names.get(id) ?? id }),
	};
}

// ── starting ─────────────────────────────────────────────────────────────────

/** Cents are the unit people set limits in: a cap is rounded down to whole cents. */
function floorCents(usd: number): number {
	return Math.floor(usd * 100) / 100;
}

/**
 * The spend cap (`--max-cost`, USD) for a foreign session: the smallest of the one asked for (a scheduled run, a fan-out
 * member), what the per-session limit leaves after what the session already spent, and what today's limit leaves.
 * undefined when nothing limits it.
 * @throws Error when a limit is already used up: such a session could not do anything.
 */
export function foreignMaxCost(input: {
	requestedUsd?: number;
	limits: SpendLimits | null;
	spentTodayUsd: number;
	spentBySessionUsd: number;
}): number | undefined {
	const caps: number[] = [];
	if (input.requestedUsd !== undefined) caps.push(input.requestedUsd);
	const { limits } = input;
	if (limits?.sessionUsd != null) {
		const left = floorCents(limits.sessionUsd - input.spentBySessionUsd);
		if (left < 0.01) throw new Error("This session has already reached your per-session spend limit.");
		caps.push(left);
	}
	if (limits?.dailyUsd != null) {
		const left = floorCents(limits.dailyUsd - input.spentTodayUsd);
		if (left < 0.01) throw new Error("You have already reached today's spend limit.");
		caps.push(left);
	}
	return caps.length === 0 ? undefined : Math.min(...caps);
}

export interface ForeignStartInput {
	/** The agent to run; absent for omp, or when `resume` names a foreign session. */
	agent?: unknown;
	resume?: string;
	cwd: string;
	model?: unknown;
	permission?: unknown;
	/** Refused: a vendor agent has no sandbox. */
	sandboxed?: boolean;
	/** A cap the caller already has (scheduled run, fan-out member), USD. */
	maxCostUsd?: number;
}

export interface ForeignStartDeps {
	agents(): Promise<CompanionAgent[]>;
	rows(): Promise<ForeignRows>;
	/** The spend limits the user set in the app; null when none. */
	limits(): SpendLimits | null;
	/** Spend of every foreign session since local midnight, USD. */
	spentToday(): Promise<number>;
	/** Spend of one foreign session so far, USD. */
	sessionSpend(sessionId: string): Promise<number>;
}

export interface ForeignStartPlan {
	agent: CompanionAgent;
	cwd: string;
	/** A foreign session id to continue. */
	resume?: string;
	row?: ForeignRow;
	/** The vendor's model id; undefined: the agent's default. */
	model?: string;
	permission: ForeignPermission;
	maxCostUsd?: number;
}

/**
 * What a `start` asks for when it is a foreign one: null for an omp start. Resuming a session of the index continues
 * it in its own folder with its own agent; a new session needs a ready agent. Anything that cannot work (not installed,
 * not signed in, sandboxed requested, spend limit used up) is refused here, with a message the person can act on.
 */
export async function planForeignStart(
	input: ForeignStartInput,
	deps: ForeignStartDeps,
): Promise<ForeignStartPlan | null> {
	if (input.agent !== undefined && typeof input.agent !== "string") throw new Error("invalid request");
	const rows = input.resume !== undefined ? await deps.rows() : null;
	const row = input.resume !== undefined && rows && Object.hasOwn(rows, input.resume) ? rows[input.resume] : undefined;
	if (input.agent === undefined && row === undefined) {
		if (input.model !== undefined || input.permission !== undefined) throw new Error("invalid request");
		return null;
	}
	const agentId = row?.agent ?? (input.agent as string);
	if (!AGENT_ID_RE.test(agentId)) throw new Error("unknown agent");
	if (input.agent !== undefined && input.agent !== agentId) throw new Error("that session belongs to another agent");
	if (input.resume !== undefined && row === undefined)
		throw new Error("that session is not one of this computer's agent sessions");
	if (input.permission !== undefined && input.permission !== "supervised" && input.permission !== "full")
		throw new Error("invalid permission");
	if (input.model !== undefined && typeof input.model !== "string") throw new Error("invalid model");
	const model = input.model === "" ? undefined : input.model;
	if (model !== undefined && !FOREIGN_MODEL_RE.test(model)) throw new Error("invalid model");
	const agent = (await deps.agents()).find(candidate => candidate.id === agentId);
	if (!agent) throw new Error("unknown agent");
	if (!agent.installed) throw new Error(`${agent.name} is not installed on this computer.`);
	if (agent.auth === "needed")
		throw new Error(
			`${agent.name} is not signed in${agent.loginCommand ? `: run \`${agent.loginCommand}\` on the computer` : ""}.`,
		);
	// Other agents run unsandboxed for now: omp's profile cannot confine an agent that has a shell.
	if (input.sandboxed === true) throw new Error(`${agent.name} cannot run sandboxed yet.`);
	const limits = deps.limits();
	const maxCostUsd = foreignMaxCost({
		requestedUsd: input.maxCostUsd,
		limits,
		spentTodayUsd: limits?.dailyUsd == null ? 0 : await deps.spentToday(),
		spentBySessionUsd:
			row === undefined || limits?.sessionUsd == null ? 0 : await deps.sessionSpend(input.resume as string),
	});
	return {
		agent,
		cwd: row?.cwd ?? input.cwd,
		resume: row === undefined ? undefined : input.resume,
		row,
		model,
		permission: input.permission ?? row?.permission ?? "supervised",
		maxCostUsd,
	};
}

/** The `--fanout` value of a fan-out member's host: its group, the selector it was picked by and its agent. */
export function fanoutArg(group: string, selector: string, agent: AgentRef): string {
	return JSON.stringify({ group, model: selector, agent });
}

// ── model comparison ─────────────────────────────────────────────────────────

/**
 * The models vendor agents add to a comparison: every ready agent, with its listed models or just "default".
 * An agent that is not installed or not signed in is left out.
 */
export function foreignFanoutModels(agents: readonly CompanionAgent[]): FanoutModel[] {
	const models: FanoutModel[] = [];
	for (const agent of agents) {
		if (!agent.installed || agent.auth === "needed") continue;
		const ref = { id: agent.id, name: agent.name };
		const listed = agent.models?.length ? agent.models : [{ id: "", name: `${agent.name} (default model)` }];
		for (const model of listed) {
			if (model.id !== "" && !FOREIGN_MODEL_RE.test(model.id)) continue;
			models.push({
				selector: foreignSelector(agent.id, model.id),
				name: model.name,
				provider: agent.name,
				agent: ref,
			});
		}
	}
	return models;
}

// ── transcripts ──────────────────────────────────────────────────────────────

/** One model request of a session, as its transcript recorded it. */
export interface UsageEvent {
	/** Unix ms; 0 when the entry has no readable timestamp. */
	at: number;
	model: string;
	/** USD; null when the vendor reported none. */
	cost: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TranscriptStats {
	title: string | null;
	toolCalls: number;
	events: UsageEvent[];
	/** Time of the last entry, Unix ms; 0 when none has a timestamp. */
	lastAt: number;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timeOf(entry: Record<string, unknown>, message: Record<string, unknown>): number {
	const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (!Number.isNaN(stamp)) return stamp;
	return typeof message.timestamp === "number" ? message.timestamp : 0;
}

/** The requests, tool calls and title of a transcript's text: the entries are omp's, one JSON object per line. */
export function parseTranscript(text: string): TranscriptStats {
	const stats: TranscriptStats = { title: null, toolCalls: 0, events: [], lastAt: 0 };
	let slotTitle: string | null | undefined;
	let headerTitle: string | null = null;
	let changedTitle: string | null = null;
	for (const line of text.split("\n")) {
		if (line.charCodeAt(0) !== 123) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a line still being written
		}
		if (!isRecord(entry)) continue;
		if (entry.type === "title") {
			if (slotTitle === undefined) slotTitle = typeof entry.title === "string" ? entry.title : null;
		} else if (entry.type === "session") {
			headerTitle = typeof entry.title === "string" ? entry.title : headerTitle;
		} else if (entry.type === "title_change") {
			if (typeof entry.title === "string") changedTitle = entry.title;
		} else if (entry.type === "message" && isRecord(entry.message)) {
			const message = entry.message;
			const at = timeOf(entry, message);
			if (at > stats.lastAt) stats.lastAt = at;
			if (message.role !== "assistant") continue;
			if (Array.isArray(message.content))
				stats.toolCalls += message.content.filter(block => isRecord(block) && block.type === "toolCall").length;
			if (!isRecord(message.usage)) continue;
			const { usage } = message;
			const cost = isRecord(usage.cost) ? usage.cost.total : usage.cost;
			stats.events.push({
				at,
				model: typeof message.model === "string" ? message.model : "",
				cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
				input: numberOf(usage.input),
				output: numberOf(usage.output),
				cacheRead: numberOf(usage.cacheRead),
				cacheWrite: numberOf(usage.cacheWrite),
			});
		}
	}
	stats.title = (slotTitle !== undefined ? slotTitle : (changedTitle ?? headerTitle))?.trim() || null;
	return stats;
}

/** Transcripts kept parsed in memory: the newest sessions are the ones asked about again and again. */
const MAX_CACHED_TRANSCRIPTS = 300;

export interface ForeignCatalogOptions {
	/** `<config>/agent/collab-foreign/sessions`. */
	transcriptsDir: string;
	readRows(): Promise<ForeignRows>;
	agentRef(id: string): AgentRef;
}

/** A session of the index with what its transcript says. */
export interface ForeignSession {
	sessionId: string;
	row: ForeignRow;
	stats: TranscriptStats | null;
}

export interface ForeignCatalog {
	rows(): Promise<ForeignRows>;
	/** Every session of the index, with its transcript's statistics. */
	sessions(): Promise<ForeignSession[]>;
	/** The agent a foreign session runs, by session id; undefined for any other id. */
	agentOf(sessionId: string): Promise<AgentRef | undefined>;
	/** Rows for the all-sessions list: every foreign session, hosting ones marked, filtered by `q` (title or folder). */
	overviews(request: { q?: unknown }, live: { hosts: readonly CompanionHost[] }): Promise<SessionOverview[]>;
	/** `folders` with the foreign sessions' folders merged in (at most five sessions per folder, fifteen folders). */
	folders(base: readonly RecentFolder[]): Promise<RecentFolder[]>;
	/** Model requests recorded at or after `since`. */
	usageSince(since: number): Promise<(UsageEvent & { folder: string; agentId: string })[]>;
	/** USD spent by one foreign session so far; 0 for an unknown one. */
	sessionSpend(sessionId: string): Promise<number>;
	/** USD spent by foreign sessions since `since`. */
	spentSince(since: number): Promise<number>;
}

const MAX_QUERY_CHARS = 200;
const MAX_FOLDERS = 15;
const SESSIONS_PER_FOLDER = 5;

export function createForeignCatalog(options: ForeignCatalogOptions): ForeignCatalog {
	const cache = new Map<string, { mtimeMs: number; size: number; stats: TranscriptStats }>();

	async function statsOf(sessionId: string): Promise<{ stats: TranscriptStats | null; mtimeMs: number }> {
		if (!SAFE_ID_RE.test(sessionId)) return { stats: null, mtimeMs: 0 };
		const file = path.join(options.transcriptsDir, `${sessionId}.jsonl`);
		let stat: { mtimeMs: number; size: number };
		try {
			stat = await fs.stat(file);
		} catch {
			return { stats: null, mtimeMs: 0 };
		}
		const cached = cache.get(sessionId);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			// Most recently used last.
			cache.delete(sessionId);
			cache.set(sessionId, cached);
			return { stats: cached.stats, mtimeMs: stat.mtimeMs };
		}
		let stats: TranscriptStats;
		try {
			stats = parseTranscript(await Bun.file(file).text());
		} catch {
			return { stats: null, mtimeMs: stat.mtimeMs };
		}
		cache.delete(sessionId);
		cache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, stats });
		for (const key of cache.keys()) {
			if (cache.size <= MAX_CACHED_TRANSCRIPTS) break;
			cache.delete(key);
		}
		return { stats, mtimeMs: stat.mtimeMs };
	}

	async function sessions(): Promise<ForeignSession[]> {
		const rows = await options.readRows();
		return await Promise.all(
			Object.entries(rows).map(async ([sessionId, row]) => ({
				sessionId,
				row,
				stats: (await statsOf(sessionId)).stats,
			})),
		);
	}

	return {
		rows: () => options.readRows(),
		sessions,
		async agentOf(sessionId) {
			const rows = await options.readRows();
			return Object.hasOwn(rows, sessionId) ? options.agentRef(rows[sessionId]!.agent) : undefined;
		},
		async overviews(request, live) {
			const q = typeof request.q === "string" ? request.q.trim().slice(0, MAX_QUERY_CHARS).toLowerCase() : "";
			const hosting = new Map(live.hosts.map(host => [host.sessionId, host.instanceId]));
			const overviews: SessionOverview[] = [];
			for (const { sessionId, row, stats } of await sessions()) {
				const title = row.title ?? stats?.title ?? null;
				if (q !== "" && !`${title ?? ""}\n${row.cwd}`.toLowerCase().includes(q)) continue;
				const events = stats?.events ?? [];
				const models = [
					...new Set([...(row.model ? [row.model] : []), ...events.map(e => e.model).filter(Boolean)]),
				].sort();
				const instanceId = hosting.get(sessionId);
				overviews.push({
					sessionId,
					title,
					folder: row.cwd,
					startedAt: row.createdAt,
					endedAt: Math.max(row.lastActive, stats?.lastAt ?? 0) || null,
					requests: events.length,
					toolCalls: stats?.toolCalls ?? 0,
					subagents: 0,
					tokens: events.reduce((sum, e) => sum + e.input + e.output + e.cacheRead + e.cacheWrite, 0),
					cost: events.reduce((sum, e) => sum + (e.cost ?? 0), 0),
					models,
					agent: options.agentRef(row.agent),
					...(instanceId !== undefined ? { instanceId, live: "host" as const } : {}),
				});
			}
			return overviews;
		},
		async folders(base) {
			const rows = await options.readRows();
			const folders = new Map<string, RecentFolder>(
				base.map(folder => [folder.cwd, { ...folder, sessions: [...folder.sessions] }]),
			);
			const exists = new Map<string, boolean>();
			for (const [sessionId, row] of Object.entries(rows)) {
				if (!path.isAbsolute(row.cwd)) continue;
				let alive = exists.get(row.cwd);
				if (alive === undefined) {
					alive = await fs.stat(row.cwd).then(
						s => s.isDirectory(),
						() => false,
					);
					exists.set(row.cwd, alive);
				}
				if (!alive) continue;
				const folder = folders.get(row.cwd) ?? { cwd: row.cwd, lastActive: row.lastActive, sessions: [] };
				folder.sessions.push({
					id: sessionId,
					title: row.title,
					lastActive: row.lastActive,
					agent: options.agentRef(row.agent),
				});
				folder.lastActive = Math.max(folder.lastActive, row.lastActive);
				folders.set(row.cwd, folder);
			}
			return [...folders.values()]
				.map(folder => ({
					...folder,
					sessions: folder.sessions.sort((a, b) => b.lastActive - a.lastActive).slice(0, SESSIONS_PER_FOLDER),
				}))
				.sort((a, b) => b.lastActive - a.lastActive)
				.slice(0, MAX_FOLDERS);
		},
		async usageSince(since) {
			const events: (UsageEvent & { folder: string; agentId: string })[] = [];
			for (const { row, stats } of await sessions()) {
				for (const event of stats?.events ?? [])
					if (event.at >= since) events.push({ ...event, folder: row.cwd, agentId: row.agent });
			}
			return events;
		},
		async sessionSpend(sessionId) {
			return (await statsOf(sessionId)).stats?.events.reduce((sum, e) => sum + (e.cost ?? 0), 0) ?? 0;
		},
		async spentSince(since) {
			let usd = 0;
			for (const { stats } of await sessions())
				for (const event of stats?.events ?? []) if (event.at >= since) usd += event.cost ?? 0;
			return usd;
		},
	};
}

/** `omp`'s rows and the foreign ones as one list, newest activity first, at most `limit`. */
export function mergeOverviews(
	omp: readonly SessionOverview[],
	foreign: readonly SessionOverview[],
	limit: number,
): SessionOverview[] {
	return [...omp, ...foreign].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).slice(0, limit);
}

/**
 * Overviews for sessions a file scan found, in the scan's order: vendor agent sessions come from the catalog (their
 * transcripts hold the totals), the others from `ompOverviews`.
 */
export async function mergeFileSessions<T extends { sessionId: string }>(
	found: readonly T[],
	catalog: Pick<ForeignCatalog, "overviews">,
	live: { hosts: readonly CompanionHost[] },
	ompOverviews: (omp: readonly T[]) => Promise<SessionOverview[]>,
): Promise<SessionOverview[]> {
	const foreign = new Map((await catalog.overviews({}, live)).map(overview => [overview.sessionId, overview]));
	const omp = new Map(
		(await ompOverviews(found.filter(session => !foreign.has(session.sessionId)))).map(overview => [
			overview.sessionId,
			overview,
		]),
	);
	return found.flatMap(session => {
		const overview = foreign.get(session.sessionId) ?? omp.get(session.sessionId);
		return overview ? [overview] : [];
	});
}

/** Search hits and any other row keyed by a session id, with the agent of those that are foreign sessions. */
export async function withAgents<T extends { sessionId: string; agent?: AgentRef }>(
	items: readonly T[],
	catalog: Pick<ForeignCatalog, "agentOf">,
): Promise<T[]> {
	return await Promise.all(
		items.map(async item => {
			const agent = await catalog.agentOf(item.sessionId);
			return agent ? { ...item, agent } : item;
		}),
	);
}

/**
 * Hosts that run a vendor agent have no omp overlay, and their index row is how the companion knows the session: a host
 * with a row is unrestricted (`sandboxed: false`, other agents run unsandboxed). A host whose row is missing (not
 * written yet, lost, or the index unreadable) is reported `sandboxed: true` until the row is readable, the flag the
 * file, git and run actions are refused on: they stay closed rather than open to a session the companion cannot vouch for.
 */
export function withForeignRows(hosts: readonly CompanionHost[], rows: ForeignRows): CompanionHost[] {
	return hosts.map(host => {
		if (!host.agent) return host;
		return { ...host, sandboxed: !Object.hasOwn(rows, host.sessionId) };
	});
}

// ── spend and usage ──────────────────────────────────────────────────────────

/**
 * `reading` (omp's, from the stats database) with the foreign sessions' spend added: today's total, and the total of each
 * hosting foreign session when a per-session limit is set.
 */
export async function withForeignSpend(
	reading: SpendReading,
	input: {
		catalog: Pick<ForeignCatalog, "spentSince" | "sessionSpend">;
		hosts: readonly CompanionHost[];
		limits: SpendLimits;
		now: number;
	},
): Promise<SpendReading> {
	const { catalog, hosts, limits, now } = input;
	const dailyUsd =
		limits.dailyUsd === null ? reading.dailyUsd : reading.dailyUsd + (await catalog.spentSince(dayStart(now)));
	const sessions = [...reading.sessions];
	if (limits.sessionUsd !== null) {
		for (const host of hosts) {
			if (!host.agent) continue;
			sessions.push({
				sessionId: host.sessionId,
				instanceId: host.instanceId,
				title: host.sessionName || path.basename(host.cwd) || "session",
				usd: await catalog.sessionSpend(host.sessionId),
			});
		}
	}
	return { dailyUsd, sessions };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How far back each usage range reaches; null: everything. */
const RANGE_SPAN_MS: Record<UsageRange, number | null> = {
	"24h": DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
	"90d": 90 * DAY_MS,
	all: null,
};
const USAGE_MODEL_LIMIT = 12;
const USAGE_PROJECT_LIMIT = 15;

/** When `range` starts, counted back from `now`; 0 for all time. */
export function usageRangeStart(range: UsageRange, now: number): number {
	const span = RANGE_SPAN_MS[range];
	return span === null ? 0 : now - span;
}

/**
 * The omp usage `report` with foreign requests added: totals, the chart bucket each fell in, spend per model and per
 * project. A request without a reported cost counts as unpriced, as omp's unpriced ones do.
 */
export function mergeForeignUsage(
	report: UsageReport,
	events: readonly (UsageEvent & { folder: string; agentId: string })[],
	agentRef: (id: string) => AgentRef,
): UsageReport {
	if (events.length === 0) return report;
	const overall = { ...report.overall };
	const series = report.series.map(point => ({ ...point }));
	const byModel = new Map(report.byModel.map(row => [`${row.provider}\n${row.model}`, { ...row }]));
	const byProject = new Map(report.byProject.map(row => [row.folder, { ...row }]));
	for (const event of events) {
		const tokens = event.input + event.output + event.cacheRead + event.cacheWrite;
		const cost = event.cost ?? 0;
		overall.requests += 1;
		overall.cost += cost;
		overall.inputTokens += event.input;
		overall.outputTokens += event.output;
		overall.cacheReadTokens += event.cacheRead;
		overall.cacheWriteTokens += event.cacheWrite;
		overall.totalTokens += tokens;
		if (event.cost === null) overall.unpricedRequests += 1;
		// The last bucket that starts at or before the request (a compacted bucket keeps its first start).
		let bucket: (typeof series)[number] | undefined;
		for (const point of series) if (point.t <= event.at) bucket = point;
		if (bucket) {
			bucket.cost += cost;
			bucket.tokens += tokens;
			bucket.requests += 1;
		}
		const provider = agentRef(event.agentId).name;
		const model = event.model || "default";
		const modelRow = byModel.get(`${provider}\n${model}`) ?? { model, provider, cost: 0, requests: 0, tokens: 0 };
		modelRow.cost += cost;
		modelRow.requests += 1;
		modelRow.tokens += tokens;
		byModel.set(`${provider}\n${model}`, modelRow);
		const project = byProject.get(event.folder) ?? { folder: event.folder, cost: 0, requests: 0, tokens: 0 };
		project.cost += cost;
		project.requests += 1;
		project.tokens += tokens;
		byProject.set(event.folder, project);
	}
	const cached = overall.inputTokens + overall.cacheReadTokens;
	overall.cacheRate = cached > 0 ? overall.cacheReadTokens / cached : 0;
	return {
		...report,
		overall,
		series,
		byModel: [...byModel.values()]
			.sort((a, b) => b.cost - a.cost || b.requests - a.requests)
			.slice(0, USAGE_MODEL_LIMIT),
		byProject: [...byProject.values()]
			.sort((a, b) => b.cost - a.cost || b.requests - a.requests)
			.slice(0, USAGE_PROJECT_LIMIT),
	};
}
