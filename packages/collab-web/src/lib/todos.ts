/** The agent's task list, read back from its latest `todo` tool result. */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { executeXdevDispatch } from "../tool-render/ToolView";
import { isRecord, str } from "../tool-render/util";
import type { ActiveTool } from "./client";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
	content: string;
	status: TodoStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoState {
	phases: TodoPhase[];
	/** Completed tasks. */
	done: number;
	/** Every task that is not abandoned: abandoned work is neither done nor remaining. */
	total: number;
	/** The task in progress, else the first pending one; null when nothing is left. */
	current: string | null;
}

function toPhases(raw: unknown[]): TodoPhase[] {
	const phases: TodoPhase[] = [];
	for (const phase of raw) {
		if (!isRecord(phase)) continue;
		const tasks: TodoTask[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks as unknown[]) {
				if (!isRecord(task)) continue;
				const status = task.status;
				tasks.push({
					content: str(task.content) ?? "",
					status:
						status === "completed" || status === "in_progress" || status === "abandoned" ? status : "pending",
				});
			}
		}
		phases.push({ name: str(phase.name) ?? "", tasks });
	}
	return phases;
}

function summarize(phases: TodoPhase[]): TodoState {
	let done = 0;
	let total = 0;
	let working: string | null = null;
	let pending: string | null = null;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "abandoned") continue;
			total++;
			if (task.status === "completed") done++;
			else if (task.status === "in_progress") working ??= task.content;
			else pending ??= task.content;
		}
	}
	return { phases, done, total, current: working ?? pending };
}

/** `details.phases` of a todo result, whether it is the tool's own or a `write xd://todo` device call's. */
function phasesOf(toolName: string, result: { isError?: boolean; details?: unknown }): unknown[] | null {
	if (result.isError === true) return null;
	let details: unknown = result.details;
	if (toolName === "write") {
		const xdev = executeXdevDispatch(toolName, { content: [], ...result });
		if (xdev?.tool !== "todo") return null;
		details = xdev.inner;
	} else if (toolName !== "todo") {
		return null;
	}
	return isRecord(details) && Array.isArray(details.phases) ? details.phases : null;
}

/**
 * The task list as of the last successful `todo` result in the main session,
 * or null when the agent never wrote one. A call still running counts when its
 * live partial result already carries the board.
 */
export function currentTodos(
	entries: readonly SessionEntry[],
	activeTools?: ReadonlyMap<string, ActiveTool>,
): TodoState | null {
	if (activeTools) {
		const live = [...activeTools.values()];
		for (let i = live.length - 1; i >= 0; i--) {
			const partial = live[i].partialResult;
			if (!isRecord(partial)) continue;
			const phases = phasesOf(live[i].toolName, partial);
			if (phases) return summarize(toPhases(phases));
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const phases = phasesOf(entry.message.toolName, entry.message);
		if (phases) return summarize(toPhases(phases));
	}
	return null;
}
