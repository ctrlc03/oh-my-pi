import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import type { CompanionClient, FileContent } from "../../lib/companion";
import { fmtBytes } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";

export interface FileSheetProps {
	client: CompanionClient;
	/** Companion host of the session the path belongs to. */
	instanceId: string;
	/** Absolute, or relative to the session's working directory. */
	path: string;
	onClose(): void;
}

/** Read-only view of one file on the paired computer. */
export function FileSheet({ client, instanceId, path, onClose }: FileSheetProps): ReactNode {
	const load = useCallback(() => client.requestFile(instanceId, path), [client, instanceId, path]);
	const { state, reload } = useRequest(load);
	const shown = state.status === "ready" ? state.value.path : path;
	return (
		<Sheet label="file" wide onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title sh-file-path" title={shown}>
					{shown}
				</div>
				<span className="sh-file-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={state.status === "loading"}
						aria-label="reload file"
						title="reload"
					>
						<RefreshCw size={15} className={state.status === "loading" ? "sh-spin" : undefined} />
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			)}
			{state.status === "error" && <div className="sh-connect-error">{state.message}</div>}
			{state.status === "ready" && <FileBody file={state.value} />}
		</Sheet>
	);
}

function FileBody({ file }: { file: FileContent }): ReactNode {
	const lines = useMemo(() => (file.text === null ? [] : file.text.replace(/\n$/, "").split("\n")), [file.text]);
	// One gutter column of numbers beside one text block: both are `pre` with the
	// same line height, so rows line up without a DOM node per line.
	const gutter = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);
	return (
		<>
			<div className="sh-file-meta">
				<span>{fmtBytes(file.size)}</span>
				{file.text !== null && (
					<span>
						{lines.length} line{lines.length === 1 ? "" : "s"}
					</span>
				)}
			</div>
			{file.truncated && (
				<div className="sh-file-note">Showing the start of the file only: it is larger than the viewer reads.</div>
			)}
			{file.text === null ? (
				<div className="sh-file-note">Binary file, not shown.</div>
			) : file.text.length === 0 ? (
				<div className="sh-file-note">Empty file.</div>
			) : (
				<div className="sh-file-view">
					<pre className="sh-file-gutter" aria-hidden>
						{gutter}
					</pre>
					<pre className="sh-file-text">{file.text}</pre>
				</div>
			)}
		</>
	);
}
