/**
 * A read-only omp session the companion starts to write one JSON file, shared by architecture maps
 * (./companion-blueprint) and quizzes (./companion-quiz): how the session is kept read-only (a tool allowlist and a
 * config overlay that lets `write` reach exactly one file), how the companion notices that it is done (the file has
 * stopped changing while the session is idle or gone), and how it is stopped and cleaned up. What the session is told
 * and what is done with its file are the caller's.
 *
 * The session is started through the companion's own session start, so it is listed, watchable and stoppable like any
 * other and obeys its spending limit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MODEL_SELECTOR_RE } from "../src/lib/fanout";
import { checkRefName } from "./companion-blueprint-git";

/** Tools the session gets: read and search the code, ask the index, and write the one result file. */
export const READONLY_AGENT_TOOLS = ["read", "grep", "glob", "ast_grep", "trace", "flow", "write"] as const;

/**
 * Tools omp keeps off by default, and the setting that turns each on. `--tools` naming a tool that is off makes omp
 * exit at once ("Built-in tools unavailable in this session"), so an overlay must enable every gated tool it lists.
 */
export const GATED_TOOL_SETTINGS: Record<string, "astGrep" | "codemap"> = {
	ast_grep: "astGrep",
	trace: "codemap",
	flow: "codemap",
};

/**
 * A glob that matches exactly `file`. omp's path-rule globs have no backslash escape: a wildcard character in the
 * path is matched literally by wrapping it in a character class (`[*]`). A backslash cannot be matched at all.
 */
function globLiteral(file: string): string {
	if (file.includes("\\")) throw new Error("the folder path contains a backslash");
	return file.replace(/[*?[\]{}]/g, char => `[${char}]`);
}

/**
 * Config overlay for a read-only agent, layered after the companion's. Execution tools are denied outright, and the
 * file tools may write exactly one file: `outFile`. Defence in depth behind `--tools` (which has no shell) and, where
 * the platform has it, the sandbox profile. Every gated tool in `tools` is turned on ({@link GATED_TOOL_SETTINGS}).
 */
export function restrictedOverlayYaml(outFile: string, tools: readonly string[]): string {
	const gated = new Set(
		tools.flatMap(tool => (Object.hasOwn(GATED_TOOL_SETTINGS, tool) ? [GATED_TOOL_SETTINGS[tool]!] : [])),
	);
	return `tools:
  approvalMode: write
  approval:
    bash: deny
    python: deny
    eval: deny
    browser: deny
    computer: deny
    task: deny
    debug: deny
  outsideProject: allow
  pathRules:
    - glob: ${JSON.stringify(globLiteral(outFile))}
      tools: [write]
      action: allow
    - glob: "**"
      tools: [write, edit, ast_edit]
      action: deny
bash:
  enabled: false
${[...gated]
	.sort()
	.map(setting => `${setting}:\n  enabled: true\n`)
	.join("")}lsp:
  enabled: false
mcp:
  enableProjectConfig: false
`;
}

/** The file the agent writes to, inside `outDir`. */
export function agentOutputFile(outDir: string, id: string): string {
	return path.join(outDir, `${id}.json`);
}

/**
 * The (not yet existing) result file of run `id` in `outDir`, created if needed. The session's write rule names this
 * file, and omp judges a path by its real location too, so the rule needs the real one.
 */
export async function prepareOutputFile(outDir: string, id: string): Promise<string> {
	await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
	const file = agentOutputFile(await fs.realpath(outDir), id);
	await fs.rm(file, { force: true });
	return file;
}

// ── starting the session ─────────────────────────────────────────────────────

/** What the agent session is started with; the companion starts it like any other session, read-only. */
export interface AgentLaunch {
	/** The checkout the session works in. */
	cwd: string;
	prompt: string;
	maxCostUsd: number;
	model?: string;
	outFile: string;
	/** Overlay file this launch writes (the run removes it). */
	overlayPath: string;
	overlayYaml: string;
	tools: readonly string[];
}

/** A listed omp session, as far as a run needs to know. */
export interface AgentSession {
	instanceId: string;
	sessionId: string;
	model: string | null;
	busy: boolean | null;
}

/** The companion's session start, as far as a run needs it. */
export interface AgentRunner {
	start(launch: AgentLaunch): Promise<string>;
	hosts(): Promise<AgentSession[]>;
	stop(instanceId: string): Promise<void>;
	/** Spend of a session so far, USD. */
	cost(sessionId: string): Promise<number | undefined>;
}

// ── noticing that the agent is done ──────────────────────────────────────────

/** What the session was last seen doing, from the companion's session list. */
export interface AgentHost {
	busy: boolean | null;
}

export interface AgentWatch {
	/** The session, or null when it is no longer listed. */
	host(): Promise<AgentHost | null>;
	/** The result file: its raw text and a change signature (size and mtime), or null when it is not there. */
	output(): Promise<{ text: string; signature: string } | null>;
	now(): number;
	sleep(ms: number): Promise<void>;
	cancelled(): boolean;
}

export type AgentOutcome =
	| { kind: "done"; text: string }
	/** The session ended without a usable file (a spending limit, a crash, stopped from the app). */
	| { kind: "ended" }
	/** The session sat idle without writing the file. */
	| { kind: "stalled" }
	| { kind: "timeout" }
	| { kind: "cancelled" };

export interface AgentWatchOptions {
	pollMs: number;
	/** The file must stay unchanged, with the session idle or gone, this long before it counts as the result. */
	settleMs: number;
	/** Idle without a file this long counts as stalled. */
	idleMs: number;
	/** Not listed for this long, with no file, counts as ended. */
	goneMs: number;
	timeoutMs: number;
}

export const DEFAULT_WATCH: AgentWatchOptions = {
	pollMs: 2_000,
	settleMs: 6_000,
	idleMs: 120_000,
	goneMs: 10_000,
	timeoutMs: 45 * 60_000,
};

/**
 * Wait until the session has written its result and finished, or has ended or stalled without one. A result
 * counts once its file has stopped changing while the session is idle or gone: a file written mid-run, with
 * more turns to come, is not taken early.
 */
export async function waitForAgent(
	watch: AgentWatch,
	options: AgentWatchOptions = DEFAULT_WATCH,
): Promise<AgentOutcome> {
	const started = watch.now();
	let idleSince: number | null = null;
	let goneSince: number | null = null;
	let stable: { signature: string; since: number } | null = null;
	for (;;) {
		if (watch.cancelled()) return { kind: "cancelled" };
		const now = watch.now();
		if (now - started > options.timeoutMs) return { kind: "timeout" };
		const [host, output] = await Promise.all([watch.host(), watch.output()]);
		goneSince = host === null ? (goneSince ?? now) : null;
		idleSince = host !== null && host.busy === false ? (idleSince ?? now) : null;
		if (output === null) {
			stable = null;
			if (goneSince !== null && now - goneSince >= options.goneMs) return { kind: "ended" };
			if (idleSince !== null && now - idleSince >= options.idleMs) return { kind: "stalled" };
		} else {
			if (stable === null || stable.signature !== output.signature)
				stable = { signature: output.signature, since: now };
			const finished = host === null || host.busy === false;
			if (finished && now - stable.since >= options.settleMs) return { kind: "done", text: output.text };
		}
		await watch.sleep(options.pollMs);
	}
}

// ── a whole run ──────────────────────────────────────────────────────────────

export interface AgentRunOptions {
	agent: AgentRunner;
	launch: AgentLaunch;
	/** Timing of the wait; tests shorten it. */
	watch?: Partial<AgentWatchOptions>;
	now(): number;
	cancelled(): boolean;
	/** The session started: its instance id, to show and to stop it. */
	started?(instanceId: string): Promise<void>;
	log?(message: string): void;
}

export interface AgentRunResult {
	outcome: AgentOutcome;
	/** `provider/model` the session ran on, when it was seen. */
	model?: string;
	costUsd?: number;
}

/**
 * Start the session, wait for its file, read its cost, end it and remove its overlay and file. A session that fails to
 * start throws; one that ends without a usable file is an `outcome`, which {@link agentFailureReason} words.
 */
export async function runAgentToFile(options: AgentRunOptions): Promise<AgentRunResult> {
	const { agent, launch } = options;
	let instanceId: string | undefined;
	let lastHost: AgentSession | undefined;
	try {
		instanceId = await agent.start(launch);
		await options.started?.(instanceId);
		const outcome = await waitForAgent(
			{
				host: async () => {
					const host = (await agent.hosts()).find(h => h.instanceId === instanceId) ?? null;
					if (host) lastHost = host;
					return host;
				},
				output: async () => {
					try {
						const [text, stat] = await Promise.all([
							fs.readFile(launch.outFile, "utf8"),
							fs.stat(launch.outFile),
						]);
						return { text, signature: `${stat.size}:${stat.mtimeMs}` };
					} catch {
						return null;
					}
				},
				now: options.now,
				sleep: ms => Bun.sleep(ms),
				cancelled: options.cancelled,
			},
			{ ...DEFAULT_WATCH, ...options.watch },
		);
		const costUsd = lastHost ? await agent.cost(lastHost.sessionId).catch(() => undefined) : undefined;
		return { outcome, model: lastHost?.model ?? undefined, costUsd };
	} finally {
		if (instanceId !== undefined)
			await agent
				.stop(instanceId)
				.catch(err =>
					options.log?.(`stopping the agent session failed: ${err instanceof Error ? err.message : err}`),
				);
		await Promise.all([fs.rm(launch.outFile, { force: true }), fs.rm(launch.overlayPath, { force: true })]);
	}
}

/**
 * Why a run that is not `done` produced nothing, in plain words that complete "The agent … because": `what` names
 * the missing thing ("the diagrams", "the questions").
 */
export function agentFailureReason(
	outcome: Exclude<AgentOutcome, { kind: "done" }>,
	costUsd: number | undefined,
	maxCostUsd: number,
	what: string,
): string {
	if (outcome.kind === "ended")
		return costUsd !== undefined && costUsd >= maxCostUsd * 0.98
			? `it reached its spending limit before writing ${what}`
			: `its session ended before it wrote ${what}`;
	if (outcome.kind === "stalled") return `it stopped without writing ${what}`;
	if (outcome.kind === "timeout") return "it ran out of time";
	return "it was cancelled";
}

/** Fill `{{name}}` placeholders; a missing value is an empty string. */
export function fillTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (Object.hasOwn(values, name) ? values[name]! : ""));
}

/**
 * Folder name of the checkout a session works in, which is how the session is listed ("Architecture · repo @ ref",
 * "Quiz · repo @ ref"). Characters a sandbox profile refuses are replaced.
 */
export function agentFolderName(kind: string, repo: string, label: string): string {
	const clean = (text: string): string => text.replace(/[/\\"\0-\x1f]/g, "-").trim();
	return `${kind} · ${clean(repo)} @ ${clean(label)}`;
}

/** The JSON in the agent's file, tolerating a markdown fence around it. */
export function parseAgentJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
	return JSON.parse(fenced ? fenced[1]! : trimmed);
}

/** The largest spending limit a request may name, USD. */
export const MAX_COST_LIMIT_USD = 100;

/** The parts of a request to map or quiz a repository that every kind shares, validated: a device sent them. */
export interface RunRequest {
	cwd: string;
	ref?: string;
	base?: string;
	maxCostUsd: number;
	model?: string;
}

/**
 * @throws Error with a plain message for a folder that is not absolute, a ref that is not a ref name, a spending limit
 * that is not a positive number up to {@link MAX_COST_LIMIT_USD}, or a model that is not a model selector.
 */
export function checkRunRequest(
	request: { cwd?: unknown; ref?: unknown; base?: unknown; maxCostUsd?: unknown; model?: unknown },
	defaultMaxCostUsd: number,
): RunRequest {
	if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd) || request.cwd.includes("\0"))
		throw new Error("invalid folder");
	if (request.ref !== undefined) checkRefName(request.ref, "ref");
	if (request.base !== undefined) checkRefName(request.base, "base");
	const maxCostUsd = request.maxCostUsd ?? defaultMaxCostUsd;
	if (
		typeof maxCostUsd !== "number" ||
		!Number.isFinite(maxCostUsd) ||
		maxCostUsd <= 0 ||
		maxCostUsd > MAX_COST_LIMIT_USD
	)
		throw new Error("invalid spending limit");
	if (request.model !== undefined && (typeof request.model !== "string" || !MODEL_SELECTOR_RE.test(request.model)))
		throw new Error("invalid model");
	return {
		cwd: request.cwd,
		ref: request.ref as string | undefined,
		base: request.base as string | undefined,
		maxCostUsd,
		model: request.model,
	};
}
