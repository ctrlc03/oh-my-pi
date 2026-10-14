import type { Quiz, QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import type { ReactNode } from "react";
import { useState } from "react";
import { computerById, type ComputerHandle } from "../../lib/computers";
import { Sheet } from "../shell/Sheet";
import "../architecture/architecture.css";
import { NewQuizForm, type NewQuizTarget } from "./NewQuizForm";
import { QuizList } from "./QuizList";
import { QuizScreen } from "./QuizScreen";
import { subjectOf, type QuizSubject } from "./quiz-flow";
import "./quiz.css";

/** What the sheet opens on. */
export type QuizStart =
	| { view: "home" }
	| { view: "new"; subject: QuizSubject }
	| { view: "quiz"; computerId: string; id: string };

export interface QuizSheetProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen, where every computer's quizzes are listed. */
	computerId: string | null;
	/** The session's folder (on `computerId`); null from the start screen, where every repository's quizzes are listed. */
	cwd: string | null;
	/** Host of the session on screen, on `computerId`; null from the start screen. */
	instanceId: string | null;
	/** The omp session on screen, whose conversation a quiz about its changes may draw on; null from the start screen. */
	sessionId: string | null;
	start: QuizStart;
	/** Fetch a link for a hosting session on a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Show a file of the session's checkout, scrolled to `line` when given. */
	onOpenFile?(path: string, line?: number): void;
	onClose(): void;
}

type Screen =
	| { kind: "home" }
	| { kind: "new"; target: NewQuizTarget }
	| { kind: "quiz"; computerId: string; id: string; hint?: QuizSummary };

/**
 * Quizzes on code changes: the list of a repository's quizzes (those of every computer that writes them), the
 * form that starts one, and a quiz being written, taken, and scored. Progress of a quiz being written arrives by push.
 */
export function QuizSheet({
	computers,
	computerId,
	cwd,
	instanceId,
	sessionId,
	start,
	onOpenHost,
	onOpenFile,
	onClose,
}: QuizSheetProps): ReactNode {
	/** The session's own repository and computer: what a quiz about "these changes" is made from. */
	const sessionTarget = (subject: QuizSubject): NewQuizTarget | null =>
		computerId === null || cwd === null ? null : { computerId, cwd, sessionId, subject };
	const [screen, setScreen] = useState<Screen>(() => {
		if (start.view === "quiz") return { kind: "quiz", computerId: start.computerId, id: start.id };
		const target = start.view === "new" ? sessionTarget(start.subject) : null;
		return target === null ? { kind: "home" } : { kind: "new", target };
	});
	const home = (): void => setScreen({ kind: "home" });
	const changes = sessionTarget({ kind: "changes" });

	if (screen.kind === "new") {
		return (
			<Sheet label="quizzes" size="full" onClose={onClose}>
				<NewQuizForm
					computers={computers}
					target={screen.target}
					onBack={home}
					onStarted={(startedOn, id) => setScreen({ kind: "quiz", computerId: startedOn, id })}
					onClose={onClose}
				/>
			</Sheet>
		);
	}
	if (screen.kind === "quiz") {
		const quizClient = computerById(computers, screen.computerId)?.client ?? null;
		// The session's checkout is only on its own computer: a quiz of another computer cannot open its lines there.
		const onSessionComputer = screen.computerId === computerId;
		const another = (quiz: Quiz): void => {
			const owner = computerById(computers, screen.computerId);
			if (owner === null) return;
			setScreen({
				kind: "new",
				target: {
					computerId: owner.id,
					cwd: quiz.repo.root,
					sessionId: quiz.sessionId ?? null,
					subject: subjectOf(quiz),
				},
			});
		};
		return (
			<Sheet label="quizzes" size="full" onClose={onClose}>
				{quizClient === null ? (
					<div className="qz-center">
						<div className="qz-alert" role="alert">
							This computer is not connected.
						</div>
						<button type="button" className="sh-btn" onClick={home}>
							Back to the quizzes
						</button>
					</div>
				) : (
					<QuizScreen
						key={`${screen.computerId}:${screen.id}`}
						client={quizClient}
						id={screen.id}
						hint={screen.hint}
						currentInstanceId={onSessionComputer ? instanceId : null}
						onOpenHost={async host => {
							await onOpenHost(screen.computerId, host);
							onClose();
						}}
						editor={
							onSessionComputer && onOpenFile !== undefined && cwd !== null
								? { root: cwd, open: onOpenFile }
								: undefined
						}
						onNewQuiz={another}
						onHistory={home}
						onClose={onClose}
					/>
				)}
			</Sheet>
		);
	}
	return (
		<Sheet label="quizzes" size="full" onClose={onClose}>
			<QuizList
				computers={computers}
				computerId={computerId}
				cwd={cwd}
				currentInstanceId={instanceId}
				onOpen={(quizComputerId, quiz) =>
					setScreen({ kind: "quiz", computerId: quizComputerId, id: quiz.id, hint: quiz })
				}
				onNew={changes === null ? null : () => setScreen({ kind: "new", target: changes })}
				onOpenHost={async (hostComputerId, host) => {
					await onOpenHost(hostComputerId, host);
					onClose();
				}}
				onClose={onClose}
			/>
		</Sheet>
	);
}
