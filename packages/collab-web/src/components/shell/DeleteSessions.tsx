import { LoaderCircle, Trash2, Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import { shortenPath } from "../../lib/format";
import {
	closesOpen,
	type DeleteOutcome,
	type DeleteRequest,
	type DeleteTarget,
	deleteHeading,
	deleteLabel,
	deleteSummarized,
	type PlanSummary,
	restoreDeleted,
	sessionsMessage,
	summarizePlan,
	tombstoneDeleted,
	type TrashEntry,
} from "../../lib/session-delete";
import type { OrgEntry } from "../../lib/session-org";
import { isTypingTarget } from "../../lib/shortcuts";
import type { SessionOrgControl, SessionOrgs } from "../../lib/use-session-org";
import { Sheet } from "./Sheet";
import "./delete-sessions.css";

/** How long the Undo stays, as long as settle's. */
const UNDO_MS = 7000;

/** What a confirmed deletion changed outside the dialog: the app leaves the open session, and forgets the rooms it was remembered by. */
export interface DeletedSessions {
	closeOpen: boolean;
	roomIds: string[];
}

export interface DeleteControl {
	/** Ask the computer what deleting these sessions would do, and confirm it with the person. */
	request(request: DeleteRequest): void;
	/** Moves whenever sessions were deleted or put back: lists of sessions load again. */
	rev: number;
}

const DeleteContext = createContext<DeleteControl | null>(null);

/** The delete flow of the app; null outside {@link DeleteHost}, where no row offers Delete. */
export function useDeleteSessions(): DeleteControl | null {
	return useContext(DeleteContext);
}

type PlanState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; summary: PlanSummary };

interface Pending {
	request: DeleteRequest;
	plan: PlanState;
	removeWorktree: boolean;
	deleting: boolean;
	error: string | null;
}

/** What Undo needs: the trash ids, the computer, and the sidebar entries as they were before the tombstones. */
interface UndoState {
	trash: TrashEntry[];
	client: CompanionClient;
	org: SessionOrgControl;
	prev: Record<string, OrgEntry | null>;
}

interface Toast {
	message: string;
	notes: string[];
	undo: UndoState | null;
	undoing: boolean;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface DeleteConfirmProps {
	targets: readonly DeleteTarget[];
	plan: PlanState;
	removeWorktree: boolean;
	deleting: boolean;
	error: string | null;
	onWorktree(on: boolean): void;
	onCancel(): void;
	onConfirm(): void;
}

/** The names of what a deletion removes, one line per kind. */
const GOES = ["The conversation, with its subagents and artifacts", "The sidebar entry", "The hidden-message marks"];

/** The dialog's content: what will go, what will not, and the buttons. */
export function DeleteConfirm(props: DeleteConfirmProps): ReactNode {
	const { targets, plan } = props;
	const cancel = useRef<HTMLButtonElement>(null);
	useEffect(() => cancel.current?.focus(), []);
	const summary = plan.status === "ready" ? plan.summary : null;
	const several = targets.length > 1;
	const worktrees = summary?.worktrees ?? [];
	const plural = worktrees.length > 1;
	return (
		<div className="sh-delete">
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{deleteHeading(targets)}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={props.onCancel} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-delete-body">
				{plan.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Asking your computer…
					</div>
				)}
				{plan.status === "error" && <div className="sh-connect-error">{plan.message}</div>}
				{summary !== null && summary.deletable.length > 0 && (
					<>
						<div className="sh-field-label">This deletes</div>
						<ul className="sh-delete-list">
							{GOES.map(line => (
								<li key={line}>{line}</li>
							))}
						</ul>
						{summary.running.map(target => (
							<div key={target.sessionId} className="sh-delete-note">
								{several
									? `${target.title} is running; it will be ended first.`
									: "It is running; it will be ended first."}
							</div>
						))}
					</>
				)}
				{summary?.refused.map(({ target, reason }) => (
					<div key={target.sessionId} className="sh-connect-error">
						{several ? `${target.title}: ${reason}` : reason}
					</div>
				))}
				{worktrees.length > 0 && (
					<label className="sh-org-check sh-org-check-hinted sh-delete-worktree">
						<input
							type="checkbox"
							checked={props.removeWorktree}
							disabled={props.deleting}
							onChange={e => props.onWorktree(e.currentTarget.checked)}
						/>
						<span className="sh-org-check-text">
							{plural ? "Also remove their worktrees" : "Also remove its worktree"}
							<span className="sh-field-hint">
								{plural
									? "The worktree folders stay unless you tick this."
									: "The worktree folder stays unless you tick this."}
							</span>
							{worktrees.map(({ target, folder }) => (
								<code key={target.sessionId} className="sh-delete-folder" title={folder}>
									{shortenPath(folder)}
								</code>
							))}
							<span className="sh-field-hint">
								Uses git worktree remove without force. A worktree with uncommitted changes is reported and
								kept. A removed worktree can't be undone.
							</span>
						</span>
					</label>
				)}
				{props.error !== null && <div className="sh-connect-error">{props.error}</div>}
			</div>
			<div className="sh-delete-actions">
				<button ref={cancel} type="button" className="sh-btn" onClick={props.onCancel} disabled={props.deleting}>
					Cancel
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-stop"
					onClick={props.onConfirm}
					disabled={summary === null || summary.deletable.length === 0 || props.deleting}
				>
					{props.deleting ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
					{deleteLabel(summary?.deletable.length ?? 0)}
				</button>
			</div>
		</div>
	);
}

export interface DeleteToastProps {
	message: string;
	notes: readonly string[];
	/** Undo is still offered. */
	canUndo: boolean;
	undoing: boolean;
	onUndo(): void;
	onDismiss(): void;
}

/** The line after a deletion: what went, an Undo while it lasts, and what did not go as asked. */
export function DeleteToast(props: DeleteToastProps): ReactNode {
	return (
		<div className="sh-delete-toast" role="status">
			<div className="sh-delete-toast-main">
				<span className="sh-delete-toast-msg">{props.message || props.notes[0]}</span>
				{props.canUndo && (
					<button type="button" className="sh-btn" onClick={props.onUndo} disabled={props.undoing}>
						{props.undoing ? <LoaderCircle size={14} className="sh-spin" /> : <Undo2 size={14} />} Undo
					</button>
				)}
				{props.notes.length > 0 && (
					<button type="button" className="sh-btn sh-btn-icon" onClick={props.onDismiss} aria-label="Dismiss">
						<X size={14} />
					</button>
				)}
			</div>
			{(props.message ? props.notes : props.notes.slice(1)).map(note => (
				<div key={note} className="sh-delete-toast-note">
					{note}
				</div>
			))}
		</div>
	);
}

export interface DeleteHostProps {
	computers: readonly ComputerHandle[];
	orgs: SessionOrgs;
	/** Sessions went: leave the open one and forget the rooms they were remembered by. */
	onDeleted(done: DeletedSessions): void;
	children: ReactNode;
}

/**
 * The one delete flow every entry point shares (a row's menu, the open session's sheet, All sessions, the Settled
 * header): the confirm dialog, then the Undo toast. Mounted at the app's top so the toast is not tied to the sheet
 * or the sidebar that asked, and outlives them.
 */
export function DeleteHost({ computers, orgs, onDeleted, children }: DeleteHostProps): ReactNode {
	const [pending, setPending] = useState<Pending | null>(null);
	const [toast, setToast] = useState<Toast | null>(null);
	const [rev, setRev] = useState(0);
	const latest = useRef({ computers, orgs, onDeleted });
	latest.current = { computers, orgs, onDeleted };
	/** The request whose plan is being asked: an answer for any other (cancelled, replaced) is dropped. */
	const asking = useRef<DeleteRequest | null>(null);

	const clientOf = (computerId: string): CompanionClient | null =>
		latest.current.computers.find(computer => computer.id === computerId)?.client ?? null;

	const request = useCallback((next: DeleteRequest): void => {
		const client = clientOf(next.computerId);
		if (client === null || next.sessions.length === 0) return;
		asking.current = next;
		setToast(null);
		setPending({ request: next, plan: { status: "loading" }, removeWorktree: false, deleting: false, error: null });
		const update = (plan: PlanState): void => {
			if (asking.current === next)
				setPending(current => (current?.request === next ? { ...current, plan } : current));
		};
		client.planSessionDelete(next.sessions.map(target => target.sessionId)).then(
			plans => update({ status: "ready", summary: summarizePlan(next.sessions, plans) }),
			(err: unknown) => update({ status: "error", message: messageOf(err) }),
		);
	}, []);

	const cancel = useCallback((): void => {
		asking.current = null;
		setPending(null);
	}, []);

	const confirm = async (): Promise<void> => {
		if (pending === null || pending.plan.status !== "ready" || pending.deleting) return;
		const { request: asked, plan, removeWorktree } = pending;
		const client = clientOf(asked.computerId);
		if (client === null) return;
		setPending({ ...pending, deleting: true, error: null });
		let outcome: DeleteOutcome;
		try {
			outcome = await deleteSummarized(client, plan.summary, removeWorktree);
		} catch (err) {
			setPending(current =>
				current?.request === asked ? { ...current, deleting: false, error: messageOf(err) } : current,
			);
			return;
		}
		asking.current = null;
		setPending(null);
		let undo: UndoState | null = null;
		if (outcome.deleted.length > 0) {
			const org = latest.current.orgs.of(asked.computerId);
			const ids = outcome.deleted.map(entry => entry.sessionId);
			const prev = org.edit((doc, now) => tombstoneDeleted(doc, ids, now));
			undo = { trash: outcome.deleted, client, org, prev };
			const rooms = asked.sessions
				.filter(target => ids.includes(target.sessionId))
				.flatMap(target => target.roomIds ?? []);
			latest.current.onDeleted({ closeOpen: closesOpen(asked, outcome.deleted), roomIds: rooms });
			setRev(n => n + 1);
		}
		if (outcome.deleted.length > 0 || outcome.notes.length > 0)
			setToast({ message: outcome.message, notes: outcome.notes, undo, undoing: false });
	};

	const undo = useCallback(async (state: UndoState): Promise<void> => {
		setToast(current => (current === null ? null : { ...current, undoing: true }));
		const outcome = await restoreDeleted(state.client, state.trash);
		const back = new Set(outcome.restored.map(entry => entry.sessionId));
		// Entries of sessions the computer refused to bring back stay as the tombstones left them.
		state.org.restore(Object.fromEntries(Object.entries(state.prev).filter(([key]) => back.has(key))));
		if (back.size > 0) setRev(n => n + 1);
		setToast(
			outcome.notes.length === 0
				? null
				: {
						message: sessionsMessage(
							"Restored",
							outcome.restored.map(entry => entry.title),
						),
						notes: outcome.notes,
						undo: null,
						undoing: false,
					},
		);
	}, []);

	useEffect(() => {
		if (toast === null || toast.undo === null) return;
		const state = toast.undo;
		const timer = setTimeout(
			() =>
				setToast(current =>
					current === toast ? (toast.notes.length === 0 ? null : { ...toast, undo: null }) : current,
				),
			UNDO_MS,
		);
		const onKey = (e: KeyboardEvent): void => {
			if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
			if (isTypingTarget(e.target) || toast.undoing) return;
			// The sidebar's own Undo (for a settle) listens too: this one is the later, so it answers.
			e.preventDefault();
			e.stopPropagation();
			void undo(state);
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [toast, undo]);

	const control = useMemo<DeleteControl>(() => ({ request, rev }), [request, rev]);
	return (
		<DeleteContext.Provider value={control}>
			{children}
			{pending !== null && (
				<Sheet label="Delete sessions" onClose={cancel}>
					<DeleteConfirm
						targets={pending.request.sessions}
						plan={pending.plan}
						removeWorktree={pending.removeWorktree}
						deleting={pending.deleting}
						error={pending.error}
						onWorktree={on => setPending({ ...pending, removeWorktree: on })}
						onCancel={cancel}
						onConfirm={() => void confirm()}
					/>
				</Sheet>
			)}
			{toast !== null && (
				<DeleteToast
					message={toast.message}
					notes={toast.notes}
					canUndo={toast.undo !== null}
					undoing={toast.undoing}
					onUndo={() => toast.undo !== null && void undo(toast.undo)}
					onDismiss={() => setToast(null)}
				/>
			)}
		</DeleteContext.Provider>
	);
}
