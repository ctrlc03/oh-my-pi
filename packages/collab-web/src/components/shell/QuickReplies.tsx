import type { ReactNode } from "react";
import { useQuickReplies } from "../../lib/quick-replies";

export interface QuickRepliesProps {
	disabled: boolean;
	onPick(text: string): void;
}

/** Saved prompts as a horizontally scrolling chip row, above the composer and in the start sheet. They are edited in Settings → Messages. */
export function QuickReplies({ disabled, onPick }: QuickRepliesProps): ReactNode {
	const replies = useQuickReplies();
	return (
		<div className="sh-quick sh-quick-bar">
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
			</div>
		</div>
	);
}
