import type { InspectInjected, InspectInjectedKind, InspectRow, SessionCommand } from "@oh-my-pi/pi-wire";
import {
	Archive,
	ArrowLeft,
	Brain,
	Check,
	ChevronRight,
	CircleHelp,
	Copy,
	Eye,
	Lightbulb,
	ListChecks,
	LoaderCircle,
	MessageSquare,
	RefreshCw,
	ScrollText,
	ShieldCheck,
	SlidersHorizontal,
	StickyNote,
	Webhook,
	Wrench,
	X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InspectInfo, RequestPreviewInfo } from "../../lib/client";
import { fmtBytes, fmtCost, fmtDuration, fmtPercent, fmtTokens } from "../../lib/format";
import { copyText } from "../../lib/share";
import { cacheFraction, decodeMs, shortModel, slowestMs, summarize, timingBar } from "../../lib/timeline";
import { Sheet } from "./Sheet";
import "./timeline.css";

/** A reply that never comes (a host that dropped the command) stops the spinner after this long. */
const PENDING_TIMEOUT_MS = 12_000;
/** Excerpts longer than this start clipped, with a toggle. */
const CLIP_CHARS = 280;

const KIND_ICON: Record<InspectInjectedKind, LucideIcon> = {
	prompt: MessageSquare,
	"tool-results": Wrench,
	"system-prompt": ScrollText,
	"context-notes": StickyNote,
	todo: ListChecks,
	verify: ShieldCheck,
	hook: Webhook,
	memory: Brain,
	advisor: Lightbulb,
	mode: SlidersHorizontal,
	compaction: Archive,
	other: CircleHelp,
};

function kindIcon(kind: InspectInjectedKind): LucideIcon {
	return Object.hasOwn(KIND_ICON, kind) ? KIND_ICON[kind] : CircleHelp;
}

export interface TimelineSheetProps {
	/** Latest timeline from the host; null until the first reply. */
	info: InspectInfo | null;
	/** Latest request preview from the host; null until one arrives. */
	preview: RequestPreviewInfo | null;
	/** Id of the newest notice: a host refusal (`error` frame) shows up as a new one and ends the wait. */
	noticeId: number;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	onClose(): void;
}

/** True from `start()` until `reply` or `noticeId` changes (a reply, or a refusal that shows up as a notice) or the timeout passes. */
function usePending(reply: unknown, noticeId: number): { pending: boolean; start(): void } {
	const [pending, setPending] = useState(false);
	useEffect(() => setPending(false), [reply, noticeId]);
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => setPending(false), PENDING_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [pending]);
	const start = useCallback(() => setPending(true), []);
	return { pending, start };
}

function Injected({ item }: { item: InspectInjected }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const Icon = kindIcon(item.kind);
	const long = item.text !== undefined && item.text.length > CLIP_CHARS;
	return (
		<li className="tv-injected">
			<span className="tv-injected-head">
				<Icon size={14} aria-hidden />
				<span className="tv-injected-label">{item.label}</span>
				<span className="tv-injected-tokens sh-sheet-faint">~{fmtTokens(item.tokens)} tok</span>
			</span>
			{item.text !== undefined && item.text.length > 0 && (
				<>
					<pre className={long && !expanded ? "tv-excerpt tv-excerpt-clipped" : "tv-excerpt"}>{item.text}</pre>
					{long && (
						<button type="button" className="tv-more" onClick={() => setExpanded(!expanded)}>
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
				</>
			)}
		</li>
	);
}

function RequestRow({ row, slowest }: { row: InspectRow; slowest: number }): ReactNode {
	const [open, setOpen] = useState(false);
	const bar = timingBar(row, slowest);
	const decode = decodeMs(row);
	const cache = cacheFraction(row);
	const failed = row.error !== undefined || row.stopReason === "error";
	const timing =
		row.durationMs === undefined
			? "no timing reported"
			: `waited ${row.ttftMs === undefined ? "?" : fmtDuration(row.ttftMs)} for the first token, ` +
				`${decode === null ? "?" : fmtDuration(decode)} streaming, ${fmtDuration(row.durationMs)} total`;
	return (
		<li className={failed ? "tv-row tv-row-error" : "tv-row"}>
			<button type="button" className="tv-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="tv-seq">#{row.seq}</span>
				<span className="tv-model" title={row.model}>
					{shortModel(row.model)}
				</span>
				<span className="tv-time sh-sheet-faint">
					{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
				</span>
				<span className={failed ? "tv-stop tv-stop-error" : "tv-stop"}>{row.stopReason}</span>
				<span className="tv-timing" title={timing}>
					<span className="tv-track">
						{bar !== null && (
							<>
								<span className="tv-wait" style={{ width: `${bar.wait * 100}%` }} />
								<span className="tv-decode" style={{ width: `${bar.decode * 100}%` }} />
							</>
						)}
					</span>
					<span className="tv-dur">
						{row.ttftMs === undefined ? "—" : fmtDuration(row.ttftMs)}
						<span className="sh-sheet-faint">
							{" "}
							/ {row.durationMs === undefined ? "—" : fmtDuration(row.durationMs)}
						</span>
					</span>
				</span>
				<span className="tv-tokens">
					{fmtTokens(row.input + row.cacheRead + row.cacheWrite)} in · {fmtTokens(row.output)} out
				</span>
				<span
					className="tv-cache"
					title={`${fmtTokens(row.cacheRead)} read from cache, ${fmtTokens(row.cacheWrite)} written, ${fmtTokens(row.input)} uncached`}
				>
					<span className="tv-cache-track">
						<span className="tv-cache-fill" style={{ width: `${(cache ?? 0) * 100}%` }} />
					</span>
					<span>{cache === null ? "—" : fmtPercent(cache * 100)}</span>
				</span>
				<span className="tv-cost">{fmtCost(row.cost)}</span>
				<ChevronRight size={16} className={open ? "tv-chev tv-chev-open" : "tv-chev"} aria-hidden />
			</button>
			{open && (
				<div className="tv-detail">
					{row.error !== undefined && <div className="tv-error">{row.error}</div>}
					{row.injected.length > 0 ? (
						<>
							<div className="tv-detail-title sh-sheet-faint">Entered the context since the request before</div>
							<ul className="tv-injected-list">
								{row.injected.map((item, index) => (
									<Injected key={`${item.kind}:${index}`} item={item} />
								))}
							</ul>
						</>
					) : (
						row.error === undefined && <div className="sh-sheet-faint">Nothing new entered the context.</div>
					)}
				</div>
			)}
		</li>
	);
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="tv-stat">
			<span className="tv-stat-value">{value}</span>
			<span className="tv-stat-label sh-sheet-faint">{label}</span>
		</div>
	);
}

function PreviewView({ info, pending }: { info: RequestPreviewInfo | null; pending: boolean }): ReactNode {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	if (pending) {
		return (
			<div className="tv-empty sh-sheet-faint">
				<LoaderCircle size={14} className="tv-spin" aria-hidden /> Building the request…
			</div>
		);
	}
	if (info === null) {
		return (
			<div className="tv-empty sh-sheet-faint">The host sent no preview. It may have refused: see the notices.</div>
		);
	}
	const { preview } = info;
	const copy = (): void => {
		void copyText(preview.text).then(ok => {
			if (!ok) return;
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<>
			<div className="tv-preview-meta">
				<span
					className={preview.source === "request" ? "tv-source tv-source-request" : "tv-source tv-source-context"}
				>
					{preview.source === "request" ? "provider request" : "context only"}
				</span>
				<span className="tv-mono" title={preview.model}>
					{shortModel(preview.model)}
				</span>
				<span className="sh-sheet-faint">
					{preview.messages} message{preview.messages === 1 ? "" : "s"} · {preview.tools} tool
					{preview.tools === 1 ? "" : "s"} · ~{fmtTokens(preview.tokens)} tok · {fmtBytes(preview.text.length)}
				</span>
			</div>
			{preview.note !== undefined && <div className="tv-note">{preview.note}</div>}
			{preview.truncated && (
				<div className="tv-note tv-note-warn">Truncated: the host cut the request at its size cap.</div>
			)}
			<div className="tv-preview-actions">
				<button type="button" className="sh-btn" onClick={copy}>
					{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
				</button>
			</div>
			<pre className="tv-json">{preview.text}</pre>
		</>
	);
}

/**
 * Every model request of the session, newest first: when it ran, how long it waited for the first token versus
 * streamed, its tokens and cache share and cost, and what entered the context since the request before.
 * Asks the host for the list when opened. A second view previews the request the next turn would send.
 */
export function TimelineSheet({ info, preview, noticeId, onSessionCommand, onClose }: TimelineSheetProps): ReactNode {
	const [view, setView] = useState<"requests" | "preview">("requests");
	// A reply or a refusal (a new notice) ends each wait.
	const listing = usePending(info, noticeId);
	const previewing = usePending(preview, noticeId);

	const refresh = (): void => {
		listing.start();
		onSessionCommand("inspect");
	};
	const showPreview = (): void => {
		setView("preview");
		previewing.start();
		onSessionCommand("preview-request");
	};
	const startListing = listing.start;
	useEffect(() => {
		startListing();
		onSessionCommand("inspect");
	}, [startListing, onSessionCommand]);

	const rows = info?.rows ?? [];
	const summary = summarize(rows);
	const slowest = slowestMs(rows);
	const newest = rows.toReversed();
	const cut = info !== null && info.total > rows.length;

	return (
		<Sheet
			label="timeline"
			size="wide"
			onClose={() => {
				if (view === "preview") setView("requests");
				else onClose();
			}}
		>
			<div className="sh-sheet-head">
				{view === "preview" && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setView("requests")}
						aria-label="back to the timeline"
					>
						<ArrowLeft size={16} />
					</button>
				)}
				<div className="sh-sheet-title">{view === "preview" ? "Next request" : "Timeline"}</div>
				<span className="sh-sheet-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={view === "preview" ? showPreview : refresh}
						disabled={view === "preview" ? previewing.pending : listing.pending}
						aria-label="refresh"
						title="Refresh"
					>
						<RefreshCw
							size={16}
							className={(view === "preview" ? previewing.pending : listing.pending) ? "tv-spin" : undefined}
						/>
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{view === "preview" ? (
				<PreviewView info={preview} pending={previewing.pending} />
			) : (
				<>
					<div className="tv-summary">
						<Stat label="requests" value={String(info?.total ?? 0)} />
						<Stat label="cost" value={fmtCost(summary.cost)} />
						<Stat label="tokens" value={fmtTokens(summary.tokens)} />
						<Stat
							label="median TTFT"
							value={summary.medianTtftMs === null ? "—" : fmtDuration(summary.medianTtftMs)}
						/>
						<Stat
							label="cache"
							value={summary.cacheFraction === null ? "—" : fmtPercent(summary.cacheFraction * 100)}
						/>
					</div>
					<div className="tv-toolbar">
						<button type="button" className="sh-btn" onClick={showPreview}>
							<Eye size={14} /> Preview next request
						</button>
						<span className="tv-legend sh-sheet-faint" aria-hidden>
							<span className="tv-swatch tv-wait" /> waiting
							<span className="tv-swatch tv-decode" /> streaming
						</span>
					</div>
					{info === null ? (
						<div className="tv-empty sh-sheet-faint">
							{listing.pending ? (
								<>
									<LoaderCircle size={14} className="tv-spin" aria-hidden /> Asking the host…
								</>
							) : (
								"The host sent no timeline. It may have refused: see the notices."
							)}
						</div>
					) : rows.length === 0 ? (
						<div className="tv-empty sh-sheet-faint">No model requests yet.</div>
					) : (
						<>
							{cut && (
								<div className="tv-note">
									Showing the newest {rows.length} of {info.total} requests.
								</div>
							)}
							<ol className="tv-list">
								{newest.map(row => (
									<RequestRow key={row.entryId} row={row} slowest={slowest} />
								))}
							</ol>
						</>
					)}
				</>
			)}
		</Sheet>
	);
}
