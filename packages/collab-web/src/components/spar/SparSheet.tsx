import type { Spar, SparRun, SparSummary } from "@oh-my-pi/pi-wire/spar";
import type { ReactNode } from "react";
import { useState } from "react";
import { computerById, type ComputerHandle } from "../../lib/computers";
import { Sheet } from "../shell/Sheet";
import "../architecture/architecture.css";
import "../quiz/quiz.css";
import { NewSparForm } from "./NewSparForm";
import { SparList } from "./SparList";
import { SparScreen } from "./SparScreen";
import { subjectOf, type SparStart, type SparSubject, type SparDocInput, type SparTarget } from "./spar-flow";
import "./sparring.css";

export interface SparSheetProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen, where every computer's spars are listed. */
	computerId: string | null;
	/** The session's folder (on `computerId`); null from the start screen, where every repository's spars are listed. */
	cwd: string | null;
	/** Host of the session on screen, on `computerId`; null from the start screen. */
	instanceId: string | null;
	/** The omp session on screen, whose conversation a spar about its changes may draw on; null from the start screen. */
	sessionId: string | null;
	start: SparStart;
	/** Fetch a link for a hosting session on a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Show a file of the session's checkout, scrolled to `line` when given. */
	onOpenFile?(path: string, line?: number): void;
	/** Bake off the change or design of a spar (the run shown); absent when bake-offs cannot be started from here. */
	onBakeoff?(computerId: string, spar: Spar, run: SparRun): void;
	/** Switch to the list of quizzes. */
	onShowQuizzes(): void;
	onClose(): void;
}

type Screen =
	| { kind: "home" }
	| { kind: "new"; target: SparTarget }
	| { kind: "spar"; computerId: string; id: string; hint?: SparSummary };

/**
 * Sparring on code changes and designs: the list of a repository's spars (those of every computer that writes them),
 * the form that starts one, and a spar being prepared, argued and summed up. Progress of a spar being prepared arrives
 * by push.
 */
export function SparSheet({
	computers,
	computerId,
	cwd,
	instanceId,
	sessionId,
	start,
	onOpenHost,
	onOpenFile,
	onBakeoff,
	onShowQuizzes,
	onClose,
}: SparSheetProps): ReactNode {
	/** The session's own repository and computer: what a spar about "these changes" is made from. */
	const sessionTarget = (subject: SparSubject, doc?: SparDocInput): SparTarget | null =>
		computerId === null || cwd === null ? null : { computerId, cwd, sessionId, subject, doc };
	const [screen, setScreen] = useState<Screen>(() => {
		if (start.view === "spar") return { kind: "spar", computerId: start.computerId, id: start.id };
		const target = start.view === "spar-new" ? sessionTarget(start.subject, start.doc) : null;
		return target === null ? { kind: "home" } : { kind: "new", target };
	});
	const home = (): void => setScreen({ kind: "home" });
	const changes = sessionTarget({ kind: "changes" });

	if (screen.kind === "new") {
		return (
			<Sheet label="sparring" size="full" onClose={onClose}>
				<NewSparForm
					computers={computers}
					target={screen.target}
					onBack={home}
					onStarted={(startedOn, id) => setScreen({ kind: "spar", computerId: startedOn, id })}
					onClose={onClose}
				/>
			</Sheet>
		);
	}
	if (screen.kind === "spar") {
		const sparClient = computerById(computers, screen.computerId)?.client ?? null;
		// The session's checkout is only on its own computer: a spar of another computer cannot open its lines there.
		const onSessionComputer = screen.computerId === computerId;
		const another = (spar: Spar): void => {
			const owner = computerById(computers, screen.computerId);
			if (owner === null) return;
			setScreen({
				kind: "new",
				target: {
					computerId: owner.id,
					cwd: spar.repo.root,
					sessionId: spar.sessionId ?? null,
					subject: subjectOf(spar),
				},
			});
		};
		return (
			<Sheet label="sparring" size="full" onClose={onClose}>
				{sparClient === null ? (
					<div className="sp-center">
						<div className="sp-alert" role="alert">
							This computer is not connected.
						</div>
						<button type="button" className="sh-btn" onClick={home}>
							Back to the spars
						</button>
					</div>
				) : (
					<SparScreen
						key={`${screen.computerId}:${screen.id}`}
						client={sparClient}
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
						onNewSpar={another}
						onBakeoff={
							onBakeoff === undefined ? undefined : (spar, run) => onBakeoff(screen.computerId, spar, run)
						}
						onHistory={home}
						onClose={onClose}
					/>
				)}
			</Sheet>
		);
	}
	return (
		<Sheet label="sparring" size="full" onClose={onClose}>
			<SparList
				computers={computers}
				computerId={computerId}
				cwd={cwd}
				currentInstanceId={instanceId}
				onOpen={(sparComputerId, spar) =>
					setScreen({ kind: "spar", computerId: sparComputerId, id: spar.id, hint: spar })
				}
				onNew={changes === null ? null : () => setScreen({ kind: "new", target: changes })}
				onOpenHost={async (hostComputerId, host) => {
					await onOpenHost(hostComputerId, host);
					onClose();
				}}
				onShowQuizzes={onShowQuizzes}
				onClose={onClose}
			/>
		</Sheet>
	);
}
