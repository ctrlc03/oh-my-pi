import { ChevronUp, ListChecks, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { fmtDuration } from "../../lib/format";
import type { SubagentRow, SubagentStatus, SubagentWork } from "../../lib/subagents";
import type { TodoState } from "../../lib/todos";
import { Board } from "../../tool-render/tools/todo";
import { Sheet } from "./Sheet";
import "./task-progress.css";

export interface TaskProgressProps {
	/** Derived from the full entry list, so a trimmed transcript still shows it. */
	todos: TodoState | null;
	/** Subagents of the current `task` run. */
	subagents: SubagentWork | null;
	/** Whether a subagent is in the agents list, so its transcript can open. */
	hasAgent(id: string): boolean;
	onOpenAgent(id: string): void;
}

/** The todo board's glyphs, so both lists read the same. */
const STATUS_ICON: Record<SubagentStatus, string> = {
	pending: "○",
	running: "→",
	completed: "✓",
	failed: "✕",
	aborted: "✕",
};

const STATUS_LABEL: Record<SubagentStatus, string> = {
	pending: "to do",
	running: "working",
	completed: "done",
	failed: "failed",
	aborted: "aborted",
};

/** "1 agent working", "2 of 3 agents working": the one agent of a run needs no total. */
function agentsSummary(work: SubagentWork): string {
	const total = work.rows.length;
	const state = work.active > 0 ? "working" : "done";
	const count = work.active > 0 ? work.active : work.done;
	if (total === 1) return count === 1 ? `1 agent ${state}` : `${count} of 1 agent ${state}`;
	return `${count} of ${total} agents ${state}`;
}

/**
 * The agent's work as a slim bar above the composer: its task list's count and
 * the task in hand, and how many subagents are still working, with a thin
 * meter. Tapping opens both lists. Hidden once nothing is left to do or
 * running, so a finished run never lingers.
 */
export function TaskProgress({ todos, subagents, hasAgent, onOpenAgent }: TaskProgressProps): ReactNode {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const openTodos = todos !== null && todos.done < todos.total;
	const runningAgents = subagents !== null && subagents.active > 0;
	if (!openTodos && !runningAgents && anchor === null) return null;

	const title = openTodos ? `Tasks ${todos.done}/${todos.total}` : subagents !== null ? "Subagents" : "Tasks";
	const running = subagents?.rows.find(row => row.status === "running");
	const detail = openTodos
		? todos.current
		: running !== undefined
			? `${running.name}${running.activity !== null ? `: ${running.activity}` : ""}`
			: null;
	const [meterDone, meterTotal] = openTodos
		? [todos.done, todos.total]
		: subagents !== null
			? [subagents.rows.length - subagents.active, subagents.rows.length]
			: [0, 1];

	return (
		<div className="sh-tasks">
			<button
				type="button"
				className="sh-tasks-btn"
				aria-haspopup="dialog"
				aria-expanded={anchor !== null}
				onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}
			>
				<ListChecks size={14} className="sh-tasks-icon" aria-hidden />
				<span className="sh-tasks-count">{title}</span>
				{detail !== null && <span className="sh-tasks-current">{detail}</span>}
				{openTodos && runningAgents && <span className="sh-tasks-agents">{agentsSummary(subagents)}</span>}
				<ChevronUp size={14} className="sh-tasks-chev" aria-hidden />
			</button>
			<div
				className="sh-tasks-meter"
				role="progressbar"
				aria-label={openTodos ? "Tasks completed" : "Subagents finished"}
				aria-valuemin={0}
				aria-valuemax={meterTotal}
				aria-valuenow={meterDone}
				style={{ "--done": meterTotal > 0 ? meterDone / meterTotal : 0 } as CSSProperties}
			/>
			{anchor !== null && (
				<Sheet label="tasks" anchor={anchor} onClose={() => setAnchor(null)}>
					<div className="sh-sheet-head">
						<div className="sh-sheet-title">{title}</div>
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => setAnchor(null)}
							aria-label="Close"
						>
							<X size={16} />
						</button>
					</div>
					<div className="sh-tasks-body">
						{todos !== null && (
							<div className="sh-tasks-board">
								<Board phases={todos.phases} />
							</div>
						)}
						{subagents !== null && (
							<section className="sh-tasks-subagents" aria-label="Subagents">
								<div className="sh-tasks-section">{agentsSummary(subagents)}</div>
								<ul className="sh-tasks-agent-list">
									{subagents.rows.map(row => (
										<SubagentItem
											key={row.id}
											row={row}
											onOpen={
												!hasAgent(row.id)
													? null
													: () => {
															setAnchor(null);
															onOpenAgent(row.id);
														}
											}
										/>
									))}
								</ul>
							</section>
						)}
					</div>
				</Sheet>
			)}
		</div>
	);
}

function SubagentItem({ row, onOpen }: { row: SubagentRow; onOpen: (() => void) | null }): ReactNode {
	const body = (
		<>
			<span className="sh-tasks-agent-icon" aria-hidden>
				{STATUS_ICON[row.status]}
			</span>
			<span className="sh-tasks-agent-main">
				<span className="sh-tasks-agent-head">
					<span className="sh-tasks-agent-name">{row.name}</span>
					<span className="sh-tasks-agent-status">{STATUS_LABEL[row.status]}</span>
					{row.durationMs > 0 && <span className="sh-tasks-agent-time">{fmtDuration(row.durationMs)}</span>}
				</span>
				{row.label !== "" && <span className="sh-tasks-agent-label">{row.label}</span>}
				{row.activity !== null && <span className="sh-tasks-agent-activity">{row.activity}</span>}
			</span>
		</>
	);
	return (
		<li className={`sh-tasks-agent sh-tasks-agent--${row.status}`}>
			{onOpen === null ? (
				<div className="sh-tasks-agent-row">{body}</div>
			) : (
				<button type="button" className="sh-tasks-agent-row" onClick={onOpen} title="Open its transcript">
					{body}
				</button>
			)}
		</li>
	);
}
