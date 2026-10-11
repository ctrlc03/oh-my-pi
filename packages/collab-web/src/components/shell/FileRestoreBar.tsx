import { Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FileRestoreInfo } from "../../lib/client";
import { describeFilePlan } from "../../lib/file-restore";

export interface FileRestoreBarProps {
	restore: FileRestoreInfo | null;
	/** Undoing is refused while a turn runs, so the bar waits for the host to go idle. */
	working: boolean;
	readOnly: boolean;
	onUndo(): void;
}

/**
 * Shown after a rewind put the files back: what changed, and a way to undo it until a turn
 * changes the files again. Dismissing it only hides it here; the host keeps the undo.
 */
export function FileRestoreBar({ restore, working, readOnly, onUndo }: FileRestoreBarProps): ReactNode {
	const [dismissed, setDismissed] = useState<FileRestoreInfo | null>(null);
	if (restore === null || restore === dismissed || restore.kind !== "restore" || !restore.canRedo) return null;
	if (working || readOnly) return null;
	const skipped = restore.skipped > 0 ? `, ${restore.skipped} left alone` : "";
	return (
		<div className="sh-restore-bar" role="status">
			<span className="sh-restore-msg">{`Restored ${describeFilePlan(restore.plan)}${skipped}`}</span>
			<button type="button" className="sh-restore-undo" onClick={onUndo}>
				<Undo2 size={13} />
				Undo restore
			</button>
			<button type="button" className="sh-toast-close" onClick={() => setDismissed(restore)} title="Dismiss">
				<X size={12} />
			</button>
		</div>
	);
}
