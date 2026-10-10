/**
 * Files a paired device saves from the computer (`file-download` request): the file is served in
 * chunks, so no frame comes near the relay's size cap and a phone can show progress. Paths are
 * confined exactly like the file viewer and editor: inside the session's repository, symlinks
 * resolved. Reading changes nothing, so sandboxed sessions may be downloaded from too.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileChunk } from "../src/lib/companion";
import { checkPathText, repoScope, resolveInScope } from "./companion-git";

/** Raw bytes per frame; base64 makes it ~5.3 MB, far under the relay's 16 MB cap. */
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** Largest file a download may carry. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

const FALLBACK_MIME = "application/octet-stream";

const MIME_BY_EXTENSION: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".ts": "text/plain",
	".tsx": "text/plain",
	".csv": "text/csv",
	".xml": "application/xml",
	".yaml": "text/plain",
	".yml": "text/plain",
	".toml": "text/plain",
	".log": "text/plain",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".heic": "image/heic",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
};

/** Content type from the file name's extension; octet-stream when unknown. */
export function mimeOf(name: string): string {
	const mime = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
	return mime ?? FALLBACK_MIME;
}

/**
 * Bytes the chunk at `offset` of a `size`-byte file carries, and whether it is the last one.
 * @throws when `offset` is not a whole position inside the file (an empty file has only offset 0).
 */
export function chunkSpan(size: number, offset: number): { length: number; done: boolean } {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || (offset === size && size > 0))
		throw new Error("invalid offset");
	const length = Math.min(DOWNLOAD_CHUNK_BYTES, size - offset);
	return { length, done: offset + length >= size };
}

/**
 * The chunk of `input` (absolute, or relative to `cwd`) starting at `offset`.
 * @throws when the path leaves the session's repository, is not a regular file, or is over the size cap.
 */
export async function readFileChunk(cwd: string, input: string, offset: unknown): Promise<FileChunk> {
	checkPathText(input);
	if (typeof offset !== "number") throw new Error("invalid offset");
	const scope = await repoScope(cwd);
	const real = await resolveInScope(cwd, scope, input);
	if (real === null) throw new Error("file not found");
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new Error("not a regular file");
	if (stat.size > DOWNLOAD_MAX_BYTES) throw new Error("file is larger than 100 MB");
	const { length, done } = chunkSpan(stat.size, offset);
	const bytes = new Uint8Array(length);
	const handle = await fs.open(real, "r");
	let read = 0;
	try {
		while (read < length) {
			const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
	} finally {
		await handle.close();
	}
	// The file shrank between the stat and the read: refuse rather than send a silently short chunk.
	if (read !== length) throw new Error("file changed while downloading");
	const name = path.basename(real);
	return {
		name,
		size: stat.size,
		mime: mimeOf(name),
		offset,
		data: Buffer.from(bytes).toString("base64"),
		done,
	};
}
