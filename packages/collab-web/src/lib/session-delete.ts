/**
 * Deleting sessions, as the app words and sequences it: which rows offer it, what the confirm dialog says of a
 * plan, and what the toast says of the answer. No I/O of its own and no React: the dialog and the toast are in
 * components/shell/DeleteSessions.tsx. The companion's side is `session-delete-plan`, `session-delete` and
 * `session-restore` (see ./companion.ts).
 */

import type {
	AgentRef,
	CompanionClient,
	CompanionSnapshot,
	SessionDeletePlan,
	SessionDeleteResult,
	SessionOverview,
} from "./companion";
import type { ComputerHandle } from "./computers";
import { applyMany, type OrgDoc } from "./session-org";

/** One session a deletion names, as the person knows it. */
export interface DeleteTarget {
	sessionId: string;
	title: string;
	/** Recent rooms remembered for the session: they go with it, so the deleted session is not listed as a room. */
	roomIds?: readonly string[];
}

/** A deletion to confirm: sessions of one computer. */
export interface DeleteRequest {
	computerId: string;
	sessions: readonly DeleteTarget[];
	/** The session on screen: when it is among the deleted ones the app leaves it. */
	openSessionId: string | null;
}

/** Whether a computer can delete sessions now. Older companions never offer it. */
export function deleteOffered(snap: Pick<CompanionSnapshot, "phase" | "canDeleteSessions">): boolean {
	return snap.phase === "live" && snap.canDeleteSessions;
}

/** An omp session of the user's own: not a vendor agent's, and not the Personal agent's. */
export function isDeletableSession(session: { agent?: AgentRef; personal?: unknown }): boolean {
	return session.agent === undefined && session.personal === undefined;
}

/** Whether the all-sessions list offers Delete on a row of `computer`. */
export function deletableOverview(computer: Pick<ComputerHandle, "snap">, session: SessionOverview): boolean {
	return (
		deleteOffered(computer.snap) &&
		isDeletableSession(session) &&
		!computer.snap.hosts.some(host => host.personal !== undefined && host.sessionId === session.sessionId)
	);
}

const NOT_PLANNED = "The computer did not say whether it can be deleted.";
const NOT_ANSWERED = "The computer did not answer for it.";

/** What a plan says of the sessions a deletion names. */
export interface PlanSummary {
	/** The sessions Delete takes, in the order asked. */
	deletable: DeleteTarget[];
	refused: { target: DeleteTarget; reason: string }[];
	/** Started by the companion and still running: they are ended first. */
	running: DeleteTarget[];
	/** Worktree folders the companion made for the deletable sessions and that still exist. */
	worktrees: { target: DeleteTarget; folder: string }[];
}

export function summarizePlan(targets: readonly DeleteTarget[], plans: readonly SessionDeletePlan[]): PlanSummary {
	const summary: PlanSummary = { deletable: [], refused: [], running: [], worktrees: [] };
	for (const target of targets) {
		const plan = plans.find(candidate => candidate.sessionId === target.sessionId);
		if (plan === undefined || plan.refused !== undefined) {
			summary.refused.push({ target, reason: plan?.refused ?? NOT_PLANNED });
			continue;
		}
		summary.deletable.push(target);
		if (plan.running === true) summary.running.push(target);
		if (plan.worktree !== undefined) summary.worktrees.push({ target, folder: plan.worktree });
	}
	return summary;
}

/** The dialog's heading: "Delete Foo?" or "Delete 3 sessions?". */
export function deleteHeading(targets: readonly DeleteTarget[]): string {
	return targets.length === 1 ? `Delete ${targets[0]!.title}?` : `Delete ${targets.length} sessions?`;
}

/** The confirm button: "Delete", or "Delete 3 sessions" for several. */
export function deleteLabel(count: number): string {
	return count > 1 ? `Delete ${count} sessions` : "Delete";
}

/** The Settled header's button: "Delete 3 settled sessions…". */
export function deleteSettledLabel(count: number): string {
	return `Delete ${count} settled ${count === 1 ? "session" : "sessions"}…`;
}

/** A session that went to the companion's trash, with the id that brings it back. */
export interface TrashEntry {
	sessionId: string;
	title: string;
	trashId: string;
}

/** What the person is told of a deletion's answer. */
export interface DeleteOutcome {
	deleted: TrashEntry[];
	/** "Deleted Foo" / "Deleted 3 sessions"; empty when nothing was deleted. */
	message: string;
	/** Plain lines about what did not go as asked: refusals, and worktrees that were kept. */
	notes: string[];
}

/** "Deleted Foo" for one session, "Deleted 3 sessions" for several; empty for none (the same for "Restored"). */
export function sessionsMessage(verb: "Deleted" | "Restored", titles: readonly string[]): string {
	if (titles.length === 0) return "";
	return titles.length === 1 ? `${verb} ${titles[0]}` : `${verb} ${titles.length} sessions`;
}

export function summarizeResults(
	targets: readonly DeleteTarget[],
	results: readonly SessionDeleteResult[],
): DeleteOutcome {
	const deleted: TrashEntry[] = [];
	const notes: string[] = [];
	let removed = 0;
	const alone = targets.length === 1;
	for (const target of targets) {
		const result = results.find(candidate => candidate.sessionId === target.sessionId);
		if (result === undefined) {
			notes.push(`${target.title}: ${NOT_ANSWERED}`);
		} else if (result.status === "refused") {
			notes.push(`${target.title}: ${result.reason}`);
		} else {
			deleted.push({ sessionId: target.sessionId, title: target.title, trashId: result.trashId });
			if (result.status === "worktreeKept")
				notes.push(
					alone
						? `Its worktree was kept: ${result.reason}`
						: `${target.title}: its worktree was kept: ${result.reason}`,
				);
			else if (result.worktree === "removed") removed++;
		}
	}
	if (removed > 0) notes.push(alone ? "Its worktree was removed." : `${removed} worktrees were removed.`);
	return {
		deleted,
		message: sessionsMessage(
			"Deleted",
			deleted.map(entry => entry.title),
		),
		notes,
	};
}

/**
 * Delete the sessions a plan allowed. `removeWorktree` is what the box said; it only goes to the computer when some
 * session has a worktree to remove.
 */
export async function deleteSummarized(
	client: Pick<CompanionClient, "deleteSessions">,
	summary: PlanSummary,
	removeWorktree: boolean,
): Promise<DeleteOutcome> {
	const results = await client.deleteSessions(
		summary.deletable.map(target => target.sessionId),
		{ removeWorktree: removeWorktree && summary.worktrees.length > 0 },
	);
	return summarizeResults(summary.deletable, results);
}

/** What an Undo brought back, and the reasons the rest stayed deleted. */
export interface RestoreOutcome {
	restored: TrashEntry[];
	notes: string[];
}

/** Put every session back from the trash; one the companion refuses stays deleted and says why. */
export async function restoreDeleted(
	client: Pick<CompanionClient, "restoreSession">,
	trash: readonly TrashEntry[],
): Promise<RestoreOutcome> {
	const answers = await Promise.allSettled(trash.map(entry => client.restoreSession(entry.trashId)));
	const restored: TrashEntry[] = [];
	const notes: string[] = [];
	trash.forEach((entry, at) => {
		const answer = answers[at]!;
		if (answer.status === "fulfilled") restored.push(entry);
		else
			notes.push(
				`${entry.title}: ${answer.reason instanceof Error ? answer.reason.message : String(answer.reason)}`,
			);
	});
	return { restored, notes };
}

/**
 * `doc` with the sidebar entries of deleted sessions gone back to default: the tombstone the computer writes too, so
 * a settled row that is only history vanishes at once. A session with no entry is left as it is.
 */
export function tombstoneDeleted(doc: OrgDoc, sessionIds: readonly string[], now: number): OrgDoc {
	return applyMany(
		doc,
		sessionIds.filter(id => Object.hasOwn(doc.entries, id)),
		{ type: "restore", entry: null },
		now,
	);
}

/** Whether the deletion took the session on screen. */
export function closesOpen(request: Pick<DeleteRequest, "openSessionId">, deleted: readonly TrashEntry[]): boolean {
	return request.openSessionId !== null && deleted.some(entry => entry.sessionId === request.openSessionId);
}
