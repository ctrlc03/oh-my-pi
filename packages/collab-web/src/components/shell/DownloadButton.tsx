import { Download, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { DownloadProgress } from "../../lib/download";
import { assembleChunks, DownloadCancelled, saveBlob } from "../../lib/download";
import "./download.css";

/** Whether the paired companion serves files for download; false from companions that predate it. */
export function useCanDownload(client: CompanionClient): boolean {
	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const getSnapshot = useCallback(() => client.getSnapshot().canDownload, [client]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface DownloadButtonProps {
	client: CompanionClient;
	/** Companion host of the session the path belongs to. */
	instanceId: string;
	/** Absolute, or relative to the session's working directory. */
	path: string;
	/** Text beside the icon; omitted, the button is icon-only. */
	label?: string;
}

/**
 * Saves a file of the session's repository onto this device. The bytes come from disk as they are now,
 * not from an editor buffer. Chunks arrive one by one with progress, and the download can be cancelled.
 * Renders nothing when the companion cannot serve files.
 */
export function DownloadButton({ client, instanceId, path, label }: DownloadButtonProps): ReactNode {
	const canDownload = useCanDownload(client);
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<DownloadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);

	// A download of a file the sheet no longer shows has no one to save it for.
	useEffect(() => () => abort.current?.abort(), []);

	const start = async (): Promise<void> => {
		const controller = new AbortController();
		abort.current = controller;
		setRunning(true);
		setProgress(null);
		setError(null);
		try {
			const { blob, name } = await assembleChunks(offset => client.requestFileChunk(instanceId, path, offset), {
				signal: controller.signal,
				onProgress: setProgress,
			});
			await saveBlob(blob, name);
		} catch (err) {
			if (!(err instanceof DownloadCancelled)) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (abort.current === controller) abort.current = null;
			setRunning(false);
			setProgress(null);
		}
	};

	if (!canDownload) return null;
	const percent =
		progress !== null && progress.received < progress.total
			? Math.floor((progress.received / progress.total) * 100)
			: null;
	return (
		<span className="sh-download">
			<button
				type="button"
				className={label === undefined ? "sh-btn sh-btn-icon" : "sh-btn"}
				onClick={() => void start()}
				disabled={running}
				aria-label={label === undefined ? "Download file" : undefined}
				title="Download the file as saved on the computer"
			>
				{running ? <LoaderCircle size={15} className="sh-spin" /> : <Download size={15} />}
				{label !== undefined && <span>{label}</span>}
			</button>
			{running && (
				<>
					{percent !== null && <span className="sh-download-pct">{percent}%</span>}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => abort.current?.abort()}
						aria-label="Cancel download"
						title="Cancel"
					>
						<X size={14} />
					</button>
				</>
			)}
			{error !== null && (
				<span className="sh-download-err" role="alert" title={error}>
					{error}
				</span>
			)}
		</span>
	);
}
