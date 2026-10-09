import { Check, Pencil, Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { loadQuickReplies, MAX_QUICK_REPLY_CHARS, saveQuickReplies } from "../../lib/quick-replies";

export interface QuickRepliesProps {
	disabled: boolean;
	onPick(text: string): void;
}

/**
 * Saved prompts as a horizontally scrolling chip row, above the composer and in the start
 * sheet. The pencil switches it into an editor: tap a chip to change its text, ✕ removes it.
 */
export function QuickReplies({ disabled, onPick }: QuickRepliesProps): ReactNode {
	const [replies, setReplies] = useState(loadQuickReplies);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	/** The saved prompt whose text is being changed; null while adding a new one. */
	const [changing, setChanging] = useState<string | null>(null);

	const update = (next: string[]): void => {
		setReplies(next);
		saveQuickReplies(next);
	};

	const stopChanging = (): void => {
		setChanging(null);
		setDraft("");
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const text = draft.trim();
		if (!text) return;
		if (changing === null) {
			if (!replies.includes(text)) update([...replies, text]);
		} else if (text === changing || !replies.includes(text)) {
			update(replies.map(r => (r === changing ? text : r)));
		} else {
			// The new text already exists elsewhere: the edited one merges into it.
			update(replies.filter(r => r !== changing));
		}
		stopChanging();
	};

	if (editing) {
		return (
			<div className="sh-quick sh-quick-editing">
				<div className="sh-quick-row">
					{replies.map(reply => (
						<span
							key={reply}
							className={`sh-quick-chip sh-quick-chip-edit${reply === changing ? " sh-quick-chip-changing" : ""}`}
						>
							<button
								type="button"
								className="sh-quick-text sh-quick-change"
								onClick={() => {
									setChanging(reply);
									setDraft(reply);
								}}
								aria-label={`edit ${reply}`}
								title={reply}
							>
								{reply}
							</button>
							<button
								type="button"
								className="sh-quick-remove"
								onClick={() => {
									update(replies.filter(r => r !== reply));
									if (reply === changing) stopChanging();
								}}
								aria-label={`remove ${reply}`}
							>
								<X size={13} />
							</button>
						</span>
					))}
				</div>
				<form className="sh-quick-add" onSubmit={submit}>
					<input
						className="sh-input"
						value={draft}
						onChange={e => setDraft(e.target.value)}
						placeholder={changing === null ? "New saved prompt" : "Change saved prompt"}
						maxLength={MAX_QUICK_REPLY_CHARS}
						enterKeyHint="done"
						aria-label={changing === null ? "new saved prompt" : "saved prompt text"}
					/>
					<button
						type="submit"
						className="sh-btn sh-btn-icon"
						disabled={!draft.trim()}
						aria-label={changing === null ? "add" : "save"}
					>
						{changing === null ? <Plus size={16} /> : <Check size={16} />}
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={changing === null ? () => setEditing(false) : stopChanging}
						aria-label={changing === null ? "done editing saved prompts" : "cancel change"}
					>
						{changing === null ? <Check size={16} /> : <X size={16} />}
					</button>
				</form>
			</div>
		);
	}

	return (
		<div className="sh-quick">
			<div className="sh-quick-row">
				{replies.map(reply => (
					<button
						key={reply}
						type="button"
						className="sh-quick-chip"
						disabled={disabled}
						onClick={() => onPick(reply)}
						title={reply}
					>
						<span className="sh-quick-text">{reply}</span>
					</button>
				))}
				<button
					type="button"
					className="sh-quick-chip sh-quick-chip-icon"
					onClick={() => setEditing(true)}
					aria-label="edit saved prompts"
					title="edit saved prompts"
				>
					<Pencil size={13} />
				</button>
			</div>
		</div>
	);
}
