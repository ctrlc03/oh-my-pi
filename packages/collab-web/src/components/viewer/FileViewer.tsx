import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CompanionClient } from "../../lib/companion";
import { imageMime, viewerLimit } from "../../lib/file-viewer";
import { fmtBytes } from "../../lib/format";
import { DownloadButton, useCanDownload } from "../shell/DownloadButton";
import { FileTooLargeError, useFileBlob, useObjectUrl } from "./file-blob";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import "./viewer.css";

export interface FileViewerProps {
	client: CompanionClient;
	/** Companion host of the session the file belongs to. */
	instanceId: string;
	/** The path the companion is sent: absolute, or relative to the session's working directory. */
	path: string;
	/** The file's version on disk (`FileContent.version`); a new one loads the file again. */
	version: string;
	/** The file's size in bytes. */
	size: number;
	kind: "image" | "pdf";
}

/**
 * An image or a PDF of the paired computer. The bytes are fetched over `file-download` (see `file-blob.ts`), up to a
 * size limit; a file over it, or a companion that cannot send files, gets an explanation and the download button.
 */
export function FileViewer(props: FileViewerProps): ReactNode {
	const { client, instanceId, path, size, kind } = props;
	const canRead = useCanDownload(client);
	const limit = viewerLimit(kind)!;
	if (!canRead) {
		return (
			<div className="sh-file-note">
				This computer's companion cannot send files to the viewer: update it to see {kind === "pdf" ? "PDFs" : "images"} here.
			</div>
		);
	}
	if (size > limit) return <TooLarge client={client} instanceId={instanceId} path={path} size={size} limit={limit} />;
	return <LoadedFile {...props} limit={limit} />;
}

function TooLarge({
	client,
	instanceId,
	path,
	size,
	limit,
}: {
	client: CompanionClient;
	instanceId: string;
	path: string;
	size: number;
	limit: number;
}): ReactNode {
	return (
		<div className="sh-view-note">
			<div>
				This file is {fmtBytes(size)}; the viewer shows files up to {fmtBytes(limit)}.
			</div>
			<DownloadButton client={client} instanceId={instanceId} path={path} label="Download" />
		</div>
	);
}

function LoadedFile({ client, instanceId, path, version, size, kind, limit }: FileViewerProps & { limit: number }): ReactNode {
	const mime = kind === "pdf" ? "application/pdf" : (imageMime(path) ?? undefined);
	const state = useFileBlob({ client, instanceId, path, version, limit, mime });
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (state.status === "loading") {
		const percent =
			state.progress !== null && state.progress.total > 0
				? Math.floor((state.progress.received / state.progress.total) * 100)
				: null;
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading {fmtBytes(size)}
				{percent === null ? "…" : ` (${percent}%)`}
			</div>
		);
	}
	if (state.status === "error") {
		if (state.error instanceof FileTooLargeError)
			return (
				<TooLarge client={client} instanceId={instanceId} path={path} size={state.error.size} limit={state.error.limit} />
			);
		return (
			<div className="sh-view-note">
				<div className="sh-connect-error">{state.error.message}</div>
				<button type="button" className="sh-btn" onClick={state.reload}>
					Try again
				</button>
			</div>
		);
	}
	return kind === "pdf" ? (
		<PdfViewer blob={state.blob} name={name} />
	) : (
		<ImageBlob blob={state.blob} name={name} />
	);
}

function ImageBlob({ blob, name }: { blob: Blob; name: string }): ReactNode {
	const url = useObjectUrl(blob);
	if (url === null) return null;
	return <ImageViewer url={url} name={name} bytes={blob.size} vector={blob.type === "image/svg+xml"} />;
}
