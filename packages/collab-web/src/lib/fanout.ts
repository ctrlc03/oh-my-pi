import type { AgentRef } from "@oh-my-pi/pi-wire";

/**
 * Best-of-N: one prompt on several models, each in its own git worktree, then a
 * comparison. Types shared by the app and the companion (`fanout-*` requests).
 */

export const MIN_FANOUT_MODELS = 2;
export const MAX_FANOUT_MODELS = 4;
/** Longest prompt a fan-out carries (it travels as one tmux-side file per session, so the cap is generous). */
export const MAX_FANOUT_PROMPT_CHARS = 100_000;
/** Largest group budget in USD; the same ceiling as a scheduled run's spend limit. */
export const MAX_FANOUT_BUDGET_USD = 10_000;
/** `provider/id` as `omp models --json` lists it: no spaces, no leading dash (it would read as a flag). */
export const MODEL_SELECTOR_RE = /^[A-Za-z0-9_][\w.:/@+[\]-]{0,199}$/;

/** Prefix of the selector of a model a foreign agent runs: `agent:<agent id>/<vendor model id>`. */
const FOREIGN_SELECTOR_PREFIX = "agent:";

/** Selector of `model` (a vendor model id; empty: the agent's default) of the foreign agent `agentId`. */
export function foreignSelector(agentId: string, model: string): string {
	return `${FOREIGN_SELECTOR_PREFIX}${agentId}/${model}`;
}

/** The agent and vendor model id of a {@link foreignSelector}; null for an omp model selector. */
export function parseForeignSelector(selector: string): { agent: string; model: string } | null {
	if (!selector.startsWith(FOREIGN_SELECTOR_PREFIX)) return null;
	const rest = selector.slice(FOREIGN_SELECTOR_PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	return { agent: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** A model the computer can run, from `omp models` or, tagged with `agent`, from a foreign agent. */
export interface FanoutModel {
	/** `provider/id`: what `omp --model` takes; `agent:<agent>/<model>` for a foreign agent's model (see {@link foreignSelector}). */
	selector: string;
	name: string;
	provider: string;
	/** The vendor agent that runs it; absent for an omp model. */
	agent?: AgentRef;
}

/** Start one prompt on each of `models` (2–4 distinct) in new worktrees of the repository containing `cwd`. */
export interface FanoutRequest {
	cwd: string;
	prompt: string;
	models: string[];
	/** Total spend limit in USD for the group, split evenly: each session gets `omp --max-cost <budget / N>`. */
	budgetUsd?: number;
	/** Run each session sandboxed (needs `canSandbox`). */
	sandboxed?: boolean;
}

/** One session of a group, as recorded when it started. */
export interface FanoutRun {
	model: string;
	branch: string;
	/** Worktree folder, resolved. */
	path: string;
	/** Session id of the started omp; absent when it failed to start. */
	instanceId?: string;
	/** The per-session spend limit it was started with. */
	maxCostUsd?: number;
	/** Why this session did not start (its worktree was discarded). */
	error?: string;
	/** The worktree was removed by a keep. */
	removed?: boolean;
	/** The vendor agent the session runs; absent for omp. */
	agent?: AgentRef;
}

export interface FanoutGroup {
	id: string;
	/** Repository root the worktrees were made from. */
	root: string;
	prompt: string;
	createdAt: number;
	budgetUsd?: number;
	runs: FanoutRun[];
	/** instanceId of the run the user kept. */
	kept?: string;
}

/** The group a listed session belongs to, as the `hosts` frame carries it. */
export interface HostFanout {
	group: string;
	model: string;
	/** The vendor agent the session runs; absent for omp. */
	agent?: AgentRef;
}

/** `ended`: the session's omp exited. `failed`: it never started. */
export type FanoutStatus = "working" | "needs-input" | "idle" | "offline" | "ended" | "failed";

export interface FanoutVerify {
	/** The command line that ran. */
	command: string;
	ok: boolean;
}

export interface FanoutRunView {
	model: string;
	branch: string;
	path: string;
	instanceId: string | null;
	status: FanoutStatus;
	/** Spend so far in USD; null when the stats database has nothing for the folder. */
	costUsd: number | null;
	maxCostUsd: number | null;
	/** Changed files against the merge-base (untracked included); null when the worktree is gone. */
	files: number | null;
	added: number | null;
	removed: number | null;
	/** Uncommitted changes: removing the worktree discards them. */
	dirty: boolean;
	verify: FanoutVerify | null;
	/** The branch's open pull request, once there is one. */
	pr: { url: string; number: number } | null;
	/** The worktree was removed. */
	gone: boolean;
	error: string | null;
	/** The vendor agent the session runs; absent for omp. */
	agent?: AgentRef;
}

export interface FanoutCompare {
	id: string;
	prompt: string;
	createdAt: number;
	budgetUsd: number | null;
	kept: string | null;
	runs: FanoutRunView[];
}

/** What a keep did to the worktrees of the runs that were not kept. */
export interface FanoutKeepResult {
	removed: string[];
	/** Left in place, each with the reason (uncommitted changes without a discard confirmation, …). */
	skipped: { model: string; reason: string }[];
}

export interface FanoutKeepRequest {
	group: string;
	/** instanceId of the run to keep. */
	keep: string;
	/** Remove the other worktrees (their sessions are ended first). */
	removeOthers: boolean;
	/** Also remove those with uncommitted changes, discarding them. */
	discardDirty: boolean;
}

/** Budget a group gives each of `count` sessions: an even split in whole cents, rounded down. */
export function splitBudget(totalUsd: number, count: number): number {
	return Math.floor((totalUsd / count) * 100) / 100;
}

/** Where a started group's sessions are shown once: `hosts` frame annotation by instance id. */
export function hostFanout(groups: readonly FanoutGroup[]): Record<string, HostFanout> {
	const out: Record<string, HostFanout> = {};
	for (const group of groups) {
		for (const run of group.runs) {
			if (run.instanceId !== undefined && !run.removed) {
				out[run.instanceId] = { group: group.id, model: run.model, ...(run.agent ? { agent: run.agent } : {}) };
			}
		}
	}
	return out;
}

/** Pending "open the winner's pull request flow": consumed once when the kept session opens. */
const pendingReview = new Set<string>();

export function setPendingReview(instanceId: string): void {
	pendingReview.add(instanceId);
}

/** True once for an instance that {@link setPendingReview} marked. */
export function takePendingReview(instanceId: string): boolean {
	return pendingReview.delete(instanceId);
}
