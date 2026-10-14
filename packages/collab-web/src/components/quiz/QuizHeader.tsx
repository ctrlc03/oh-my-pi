import { ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";

/** The head of a quiz screen: back to the list of quizzes, and close. */
export function QuizHeader({ onHistory, onClose }: { onHistory(): void; onClose(): void }): ReactNode {
	return (
		<div className="sh-sheet-head qz-head">
			<button type="button" className="sh-btn sh-gh-back" onClick={onHistory}>
				<ChevronLeft size={16} /> Quizzes
			</button>
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}
