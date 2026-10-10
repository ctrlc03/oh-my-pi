/**
 * Guest-driven file restore for the collab host: the file half of `session-cmd` `rewind`
 * (`restoreFiles`), `rewind-preview` and `redo-files`. The snapshots and the restore itself live in
 * `session/file-snapshots.ts`; this only validates the request, calls the session, and answers the
 * asking guest with targeted frames.
 */
import type { AgentSession } from "../session/agent-session";
import { describeFileRestore, FileSnapshotError, type FileRestoreResult } from "../session/file-snapshots";
import type { CollabFrame } from "./protocol";

/** What a `session-cmd` handler needs to run its file-restore half. */
export interface RewindFilesChannel {
	/** The guest asked for the files to be restored along with the conversation. */
	restoreFiles: boolean;
	/** Send a frame to the asking guest only. */
	reply(frame: CollabFrame): void;
}

type SessionFiles = Pick<
	AgentSession,
	"canRestoreFiles" | "canRedoFileRestore" | "previewFileRestore" | "restoreFiles" | "redoFileRestore"
>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function restoredFrame(kind: "restore" | "redo", result: FileRestoreResult, canRedo: boolean): CollabFrame {
	return { t: "files-restored", kind, plan: result.plan, skipped: result.skipped, canRedo };
}

/** `rewind-preview`: answer what restoring the files before prompt `entryId` would change. */
export async function previewRewindFiles(
	session: SessionFiles,
	entryId: string | undefined,
	channel: Pick<RewindFilesChannel, "reply">,
	fail: (message: string) => void,
): Promise<void> {
	if (entryId === undefined) {
		fail("no prompt given");
		return;
	}
	const files = session.canRestoreFiles ? await session.previewFileRestore(entryId) : undefined;
	channel.reply({ t: "rewind-preview", entryId, files: files ?? null });
}

/**
 * The file half of a rewind to before prompt `entryId`, run before the conversation moves so a
 * refusal leaves both untouched. Resolves the result, `undefined` when the guest did not ask for a
 * restore, or "failed" after reporting why (the caller must then not rewind).
 */
export async function restoreFilesForRewind(
	session: SessionFiles,
	entryId: string,
	channel: RewindFilesChannel,
	fail: (message: string) => void,
): Promise<FileRestoreResult | undefined | "failed"> {
	if (!channel.restoreFiles) return undefined;
	if (!session.canRestoreFiles) {
		fail("files cannot be restored here: this session is not in a git repository, or file snapshots are off");
		return "failed";
	}
	try {
		return await session.restoreFiles(entryId);
	} catch (error) {
		fail(error instanceof FileSnapshotError ? error.message : `file restore failed: ${message(error)}`);
		return "failed";
	}
}

/** Tell the guest the files were restored, once the conversation rewound too. */
export function announceRestoredFiles(
	session: SessionFiles,
	result: FileRestoreResult,
	channel: RewindFilesChannel,
): void {
	channel.reply(restoredFrame("restore", result, session.canRedoFileRestore));
}

/** Put the files back as they were before a failed rewind's restore. Best effort: the failure is already being reported. */
export async function rollBackRestoredFiles(session: SessionFiles): Promise<void> {
	await session.redoFileRestore().catch(() => undefined);
}

/** `redo-files`: undo the last file restore. Returns the notice text for the room, or undefined on refusal. */
export async function redoRestoredFiles(
	session: SessionFiles,
	channel: Pick<RewindFilesChannel, "reply">,
	fail: (message: string) => void,
): Promise<string | undefined> {
	if (!session.canRestoreFiles) {
		fail("files cannot be restored here: this session is not in a git repository, or file snapshots are off");
		return undefined;
	}
	try {
		const result = await session.redoFileRestore();
		channel.reply(restoredFrame("redo", result, session.canRedoFileRestore));
		return `undid the file restore (${describeFileRestore(result.plan)})`;
	} catch (error) {
		fail(error instanceof FileSnapshotError ? error.message : `undoing the file restore failed: ${message(error)}`);
		return undefined;
	}
}
