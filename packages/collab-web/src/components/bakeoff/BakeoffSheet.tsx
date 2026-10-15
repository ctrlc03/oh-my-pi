import type { BakeoffSummary } from "@oh-my-pi/pi-wire/bakeoff";
import type { ReactNode } from "react";
import { useState } from "react";
import { type ComputerHandle, computerById } from "../../lib/computers";
import { isProjectless } from "../../lib/start-session";
import { Sheet } from "../shell/Sheet";
import { StartSessionSheet } from "../shell/StartSessionSheet";
import "../architecture/architecture.css";
import "../quiz/quiz.css";
import { BakeoffList } from "./BakeoffList";
import { BakeoffScreen } from "./BakeoffScreen";
import { NewBakeoffForm } from "./NewBakeoffForm";
import { isGitFolder } from "./bakeoff-flow";
import type { BakeoffJoins, BakeoffStart, BakeoffSubject, BakeoffTarget } from "./bakeoff-types";
import { designMarkdown } from "./bakeoff-result-flow";
import { useBakeoffFolder } from "./use-bakeoff-folder";
import "./bakeoff.css";
import "./bakeoff-result.css";

export interface BakeoffSheetProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null when none is at hand, where every computer's bake-offs are listed. */
	computerId: string | null;
	/** The session's folder (on `computerId`); null when none is at hand, where every repository's bake-offs are listed. */
	cwd: string | null;
	/** Host of the session on screen, on `computerId`, which lists the repository's run targets; null when none. */
	instanceId: string | null;
	/** The omp session on screen, whose changes and conversation a bake-off may draw on; null when none. */
	sessionId: string | null;
	start: BakeoffStart;
	/** What an entry of a finished bake-off can lead to; the sheet adds *Start a session from this design* itself. */
	joins: BakeoffJoins;
	/** Fetch a link for a hosting session on a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Show a file of the session's checkout, scrolled to `line` when given. */
	onOpenFile?(path: string, line?: number): void;
	onClose(): void;
}

type Screen =
	| { kind: "home" }
	| { kind: "new"; target: BakeoffTarget }
	| { kind: "bakeoff"; computerId: string; id: string; hint?: BakeoffSummary };

/**
 * Design bake-offs: the list of a repository's bake-offs (those of every computer that runs them), the form that starts
 * one, and one being run and judged. Progress of a bake-off being run arrives by push.
 */
export function BakeoffSheet({
	computers,
	computerId,
	cwd,
	instanceId,
	sessionId,
	start,
	joins,
	onOpenHost,
	onOpenFile,
	onClose,
}: BakeoffSheetProps): ReactNode {
	/** The session's own repository and computer: what a bake-off about "these changes" is made from. */
	const sessionTarget = (
		subject: BakeoffSubject,
		more: Pick<BakeoffTarget, "doc" | "mode" | "goal" | "instructions"> = {},
	): BakeoffTarget | null =>
		computerId === null || cwd === null ? null : { computerId, cwd, sessionId, instanceId, subject, ...more };
	const [screen, setScreen] = useState<Screen>(() => {
		if (start.view === "bakeoff") return { kind: "bakeoff", computerId: start.computerId, id: start.id };
		if (start.view !== "new") return { kind: "home" };
		const more = { doc: start.doc, mode: start.mode, goal: start.goal, instructions: start.instructions };
		// A spar of another repository (or computer) than the session on screen keeps its own.
		const target: BakeoffTarget | null =
			start.at === undefined || (start.at.computerId === computerId && start.at.cwd === cwd)
				? sessionTarget(start.subject, more)
				: {
						computerId: start.at.computerId,
						cwd: start.at.cwd,
						sessionId: start.at.sessionId,
						instanceId: start.at.computerId === computerId ? instanceId : null,
						subject: start.subject,
						...more,
					};
		return target === null ? { kind: "home" } : { kind: "new", target };
	});
	/** *Start a session from this design* is open over the bake-off: where it starts and what it first says. */
	const [session, setSession] = useState<{ computerId: string; cwd: string; prompt: string } | null>(null);
	const home = (): void => setScreen({ kind: "home" });
	// A folder that is not a git repository has no changes to compare: the form opens on a design document.
	const owner = computerById(computers, computerId);
	const canFolder = owner?.snap.canBakeoffFolder === true;
	const folder = useBakeoffFolder(owner?.client ?? null, cwd ?? "", canFolder && cwd !== null && !isProjectless(cwd));
	const fresh = sessionTarget(
		cwd !== null && !isGitFolder(cwd, canFolder, folder) ? { kind: "doc" } : { kind: "changes" },
	);

	if (screen.kind === "new") {
		return (
			<Sheet label="bake-off" size="full" onClose={onClose}>
				<NewBakeoffForm
					computers={computers}
					target={screen.target}
					onBack={home}
					onStarted={(startedOn, id) => setScreen({ kind: "bakeoff", computerId: startedOn, id })}
					onClose={onClose}
				/>
			</Sheet>
		);
	}
	if (screen.kind === "bakeoff") {
		const owner = computerById(computers, screen.computerId);
		return (
			<>
				<Sheet label="bake-off" size="full" onClose={onClose}>
					{(owner?.client ?? null) === null ? (
						<div className="bo-sheet-center">
							<div className="bo-sheet-alert" role="alert">
								This computer is not connected.
							</div>
							<button type="button" className="sh-btn" onClick={home}>
								Back to the bake-offs
							</button>
						</div>
					) : (
						<BakeoffScreen
							key={`${screen.computerId}:${screen.id}`}
							computers={computers}
							computerId={screen.computerId}
							id={screen.id}
							hint={screen.hint}
							joins={{
								...joins,
								startFromDesign: (designComputerId, bakeoff, entry) =>
									setSession({
										computerId: designComputerId,
										cwd: bakeoff.repo.root,
										prompt: `Carry out this design:\n\n${designMarkdown(bakeoff, entry)}`,
									}),
							}}
							onBack={home}
							onOpenHost={async (hostComputerId, host) => {
								await onOpenHost(hostComputerId, host);
								onClose();
							}}
							// The session's checkout is only on its own computer: another computer's bake-off cannot open its lines there.
							onOpenFile={screen.computerId === computerId ? onOpenFile : undefined}
							onClose={onClose}
							onDeleted={home}
						/>
					)}
				</Sheet>
				{session !== null && (
					<StartSessionSheet
						computers={computers}
						currentComputerId={session.computerId}
						initial={{ cwd: session.cwd, prompt: session.prompt }}
						onOpen={async (hostComputerId, host) => {
							await onOpenHost(hostComputerId, host);
							onClose();
						}}
						onClose={() => setSession(null)}
					/>
				)}
			</>
		);
	}
	return (
		<Sheet label="bake-off" size="full" onClose={onClose}>
			<BakeoffList
				computers={computers}
				computerId={computerId}
				cwd={cwd}
				currentInstanceId={instanceId}
				onOpen={(bakeoffComputerId, bakeoff) =>
					setScreen({ kind: "bakeoff", computerId: bakeoffComputerId, id: bakeoff.id, hint: bakeoff })
				}
				onNew={fresh === null ? null : () => setScreen({ kind: "new", target: fresh })}
				onOpenHost={async (hostComputerId, host) => {
					await onOpenHost(hostComputerId, host);
					onClose();
				}}
				onClose={onClose}
			/>
		</Sheet>
	);
}
