/**
 * Best-of-N for the `fanout-*` requests: one prompt starts on several models, each session in its own git
 * worktree of the same repository (see ./companion-gitflow), and the app compares them and keeps one.
 * Effects (starting omp, listing sessions, reading the repository) arrive as options, so the bookkeeping
 * and the refusals (never delete uncommitted work unasked) are testable without tmux or omp.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentRef, RunInfo } from "../src/lib/companion";
import {
	type FanoutCompare,
	type FanoutGroup,
	type FanoutKeepRequest,
	type FanoutKeepResult,
	type FanoutModel,
	type FanoutRequest,
	type FanoutRun,
	type FanoutRunView,
	type FanoutStatus,
	type FanoutVerify,
	MAX_FANOUT_BUDGET_USD,
	MAX_FANOUT_MODELS,
	MAX_FANOUT_PROMPT_CHARS,
	MIN_FANOUT_MODELS,
	MODEL_SELECTOR_RE,
	splitBudget,
} from "../src/lib/fanout";
import { createWorktree, DEFAULT_BRANCH_PREFIX, discardWorktree, removeWorktree } from "./companion-gitflow";
import { SAFE_ID_RE } from "./companion-sessions";

/** Groups kept on disk; the oldest go first. */
export const MAX_GROUPS = 20;
const MAX_CWD_CHARS = 4096;
const MAX_BRANCH_SLUG_CHARS = 30;
/** How long a stopped session gets to leave the host list before its worktree is judged still in use. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 250;
const MODELS_TTL_MS = 5 * 60_000;
const MODELS_TIMEOUT_MS = 30_000;
/** Targets of a finished run that count as the session's test or verify result. */
const VERIFY_RE = /\b(test|tests|verify|check|typecheck|lint)\b/;

// ── requests ─────────────────────────────────────────────────────────────────

/** The request, validated: 2–4 distinct models, a prompt, an optional total budget. */
export function parseFanoutRequest(input: unknown): FanoutRequest {
	if (typeof input !== "object" || input === null) throw new Error("invalid request");
	const { cwd, prompt, models, budgetUsd, sandboxed } = input as Record<string, unknown>;
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0") || cwd.length > MAX_CWD_CHARS)
		throw new Error("cwd must be an absolute path");
	if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("a prompt is required");
	if (prompt.length > MAX_FANOUT_PROMPT_CHARS) throw new Error("the prompt is too long");
	if (!Array.isArray(models) || models.length < MIN_FANOUT_MODELS || models.length > MAX_FANOUT_MODELS)
		throw new Error(`pick ${MIN_FANOUT_MODELS} to ${MAX_FANOUT_MODELS} models`);
	for (const model of models) {
		if (typeof model !== "string" || !MODEL_SELECTOR_RE.test(model)) throw new Error("invalid model");
	}
	if (new Set(models).size !== models.length) throw new Error("pick different models");
	if (budgetUsd !== undefined) {
		if (
			typeof budgetUsd !== "number" ||
			!Number.isFinite(budgetUsd) ||
			budgetUsd <= 0 ||
			budgetUsd > MAX_FANOUT_BUDGET_USD
		)
			throw new Error(`the budget must be between $0 and $${MAX_FANOUT_BUDGET_USD}`);
		if (splitBudget(budgetUsd, models.length) < 0.01)
			throw new Error("the budget is too small to split between the models");
	}
	if (sandboxed !== undefined && typeof sandboxed !== "boolean") throw new Error("invalid request");
	return { cwd, prompt, models: models as string[], budgetUsd, sandboxed };
}

/** A keep request, validated. */
export function parseKeepRequest(input: unknown): FanoutKeepRequest {
	if (typeof input !== "object" || input === null) throw new Error("invalid request");
	const { group, keep, removeOthers, discardDirty } = input as Record<string, unknown>;
	if (typeof group !== "string" || !SAFE_ID_RE.test(group)) throw new Error("invalid group");
	if (typeof keep !== "string" || !SAFE_ID_RE.test(keep)) throw new Error("invalid session id");
	if (typeof removeOthers !== "boolean" || typeof discardDirty !== "boolean") throw new Error("invalid request");
	if (discardDirty && !removeOthers) throw new Error("invalid request");
	return { group, keep, removeOthers, discardDirty };
}

/** `<prefix>fan-<group>-<n>-<model>` (prefix `omp/` by default; a bake-off's is `bake`): unique per session, a valid branch name whatever the model's id holds. */
export function fanoutBranch(
	groupId: string,
	index: number,
	model: string,
	prefix = DEFAULT_BRANCH_PREFIX,
	word: "fan" | "bake" = "fan",
): string {
	const slug =
		model
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_BRANCH_SLUG_CHARS)
			.replace(/-+$/, "") || "model";
	return `${prefix}${word}-${groupId.slice(0, 4)}-${index + 1}-${slug}`;
}

export interface FanoutStartDeps {
	/** Where new worktrees go (the companion's worktree folder setting). */
	worktreesDir: string;
	/** Branch-name prefix of the companion's git settings. */
	branchPrefix?: string;
	/** Prepare a fresh worktree (the companion's setup script) before its session starts; a rejection fails that run. */
	setup?(tree: { root: string; path: string; branch: string }): Promise<unknown>;
	/** The vendor agent a model selector runs; undefined for an omp model. */
	agentRef?(model: string): AgentRef | undefined;
	/**
	 * Start a session in `cwd` (a worktree) on `model` with the prompt and `--max-cost`; resolves with its instance id once it hosts.
	 * `model` is an omp `provider/id`, or the selector of a vendor agent's model (`agent:<agent>/<model>`); `group` is the fan-out's id.
	 */
	launch(input: {
		cwd: string;
		prompt: string;
		model: string;
		maxCostUsd?: number;
		sandboxed?: boolean;
		group: string;
	}): Promise<string>;
	now?: () => number;
	newId?: () => string;
	/** Commit every worktree starts from (a full commit id); default: HEAD of the repository. */
	startCommit?: string;
	/** The branch name of the member at `index` on `model`; default {@link fanoutBranch}. */
	branchName?(index: number, model: string): string;
	/** The bake-off this group belongs to: its group is kept until the bake-off is deleted. */
	bakeoff?: string;
}

/**
 * Create a worktree per model, then start every session at once. A worktree that cannot be made undoes the
 * rest and fails the request; a session that does not start is recorded with its error and its worktree
 * discarded, while the others go on. Rejects when none started.
 */
export async function startFanout(request: FanoutRequest, deps: FanoutStartDeps): Promise<FanoutGroup> {
	const id = (deps.newId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 12)))();
	const trees: { root: string; path: string; branch: string }[] = [];
	try {
		// One at a time: git takes its repository-wide locks per worktree.
		for (const [i, model] of request.models.entries()) {
			trees.push(
				await createWorktree(
					request.cwd,
					deps.worktreesDir,
					deps.branchName?.(i, model) ?? fanoutBranch(id, i, model, deps.branchPrefix),
					undefined,
					{ start: deps.startCommit },
				),
			);
		}
	} catch (err) {
		for (const tree of trees) await discardWorktree(tree);
		throw err;
	}
	const perSession =
		request.budgetUsd === undefined ? undefined : splitBudget(request.budgetUsd, request.models.length);
	const runs: FanoutRun[] = await Promise.all(
		trees.map(async (tree, i): Promise<FanoutRun> => {
			const model = request.models[i]!;
			// Resolved, as the session list and the stats database name the folder omp ran in.
			const resolved = await fs.realpath(tree.path).catch(() => tree.path);
			const run: FanoutRun = {
				model,
				agent: deps.agentRef?.(model),
				branch: tree.branch,
				path: resolved,
				maxCostUsd: perSession,
			};
			try {
				await deps.setup?.(tree);
				run.instanceId = await deps.launch({
					cwd: tree.path,
					prompt: request.prompt,
					model,
					maxCostUsd: perSession,
					sandboxed: request.sandboxed,
					group: id,
				});
			} catch (err) {
				run.error = err instanceof Error ? err.message : String(err);
				await discardWorktree(tree);
			}
			return run;
		}),
	);
	const failed = runs.find(run => run.instanceId === undefined);
	if (failed && runs.every(run => run.instanceId === undefined)) throw new Error(failed.error ?? "no session started");
	return {
		id,
		root: trees[0]!.root,
		prompt: request.prompt,
		createdAt: (deps.now ?? Date.now)(),
		budgetUsd: request.budgetUsd,
		runs,
		...(deps.bakeoff ? { bakeoff: deps.bakeoff } : {}),
	};
}

// ── compare ──────────────────────────────────────────────────────────────────

export interface CompareHost {
	instanceId: string;
	cwd: string;
	busy: boolean | null;
	inputRequired: boolean;
	relayConnected: boolean;
}

export interface CompareDeps {
	/** Sessions hosting collab right now. */
	hosts(): CompareHost[];
	/** Spend in USD of every session that worked in `folder`; null when none is known. */
	cost(folder: string): number | null;
	/** The worktree's branch review (`gitReview`); null when the worktree is gone. */
	review(folder: string): Promise<{
		dirty: boolean;
		files: { added: number | null; removed: number | null }[];
		pr: { url: string; number: number } | null;
	} | null>;
	runs(instanceId: string): RunInfo[];
}

/** The newest finished run of a test, verify, check, typecheck or lint target. */
export function pickVerify(runs: readonly RunInfo[]): FanoutVerify | null {
	const found = runs
		.filter(run => run.state !== "running" && VERIFY_RE.test(`${run.targetId} ${run.command}`.toLowerCase()))
		.sort((a, b) => b.startedAt - a.startedAt)[0];
	if (!found) return null;
	return { command: found.command, ok: found.state === "exited" && found.exitCode === 0 };
}

function statusOf(run: FanoutRun, host: CompareHost | undefined): FanoutStatus {
	if (run.instanceId === undefined) return "failed";
	if (!host) return "ended";
	if (!host.relayConnected) return "offline";
	if (host.inputRequired) return "needs-input";
	return host.busy === false ? "idle" : "working";
}

/** Everything the compare sheet shows about a group, read fresh. */
export async function compareGroup(group: FanoutGroup, deps: CompareDeps): Promise<FanoutCompare> {
	const hosts = deps.hosts();
	const runs = await Promise.all(
		group.runs.map(async (run): Promise<FanoutRunView> => {
			const host = run.instanceId === undefined ? undefined : hosts.find(h => h.instanceId === run.instanceId);
			const review = run.removed || run.error !== undefined ? null : await deps.review(run.path).catch(() => null);
			return {
				model: run.model,
				agent: run.agent,
				branch: run.branch,
				path: run.path,
				instanceId: run.instanceId ?? null,
				status: statusOf(run, host),
				costUsd: deps.cost(run.path),
				maxCostUsd: run.maxCostUsd ?? null,
				files: review?.files.length ?? null,
				// A binary file has no line counts: the totals then count only the text files.
				added: review ? review.files.reduce((sum, file) => sum + (file.added ?? 0), 0) : null,
				removed: review ? review.files.reduce((sum, file) => sum + (file.removed ?? 0), 0) : null,
				dirty: review?.dirty ?? false,
				verify: run.instanceId === undefined ? null : pickVerify(deps.runs(run.instanceId)),
				pr: review?.pr ?? null,
				gone: run.removed === true || review === null,
				error: run.error ?? null,
			};
		}),
	);
	return {
		id: group.id,
		prompt: group.prompt,
		createdAt: group.createdAt,
		budgetUsd: group.budgetUsd ?? null,
		kept: group.kept ?? null,
		runs,
	};
}

// ── keep ─────────────────────────────────────────────────────────────────────

export interface KeepDeps {
	/** The folders the companion keeps worktrees in (the current setting and where earlier ones went). */
	worktreesDir: string | readonly string[];
	/** A fresh listing of the sessions hosting collab. */
	hosts(): Promise<CompareHost[]>;
	/** Working directories of every running omp (hosting or not), fresh. */
	runningCwds(): Promise<string[]>;
	/** Uncommitted changes in the worktree; null when it is gone. */
	dirty(folder: string): Promise<boolean | null>;
	/** End the session (best effort). */
	stop(instanceId: string): Promise<void>;
	/** How long a stopped session gets to leave the host list (default {@link STOP_WAIT_MS}). */
	stopWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Mark `request.keep` as the winner and, when asked, remove the other worktrees (their branches stay). A worktree
 * with uncommitted changes is removed only with `discardDirty`; anything that cannot be removed is reported.
 * Mutates `group`; the caller saves it.
 */
export async function keepRun(
	group: FanoutGroup,
	request: FanoutKeepRequest,
	deps: KeepDeps,
): Promise<FanoutKeepResult> {
	const winner = group.runs.find(run => run.instanceId === request.keep && !run.removed);
	if (!winner) throw new Error("that session is not part of this group");
	group.kept = request.keep;
	const result: FanoutKeepResult = { removed: [], skipped: [] };
	if (!request.removeOthers) return result;
	const sleep = deps.sleep ?? Bun.sleep;
	for (const run of group.runs) {
		if (run === winner || run.removed) continue;
		try {
			const dirty = await deps.dirty(run.path);
			if (dirty === null) {
				run.removed = true;
				continue;
			}
			if (dirty && !request.discardDirty) {
				result.skipped.push({ model: run.model, reason: "it has uncommitted changes" });
				continue;
			}
			if (run.instanceId !== undefined && (await deps.hosts()).some(h => h.instanceId === run.instanceId)) {
				await deps.stop(run.instanceId);
				const until = Date.now() + (deps.stopWaitMs ?? STOP_WAIT_MS);
				while ((await deps.hosts()).some(h => h.instanceId === run.instanceId) && Date.now() < until)
					await sleep(STOP_POLL_MS);
			}
			await removeWorktree(run.path, deps.worktreesDir, await deps.runningCwds(), request.discardDirty);
			run.removed = true;
			result.removed.push(run.model);
		} catch (err) {
			result.skipped.push({ model: run.model, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}

// ── storage ──────────────────────────────────────────────────────────────────

/** The agent a saved run recorded; absent for an omp run. */
function parseAgentRef(value: unknown): AgentRef | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, name } = value as Record<string, unknown>;
	return typeof id === "string" && typeof name === "string" ? { id, name } : undefined;
}

function parseRun(value: unknown): FanoutRun | null {
	if (typeof value !== "object" || value === null) return null;
	const run = value as Record<string, unknown>;
	if (typeof run.model !== "string" || typeof run.branch !== "string" || typeof run.path !== "string") return null;
	if (run.instanceId !== undefined && (typeof run.instanceId !== "string" || !SAFE_ID_RE.test(run.instanceId)))
		return null;
	return {
		model: run.model,
		agent: parseAgentRef(run.agent),
		branch: run.branch,
		path: run.path,
		instanceId: run.instanceId as string | undefined,
		maxCostUsd: typeof run.maxCostUsd === "number" ? run.maxCostUsd : undefined,
		error: typeof run.error === "string" ? run.error : undefined,
		removed: run.removed === true ? true : undefined,
	};
}

/** The groups saved in `file`, newest first; unreadable or malformed entries are dropped. */
export async function loadGroups(file: string): Promise<FanoutGroup[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(file).text());
	} catch {
		return [];
	}
	const list = (raw as { groups?: unknown } | null)?.groups;
	if (!Array.isArray(list)) return [];
	const groups: FanoutGroup[] = [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const g = item as Record<string, unknown>;
		if (
			typeof g.id !== "string" ||
			!SAFE_ID_RE.test(g.id) ||
			typeof g.root !== "string" ||
			typeof g.prompt !== "string" ||
			typeof g.createdAt !== "number" ||
			!Array.isArray(g.runs)
		)
			continue;
		const runs = g.runs.map(parseRun);
		if (runs.some(run => run === null)) continue;
		groups.push({
			id: g.id,
			root: g.root,
			prompt: g.prompt,
			createdAt: g.createdAt,
			budgetUsd: typeof g.budgetUsd === "number" ? g.budgetUsd : undefined,
			runs: runs as FanoutRun[],
			kept: typeof g.kept === "string" ? g.kept : undefined,
			bakeoff: typeof g.bakeoff === "string" && /^bk-[0-9a-f]{12}$/.test(g.bakeoff) ? g.bakeoff : undefined,
		});
	}
	return groups;
}

export async function saveGroups(file: string, groups: readonly FanoutGroup[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify({ groups }, null, "\t")}\n`, { mode: 0o600 });
}

/** `group` first, replacing an entry with its id; at most {@link MAX_GROUPS} are kept, except that a bake-off's group stays until the bake-off is deleted. */
export function withGroup(groups: readonly FanoutGroup[], group: FanoutGroup): FanoutGroup[] {
	let plain = 0;
	return [group, ...groups.filter(g => g.id !== group.id)].filter(
		g => g.bakeoff !== undefined || ++plain <= MAX_GROUPS,
	);
}

// ── models ───────────────────────────────────────────────────────────────────

/** USD per million tokens as `omp models --json` lists them; undefined when either side is missing. */
function priceOf(value: unknown): FanoutModel["cost"] {
	if (typeof value !== "object" || value === null) return undefined;
	const input = "input" in value ? value.input : undefined;
	const output = "output" in value ? value.output : undefined;
	return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
}

/** The chat models of `omp models --json` output; anything with an unusable selector is skipped. */
export function parseModelList(json: string): FanoutModel[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const list = (parsed as { models?: unknown } | null)?.models;
	if (!Array.isArray(list)) return [];
	const models: FanoutModel[] = [];
	for (const item of list as Record<string, unknown>[]) {
		if (typeof item?.provider !== "string" || typeof item.id !== "string") continue;
		const selector = typeof item.selector === "string" ? item.selector : `${item.provider}/${item.id}`;
		if (!MODEL_SELECTOR_RE.test(selector)) continue;
		const cost = priceOf(item.cost);
		models.push({
			selector,
			provider: item.provider,
			name: typeof item.name === "string" ? item.name : item.id,
			...(cost ? { cost } : {}),
		});
	}
	return models;
}

/** `omp models --json`, cached for five minutes. */
export function createModelCatalog(ompBin: string): () => Promise<FanoutModel[]> {
	let cached: { at: number; models: FanoutModel[] } | null = null;
	return async () => {
		if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
		const proc = Bun.spawn([ompBin, "models", "--json"], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: MODELS_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) throw new Error("omp could not list its models");
		const models = parseModelList(out);
		cached = { at: Date.now(), models };
		return models;
	};
}
