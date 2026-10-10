import { ChevronUp, ListChecks, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import type { TodoState } from "../../lib/todos";
import { Board } from "../../tool-render/tools/todo";
import { Sheet } from "./Sheet";
import "./task-progress.css";

export interface TaskProgressProps {
	/** Derived from the full entry list, so a trimmed transcript still shows it. */
	todos: TodoState | null;
}

/**
 * The agent's task list as a slim bar above the composer: the count, the task
 * in hand, and a thin meter. Tapping opens the full board. Hidden once nothing
 * is left to do, so a finished list never lingers.
 */
export function TaskProgress({ todos }: TaskProgressProps): ReactNode {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	if (todos === null || todos.done >= todos.total) return null;
	const label = `Tasks ${todos.done}/${todos.total}`;
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
				<span className="sh-tasks-count">{label}</span>
				{todos.current !== null && <span className="sh-tasks-current">{todos.current}</span>}
				<ChevronUp size={14} className="sh-tasks-chev" aria-hidden />
			</button>
			<div
				className="sh-tasks-meter"
				role="progressbar"
				aria-label="Tasks completed"
				aria-valuemin={0}
				aria-valuemax={todos.total}
				aria-valuenow={todos.done}
				style={{ "--done": todos.done / todos.total } as CSSProperties}
			/>
			{anchor !== null && (
				<Sheet label="tasks" anchor={anchor} onClose={() => setAnchor(null)}>
					<div className="sh-sheet-head">
						<div className="sh-sheet-title">{label}</div>
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => setAnchor(null)}
							aria-label="close"
						>
							<X size={16} />
						</button>
					</div>
					<div className="sh-tasks-board">
						<Board phases={todos.phases} />
					</div>
				</Sheet>
			)}
		</div>
	);
}
