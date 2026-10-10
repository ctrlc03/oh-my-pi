/**
 * The subagents of the agent's current `task` run, read from the mirrored
 * progress and lifecycle bus traffic: one row per subagent with whether it is
 * still to do, working, or finished, like the TUI's task HUD.
 */
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";

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
 * is known.
 *
 * Progress only flows while a guest is in the room, so after a (re)join a
 * subagent deep in one long step has not ticked yet. The host's `agents` list
 * already names it as running, so such subagents are listed from it, with no
 * task or activity until their first tick.
 */
export function currentSubagents(
	progress: ReadonlyMap<string, SubagentProgressPayload>,
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>,
	agents: readonly AgentSnapshot[],
): SubagentWork | null {
	const batches: Record<string, { index: number; row: SubagentRow }[]> = {};
	const order: string[] = [];
	const live: Record<string, true> = {};
	const unticked = agents
		.filter(agent => agent.kind === "sub" && agent.status === "running" && !progress.has(agent.id))
		.sort((a, b) => a.createdAt - b.createdAt);
	if (progress.size === 0 && unticked.length === 0) return null;
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
	if (unticked.length > 0) {
		// Keyed apart from every `parentToolCallId`, so they never merge into a real call.
		const batch = "\u0000agents";
		order.push(batch);
		live[batch] = true;
		batches[batch] = unticked.map((agent, index) => ({
			index,
			row: {
				id: agent.id,
				name: agent.id.split(".").join(">"),
				label: "",
				status: "running",
				activity: null,
				durationMs: 0,
			},
		}));
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
