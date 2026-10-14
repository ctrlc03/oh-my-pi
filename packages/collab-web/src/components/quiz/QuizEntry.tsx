import { GraduationCap } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { LazyQuizSheet } from "./LazyQuizSheet";

/**
 * The start screen's button for quizzes: every repository's quizzes on every computer that writes them, to open,
 * retake or delete. Absent while no computer can write quizzes.
 */
export function QuizEntry({
	computers,
	onOpenHost,
}: {
	computers: readonly ComputerHandle[];
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const available = computers.some(computer => unavailableReason(computer, "quiz") === null);
	// A sheet already open stays when the last computer drops: it lists why.
	if (!available && !open) return null;
	return (
		<>
			<button type="button" className="sh-btn sh-card-action" onClick={() => setOpen(true)}>
				<GraduationCap size={15} /> Quizzes
			</button>
			{open && (
				<LazyQuizSheet
					computers={computers}
					computerId={null}
					cwd={null}
					instanceId={null}
					sessionId={null}
					start={{ view: "home" }}
					onOpenHost={onOpenHost}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
