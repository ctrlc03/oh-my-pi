/**
 * Drag and drop into the message box. Two things can be dropped on a conversation: files from the operating system
 * (attached exactly like pasted ones) and rows of the Explorer (turned into an `@path` mention). The two are told
 * apart by the types the drag carries, which is all a page can read before the drop: Explorer rows carry
 * `PATH_DRAG_MIME`, files from Finder carry `Files`.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { insertAtCaret } from "./voice";

/** The drag type Explorer rows carry; its payload is JSON `{ path, dir }` (see `parsePathDrag`). */
export const PATH_DRAG_MIME = "application/x-omp-path";

/** A file or folder of the repository, named relative to the session's working directory. */
export interface DraggedPath {
	path: string;
	dir: boolean;
}

/** What a drag holds: files from the operating system, or a repository path from the Explorer. */
export type DragKind = "files" | "path";

/** What the drag would drop; the path of an Explorer row wins when both are somehow present. null: nothing this app takes. */
export function dragKindOf(types: readonly string[]): DragKind | null {
	if (types.includes(PATH_DRAG_MIME)) return "path";
	if (types.includes("Files")) return "files";
	return null;
}

/** Marks `drag` as an Explorer row being dragged: copying it into the message box leaves the row where it is. */
export function setPathDrag(transfer: DataTransfer, drag: DraggedPath): void {
	transfer.setData(PATH_DRAG_MIME, JSON.stringify(drag));
	transfer.effectAllowed = "copy";
}

/** The path a drag carried, or null when the payload is not one (another page's drag cannot be told from ours by type alone). */
export function parsePathDrag(raw: string): DraggedPath | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const { path, dir } = value;
	if (typeof path !== "string" || path === "" || typeof dir !== "boolean") return null;
	return { path, dir };
}

/**
 * The text a mention of `path` takes in a prompt: `@path`, the form the agent's own `@` selector writes. The agent reads a
 * bare mention up to the next space and strips punctuation around it, so a path with a space, an `@`, or punctuation at an
 * end is quoted, with the quote the path does not contain.
 */
export function mentionOf(path: string): string {
	const bare = !/[\s@]/.test(path) && !/^[`"'([{<]/.test(path) && !/[)\]}>.,;:!?"'`]$/.test(path);
	if (bare) return `@${path}`;
	return path.includes('"') ? `@'${path}'` : `@"${path}"`;
}

/**
 * `draft` with the mention of `path` over `[start, end)`, set apart from the words around it and followed by a space
 * when it ends the draft so the next word does not run into it. Returns the new draft and where the caret goes.
 */
export function insertMention(
	draft: string,
	path: string,
	start: number,
	end: number,
): { text: string; caret: number } {
	const next = insertAtCaret(draft, mentionOf(path), start, end);
	if (next.caret < next.text.length) return next;
	return { text: `${next.text} `, caret: next.caret + 1 };
}

/**
 * The files of a drop and how many folders came with them. A folder dragged from Finder shows up as a file that cannot be
 * read, so it is told apart through its directory entry and left out. Must run inside the drop event: the transfer is
 * emptied once the event ends.
 */
export function droppedFiles(transfer: DataTransfer): { files: File[]; folders: number } {
	const files: File[] = [];
	let folders = 0;
	for (const item of Array.from(transfer.items)) {
		if (item.kind !== "file") continue;
		if (item.webkitGetAsEntry()?.isDirectory === true) {
			folders++;
			continue;
		}
		const file = item.getAsFile();
		if (file !== null) files.push(file);
	}
	return { files, folders };
}

/**
 * Stops the page from navigating to a file dropped anywhere that does not take it: left alone, the browser (and the
 * desktop app's window) replaces the whole app with the file. A drop zone that took the drag has already called
 * `preventDefault`, so it is left as it is; so is a file input, which takes drops natively.
 */
export function installDropGuard(target: Window): void {
	const guard = (event: DragEvent): void => {
		if (event.defaultPrevented || dragKindOf(event.dataTransfer?.types ?? []) !== "files") return;
		if (event.target instanceof HTMLInputElement && event.target.type === "file") return;
		event.preventDefault();
		// The pointer shows that nothing happens here.
		if (event.type === "dragover" && event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
	};
	target.addEventListener("dragover", guard);
	target.addEventListener("drop", guard);
}
