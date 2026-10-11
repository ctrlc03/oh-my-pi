import { Redo2, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot, TurnUndoInfo } from "../../lib/client";
import { describeFilePlan } from "../../lib/file-restore";
import { isPrompt } from "../../lib/trim";
import type { ComposerHandle } from "./Composer";

/** The undo and redo actions this guest may offer; each is false while the host cannot run it. */
export interface TurnUndoControl {
	canUndo: boolean;
	canRedo: boolean;
	onUndo(): void;
	onRedo(): void;
}

/**
 * Undo the last turn (conversation and files) and redo it, on hosts that advertise `undo`. The
 * host answers an undo with the prompt it removed, which goes back into the message box like
 * *Edit & resend*, and a redo with the draft that undo handed out, which is dropped if untouched.
 * `control` is undefined where the app must not offer the actions (no `undo` feature, read-only
 * link); `bar` is the redo strip shown while undone turns can still be brought back.
 */
export function useTurnUndo(
	client: GuestClient,
	snap: GuestSnapshot,
	composerRef: RefObject<ComposerHandle | null>,
): { control: TurnUndoControl | undefined; bar: ReactNode } {
	const { entries, working, turnUndo } = snap;
	const [dismissed, setDismissed] = useState<TurnUndoInfo | null>(null);
	// A reply already on the snapshot when this mounts belongs to an earlier view of the room.
	const handled = useRef(turnUndo);

	useEffect(() => {
		if (turnUndo === null || turnUndo === handled.current) return;
		handled.current = turnUndo;
		if (turnUndo.kind === "undo") {
			if (turnUndo.text) composerRef.current?.replace(turnUndo.text, turnUndo.images);
		} else if (turnUndo.staleText) {
			composerRef.current?.discard(turnUndo.staleText);
		}
	}, [turnUndo, composerRef]);

	const offered = snap.features.undo === true && !snap.readOnly;
	const idle = snap.phase === "live" && !working;
	const redoTurns = snap.state?.redoTurns ?? 0;
	const canUndo = idle && entries.some(isPrompt);
	const canRedo = idle && redoTurns > 0;
	// Stable between frames that change none of these: the header that receives it is memoized.
	const control = useMemo<TurnUndoControl | undefined>(
		() =>
			offered
				? {
						canUndo,
						canRedo,
						onUndo: () => client.sendSessionCommand("undo"),
						onRedo: () => client.sendSessionCommand("redo"),
					}
				: undefined,
		[offered, canUndo, canRedo, client],
	);
	if (!control?.canRedo || (turnUndo !== null && turnUndo === dismissed)) return { control, bar: null };
	const restored = turnUndo?.kind === "undo" && turnUndo.files ? `, restored ${describeFilePlan(turnUndo.files)}` : "";
	const bar = (
		<div className="sh-restore-bar" role="status">
			<span className="sh-restore-msg">{`${redoTurns === 1 ? "1 turn" : `${redoTurns} turns`} undone${restored}`}</span>
			<button type="button" className="sh-restore-undo" onClick={control.onRedo}>
				<Redo2 size={13} />
				Redo
			</button>
			<button type="button" className="sh-toast-close" onClick={() => setDismissed(turnUndo)} title="dismiss">
				<X size={12} />
			</button>
		</div>
	);
	return { control, bar };
}
