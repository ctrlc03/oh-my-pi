import type { PromptMention } from "@oh-my-pi/pi-wire";
import { Check, ChevronDown, ChevronUp, ListEnd, Pencil, X, Zap } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { GuestClient } from "../../lib/client";
import "./queue-edit.css";

export interface FollowUpsProps {
	client: GuestClient;
	/** Chip texts, oldest first: the next to run is first. */
	followUps: readonly string[];
	/** Ids of `followUps`, same order; with `editable`, what edit, move and steer name. */
	ids: readonly string[];
	/** The host edits, moves and steers queued follow-ups by id (`queue-edit`). */
	editable: boolean;
	readOnly: boolean;
	live: boolean;
	/** The mentions an edited text still carries, for the host to expand again. */
	resolveMentions(text: string): PromptMention[];
}

/** A slash command's chip is its text as typed; the host runs a command only when it is sent, so it is removed, not edited. */
function canEditText(text: string): boolean {
	return !text.trimStart().startsWith("/");
}

/**
 * The host's queued follow-ups ("After this turn"), oldest first. A writer on a host with `queue-edit` can edit one
 * in place, move it up or down, or send it into the running turn now; every host lets a writer take one back.
 */
export function FollowUps({
	client,
	followUps,
	ids,
	editable,
	readOnly,
	live,
	resolveMentions,
}: FollowUpsProps): ReactNode {
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const open = editing !== null && ids.includes(editing.id) ? editing : null;

	// The follow-up ran (or was removed) while it was being edited: nothing is left to save to.
	useEffect(() => {
		if (editing !== null && !ids.includes(editing.id)) setEditing(null);
	}, [editing, ids]);

	if (followUps.length === 0) return null;

	const save = (): void => {
		if (open === null) return;
		const text = open.text.trim();
		setEditing(null);
		if (text === "" || text === followUps[ids.indexOf(open.id)]) return;
		client.editQueuedFollowUp(open.id, text, resolveMentions(text));
	};
	const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setEditing(null);
		} else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			save();
		}
	};

	return (
		<div className="sh-followups">
			{followUps.map((queuedText, i) => {
				const id = editable ? ids[i] : undefined;
				const actionable = !readOnly && live;
				if (id !== undefined && open?.id === id) {
					return (
						<div key={id} className="sh-followup sh-followup-editing">
							<textarea
								className="sh-followup-editor"
								// The caret starts after the text; only the first focus does it, so typing is never moved.
								autoFocus
								onFocus={e =>
									e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)
								}
								value={open.text}
								rows={Math.min(6, Math.max(2, open.text.split("\n").length))}
								aria-label="edit queued follow-up"
								spellCheck={false}
								onChange={e => setEditing({ id, text: e.target.value })}
								onKeyDown={onEditorKey}
							/>
							<div className="sh-followup-actions">
								<button
									type="button"
									className="sh-followup-btn"
									onClick={() => setEditing(null)}
									aria-label="cancel editing"
									title="cancel (Esc)"
								>
									<X size={14} />
								</button>
								<button
									type="button"
									className="sh-followup-btn sh-followup-save"
									onClick={save}
									disabled={open.text.trim() === ""}
									aria-label="save queued follow-up"
									title="save (Enter)"
								>
									<Check size={14} />
								</button>
							</div>
						</div>
					);
				}
				return (
					<div
						key={id ?? `${i}-${queuedText}`}
						className={id === undefined ? "sh-followup" : "sh-followup sh-followup-editable"}
						title={queuedText}
					>
						<ListEnd size={14} />
						<span className="sh-followup-label">After this turn:</span>
						<span className="sh-followup-text">{queuedText.replace(/\s+/g, " ").trim()}</span>
						{!readOnly && (
							<span className="sh-followup-actions">
								{id !== undefined && canEditText(queuedText) && (
									<button
										type="button"
										className="sh-followup-btn"
										onClick={() => setEditing({ id, text: queuedText })}
										disabled={!actionable}
										aria-label="edit queued follow-up"
										title="edit this follow-up"
									>
										<Pencil size={13} />
									</button>
								)}
								{id !== undefined && (
									<>
										<button
											type="button"
											className="sh-followup-btn"
											onClick={() => client.moveQueuedFollowUp(id, i - 1)}
											disabled={!actionable || i === 0}
											aria-label="move queued follow-up earlier"
											title="run it sooner"
										>
											<ChevronUp size={14} />
										</button>
										<button
											type="button"
											className="sh-followup-btn"
											onClick={() => client.moveQueuedFollowUp(id, i + 1)}
											disabled={!actionable || i === followUps.length - 1}
											aria-label="move queued follow-up later"
											title="run it later"
										>
											<ChevronDown size={14} />
										</button>
										<button
											type="button"
											className="sh-followup-btn"
											onClick={() => client.steerQueuedFollowUp(id)}
											disabled={!actionable}
											aria-label="send queued follow-up into the running turn"
											title="send it into the running turn now"
										>
											<Zap size={13} />
										</button>
									</>
								)}
								<button
									type="button"
									className="sh-followup-remove"
									onClick={() => client.sendSessionCommand("unqueue", queuedText)}
									disabled={!live}
									aria-label="remove queued follow-up"
									title="remove from the queue"
								>
									<X size={12} />
								</button>
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}
