/**
 * Saving a file from the paired computer (or an image from the transcript) onto this device:
 * the chunks of a `file-download` are assembled into a Blob, which is then handed to the OS.
 */

import type { FileChunk } from "./companion";

/** Cancelling a download is not a failure; callers tell the two apart by this class. */
export class DownloadCancelled extends Error {
	constructor() {
		super("download cancelled");
		this.name = "DownloadCancelled";
	}
}

export interface DownloadProgress {
	/** Bytes assembled so far. */
	received: number;
	/** Size of the whole file. */
	total: number;
}

export interface DownloadOptions {
	onProgress?(progress: DownloadProgress): void;
	/** Aborting stops requesting chunks and rejects with {@link DownloadCancelled}. */
	signal?: AbortSignal;
}

function bytesFromBase64(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Request chunks one after another from offset 0 until the last, and join them. Sequential on purpose:
 * each frame is several MB and a phone connection gains nothing from several at once.
 * @throws {DownloadCancelled} the signal aborted.
 * @throws when a chunk is out of order or the file's size changes between chunks (it was edited meanwhile).
 */
export async function assembleChunks(
	fetchChunk: (offset: number) => Promise<FileChunk>,
	options: DownloadOptions = {},
): Promise<{ blob: Blob; name: string }> {
	const { onProgress, signal } = options;
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	let size: number | null = null;
	for (;;) {
		if (signal?.aborted) throw new DownloadCancelled();
		const chunk = await fetchChunk(offset);
		// Checked after the wait too: the request itself cannot be recalled, but its bytes are dropped.
		if (signal?.aborted) throw new DownloadCancelled();
		if (chunk.offset !== offset) throw new Error("the computer sent the file out of order");
		if (size !== null && chunk.size !== size) throw new Error("the file changed while downloading");
		size = chunk.size;
		const bytes = bytesFromBase64(chunk.data);
		// An empty chunk that is not the last would repeat the same request forever.
		if (bytes.length === 0 && !chunk.done) throw new Error("the computer sent an empty chunk");
		parts.push(bytes);
		offset += bytes.length;
		onProgress?.({ received: offset, total: size });
		if (chunk.done) {
			if (offset !== size) throw new Error("the file changed while downloading");
			return { blob: new Blob(parts, { type: chunk.mime }), name: chunk.name };
		}
	}
}

interface ShareNavigator {
	userAgent: string;
	platform?: string;
	maxTouchPoints?: number;
	canShare?(data: ShareData): boolean;
	share?(data: ShareData): Promise<void>;
}

/** iPhone, iPad (which reports itself as a Mac with a touch screen) or Android. */
function isMobile(nav: ShareNavigator): boolean {
	if (/iPhone|iPad|iPod|Android/.test(nav.userAgent)) return true;
	return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Whether `file` should go through the share sheet: only on phones and tablets, where it lets the user
 * pick Files or Photos; a desktop browser's `<a download>` is the better save there.
 */
export function shouldShare(nav: ShareNavigator, file: File): boolean {
	return isMobile(nav) && typeof nav.share === "function" && nav.canShare?.({ files: [file] }) === true;
}

/** How a blob reached the user; `cancelled` when they dismissed the share sheet. */
export type SaveResult = "shared" | "saved" | "cancelled";

/** Hand `blob` to the OS as `name`: the share sheet on mobile, an `<a download>` elsewhere. */
export async function saveBlob(blob: Blob, name: string): Promise<SaveResult> {
	const file = new File([blob], name, { type: blob.type });
	if (shouldShare(navigator, file)) {
		try {
			await navigator.share({ files: [file] });
			return "shared";
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
			// Share refused (no user gesture left after a long download, say): fall back to a plain download.
		}
	}
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	return "saved";
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/heic": "heic",
};

/** A Blob of an image whose bytes are base64, as transcript images carry them. */
export function imageBlob(image: { mimeType: string; data: string }): Blob {
	return new Blob([bytesFromBase64(image.data)], { type: image.mimeType });
}

/** `name` plus the extension of `mimeType` (png when unknown), for an image that has no file name. */
export function imageFileName(name: string, mimeType: string): string {
	return `${name}.${Object.hasOwn(IMAGE_EXTENSIONS, mimeType) ? IMAGE_EXTENSIONS[mimeType] : "png"}`;
}
