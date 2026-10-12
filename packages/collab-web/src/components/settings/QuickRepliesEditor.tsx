import { Check, Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { MAX_QUICK_REPLY_CHARS, setQuickReplies, useQuickReplies } from "../../lib/quick-replies";

/**
 * The saved prompts shown above the message box: tap one to change its text, ✕ removes it, and the field adds a
 * new one. Edits apply at once, in the composer too.
 */
export function QuickRepliesEditor(): ReactNode {
	const replies = useQuickReplies();
	const [draft, setDraft] = useState("");
	/** The saved prompt whose text is being changed; null while adding a new one. */
	const [changing, setChanging] = useState<string | null>(null);

	const stopChanging = (): void => {
		setChanging(null);
		setDraft("");
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const text = draft.trim();
		if (!text) return;
		if (changing === null) {
			if (!replies.includes(text)) setQuickReplies([...replies, text]);
		} else if (text === changing || !replies.includes(text)) {
			setQuickReplies(replies.map(r => (r === changing ? text : r)));
		} else {
			// The new text already exists elsewhere: the edited one merges into it.
			setQuickReplies(replies.filter(r => r !== changing));
		}
		stopChanging();
	};

	return (
		<div className="sh-quick sh-quick-editing">
			{replies.length === 0 ? (
				<div className="sh-field-hint">No saved prompts. Add one below.</div>
			) : (
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
								aria-label={`Edit ${reply}`}
							>
								{reply}
							</button>
							<button
								type="button"
								className="sh-quick-remove"
								onClick={() => {
									setQuickReplies(replies.filter(r => r !== reply));
									if (reply === changing) stopChanging();
								}}
								aria-label={`Remove ${reply}`}
							>
								<X size={13} />
							</button>
						</span>
					))}
				</div>
			)}
			<form className="sh-quick-add" onSubmit={submit}>
				<input
					className="sh-input"
					value={draft}
					onChange={e => setDraft(e.target.value)}
					placeholder={changing === null ? "New saved prompt" : "Change saved prompt"}
					maxLength={MAX_QUICK_REPLY_CHARS}
					enterKeyHint="done"
					aria-label={changing === null ? "New saved prompt" : "Saved prompt text"}
				/>
				<button
					type="submit"
					className="sh-btn sh-btn-icon"
					disabled={!draft.trim()}
					aria-label={changing === null ? "Add saved prompt" : "Save change"}
				>
					{changing === null ? <Plus size={16} /> : <Check size={16} />}
				</button>
				{changing !== null && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={stopChanging} aria-label="Cancel change">
						<X size={16} />
					</button>
				)}
			</form>
		</div>
	);
}
