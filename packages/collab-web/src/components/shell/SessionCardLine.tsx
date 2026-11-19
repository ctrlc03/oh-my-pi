import type { ReactNode } from "react";
import { CARD_LABEL, type SessionCard, type TodoProgress, todoLine } from "../../lib/session-card";
import "./session-card.css";

export interface SessionCardLineProps {
	/** The agent's todo progress; absent for a session without a list (or on an omp that predates it). */
	todo?: TodoProgress;
	/** The status and note the user gave the session. */
	card?: SessionCard;
}

/**
 * What a session's row says beyond its title: the user's status and note, then the agent's task in progress with
 * `done/total` (the last finished task once nothing is open). Nothing at all for a session with neither.
 */
export function SessionCardLine({ todo, card }: SessionCardLineProps): ReactNode {
	const line = todoLine(todo);
	const user = card !== undefined && (card.status !== null || card.note !== "");
	if (!user && line === null) return null;
	return (
		<span className="sh-card-lines">
			{user && (
				<span className="sh-card-line">
					{card.status !== null && (
						<span className="sh-card-chip" data-status={card.status}>
							{CARD_LABEL[card.status]}
						</span>
					)}
					{card.note !== "" && (
						<span className="sh-card-note" title={card.note}>
							{card.note}
						</span>
					)}
				</span>
			)}
			{line !== null && (
				<span className="sh-card-line sh-card-todo" data-active={line.active}>
					<span className="sh-card-progress" title="Tasks done of the agent's todo list">
						{line.progress}
					</span>
					{line.text !== null && (
						<span className="sh-card-task" title={line.text}>
							{line.active ? line.text : `✓ ${line.text}`}
						</span>
					)}
				</span>
			)}
		</span>
	);
}
