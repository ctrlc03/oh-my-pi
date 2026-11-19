/**
 * A file of the paired computer as a Blob, for the image and PDF viewers. The bytes come over the `file-download`
 * request (chunked, so no frame comes near the relay's cap) rather than the `file` request, which answers binary
 * files with metadata only. A file is fetched again only when its version changes: tabs shown again reuse the
 * bytes already here, up to a memory budget.
 */
import { useCallback, useEffect, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { DownloadProgress } from "../../lib/download";
import { assembleChunks, DownloadCancelled } from "../../lib/download";
import { ByteBudgetCache } from "../../lib/file-viewer";

/** Blobs kept for tabs that are not in front: a few images, or one large PDF. */
const CACHE_BYTES = 96 * 1024 * 1024;
const cache = new ByteBudgetCache<Blob>(CACHE_BYTES);

/** The file is over the viewer's size limit; the viewer offers the download instead. */
export class FileTooLargeError extends Error {
	constructor(
		readonly size: number,
		readonly limit: number,
	) {
		super("file is too large to show");
		this.name = "FileTooLargeError";
	}
}

/** The paired computer predates `file-download`, the only way to read a file's bytes. */
export class NoDownloadError extends Error {
	constructor() {
		super("this computer's companion cannot send files to the viewer: update it");
		this.name = "NoDownloadError";
	}
}

export interface FileBlobRequest {
	client: CompanionClient;
	/** Companion host of the session the path belongs to. */
	instanceId: string;
	/** Absolute, or relative to the session's working directory. */
	path: string;
	/** Identifies the content on disk (`FileContent.version`): a change fetches the file again. */
	version: string;
	/** Largest size accepted; larger files reject with {@link FileTooLargeError} before their bytes are asked for. */
	limit: number;
	/** The Blob's content type; the companion's own guess is used when absent. */
	mime?: string;
}

/**
 * Load the file's bytes.
 * @throws {FileTooLargeError} over `limit`.
 * @throws {NoDownloadError} the companion cannot serve files.
 * @throws {DownloadCancelled} the signal aborted.
 */
export async function loadFileBlob(
	request: FileBlobRequest,
	options: { signal?: AbortSignal; onProgress?(progress: DownloadProgress): void } = {},
): Promise<Blob> {
	const { client, instanceId, path, version, limit, mime } = request;
	if (!client.getSnapshot().canDownload) throw new NoDownloadError();
	const key = `${instanceId}\0${path}\0${version}\0${mime ?? ""}`;
	const kept = cache.get(key);
	if (kept !== undefined) return kept;
	const { blob } = await assembleChunks(
		async offset => {
			const chunk = await client.requestFileChunk(instanceId, path, offset);
			// The size is known from the first chunk: a file over the limit is refused before the rest is asked for.
			if (chunk.size > limit) throw new FileTooLargeError(chunk.size, limit);
			return chunk;
		},
		{ signal: options.signal, onProgress: options.onProgress },
	);
	const typed = mime === undefined || blob.type === mime ? blob : new Blob([blob], { type: mime });
	cache.set(key, typed, typed.size);
	return typed;
}

export type FileBlobState =
	| { status: "loading"; progress: DownloadProgress | null }
	| { status: "ready"; blob: Blob }
	| { status: "error"; error: Error };

/** The file as a Blob for as long as the caller shows it; reloads when the path or version changes. */
export function useFileBlob(request: FileBlobRequest): FileBlobState & { reload(): void } {
	const { client, instanceId, path, version, limit, mime } = request;
	const [state, setState] = useState<FileBlobState>({ status: "loading", progress: null });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setState({ status: "loading", progress: null });
		loadFileBlob(
			{ client, instanceId, path, version, limit, mime },
			{
				signal: controller.signal,
				onProgress: progress => setState({ status: "loading", progress }),
			},
		).then(
			blob => {
				if (!controller.signal.aborted) setState({ status: "ready", blob });
			},
			(err: unknown) => {
				if (controller.signal.aborted || err instanceof DownloadCancelled) return;
				setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
			},
		);
		return () => controller.abort();
	}, [client, instanceId, path, version, limit, mime, attempt]);
	const reload = useCallback(() => setAttempt(n => n + 1), []);
	return { ...state, reload };
}

/** An object URL for `blob`, revoked when the blob changes or the caller goes away. Null while there is no blob. */
export function useObjectUrl(blob: Blob | null): string | null {
	const [url, setUrl] = useState<string | null>(null);
	// Made in an effect, not a memo: a strict-mode remount runs the cleanup (the revoke) and must make a new URL.
	useEffect(() => {
		if (blob === null) {
			setUrl(null);
			return;
		}
		const made = URL.createObjectURL(blob);
		setUrl(made);
		return () => URL.revokeObjectURL(made);
	}, [blob]);
	return url;
}
