import type { InteractiveModeContext } from "../../modes/types";
import { describeFileRestore, type FileRestoreResult } from "../../session/file-snapshots";

function filesNote(files: FileRestoreResult | undefined): string {
	return files ? ` and restored ${describeFileRestore(files.plan)}` : "";
}

/** `/undo`: rewind before the last prompt, restore its files, and put the prompt back in the editor. */
export async function runUndoCommand(ctx: InteractiveModeContext): Promise<void> {
	try {
		const result = await ctx.session.turnUndo.undo();
		await ctx.renderInitialMessages({ clearTerminalHistory: true });
		await ctx.reloadTodos();
		if (result.editorText) ctx.editor.setDraft(result.editorText, result.editorImages);
		const caveat = result.filesUnavailable
			? "; no file snapshot was recorded for that prompt, so the files are unchanged"
			: "";
		ctx.showStatus(`Undid the last turn${filesNote(result.files)}${caveat} (/redo brings it back)`);
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/redo`: return to the conversation tip and files the last `/undo` left. */
export async function runRedoCommand(ctx: InteractiveModeContext): Promise<void> {
	try {
		const result = await ctx.session.turnUndo.redo();
		await ctx.renderInitialMessages({ clearTerminalHistory: true });
		await ctx.reloadTodos();
		// The prompt the undo handed back is part of the conversation again; drop it unless it was edited.
		if (result.staleDraft !== undefined && ctx.editor.getText() === result.staleDraft) ctx.editor.setText("");
		const more = result.redoDepth > 0 ? `; ${result.redoDepth} more can be redone` : "";
		ctx.showStatus(`Redid the turn${filesNote(result.files)}${more}`);
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
