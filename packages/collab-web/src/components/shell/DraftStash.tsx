import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { shortcutKeys, useOverrides } from "../../lib/shortcuts";
import { relTime } from "../../lib/format";
import type { StashedDraft } from "../../lib/draft-stash";
import { Sheet } from "./Sheet";
import "./draft-stash.css";

/** One line of a stashed draft, for the list. */
function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export interface DraftStashProps {
	drafts: readonly StashedDraft[];
	/** The box has text, so it can be stashed from here. */
	canStash: boolean;
	/** Typing is allowed: stashing and restoring change the box. */
	disabled: boolean;
	onStash(): void;
	/** Puts the draft in the box (the text already there is stashed in its place) and drops it from the list. */
	onRestore(draft: StashedDraft): void;
	onDrop(id: string): void;
}

/**
 * The stash button of the composer and its list. ⌘S stashes without opening the list; the button opens it, which is
 * how a phone stashes, restores and drops drafts.
 */
export function DraftStash({ drafts, canStash, disabled, onStash, onRestore, onDrop }: DraftStashProps): ReactNode {
	useOverrides();
	const [anchor, setAnchor] = useState<{ rect: DOMRect } | null>(null);
	const close = (): void => setAnchor(null);
	return (
		<>
			<button
				type="button"
				className="sh-btn sh-btn-icon sh-stash-btn"
				onClick={e => setAnchor({ rect: e.currentTarget.getBoundingClientRect() })}
				disabled={disabled && drafts.length === 0}
				aria-label={drafts.length > 0 ? `Stashed drafts (${drafts.length})` : "Stash the draft"}
				title="Stash the draft or take one back"
				data-shortcut={shortcutKeys("stashDraft")}
			>
				<Archive size={16} />
				{drafts.length > 0 && <span className="sh-stash-count">{drafts.length}</span>}
			</button>
			{anchor !== null && (
				<Sheet label="stashed drafts" anchor={anchor.rect} onClose={close}>
					<div className="sh-sheet-head">
						<div className="sh-sheet-title">Stashed drafts</div>
					</div>
					<button
						type="button"
						className="sh-btn sh-stash-now"
						disabled={!canStash || disabled}
						onClick={() => {
							onStash();
							close();
						}}
					>
						<Archive size={14} /> Stash this draft
					</button>
					{drafts.length === 0 ? (
						<p className="sh-edit-prompt-note">
							Nothing stashed. Stash a half-written message to write another one first, then take it back here.
						</p>
					) : (
						<ul className="sh-stash-list">
							{drafts.map(draft => (
								<li key={draft.id} className="sh-stash-item">
									<button
										type="button"
										className="sh-stash-text"
										disabled={disabled}
										onClick={() => {
											onRestore(draft);
											close();
										}}
										title="Put it back in the message box"
									>
										<ArchiveRestore size={14} />
										<span className="sh-stash-preview">{preview(draft.text)}</span>
										<span className="sh-stash-age">{relTime(draft.at)}</span>
									</button>
									<button
										type="button"
										className="sh-stash-drop"
										onClick={() => onDrop(draft.id)}
										aria-label="Delete stashed draft"
										title="Delete"
									>
										<Trash2 size={14} />
									</button>
								</li>
							))}
						</ul>
					)}
				</Sheet>
			)}
		</>
	);
}
