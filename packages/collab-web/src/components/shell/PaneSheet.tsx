import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiClass, parseAnsi } from "../../lib/ansi";
import type { CompanionClient, PaneCapture } from "../../lib/companion";
import { Sheet } from "./Sheet";
import "./pane.css";

/** How often the screen is captured while the sheet is open and the page is visible. */
const POLL_MS = 2_000;
/** Closer than this to the bottom counts as following the output. */
const PIN_SLACK_PX = 24;

export interface PaneSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose terminal is shown. */
	instanceId: string;
	onClose(): void;
}

/** Read-only live view of the tmux pane a session runs in, refreshed every two seconds while visible. */
export function PaneSheet({ client, instanceId, onClose }: PaneSheetProps): ReactNode {
	const [pane, setPane] = useState<PaneCapture | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const inFlight = useRef(false);
	const closed = useRef(false);

	const capture = useCallback(async (): Promise<void> => {
		if (inFlight.current) return;
		inFlight.current = true;
		setLoading(true);
		try {
			const next = await client.requestPane(instanceId);
			if (!closed.current) {
				setPane(next);
				setError(null);
			}
		} catch (err) {
			if (!closed.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			inFlight.current = false;
			if (!closed.current) setLoading(false);
		}
	}, [client, instanceId]);

	// The next capture is scheduled when the previous one ends, so a slow answer never piles requests up.
	useEffect(() => {
		closed.current = false;
		let timer: Timer | undefined;
		const tick = async (): Promise<void> => {
			if (document.visibilityState === "visible") await capture();
			if (!closed.current) timer = setTimeout(tick, POLL_MS);
		};
		const onVisible = (): void => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(timer);
			void tick();
		};
		void tick();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			closed.current = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [capture]);

	const spans = useMemo(() => (pane?.target ? parseAnsi(pane.text) : []), [pane]);
	const view = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	// Follow new output unless the reader scrolled up.
	useLayoutEffect(() => {
		const el = view.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [spans]);
	const onScroll = (): void => {
		const el = view.current;
		if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
	};

	return (
		<Sheet label="terminal" size="full" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Terminal
					{pane?.target && (
						<div className="sh-term-head-sub">
							tmux {pane.target} · {pane.cols}×{pane.rows}
						</div>
					)}
				</div>
				<span className="sh-file-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => void capture()}
						disabled={loading}
						aria-label="refresh terminal"
						title="refresh"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{error !== null && <div className="sh-connect-error">{error}</div>}
			{pane === null ? (
				error === null && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Reading the terminal…
					</div>
				)
			) : pane.target === null ? (
				<div className="sh-companion-empty">{pane.text}</div>
			) : (
				<>
					<div ref={view} className="sh-term-view" onScroll={onScroll}>
						<pre className="sh-term">
							{spans.map((span, i) => {
								const className = ansiClass(span);
								return className === "" ? (
									span.text
								) : (
									<span key={i} className={className}>
										{span.text}
									</span>
								);
							})}
						</pre>
					</div>
					<div className="sh-term-foot">Read-only · refreshes every 2 s while visible</div>
				</>
			)}
		</Sheet>
	);
}
