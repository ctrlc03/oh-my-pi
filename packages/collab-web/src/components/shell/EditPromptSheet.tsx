import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";
import { type ReactNode, type RefObject, useCallback, useEffect, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { describeFilePlan } from "../../lib/file-restore";
import { isPrompt } from "../../lib/trim";
import type { ComposerHandle } from "./Composer";
import { Sheet } from "./Sheet";

/** A rewind the host was asked for; the prompt moves into the composer once the transcript drops it. */
interface PendingEdit {
	entryId: string;
	text: string;
	images: ImageContent[];
	/** Newest notice at send time: an error notice after it is the host refusing the rewind. */
	noticeFloor: number;
}

function promptContent(entry: SessionEntry): string | (TextContent | ImageContent)[] {
	if (entry.type === "custom_message") return entry.content;
	return entry.type === "message" && entry.message.role === "user" ? entry.message.content : "";
}

/**
 * Editing a prompt rewinds the session to just before it, so the prompt and
 * everything after it leave the conversation. The host answers with a `branch`
 * frame; only when the entry is gone from the replica is the prompt handed to
 * the composer, so the draft never shows up for a rewind the host refused.
 * `onEditPrompt` is undefined whenever a rewind cannot run.
 */
export function useEditPrompt(
	client: GuestClient,
	snap: GuestSnapshot,
	composerRef: RefObject<ComposerHandle | null>,
): { onEditPrompt: ((entryId: string) => void) | undefined; sheet: ReactNode } {
	const [confirming, setConfirming] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingEdit | null>(null);
	const [restoreFiles, setRestoreFiles] = useState(true);
	const { entries, notices, working } = snap;
	const allowed = snap.features.rewind === true && !snap.readOnly && !working && snap.phase === "live";
	const filesAvailable = snap.features["rewind-files"] === true;

	useEffect(() => {
		if (!allowed) setConfirming(null);
	}, [allowed]);

	useEffect(() => {
		if (allowed && filesAvailable && confirming !== null) client.sendSessionCommand("rewind-preview", confirming);
	}, [allowed, filesAvailable, confirming, client]);

	useEffect(() => {
		if (pending === null) return;
		if (!entries.some(entry => entry.id === pending.entryId)) {
			setPending(null);
			composerRef.current?.replace(pending.text, pending.images);
		} else if (working || notices.some(notice => notice.id > pending.noticeFloor && notice.level === "error")) {
			// A turn started or the host said no while the prompt is still on the transcript: nothing was rewound.
			setPending(null);
		}
	}, [pending, entries, notices, working, composerRef]);

	const edit = useCallback((entryId: string) => setConfirming(entryId), []);
	const close = useCallback(() => setConfirming(null), []);

	const preview = snap.rewindPreview?.entryId === confirming ? snap.rewindPreview.files : undefined;
	const restorable =
		preview !== undefined && preview !== null && preview.revert + preview.remove + preview.recreate > 0;
	const restoring = restorable && restoreFiles;
	const filesNote =
		preview === undefined
			? "Checking which files would change…"
			: preview === null
				? "No file snapshot was recorded before this prompt, so its files cannot be restored."
				: restorable
					? `Restoring puts ${describeFilePlan(preview)} back as they were before this prompt. You can undo the restore afterwards.`
					: "No files changed after this prompt.";

	const confirm = (): void => {
		const entry = entries.findLast(candidate => candidate.id === confirming);
		setConfirming(null);
		if (entry === undefined || !isPrompt(entry)) return;
		const content = promptContent(entry);
		const blocks = typeof content === "string" ? [] : content;
		setPending({
			entryId: entry.id,
			text:
				typeof content === "string"
					? content
					: blocks
							.filter((block): block is TextContent => block.type === "text")
							.map(block => block.text)
							.join("\n"),
			images: blocks.filter((block): block is ImageContent => block.type === "image"),
			noticeFloor: notices.at(-1)?.id ?? 0,
		});
		client.sendSessionCommand("rewind", entry.id, restoring);
	};

	const sheet =
		allowed && confirming !== null ? (
			<Sheet label="Edit this prompt" onClose={close}>
				<div className="sh-sheet-head">
					<div className="sh-sheet-title">Edit this prompt?</div>
				</div>
				<p className="sh-edit-prompt-note">
					The turns after this prompt leave the conversation; the session file keeps them as a branch. The prompt
					goes back into the message box, ready to change and send again.
				</p>
				{filesAvailable && (
					<>
						<label className="sh-review-draft">
							<input
								type="checkbox"
								checked={restoring}
								disabled={!restorable}
								onChange={e => setRestoreFiles(e.currentTarget.checked)}
							/>
							Also restore the files
						</label>
						<p className="sh-edit-prompt-note">{filesNote}</p>
					</>
				)}
				<div className="sh-edit-prompt-actions">
					<button type="button" className="sh-btn" onClick={close}>
						Cancel
					</button>
					<button type="button" className="sh-btn sh-btn-primary" onClick={confirm}>
						Edit prompt
					</button>
				</div>
			</Sheet>
		) : null;

	return { onEditPrompt: allowed ? edit : undefined, sheet };
}
