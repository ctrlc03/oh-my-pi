/**
 * Guest-driven `/undo` and `/redo` for the collab host: `session-cmd` `undo` and `redo`, and the
 * `/undo` and `/redo` slash spellings that route to them. The rewind itself lives in
 * `session/turn-undo.ts`; this only calls it, turns a refusal into the guest's `error`, and answers
 * the asking guest with a targeted `turn-undone` frame.
 */
import type { AgentSession } from "../session/agent-session";
import { describeFileRestore } from "../session/file-snapshots";
import { TurnUndoError, type TurnUndoResult } from "../session/turn-undo";
import type { CollabFrame } from "./protocol";

/**
 * Undo the last turn (or redo the last undone one). Resolves the notice text for the room, or
 * undefined after reporting a refusal through `fail`; anything but a refusal is left to throw.
 */
export async function runGuestTurnUndo(
	session: Pick<AgentSession, "turnUndo">,
	kind: "undo" | "redo",
	reply: (frame: CollabFrame) => void,
	fail: (message: string) => void,
): Promise<string | undefined> {
	let result: TurnUndoResult;
	try {
		result = await (kind === "undo" ? session.turnUndo.undo() : session.turnUndo.redo());
	} catch (error) {
		if (!(error instanceof TurnUndoError)) throw error;
		fail(error.message);
		return undefined;
	}
	reply({
		t: "turn-undone",
		kind,
		text: result.editorText,
		images: result.editorImages,
		staleText: result.staleDraft,
		files: result.files?.plan,
		skipped: result.files?.skipped,
		filesUnavailable: result.filesUnavailable,
	});
	const files = result.files ? ` and restored ${describeFileRestore(result.files.plan)}` : "";
	return kind === "undo" ? `undid the last turn${files}` : `redid the turn${files}`;
}
