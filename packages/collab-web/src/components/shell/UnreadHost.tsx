import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { dismissInbox, hostKey, useDismissed } from "../../lib/inbox";
import { seenKeys, type SessionUnread, unreadSessions, type UnreadSource } from "../../lib/unread";
import { useComputerRequests } from "../../lib/use-computer-requests";

export interface UnreadControl {
	/** The sessions with open Inbox items, by `hostKey`. */
	sessions: ReadonlyMap<string, SessionUnread>;
	/** The sessions on screen, by `hostKey`: their rows carry no badge. */
	viewing: ReadonlySet<string>;
	/**
	 * `computerId`'s session `instanceId` is on screen (the main session or the one beside it) until the returned
	 * function is called: its finished turns count as seen while the page is visible.
	 */
	view(computerId: string, instanceId: string): () => void;
}

const NO_UNREAD: UnreadControl = { sessions: new Map(), viewing: new Set(), view: () => () => {} };

const UnreadContext = createContext<UnreadControl>(NO_UNREAD);

/** What the sessions have waiting; nothing outside {@link UnreadHost}, where no row carries a badge. */
export function useUnread(): UnreadControl {
	return useContext(UnreadContext);
}

/** Reports the session on screen to {@link UnreadHost}; a null id (no paired computer runs it) reports nothing. */
export function useViewing(computerId: string | null, instanceId: string | null): void {
	const { view } = useUnread();
	useEffect(() => {
		if (computerId === null || instanceId === null) return;
		return view(computerId, instanceId);
	}, [view, computerId, instanceId]);
}

/** A background tab shows no session to anyone: news arriving there stays unread until the tab is back. */
function usePageVisible(): boolean {
	const [visible, setVisible] = useState(() => document.visibilityState === "visible");
	useEffect(() => {
		const update = (): void => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

export interface UnreadHostProps {
	computers: readonly ComputerHandle[];
	children: ReactNode;
}

/**
 * The unread updates of every session, for the rows that list them and the Inbox button. Needs input comes from the
 * hosts frames; a finished turn from the Inbox request of each live computer, asked again whenever a session starts
 * or ends a turn or begins to wait. Seeing a session dismisses its finished-turn item the way the Inbox's own ✕ does
 * (per device, see `lib/inbox.ts`), so the Inbox and the badges drop together.
 */
export function UnreadHost({ computers, children }: UnreadHostProps): ReactNode {
	const dismissed = useDismissed();
	const visible = usePageVisible();
	const live = computers.filter(computer => computer.snap.phase === "live");
	const progress = live
		.flatMap(computer =>
			computer.snap.hosts.map(host => `${computer.id}|${host.instanceId}|${host.busy}|${host.inputRequired}`),
		)
		.join("\n");
	const { entries } = useComputerRequests(computers, null, client => client.requestInbox(), progress);

	const counts = useRef(new Map<string, number>());
	const [viewing, setViewing] = useState<ReadonlySet<string>>(new Set());
	const view = useCallback((computerId: string, instanceId: string): (() => void) => {
		const key = hostKey(computerId, instanceId);
		const sync = (): void =>
			setViewing(prev => {
				const next = new Set(counts.current.keys());
				return prev.size === next.size && [...next].every(item => prev.has(item)) ? prev : next;
			});
		counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
		sync();
		return () => {
			const left = (counts.current.get(key) ?? 1) - 1;
			if (left > 0) counts.current.set(key, left);
			else counts.current.delete(key);
			sync();
		};
	}, []);

	const sources = live.map((computer): UnreadSource => {
		const state = entries.find(entry => entry.computer.id === computer.id)?.state ?? null;
		return {
			computerId: computer.id,
			hosts: computer.snap.hosts,
			asleep: computer.snap.hibernated.map(session => session.instanceId),
			// A computer whose Inbox does not answer (one that predates it) still reports the sessions that wait.
			done: state?.status === "ready" ? state.value : [],
		};
	});
	const dismissedSet = useMemo(() => new Set(dismissed), [dismissed]);

	useEffect(() => {
		if (!visible) return;
		const keys = sources.flatMap(source => seenKeys(source.computerId, source.done, viewing, dismissedSet));
		if (keys.length > 0) dismissInbox(keys);
	});

	const value: UnreadControl = {
		sessions: unreadSessions(sources, dismissedSet),
		viewing,
		view,
	};
	return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
