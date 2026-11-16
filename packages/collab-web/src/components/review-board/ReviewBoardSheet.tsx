import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { ReviewSubject } from "../../lib/review-board";
import { buildBoardPrompt, type StackPosition } from "../../lib/review-board-view";
import { promptTurns } from "../../lib/turn-changes";
import { Sheet, SheetPlacementButton } from "../shell/Sheet";
import {
	type BoardCompanion,
	type BoardSource,
	type Load,
	useBranchSource,
	useHunkNotes,
	usePrSource,
	useSessionSource,
} from "./board-data";
import { PrPicker } from "./PrPicker";
import { ReviewBoard } from "./ReviewBoard";
import { type BoardView, SubjectBar } from "./SubjectBar";

/** What the board opens on. `number: null` asks which pull request. */
export type BoardStart =
	| { view: "pr"; number: number | null }
	| { view: "branch" }
	| { view: "session"; entryId?: string };

export interface ReviewBoardSheetProps {
	client: GuestClient;
	snap: GuestSnapshot;
	sessionId: string | null;
	/** The session's companion host; null without one (then only session changes can be shown). */
	companion: BoardCompanion | null;
	initial: BoardStart;
	onClose(): void;
}

const PR_UNSUPPORTED =
	"This computer's companion does not support the review board. Update it to review pull requests.";

function sha7(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * The review board: a pull request of a stack (each against the one below), the session's branch, or the session's
 * changes (all of them or one turn's), with the agent's reasoning beside every hunk and the reviewer's comments
 * going back to the agent as one message.
 */
export function ReviewBoardSheet({
	client,
	snap,
	sessionId,
	companion,
	initial,
	onClose,
}: ReviewBoardSheetProps): ReactNode {
	const [view, setView] = useState<BoardView>(initial.view);
	const [prNumber, setPrNumber] = useState<number | null>(initial.view === "pr" ? initial.number : null);
	// The stack is read for the PR the board was opened on; stepping through it keeps it.
	const [prRoot, setPrRoot] = useState<number | null>(initial.view === "pr" ? initial.number : null);
	const [entryId, setEntryId] = useState<string | undefined>(initial.view === "session" ? initial.entryId : undefined);
	const turns = useMemo(() => promptTurns(snap.entries), [snap.entries]);

	const subject: ReviewSubject = useMemo(
		() =>
			view === "pr"
				? { kind: "pr", number: prNumber ?? 0 }
				: view === "branch"
					? { kind: "branch" }
					: { kind: "session", ...(entryId !== undefined && { entryId }) },
		[view, prNumber, entryId],
	);
	const session = useSessionSource(client, snap, subject, view === "session");
	const branch = useBranchSource(companion, view === "branch");
	const pr = usePrSource(companion, prRoot, prNumber, view === "pr");

	let load: Load<BoardSource>;
	let reload: () => void;
	if (view === "session") {
		({ load, reload } = session);
	} else if (view === "branch") {
		({ load, reload } = branch);
	} else {
		reload = pr.reload;
		const own = prNumber === null ? undefined : pr.diffs[prNumber];
		if (companion?.canBoard !== true) load = { status: "error", message: PR_UNSUPPORTED };
		else if (own === undefined) load = { status: "loading" };
		else if (own.status !== "ready") load = own;
		else {
			load = {
				status: "ready",
				value: {
					files: own.value.files,
					version: own.value.head,
					notices: own.value.files.some(file => file.truncated === true)
						? ["Some files are longer than the companion sends; their diffs are cut."]
						: [],
				},
			};
		}
	}
	const source = load.status === "ready" ? load.value : null;
	const notes = useHunkNotes(companion, subject, source);

	const views: BoardView[] = [
		...(companion?.canBoard === true || view === "pr" ? (["pr"] as const) : []),
		...(companion !== null || view === "branch" ? (["branch"] as const) : []),
		"session",
	];

	const stackPosition = useMemo((): StackPosition | null => {
		if (pr.stack.status !== "ready" || prNumber === null) return null;
		const at = pr.stack.value.findIndex(entry => entry.number === prNumber);
		const current = pr.stack.value[at];
		if (current === undefined) return null;
		return { pr: current, index: at + 1, total: pr.stack.value.length, below: pr.stack.value[at - 1] };
	}, [pr.stack, prNumber]);
	const branchInfo = branch.load.status === "ready" ? branch.load.value.review : null;
	const turn = entryId === undefined ? null : (turns.find(t => t.id === entryId) ?? null);

	const ownDiff = prNumber === null ? undefined : pr.diffs[prNumber];
	const title =
		view === "pr" && stackPosition !== null
			? `#${stackPosition.pr.number} ${stackPosition.pr.title}`
			: view === "branch"
				? (branchInfo?.branch ?? "Branch")
				: view === "session"
					? turn === null
						? "This session"
						: `Turn ${turn.turn}`
					: "Pull request";

	const choosePr = (number: number): void => {
		// Another PR of the open stack keeps the stack; one picked afresh starts a new one.
		setPrNumber(number);
		if (prRoot === null || (pr.stack.status === "ready" && !pr.stack.value.some(entry => entry.number === number))) {
			setPrRoot(number);
		}
	};

	let body: ReactNode;
	if (view === "pr" && prNumber === null) {
		body =
			companion === null || !companion.canBoard ? (
				<div className="sh-companion-empty">{PR_UNSUPPORTED}</div>
			) : (
				<PrPicker client={companion.client} instanceId={companion.instanceId} onPick={choosePr} />
			);
	} else if (load.status === "loading") {
		body = (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> {load.detail ?? "Reading changes…"}
			</div>
		);
	} else if (load.status === "error") {
		body = (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{load.message}</div>
				<button type="button" className="sh-btn" onClick={reload}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	} else {
		const ready = load.value;
		body = (
			<ReviewBoard
				key={`${view}:${view === "pr" ? prNumber : view === "session" ? (entryId ?? "") : ""}`}
				subject={subject}
				sessionId={sessionId}
				files={ready.files}
				notices={ready.notices}
				notes={notes}
				prompt={(comments, hunkNotes) =>
					buildBoardPrompt({
						subject,
						stack: stackPosition,
						branch: branchInfo === null ? null : { name: branchInfo.branch, base: branchInfo.base },
						turn,
						comments,
						files: ready.files,
						notes: hunkNotes,
					})
				}
				onSend={snap.readOnly ? null : (text, deliver) => client.sendPrompt(text, undefined, deliver)}
			/>
		);
	}

	return (
		<Sheet label="review board" size="full" pane="review-board" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title rb-title" title={title}>
					Review board <span className="rb-title-subject">{title}</span>
				</div>
				<span className="sh-sheet-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						aria-label="Refresh"
						title="Refresh"
					>
						<RefreshCw size={16} />
					</button>
					<SheetPlacementButton />
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close" title="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<SubjectBar
				view={view}
				views={views}
				onView={next => {
					setView(next);
				}}
				turns={turns}
				entryId={entryId}
				onEntry={setEntryId}
				stack={pr.stack}
				diffs={pr.diffs}
				current={prNumber}
				onPr={choosePr}
			/>
			{view === "pr" && ownDiff?.status === "ready" && (
				<div className="rb-against">
					Own changes against <code>{ownDiff.value.against.ref}</code> ({sha7(ownDiff.value.against.sha)}) · head{" "}
					<code>{sha7(ownDiff.value.head)}</code>
				</div>
			)}
			{body}
		</Sheet>
	);
}
