/**
 * Which sessions have news for the person: the open items of the Inbox, counted per session. A session that waits on
 * an answer counts (needs input); so does one whose last finished turn the person has not seen, which is a `done`
 * item of the Inbox that is not dismissed. Pure over its inputs, so the rows, the Inbox button's badge and the tests
 * read one definition.
 */

import type { CompanionHost, InboxItem } from "./companion";
import { hostKey, inboxKey } from "./inbox";

/** What one session has waiting. */
export interface SessionUnread {
	computerId: string;
	instanceId: string;
	/** Open Inbox items of the session. */
	count: number;
	/** One of them is a question the session waits on: shown in the warning colour, the rest are neutral. */
	needsInput: boolean;
}

/** One live computer: the hosts it lists now, its hibernated sessions and the finished turns its Inbox answered with. */
export interface UnreadSource {
	computerId: string;
	hosts: readonly CompanionHost[];
	/** Instance ids of the computer's hibernated sessions: idle by definition, so their finished turns count as for an idle host. */
	asleep: readonly string[];
	/** `done` items of the computer's last Inbox answer; empty until it answers. */
	done: readonly InboxItem[];
}

/**
 * The sessions with open Inbox items, by {@link hostKey}. A session waiting on an answer is read from the hosts frame, as the
 * Inbox button's badge always was, so it shows at once and without a request. A finished turn counts only while the
 * session is still idle (a new turn started since the answer makes the item stale) and until the person dismisses it
 * or sees the session. The Personal agent's own session is not an ordinary one: what it needs from the owner is a Personal item.
 */
export function unreadSessions(
	sources: readonly UnreadSource[],
	dismissed: ReadonlySet<string>,
): ReadonlyMap<string, SessionUnread> {
	const unread = new Map<string, SessionUnread>();
	for (const { computerId, hosts, asleep, done } of sources) {
		const unseen = (instanceId: string): number =>
			done.filter(
				item =>
					item.kind === "done" && item.instanceId === instanceId && !dismissed.has(inboxKey(computerId, item)),
			).length;
		for (const host of hosts) {
			if (host.personal === true) continue;
			const entry: SessionUnread = { computerId, instanceId: host.instanceId, count: 0, needsInput: false };
			if (host.inputRequired) {
				entry.count = 1;
				entry.needsInput = true;
			} else if (host.busy === false) {
				entry.count = unseen(host.instanceId);
			}
			if (entry.count > 0) unread.set(hostKey(computerId, host.instanceId), entry);
		}
		for (const instanceId of asleep) {
			const count = unseen(instanceId);
			if (count > 0) unread.set(hostKey(computerId, instanceId), { computerId, instanceId, count, needsInput: false });
		}
	}
	return unread;
}

/** Open items across the sessions of `computerIds`: the number the Inbox button's badge starts from. */
export function unreadTotal(unread: ReadonlyMap<string, SessionUnread>, computerIds: readonly string[]): number {
	let total = 0;
	for (const entry of unread.values()) if (computerIds.includes(entry.computerId)) total += entry.count;
	return total;
}

/** The `done` items of `done` that belong to the sessions in `viewing` (by {@link hostKey}) and are not dismissed yet: what seeing them dismisses. */
export function seenKeys(
	computerId: string,
	done: readonly InboxItem[],
	viewing: ReadonlySet<string>,
	dismissed: ReadonlySet<string>,
): string[] {
	return done
		.filter(item => item.kind === "done" && viewing.has(hostKey(computerId, item.instanceId)))
		.map(item => inboxKey(computerId, item))
		.filter(key => !dismissed.has(key));
}

/** What a badge says, for a screen reader: "3 unread updates", "1 unread update, needs input". */
export function unreadLabel(entry: Pick<SessionUnread, "count" | "needsInput">): string {
	const updates = `${entry.count} unread update${entry.count === 1 ? "" : "s"}`;
	return entry.needsInput ? `${updates}, needs input` : updates;
}
