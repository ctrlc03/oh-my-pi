import { Check, Pencil, Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { loadQuickReplies, MAX_QUICK_REPLY_CHARS, saveQuickReplies } from "../../lib/quick-replies";

export interface QuickRepliesProps {
	disabled: boolean;
	onPick(text: string): void;
}

/** Horizontally scrolling chip row; the pencil switches it into an add/remove editor. */
export function QuickReplies({ disabled, onPick }: QuickRepliesProps): ReactNode {
	const [replies, setReplies] = useState(loadQuickReplies);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	const update = (next: string[]): void => {
		setReplies(next);
		saveQuickReplies(next);
	};

	const add = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const text = draft.trim();
		if (!text) return;
		if (!replies.includes(text)) update([...replies, text]);
		setDraft("");
	};

	if (editing) {
		return (
			<div className="sh-quick sh-quick-editing">
				<div className="sh-quick-row">
					{replies.map(reply => (
						<span key={reply} className="sh-quick-chip sh-quick-chip-edit">
							<span className="sh-quick-text">{reply}</span>
							<button
								type="button"
								className="sh-quick-remove"
								onClick={() => update(replies.filter(r => r !== reply))}
								aria-label={`remove ${reply}`}
							>
								<X size={13} />
							</button>
						</span>
					))}
				</div>
				<form className="sh-quick-add" onSubmit={add}>
					<input
						className="sh-input"
						value={draft}
						onChange={e => setDraft(e.target.value)}
						placeholder="New quick reply"
						maxLength={MAX_QUICK_REPLY_CHARS}
						enterKeyHint="done"
						aria-label="new quick reply"
					/>
					<button type="submit" className="sh-btn sh-btn-icon" disabled={!draft.trim()} aria-label="add">
						<Plus size={16} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setEditing(false)}
						aria-label="done editing quick replies"
					>
						<Check size={16} />
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
					aria-label="edit quick replies"
					title="edit quick replies"
				>
					<Pencil size={13} />
				</button>
			</div>
		</div>
	);
}
