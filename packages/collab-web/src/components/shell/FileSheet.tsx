import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient, FileContent } from "../../lib/companion";
import { fmtBytes } from "../../lib/format";
import { HIGHLIGHT_MAX_CHARS, languageOf, loadHighlighter } from "../../lib/highlight";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";

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
		<Sheet label="file" size="wide" onClose={onClose}>
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
			{state.status === "ready" && <FileBody file={state.value} line={line} />}
		</Sheet>
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
