import { Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import {
	applyHidden,
	changingIds,
	emptyHidden,
	type HiddenDoc,
	type HideControl,
	hiddenIds,
	mergeHidden,
	sameHidden,
} from "../../lib/hidden-messages";
import { loadHidden, saveHidden } from "../../lib/hidden-storage";

/** How long the Undo line stays after a hide. */
const UNDO_MS = 7000;

/** One Undo for the last hide: the messages it changed, and how many blocks that was. */
interface Undo {
	ids: string[];
	count: number;
}

export interface HiddenMessagesControl extends HideControl {
	/** Whether there is anything hidden: *Show hidden messages* is only offered then. */
	any: boolean;
	setShowing(showing: boolean): void;
	/** The computer keeps them too, so the user's other devices hide the same messages. */
	synced: boolean;
}

/**
 * The messages hidden from one session's chat. They are kept on this device and, when the session's computer keeps
 * them too (`canHideMessages`), merged into the computer's copy, last writer winning per message, so every device
 * shows the same ones. Hiding only changes what the app shows; nothing is sent to the host. Each hide offers one
 * Undo line (`bar`); *Show hidden messages* (`showing`) lasts for this view of the session only.
 */
export function useHiddenMessages(
	sessionId: string | null,
	computer: ComputerHandle | null,
): { control: HiddenMessagesControl | undefined; bar: ReactNode } {
	const [state, setState] = useState<{ sessionId: string | null; doc: HiddenDoc; showing: boolean }>(() => ({
		sessionId,
		doc: sessionId === null ? emptyHidden() : loadHidden(sessionId),
		showing: false,
	}));
	// A different session starts from its own document, and shows nothing it hid.
	let current = state;
	if (state.sessionId !== sessionId) {
		current = { sessionId, doc: sessionId === null ? emptyHidden() : loadHidden(sessionId), showing: false };
		setState(current);
	}
	const { doc, showing } = current;
	const latest = useRef({ sessionId, doc });
	latest.current = { sessionId, doc };
	const [undo, setUndo] = useState<(Undo & { sessionId: string | null }) | null>(null);

	const phase = computer?.snap.phase;
	const client = phase === "live" && computer?.snap.canHideMessages === true ? computer.client : null;
	const hiddenRev = computer?.snap.hiddenRev ?? null;

	const commit = useCallback((id: string, next: HiddenDoc): void => {
		if (latest.current.sessionId !== id || sameHidden(next, latest.current.doc)) return;
		const kept = saveHidden(id, next, Date.now());
		latest.current = { sessionId: id, doc: kept };
		setState(prev => (prev.sessionId === id ? { ...prev, doc: kept } : prev));
	}, []);

	const push = useCallback(
		async (id: string): Promise<void> => {
			if (client === null) return;
			try {
				const reply = await client.syncHiddenMessages(id, latest.current.doc);
				commit(id, mergeHidden(latest.current.doc, reply.doc));
			} catch {
				// Offline or refused: the next change, connection or new revision sends it again.
			}
		},
		[client, commit],
	);

	// Fetch the computer's copy on opening the session, when the connection comes back and when another device changed it.
	useEffect(() => {
		if (sessionId !== null && client !== null) void push(sessionId);
	}, [sessionId, client, hiddenRev, push]);

	// Another tab of this browser changed the stored document.
	useEffect(() => {
		if (sessionId === null) return;
		const onStorage = (): void => commit(sessionId, loadHidden(sessionId));
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [sessionId, commit]);

	const change = useCallback(
		(ids: readonly string[], hidden: boolean): string[] => {
			const { sessionId: id, doc: before } = latest.current;
			if (id === null) return [];
			const changed = changingIds(before, ids, hidden);
			if (changed.length === 0) return [];
			commit(id, applyHidden(before, changed, hidden, Date.now()));
			void push(id);
			return changed;
		},
		[commit, push],
	);

	const hide = useCallback(
		(ids: readonly string[], count: number): void => {
			const changed = change(ids, true);
			if (changed.length > 0) setUndo({ ids: changed, count, sessionId: latest.current.sessionId });
		},
		[change],
	);
	const unhide = useCallback((ids: readonly string[]): void => void change(ids, false), [change]);
	const setShowing = useCallback((next: boolean): void => setState(prev => ({ ...prev, showing: next })), []);

	useEffect(() => {
		if (undo === null) return;
		const timer = setTimeout(() => setUndo(null), UNDO_MS);
		return () => clearTimeout(timer);
	}, [undo]);

	const hidden = useMemo(() => hiddenIds(doc), [doc]);
	const control = useMemo<HiddenMessagesControl | undefined>(
		() =>
			sessionId === null
				? undefined
				: { hidden, showing, any: hidden.size > 0, synced: client !== null, hide, unhide, setShowing },
		[sessionId, hidden, showing, client, hide, unhide, setShowing],
	);

	const offered = undo !== null && undo.sessionId === sessionId ? undo : null;
	const bar =
		offered === null ? null : (
			<div className="sh-hide-bar" role="status">
				<span className="sh-hide-msg">{`Hid ${offered.count} message${offered.count === 1 ? "" : "s"}`}</span>
				<button
					type="button"
					className="sh-hide-undo"
					onClick={() => {
						unhide(offered.ids);
						setUndo(null);
					}}
				>
					<Undo2 size={13} />
					Undo
				</button>
			</div>
		);
	return { control, bar };
}
