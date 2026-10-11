/**
 * The start-session sheet's decisions, kept apart from the component so they can be tested: what a draft asks the
 * companion for, and what the next draft keeps after a session was started in the background.
 */

import type { CompanionClient, ForeignPermission } from "./companion";
import { scratchLabel } from "./scratch";

/** `cwd` of a draft without a project: the companion makes a folder for the session. */
export const NO_PROJECT = "";

/** What the start sheet has typed in so far. */
export interface StartDraft {
	/** The folder, or {@link NO_PROJECT}. */
	cwd: string;
	sandboxed: boolean;
	/** Work on a new branch in its own git worktree. */
	worktree: boolean;
	/** The worktree's branch name; empty for the default. */
	branch: string;
	prompt: string;
	/** Id of the vendor agent to run (`claude`, `custom:<slug>`, …); null: omp. */
	agent: string | null;
	/** A vendor model id of `agent`; empty: the agent's default. Ignored for omp. */
	model: string;
	/** How a foreign session answers tool-permission requests. Ignored for omp. */
	permission: ForeignPermission;
}

/** What `CompanionClient.startSession` is asked for. */
export interface StartTarget {
	cwd: string;
	/** Session id being resumed; undefined for a new session. */
	resume?: string;
	sandboxed: boolean;
	worktree?: { branch?: string };
	/** A session without a project; `hint` names its folder. */
	scratch?: { hint?: string };
	/** Vendor agent id; absent: omp. */
	agent?: string;
	model?: string;
	permission?: ForeignPermission;
}

export type StartOptions = NonNullable<Parameters<CompanionClient["startSession"]>[1]>;

/** A folder with no git repository to branch from: none was picked, or it is a scratch folder the companion made. */
export function isProjectless(cwd: string): boolean {
	return cwd === NO_PROJECT || scratchLabel(cwd) !== null;
}

/** What to call a folder: its scratch label, its last path segment, or "No project". */
export function folderLabel(cwd: string): string {
	if (cwd === NO_PROJECT) return "No project";
	return scratchLabel(cwd) ?? cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** The new session the draft asks for. A worktree needs a repository: a folder without a project never gets one. */
export function newSessionTarget(draft: StartDraft): StartTarget {
	const hint = draft.prompt.trim() || undefined;
	return {
		cwd: draft.cwd,
		sandboxed: draft.sandboxed,
		worktree: draft.worktree && !isProjectless(draft.cwd) ? { branch: draft.branch.trim() || undefined } : undefined,
		scratch: draft.cwd === NO_PROJECT ? { hint } : undefined,
		...(draft.agent === null
			? {}
			: { agent: draft.agent, model: draft.model || undefined, permission: draft.permission }),
	};
}

/** The options of `startSession` for `target`; `prompt` is what the companion sends as soon as omp is up. */
export function startOptions(target: StartTarget, extra: { prompt?: string; force?: boolean } = {}): StartOptions {
	return {
		resume: target.resume,
		sandboxed: target.sandboxed || undefined,
		worktree: target.worktree,
		scratch: target.scratch,
		agent: target.agent,
		model: target.model,
		permission: target.permission,
		prompt: extra.prompt,
		force: extra.force || undefined,
	};
}

/**
 * The draft that follows a background start: the same folder and workspace mode, nothing typed. A worktree
 * branch name belongs to the session that took it (the next worktree needs its own), so it goes back to the default.
 */
export function nextDraft(draft: StartDraft): StartDraft {
	return { ...draft, prompt: "", branch: "" };
}

/** A line of a prompt for naming the session that started from it: its first words, shortened. */
export function promptTitle(prompt: string, max = 48): string | null {
	const line =
		prompt
			.split("\n")
			.find(l => l.trim() !== "")
			?.trim() ?? "";
	if (line === "") return null;
	const chars = Array.from(line);
	return chars.length > max
		? `${chars
				.slice(0, max - 1)
				.join("")
				.trimEnd()}…`
		: line;
}
