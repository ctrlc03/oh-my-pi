import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ArrowDown, ArrowUp, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { NewSince } from "../../lib/new-since";
import type { QueuedPrompt } from "../../lib/rooms";
import type { ToolRenderHost } from "../../tool-render";
import { buildChatItems, type ChatItem, type ChatToolCall } from "./chat-items";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Chat view: prompts and replies only, tool runs folded into one line each. */
	chat?: boolean;
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Find-in-session: highlight `query` and bring entry `target` into view. */
	search?: { query: string; target: string | null };
	/** Entries that arrived since the reader last left: the first gets a divider, a pill jumps to it. */
	newSince?: NewSince;
	/** The reader has reached the divider; the pill is gone, the divider stays. */
	newSeen?: boolean;
	onNewSeen?(): void;
	/** Reader is at the tail of a live, visible transcript: `entryId` is the newest entry they have seen. */
	onTail?(entryId: string): void;
	/** Prompts waiting for the connection, shown as pending bubbles at the end. */
	queued?: readonly QueuedPrompt[];
	onCancelQueued?(id: string): void;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function Row({
	kind,
	gutter,
	title,
	entryId,
	alsoEntries,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	/** Session entry this row renders; search scrolls to it. */
	entryId?: string;
	/** Further entries this row also renders (a folded tool run spans several). */
	alsoEntries?: readonly string[];
	children: ReactNode;
}): ReactNode {
	return (
		<div
			className={`tr-row tr-row--${kind}`}
			data-entry={entryId}
			data-entries={alsoEntries && alsoEntries.length > 1 ? alsoEntries.join(" ") : undefined}
		>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function NewDivider(): ReactNode {
	return (
		<div className="tr-divider tr-divider--new" data-new-divider>
			<span>New since you left</span>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, host }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter="host" title={entry.timestamp} entryId={entry.id}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp} entryId={entry.id}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row
						kind="user"
						gutter={<span className="tr-badge">{from}</span>}
						title={entry.timestamp}
						entryId={entry.id}
					>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp} entryId={entry.id}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

const MAX_RUN_NAMES = 3;

/**
 * A folded run of tool calls: one line ("ran 7 tools · bash, edit, read", or the
 * running call's intent) that expands to the normal cards.
 */
function ToolRun({
	calls,
	results,
	active,
	host,
}: {
	calls: readonly ChatToolCall[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const isRunning = (call: ChatToolCall): boolean => !results.has(call.id) && (active.has(call.id) || call.pending);
	const running = calls.findLast(isRunning);
	let failed = 0;
	const names: string[] = [];
	for (const call of calls) {
		if (results.get(call.id)?.isError) failed++;
		if (!names.includes(call.name)) names.push(call.name);
	}
	const shown =
		names.slice(0, MAX_RUN_NAMES).join(", ") +
		(names.length > MAX_RUN_NAMES ? ` +${names.length - MAX_RUN_NAMES}` : "");
	const intent = running ? (active.get(running.id)?.intent ?? running.intent) : undefined;
	return (
		<div className={`tr-run${running ? " tr-run--live" : ""}`}>
			<button type="button" className="tr-run-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
				<ChevronRight size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				{running ? (
					<span className="tr-run-label">
						<span className="tr-run-tool">{running.name}</span>
						{intent ? ` · ${intent}` : "…"}
					</span>
				) : (
					<span className="tr-run-label">
						ran {calls.length} tool{calls.length === 1 ? "" : "s"}
						<span className="tr-run-names"> · {shown}</span>
					</span>
				)}
				{failed > 0 && <span className="tr-run-failed">{failed} failed</span>}
			</button>
			{open &&
				calls.map(call => {
					const act = active.get(call.id);
					return (
						<ToolCard
							key={call.id}
							toolCallId={call.id}
							name={call.name}
							intent={call.intent ?? act?.intent}
							args={act?.args ?? call.args}
							result={results.get(call.id)}
							host={host}
							running={isRunning(call)}
							partialResult={act?.partialResult}
						/>
					);
				})}
		</div>
	);
}

function ChatRow({
	item,
	results,
	active,
	host,
}: {
	item: ChatItem;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
}): ReactNode {
	switch (item.kind) {
		case "entry":
			return <EntryRow entry={item.entry} results={results} active={active} host={host} />;
		case "text":
			return (
				<Row kind="assistant" gutter={item.lead ? "agent" : ""} entryId={item.entryId ?? undefined}>
					{item.pending ? <StreamingMarkdown text={item.text} /> : <Markdown text={item.text} />}
				</Row>
			);
		case "tools":
			return (
				<Row
					kind="assistant"
					gutter={item.lead ? "agent" : ""}
					entryId={item.entryId ?? undefined}
					alsoEntries={item.entryIds}
				>
					<ToolRun calls={item.calls} results={results} active={active} host={host} />
				</Row>
			);
		case "stop":
			return (
				<Row kind="assistant" gutter="">
					<div className="tr-stop">
						<span className={`tr-chip ${item.stopReason === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
							{item.stopReason}
						</span>
						{item.errorMessage && <span className="tr-stop-msg">{item.errorMessage}</span>}
					</div>
				</Row>
			);
	}
}

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

/**
 * Paint every visible occurrence of `query` with the CSS Custom Highlight API
 * (no DOM mutation, so React-owned and Markdown HTML stay untouched), the ones
 * inside `current` in a stronger tone. No-op where the API is missing.
 */
function paintSearch(root: HTMLElement, query: string, current: Element | null): void {
	const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
	if (!registry || typeof Highlight === "undefined") return;
	registry.delete("tr-search");
	registry.delete("tr-search-current");
	const needle = query.trim().toLowerCase();
	if (!needle) return;
	const others: Range[] = [];
	const inCurrent: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = (node.textContent ?? "").toLowerCase();
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			(current?.contains(node) ? inCurrent : others).push(range);
		}
	}
	registry.set("tr-search", new Highlight(...others));
	registry.set("tr-search-current", new Highlight(...inCurrent));
}

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		compact,
		chat,
		host,
		phase,
		search,
		newSince,
		newSeen,
		onNewSeen,
		onTail,
		queued,
		onCancelQueued,
	} = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/** Scrolled away from the tail: offers the jump-to-latest button. */
	const [away, setAway] = useState(false);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working, queued]);

	// A shrinking viewport (mobile keyboard, rotation, composer growth) keeps a
	// bottom-locked reader on the latest message instead of stranding them mid-scroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => followTranscriptTail(el, lockRef));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	const chatItems = useMemo(
		() => (chat ? buildChatItems(visible, stream, streamDone, tailTools) : null),
		[chat, visible, stream, streamDone, tailTools],
	);

	// Find-in-session: mount the target's window if it is above it, then center it
	// once per target (new entries repaint the highlights but never re-scroll).
	const searchable = search !== undefined;
	const searchQuery = search?.query ?? "";
	const searchTarget = search?.target ?? null;
	const scrolledToRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (el === null || !searchable) return;
		const row =
			searchTarget === null
				? null
				: el.querySelector(
						`[data-entry="${CSS.escape(searchTarget)}"], [data-entries~="${CSS.escape(searchTarget)}"]`,
					);
		if (searchTarget !== null && row === null) {
			const index = entries.findIndex(entry => entry.id === searchTarget);
			if (index >= 0 && index < start) {
				lockRef.current = false;
				setPinnedStart(index);
			}
		} else if (row !== null && scrolledToRef.current !== `${searchTarget}:${chat}`) {
			scrolledToRef.current = `${searchTarget}:${chat}`;
			row.scrollIntoView({ block: "center" });
			// A match near the tail stays tail-following; one above it holds the reader there.
			updateTranscriptTailLock(el, lockRef);
			setAway(!lockRef.current);
		}
		if (searchTarget === null) scrolledToRef.current = null;
		paintSearch(el, searchQuery, row);
	}, [searchable, searchQuery, searchTarget, start, chat, entries]);
	useEffect(() => {
		if (searchable) return () => paintSearch(document.body, "", null);
	}, [searchable]);

	const jumpToLatest = (): void => {
		const el = rootRef.current;
		if (el === null) return;
		setPinnedStart(null);
		setAway(false);
		followTranscriptTail(el, lockRef, true);
	};

	// "New since you left": the divider sits before the first new row that renders.
	// When that entry is above the mounted window, the divider waits for the window to reach it.
	const dividerAt = useMemo(() => {
		if (newSince === undefined) return -1;
		const at =
			chatItems !== null
				? chatItems.findIndex(item =>
						newSince.ids.has(item.kind === "entry" ? item.entry.id : (item.entryId ?? "")),
					)
				: visible.findIndex(entry => newSince.ids.has(entry.id));
		if (at === 0 && start > 0 && newSince.ids.has(entries[start - 1]?.id ?? "")) return -1;
		return at;
	}, [newSince, chatItems, visible, start, entries]);

	const dividerInView = (): boolean => {
		const el = rootRef.current;
		const divider = el?.querySelector("[data-new-divider]");
		if (!el || !divider) return false;
		const root = el.getBoundingClientRect();
		const rect = divider.getBoundingClientRect();
		return rect.bottom > root.top && rect.top < root.bottom;
	};
	const pillActive = newSince !== undefined && newSeen !== true;
	/** Set while waiting for the mounted window to reach an off-window divider. */
	const scrollToNewRef = useRef(false);
	const scrollToDivider = (el: HTMLElement): void => {
		el.querySelector("[data-new-divider]")?.scrollIntoView({ block: "start" });
		updateTranscriptTailLock(el, lockRef);
		setAway(!lockRef.current);
		onNewSeen?.();
	};
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (el === null || dividerAt < 0) return;
		if (scrollToNewRef.current) {
			scrollToNewRef.current = false;
			scrollToDivider(el);
		} else if (pillActive && dividerInView()) {
			onNewSeen?.();
		}
	}, [dividerAt, pillActive, onNewSeen, away, entries, chat]);

	const jumpToNew = (): void => {
		const el = rootRef.current;
		if (el === null || newSince === undefined) return;
		if (dividerAt >= 0) {
			scrollToDivider(el);
			return;
		}
		const index = entries.findIndex(entry => newSince.ids.has(entry.id));
		if (index < 0) return;
		lockRef.current = false;
		scrollToNewRef.current = true;
		setPinnedStart(index);
	};

	// The newest entry the reader has seen: only while they sit at the tail of a visible page.
	useEffect(() => {
		if (onTail === undefined || phase !== "live") return;
		const report = (): void => {
			const last = entries.at(-1);
			if (last !== undefined && lockRef.current && document.visibilityState === "visible") onTail(last.id);
		};
		report();
		document.addEventListener("visibilitychange", report);
		return () => document.removeEventListener("visibilitychange", report);
	}, [entries, phase, onTail, away]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";
	// Chat view hides thinking: say something until reply text or a tool shows up.
	const quietTurn =
		working &&
		activeTools.size === 0 &&
		(stream === null || (chat === true && !stream.content.some(b => b.type === "text" || b.type === "toolCall")));
	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
				if (away === lockRef.current) setAway(!lockRef.current);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
				if (pillActive && dividerInView()) onNewSeen?.();
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{pillActive && (
				<div className="tr-new-dock">
					<button type="button" className="tr-new-pill" onClick={jumpToNew}>
						<ArrowUp size={13} /> {newSince.count} new
					</button>
				</div>
			)}
			{chatItems !== null
				? chatItems.map((item, i) => (
						<Fragment key={item.key}>
							{i === dividerAt && <NewDivider />}
							<ChatRow item={item} results={results} active={activeTools} host={host} />
						</Fragment>
					))
				: visible.map((entry, i) => (
						<Fragment key={entry.id}>
							{i === dividerAt && <NewDivider />}
							<EntryRow entry={entry} results={results} active={activeTools} host={host} />
						</Fragment>
					))}
			{chatItems === null && stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{chatItems === null && tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{quietTurn && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
			{queued?.map(prompt => (
				<Row key={prompt.id} kind="user" gutter="queued">
					<div className="tr-queued">
						<div className="tr-queued-text">{prompt.text}</div>
						{prompt.images !== undefined && prompt.images.length > 0 && (
							<span className="tr-queued-meta">
								{prompt.images.length} image{prompt.images.length === 1 ? "" : "s"}
							</span>
						)}
						<button
							type="button"
							className="tr-queued-cancel"
							onClick={() => onCancelQueued?.(prompt.id)}
							aria-label="cancel queued prompt"
							title="cancel — not sent yet"
						>
							<X size={13} />
						</button>
					</div>
				</Row>
			))}
			{away && (
				<div className="tr-jump-dock">
					<button type="button" className="tr-jump" onClick={jumpToLatest}>
						<ArrowDown size={14} /> Latest
					</button>
				</div>
			)}
		</div>
	);
}
