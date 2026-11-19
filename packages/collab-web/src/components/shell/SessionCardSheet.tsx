import { ChevronRight, LoaderCircle, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import {
	CARD_LABEL,
	CARD_STATUSES,
	type CardStatus,
	cleanNote,
	MAX_NOTE_CHARS,
	type SessionCard,
} from "../../lib/session-card";
import { SessionCardLine } from "./SessionCardLine";
import { Sheet } from "./Sheet";
import "./session-card.css";

/** What the editor needs to change one session's card. */
export interface CardEdit {
	/** The card as it is now; absent when the session has none. */
	card: SessionCard | undefined;
	/** Save the card on the computer; rejects with a message the person can read. */
	save(card: SessionCard): Promise<void>;
}

export interface SessionCardSheetProps {
	title: string;
	edit: CardEdit;
	onClose(): void;
}

/** One session's status and note: pick where it stands, write a line, save. Both empty clears the card. */
export function SessionCardSheet({ title, edit, onClose }: SessionCardSheetProps): ReactNode {
	const [status, setStatus] = useState<CardStatus | null>(edit.card?.status ?? null);
	const [note, setNote] = useState(edit.card?.note ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const empty = status === null && cleanNote(note) === "";

	const save = async (next: SessionCard): Promise<void> => {
		setSaving(true);
		setError(null);
		try {
			await edit.save(next);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setSaving(false);
		}
	};
	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		if (!saving) void save({ status, note: cleanNote(note) });
	};

	return (
		<Sheet label={`status of ${title}`} fixed onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{title}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<form className="sh-card-editor" onSubmit={submit}>
				<div className="sh-field-label">Status</div>
				<div className="sh-card-choices" role="radiogroup" aria-label="Status">
					{CARD_STATUSES.map(choice => (
						<button
							key={choice}
							type="button"
							role="radio"
							aria-checked={status === choice}
							className={status === choice ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setStatus(status === choice ? null : choice)}
						>
							{CARD_LABEL[choice]}
						</button>
					))}
				</div>
				<label className="sh-card-note-field">
					<span className="sh-field-label">Note</span>
					<input
						className="sh-input"
						type="text"
						value={note}
						maxLength={MAX_NOTE_CHARS}
						onChange={e => setNote(e.currentTarget.value)}
						placeholder="Waiting on the API key, ask Sam about the schema…"
						aria-label="Note"
						autoCapitalize="off"
						spellCheck={false}
					/>
					<span className="sh-card-count">
						{note.length}/{MAX_NOTE_CHARS}
					</span>
				</label>
				{error !== null && <div className="sh-connect-error">{error}</div>}
				<div className="sh-card-actions">
					<button
						type="button"
						className="sh-btn"
						disabled={saving || edit.card === undefined}
						onClick={() => void save({ status: null, note: "" })}
					>
						Clear
					</button>
					<button
						type="submit"
						className="sh-btn sh-btn-primary"
						disabled={saving || (empty && edit.card === undefined)}
					>
						{saving && <LoaderCircle size={14} className="sh-spin" />} Save
					</button>
				</div>
			</form>
		</Sheet>
	);
}

/** The row of the session sheet that shows the open session's status and note and opens their editor. */
export function SessionCardRow({ title, edit }: { title: string; edit: CardEdit }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="sh-sheet-row sh-sheet-row-top">
			<dt>Status</dt>
			<dd>
				<SessionCardLine card={edit.card} />
				<button type="button" className="sh-sheet-link" onClick={() => setOpen(true)}>
					{edit.card === undefined ? "Set status and note" : "Edit status and note"}
					<ChevronRight size={14} />
				</button>
				{open && <SessionCardSheet title={title} edit={edit} onClose={() => setOpen(false)} />}
			</dd>
		</div>
	);
}
