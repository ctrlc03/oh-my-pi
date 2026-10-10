/**
 * The subagents of the agent's current `task` run, read from the mirrored
 * progress and lifecycle bus traffic: one row per subagent with whether it is
 * still to do, working, or finished, like the TUI's task HUD.
 */
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface SubagentRow {
	id: string;
	/** The id as the TUI prints it: nested `Parent.Child` reads `Parent>Child`. */
	name: string;
	/** What it was asked to do: the description, else the task's first line. */
	label: string;
	status: SubagentStatus;
	/** What it is doing now (intent, else tool); null once finished. */
	activity: string | null;
	durationMs: number;
}

export interface SubagentWork {
	rows: SubagentRow[];
	/** Rows not yet finished. */
	active: number;
	/** Rows completed successfully. */
	done: number;
}

const ACTIVE: Record<SubagentStatus, boolean> = {
	pending: true,
	running: true,
	completed: false,
	failed: false,
	aborted: false,
};

/** Lifecycle frames land after a subagent's last progress tick, so a terminal one wins. */
function statusOf(payload: SubagentProgressPayload, lc: SubagentLifecyclePayload | undefined): SubagentStatus {
	if (lc !== undefined && lc.status !== "started") return lc.status;
	return Object.hasOwn(ACTIVE, payload.progress.status) ? payload.progress.status : "running";
}

function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.trim();
}

/**
 * Subagents of every `task` call that still has one to do or working, ordered
 * as spawned. With nothing active, the most recent call's subagents (all
 * finished), so a just-completed run can still be read; null when no subagent
 * ever reported.
 */
export function currentSubagents(
	progress: ReadonlyMap<string, SubagentProgressPayload>,
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>,
): SubagentWork | null {
	if (progress.size === 0) return null;
	const batches: Record<string, { index: number; row: SubagentRow }[]> = {};
	const order: string[] = [];
	const live: Record<string, true> = {};
	for (const payload of progress.values()) {
		const batch = payload.parentToolCallId ?? "";
		if (!Object.hasOwn(batches, batch)) {
			batches[batch] = [];
			order.push(batch);
		}
		const p = payload.progress;
		const status = statusOf(payload, lifecycle.get(p.id));
		if (ACTIVE[status]) live[batch] = true;
		batches[batch]!.push({
			index: payload.index,
			row: {
				id: p.id,
				name: p.id.split(".").join(">"),
				label: firstLine(p.description ?? payload.task ?? p.task),
				status,
				activity: ACTIVE[status] ? (p.lastIntent ?? p.currentToolIntent ?? p.currentTool ?? null) : null,
				durationMs: p.durationMs,
			},
		});
	}
	const shown = order.filter(batch => Object.hasOwn(live, batch));
	if (shown.length === 0) shown.push(order[order.length - 1]!);
	const rows = shown.flatMap(batch => batches[batch]!.sort((a, b) => a.index - b.index).map(item => item.row));
	let active = 0;
	let done = 0;
	for (const row of rows) {
		if (ACTIVE[row.status]) active++;
		else if (row.status === "completed") done++;
	}
	return { rows, active, done };
}
