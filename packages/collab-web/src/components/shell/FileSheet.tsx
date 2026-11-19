import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient, FileContent } from "../../lib/companion";
import type { PreviewMode } from "../../lib/file-viewer";
import { defaultPreviewMode, previewKind, viewerKind } from "../../lib/file-viewer";
import { fmtBytes } from "../../lib/format";
import { HIGHLIGHT_MAX_CHARS, languageOf, loadHighlighter } from "../../lib/highlight";
import { useRequest } from "../../lib/use-request";
import { baseName } from "../ide/file-tree";
import { FileViewer } from "../viewer/FileViewer";
import { MarkdownPreview } from "../viewer/MarkdownPreview";
import { PreviewModeToggle } from "../viewer/PreviewModeToggle";
import { SvgPreview } from "../viewer/SvgPreview";
import { DownloadButton } from "./DownloadButton";
import { Sheet, SheetPlacementButton } from "./Sheet";

export interface FileSheetProps {
	client: CompanionClient;
	/** Companion host of the session the path belongs to. */
	instanceId: string;
	/** Absolute, or relative to the session's working directory. */
	path: string;
	/** 1-based line to bring into view and highlight once the file is shown. */
	line?: number;
	onClose(): void;
}

/** Read-only view of one file on the paired computer. */
export function FileSheet({ client, instanceId, path, line, onClose }: FileSheetProps): ReactNode {
	const load = useCallback(() => client.requestFile(instanceId, path), [client, instanceId, path]);
	const { state, reload } = useRequest(load);
	const shown = state.status === "ready" ? state.value.path : path;
	return (
		<Sheet label="file" size="wide" pane="file" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title sh-file-path" title={shown}>
					{shown}
				</div>
				<span className="sh-file-actions">
					{state.status === "ready" && <DownloadButton client={client} instanceId={instanceId} path={path} />}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={state.status === "loading"}
						aria-label="Reload file"
						title="Reload"
					>
						<RefreshCw size={15} className={state.status === "loading" ? "sh-spin" : undefined} />
					</button>
					<SheetPlacementButton />
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
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
			{state.status === "ready" && (
				<FileContentView client={client} instanceId={instanceId} path={path} file={state.value} line={line} />
			)}
		</Sheet>
	);
}

/** The file sheet's switch has no Split: its body is one column. */
const SHEET_MODES: readonly PreviewMode[] = ["source", "preview"];

/**
 * What the sheet shows of a loaded file: an image or PDF in its viewer, Markdown and SVG as source or rendered, any
 * other file as its text. The editor (`IdeSheet`) does the same for the files it opens; this is the read-only route
 * a link takes when the app has no editor for the session.
 */
function FileContentView({
	client,
	instanceId,
	path,
	file,
	line,
}: {
	client: CompanionClient;
	instanceId: string;
	path: string;
	file: FileContent;
	line?: number;
}): ReactNode {
	const kind = viewerKind(path);
	const preview = previewKind(file.path);
	const [mode, setMode] = useState<PreviewMode>(() => (preview === null ? "source" : defaultPreviewMode(preview)));
	// A link names a file relative to the Markdown file's own path, and `path` is already in the form the companion reads.
	const toRequest = useCallback((resolved: string) => resolved, []);
	const wholeText = file.text !== null && !file.truncated;
	if (kind !== "text" && !(preview === "svg" && wholeText)) {
		return (
			<FileViewer
				client={client}
				instanceId={instanceId}
				path={path}
				version={file.version}
				size={file.size}
				kind={kind}
			/>
		);
	}
	if (preview === null || file.text === null || !wholeText) return <FileBody file={file} line={line} />;
	return (
		<>
			<div className="sh-view-bar">
				<PreviewModeToggle mode={mode} modes={SHEET_MODES} onChange={setMode} />
			</div>
			{mode === "preview" ? (
				preview === "svg" ? (
					<SvgPreview text={file.text} name={baseName(file.path)} />
				) : (
					<MarkdownPreview
						text={file.text}
						file={path}
						client={client}
						instanceId={instanceId}
						toRequest={toRequest}
					/>
				)
			) : (
				<FileBody file={file} line={line} />
			)}
		</>
	);
}

function FileBody({ file, line }: { file: FileContent; line?: number }): ReactNode {
	const lines = useMemo(() => (file.text === null ? [] : file.text.replace(/\n$/, "").split("\n")), [file.text]);
	// One gutter column of numbers beside one text block: both are `pre` with the
	// same line height, so rows line up without a DOM node per line.
	const gutter = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);
	// Plain text paints at once; the highlighted markup (tagged with the text it
	// was made from, so a stale result is never shown) swaps in when the grammar
	// chunk is ready. Same characters in the same font: no layout shift.
	const [highlighted, setHighlighted] = useState<{ source: string; html: string } | null>(null);
	useEffect(() => {
		const source = file.text;
		const language = languageOf(file.path);
		if (source === null || language === undefined || source.length > HIGHLIGHT_MAX_CHARS) return;
		let live = true;
		loadHighlighter().then(
			hljs => {
				if (live)
					setHighlighted({ source, html: hljs.highlight(source, { language, ignoreIllegals: true }).value });
			},
			// Offline or chunk missing: the file simply stays plain.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [file.text, file.path]);
	const view = useRef<HTMLDivElement>(null);
	const text = useRef<HTMLPreElement>(null);
	// Put the target line about a third of the way down the viewer.
	useLayoutEffect(() => {
		if (line === undefined || !view.current || !text.current) return;
		const style = getComputedStyle(text.current);
		const lineHeight = Number.parseFloat(style.lineHeight);
		const top = Number.parseFloat(style.paddingTop) + (line - 1) * lineHeight;
		view.current.scrollTop = top - view.current.clientHeight / 3;
	}, [file, line]);
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
				<div ref={view} className="sh-file-view">
					<pre className="sh-file-gutter" aria-hidden>
						{gutter}
					</pre>
					<pre ref={text} className="sh-file-text">
						{line !== undefined && (
							<span className="sh-file-hit" style={{ "--hit-line": line } as CSSProperties} aria-hidden />
						)}
						{highlighted !== null && highlighted.source === file.text ? (
							<code className="sh-file-code" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
						) : (
							<code className="sh-file-code">{file.text}</code>
						)}
					</pre>
				</div>
			)}
		</>
	);
}
