/**
 * One-step `/undo` and `/redo` of the last turn, conversation and files together.
 *
 * Undo is the rewind the host's own Esc Esc and `/branch` use (`navigateTree` to the last prompt,
 * which moves the leaf to the prompt's parent and keeps the old path as a branch) plus a restore of
 * the files from that prompt's snapshot when one exists. Each undo leaves a redo step behind: the
 * leaf it started from and the file restore point it replaced. Redo walks the leaf back to that
 * tip and returns the files to that point, newest undo first, so repeated undos unwind in reverse.
 *
 * The steps are valid only while the conversation still sits where the last undo left it: sending a
 * prompt, navigating elsewhere or switching sessions moves the leaf and drops them.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { AgentSession } from "./agent-session";
import type { FileRestorePoint, FileRestoreResult } from "./file-snapshots";
import { isTranscriptEntry } from "./session-context";

type TurnUndoSession = Pick<
	AgentSession,
	| "sessionManager"
	| "isBusyForSnapshot"
	| "isSessionTransitioning"
	| "canRestoreFiles"
	| "previewFileRestore"
	| "restoreFiles"
	| "fileRestorePoint"
	| "redoFileRestore"
	| "navigateTree"
>;

/** A refusal whose message is safe to show a user. */
export class TurnUndoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TurnUndoError";
	}
}

export interface TurnUndoResult {
	/** `/undo`: the prompt that was undone, for the editor. */
	editorText?: string;
	editorImages?: ImageContent[];
	/** `/redo`: the draft the matching undo put in the editor, so a caller can drop it if it is still there. */
	staleDraft?: string;
	/** The file restore that ran; absent when the files already matched or snapshots do not apply. */
	files?: FileRestoreResult;
	/** Snapshots apply to this session but none was recorded before that prompt, so only the conversation moved. */
	filesUnavailable?: true;
	/** How many more turns `/redo` can bring back. */
	redoDepth: number;
}

/** What `/redo` needs to put one undone turn back. */
interface UndoneTurn {
	sessionId: string;
	/** The leaf the undo started from: the tip of the undone path. */
	tipId: string;
	/** The leaf the undo left; the step is stale once the conversation is anywhere else. */
	leafAfter: string | null;
	/** What the undo put in the editor. */
	draft: string | undefined;
	/** Where the files were before the undo restored them; absent when it did not touch them. */
	files: FileRestorePoint | undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class TurnUndo {
	readonly #session: TurnUndoSession;
	readonly #undone: UndoneTurn[] = [];
	#running = false;

	constructor(session: TurnUndoSession) {
		this.#session = session;
	}

	/** How many undone turns `/redo` can still bring back; 0 once the conversation has moved on. */
	get redoDepth(): number {
		return this.#live().length;
	}

	/** The redo steps, dropped wholesale when the conversation is no longer where the newest undo left it. */
	#live(): UndoneTurn[] {
		const { sessionManager } = this.#session;
		const newest = this.#undone.at(-1);
		if (newest?.sessionId !== sessionManager.getSessionId() || newest.leafAfter !== sessionManager.getLeafId()) {
			this.#undone.length = 0;
		}
		return this.#undone;
	}

	/** Run one undo or redo at a time, and only while nothing else writes to the conversation or the files. */
	async #exclusive<T>(run: () => Promise<T>): Promise<T> {
		if (this.#running) throw new TurnUndoError("an undo or redo is already running");
		if (this.#session.isBusyForSnapshot || this.#session.isSessionTransitioning) {
			throw new TurnUndoError("wait for the current response, compaction, or command to finish");
		}
		this.#running = true;
		try {
			return await run();
		} finally {
			this.#running = false;
		}
	}

	/** Put the files back as they were before a file restore whose conversation half then failed. Best effort: that failure is being reported. */
	async #rollBackFiles(): Promise<void> {
		await this.#session.redoFileRestore().catch(() => undefined);
	}

	/**
	 * Rewind to before the newest prompt on the active path: the conversation moves to the prompt's
	 * parent (the old path stays as a branch), the files return to that prompt's snapshot, and the
	 * prompt comes back as the editor text. Nothing moves when any part is refused.
	 */
	undo(): Promise<TurnUndoResult> {
		return this.#exclusive(async () => {
			const { sessionManager } = this.#session;
			const redoSteps = this.#live();
			const tipId = sessionManager.getLeafId();
			const target = sessionManager
				.getBranch()
				.findLast(entry => isTranscriptEntry(entry) && isUserRequestEntry(entry));
			if (!target || tipId === null) throw new TurnUndoError("nothing to undo");

			let files: FileRestoreResult | undefined;
			let point: FileRestorePoint | undefined;
			let filesUnavailable = false;
			if (this.#session.canRestoreFiles) {
				const plan = await this.#session.previewFileRestore(target.id);
				if (!plan) {
					filesUnavailable = true;
				} else if (plan.revert + plan.remove + plan.recreate > 0) {
					try {
						files = await this.#session.restoreFiles(target.id);
					} catch (error) {
						throw new TurnUndoError(messageOf(error));
					}
					point = this.#session.fileRestorePoint;
				}
			}

			const navigation = await this.#session
				.navigateTree(target.id, { summarize: false })
				.catch(async (error: unknown) => {
					if (files) await this.#rollBackFiles();
					throw error;
				});
			if (navigation.cancelled) {
				if (files) await this.#rollBackFiles();
				throw new TurnUndoError("an extension cancelled the undo");
			}

			redoSteps.push({
				sessionId: sessionManager.getSessionId(),
				tipId,
				leafAfter: sessionManager.getLeafId(),
				draft: navigation.editorText,
				files: point,
			});
			return {
				editorText: navigation.editorText,
				editorImages: navigation.editorImages,
				files,
				filesUnavailable: filesUnavailable ? true : undefined,
				redoDepth: redoSteps.length,
			};
		});
	}

	/**
	 * Bring back the newest undone turn: the conversation returns to the tip the undo started from
	 * and the files to how they were before it. Refused when the files changed since the undo.
	 */
	redo(): Promise<TurnUndoResult> {
		return this.#exclusive(async () => {
			const redoSteps = this.#live();
			const step = redoSteps.at(-1);
			if (!step) throw new TurnUndoError("nothing to redo");

			let files: FileRestoreResult | undefined;
			if (step.files) {
				try {
					files = await this.#session.redoFileRestore(step.files);
				} catch (error) {
					throw new TurnUndoError(messageOf(error));
				}
			}

			const navigation = await this.#session
				.navigateTree(step.tipId, { summarize: false, landOnTarget: true })
				.catch(async (error: unknown) => {
					if (files) await this.#rollBackFiles();
					throw error;
				});
			if (navigation.cancelled) {
				if (files) await this.#rollBackFiles();
				throw new TurnUndoError("an extension cancelled the redo");
			}

			redoSteps.pop();
			return { staleDraft: step.draft, files, redoDepth: redoSteps.length };
		});
	}
}
