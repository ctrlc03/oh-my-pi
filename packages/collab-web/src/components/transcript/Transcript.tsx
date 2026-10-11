import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ArrowDown, ArrowUp, Check, ChevronRight, Copy, Pencil, Share2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { IS_MAC, shortcutFires } from "../../lib/shortcuts";
import { replyText, turnMarkdown, type TurnRange, turnRanges } from "../../lib/export";
import { buildBlocks, buildChatBlocks, replyId, toolResults } from "../../lib/blocks";
import { fmtTokens } from "../../lib/format";
import type { NewSince } from "../../lib/new-since";
import { answeredByOtherModel } from "../../lib/prompt-model";
import type { QueuedPrompt } from "../../lib/rooms";
import { copyText, shareText } from "../../lib/share";
import { focusedPane } from "../../lib/use-split";
import type { ToolRenderHost } from "../../tool-render";
import { useBlocks } from "./use-blocks";
import { buildChatItems, type ChatItem, type ChatToolCall } from "./chat-items";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { BlockShell, BlocksContext, useFlash } from "./Block";
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
	/** Rows of prompts offer an edit action that calls this with the prompt's entry id. */
	onEditPrompt?: (entryId: string) => void;
	/**
	 * Kept latest turns: entries before `from` stay unmounted, and the top of the
	 * transcript offers *Show all* instead of earlier rows.
	 */
	trimmed?: { from: number; hiddenTurns: number; onShowAll(): void };
	/** Id of the session's model: replies from any other model since its last change carry a note. */
	sessionModel?: string;
	/** Blocks offer *Send to agent*: this puts the quoted excerpt into the message box. */
	onSendToAgent?: (text: string) => void;
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

/**
 * The row to hold in place while earlier rows mount above the window: the first
 * entry row on screen. It skips the window's first row, which can remount under a
 * new key (in the chat view a folded tool run there absorbs the earlier calls and
 * grows upward), and anything outside the row flow, such as the sticky zero-height
 * "N new" dock, which keeps its place whatever mounts above and so would anchor nothing.
 */
function scrollAnchor(el: HTMLElement): { anchor: Element; entry: string | null; offset: number } | null {
	const top = el.getBoundingClientRect().top;
	const rows = Array.from(el.querySelectorAll(":scope > [data-entry]"));
	for (const row of rows.length > 1 ? rows.slice(1) : rows) {
		const rect = row.getBoundingClientRect();
		if (rect.bottom <= top) continue;
		return { anchor: row, entry: row.getAttribute("data-entry"), offset: rect.top - top };
	}
	return null;
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
	entryId,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	/** Entry the message is, which names its blocks; null while it streams and is not in the session yet. */
	entryId: string | null;
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
				if (!block.text.trim()) return null;
				return (
					<BlockShell key={i} id={entryId === null ? null : replyId(entryId, i)} kind="reply">
						{pending ? <StreamingMarkdown text={block.text} /> : <Markdown text={block.text} />}
					</BlockShell>
				);
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<BlockShell key={block.id} id={entryId === null ? null : block.id} kind="tool">
						<ToolCard
							toolCallId={block.id}
							name={block.name}
							intent={block.intent ?? act?.intent}
							args={args}
							result={result}
							host={host}
							running={!result && (act !== undefined || pending)}
							partialResult={act?.partialResult}
							framed
						/>
					</BlockShell>
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

function EditPrompt({ entryId, onEdit }: { entryId: string; onEdit: (entryId: string) => void }): ReactNode {
	return (
		<button
			type="button"
			className="tr-act tr-edit"
			onClick={() => onEdit(entryId)}
			aria-label="edit and resend"
			title="edit and resend"
		>
			<Pencil size={13} />
		</button>
	);
}

/** What the agent did in one turn, tallied for its action row. */
interface PlannedTurn extends TurnRange {
	/** The turn has an assistant message. */
	agent: boolean;
	/** Some assistant message carries reply text. */
	reply: boolean;
	/** The turn's last assistant message: the action row follows it in the full view. */
	endId: string | null;
}

/** Copy the reply or share the turn: quiet actions at the end of a finished agent turn. */
function TurnActions({ entries, turn }: { entries: readonly SessionEntry[]; turn: PlannedTurn }): ReactNode {
	const [done, flash] = useFlash();
	const slice = (): readonly SessionEntry[] => entries.slice(turn.from, turn.to);
	const copyReply = async (): Promise<void> => {
		if (await copyText(replyText(slice()))) flash("reply");
	};
	const share = async (): Promise<void> => {
		const turnEntries = slice();
		const title = replyText(turnEntries).split("\n", 1)[0]?.slice(0, 80) || "omp reply";
		if ((await shareText(title, turnMarkdown(turnEntries))) === "copied") flash("share");
	};
	return (
		<div className="tr-turn-actions">
			{turn.reply && (
				<button
					type="button"
					className="tr-turn-btn"
					data-copied={done === "reply" ? "" : undefined}
					onClick={() => void copyReply()}
				>
					{done === "reply" ? <Check size={12} /> : <Copy size={12} />}
					{done === "reply" ? "Copied" : "Copy reply"}
				</button>
			)}
			<button
				type="button"
				className="tr-turn-btn"
				data-copied={done === "share" ? "" : undefined}
				onClick={() => void share()}
			>
				{done === "share" ? <Check size={12} /> : <Share2 size={12} />}
				{done === "share" ? "Copied" : "Share"}
			</button>
		</div>
	);
}

/** Which model gave a reply when it was not the session's (a per-prompt choice or a fallback). */
function ModelNote({ model }: { model: string }): ReactNode {
	return <div className="tr-model">answered by {model}</div>;
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	onEdit?: (entryId: string) => void;
	/** Model id of a reply a model other than the session's gave. */
	answeredBy?: string;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (
		prev.entry !== next.entry ||
		prev.host !== next.host ||
		prev.onEdit !== next.onEdit ||
		prev.answeredBy !== next.answeredBy
	) {
		return false;
	}
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	host,
	onEdit,
	answeredBy,
}: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter="" entryId={entry.id}>
							<BlockShell
								id={entry.id}
								kind="prompt"
								label="host"
								title={entry.timestamp}
								extra={onEdit && !msg.synthetic && <EditPrompt entryId={entry.id} onEdit={onEdit} />}
							>
								<MsgContent content={msg.content} />
							</BlockShell>
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp} entryId={entry.id}>
							<AssistantBody
								message={msg}
								entryId={entry.id}
								results={results}
								active={active}
								pending={false}
								host={host}
							/>
							{answeredBy && <ModelNote model={answeredBy} />}
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
					<Row kind="user" gutter="" entryId={entry.id}>
						<BlockShell
							id={entry.id}
							kind="prompt"
							label={<span className="tr-badge">{from}</span>}
							title={entry.timestamp}
							extra={onEdit && <EditPrompt entryId={entry.id} onEdit={onEdit} />}
						>
							<MsgContent content={entry.content} />
						</BlockShell>
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
	onEdit,
	otherModels,
}: {
	item: ChatItem;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	onEdit?: (entryId: string) => void;
	/** Assistant entries a model other than the session's answered. */
	otherModels: ReadonlyMap<string, string>;
}): ReactNode {
	switch (item.kind) {
		case "entry":
			return (
				<EntryRow
					entry={item.entry}
					results={results}
					active={active}
					host={host}
					onEdit={onEdit}
					answeredBy={otherModels.get(item.entry.id)}
				/>
			);
		case "text": {
			const answeredBy = item.entryId === null ? undefined : otherModels.get(item.entryId);
			return (
				<Row kind="assistant" gutter={item.lead ? "agent" : ""} entryId={item.entryId ?? undefined}>
					<BlockShell id={item.entryId === null ? null : item.key} kind="reply">
						{item.pending ? <StreamingMarkdown text={item.text} /> : <Markdown text={item.text} />}
					</BlockShell>
					{answeredBy && <ModelNote model={answeredBy} />}
				</Row>
			);
		}
		case "tools":
			return (
				<Row
					kind="assistant"
					gutter={item.lead ? "agent" : ""}
					entryId={item.entryId ?? undefined}
					alsoEntries={item.entryIds}
				>
					<BlockShell id={item.entryId === null ? null : item.key} kind="run">
						<ToolRun calls={item.calls} results={results} active={active} host={host} />
					</BlockShell>
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
		onEditPrompt,
		trimmed,
		sessionModel,
		onSendToAgent,
	} = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	/** First entry that may mount: past the hidden turns when the transcript is trimmed. */
	const floor = trimmed?.from ?? 0;
	const tailStart = Math.max(floor, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.max(floor, Math.min(pinnedStart, tailStart));
	const visible = useMemo(() => entries.slice(start), [entries, start]);
	const otherModels = useMemo(() => answeredByOtherModel(entries, sessionModel), [entries, sessionModel]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => toolResults(visible), [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/** Scrolled away from the tail: offers the jump-to-latest button. */
	const [away, setAway] = useState(false);
	/**
	 * A row on screen and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries. `entry`
	 * finds the row again when it remounted under a new key.
	 */
	const prependRef = useRef<{ anchor: Element; entry: string | null; offset: number } | null>(null);
	/** Where the last scroll event left the view: tells the reader scrolling up from the tail being followed. */
	const lastTopRef = useRef(0);
	/**
	 * The scrollTop this component set while re-laying out the window. Its scroll
	 * event is not the reader's: right after earlier rows mount, a short tail window
	 * can leave the restored position within the lock distance of the bottom, and
	 * taking that for "back at the tail" trimmed the rows again, which put the view
	 * near the top and mounted them again, in a loop.
	 */
	const ownTopRef = useRef<number | null>(null);

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

	// Keep the reader's content in place when earlier rows mount above it, and on
	// the latest message when rows above are trimmed at the tail.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (el === null) return;
		const before = prependRef.current;
		prependRef.current = null;
		if (before !== null) {
			const anchor = before.anchor.isConnected
				? before.anchor
				: before.entry === null
					? null
					: el.querySelector(`[data-entry="${CSS.escape(before.entry)}"]`);
			if (anchor === null) return;
			el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
		} else if (lockRef.current) {
			el.scrollTop = el.scrollHeight;
		} else {
			return;
		}
		ownTopRef.current = el.scrollTop;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start <= floor || prependRef.current !== null) return;
		prependRef.current = scrollAnchor(el);
		// Reading back: new entries must not pull the view to the bottom, even when the
		// restored position lands within the lock distance of it.
		lockRef.current = false;
		setPinnedStart(Math.max(floor, start - WINDOW));
	};

	// Revealing hidden turns keeps the mounted rows: *show earlier* then takes over.
	const showAll = (): void => {
		lockRef.current = false;
		setPinnedStart(start);
		trimmed?.onShowAll();
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

	// Edit action: a stable callback so memoized rows re-render only when editing turns on or off.
	const editRef = useRef(onEditPrompt);
	editRef.current = onEditPrompt;
	const canEdit = onEditPrompt !== undefined && compact !== true;
	const onEdit = useMemo(() => (canEdit ? (entryId: string) => editRef.current?.(entryId) : undefined), [canEdit]);

	// The blocks the view renders, in order, for selecting and copying. Chat items are built here without
	// the live stream, so token updates do not churn the list.
	const blockItems = useMemo(() => (chat ? buildChatItems(visible, null, true, []) : null), [chat, visible]);
	const blocks = useMemo(
		() => (blockItems === null ? buildBlocks(visible, results) : buildChatBlocks(blockItems, results)),
		[blockItems, visible, results],
	);
	const blockUi = useBlocks({
		blocks,
		rootRef,
		active: activeTools,
		compact: compact === true,
		onSendToAgent,
		onEdit,
	});

	// Where each turn's agent work ends, for the copy/share row. Computed over all
	// entries, so a turn whose start is above the mounted window still copies whole.
	const turnPlan = useMemo(() => {
		const turns: PlannedTurn[] =
			compact === true
				? []
				: turnRanges(entries).map(range => ({ ...range, agent: false, reply: false, endId: null }));
		const byEntry: Record<string, number> = {};
		const endOf: Record<string, number> = {};
		turns.forEach((turn, t) => {
			for (let i = turn.from; i < turn.to; i++) {
				const entry = entries[i]!;
				byEntry[entry.id] = t;
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				turn.agent = true;
				turn.endId = entry.id;
				if (entry.message.content.some(block => block.type === "text" && block.text.trim())) turn.reply = true;
			}
			if (turn.endId !== null) endOf[turn.endId] = t;
		});
		return { turns, byEntry, endOf };
	}, [entries, compact]);
	/** In the chat view, the last agent item of each turn (item index → turn). */
	const chatTurnEnds = useMemo(() => {
		const lastItem: Record<number, number> = {};
		chatItems?.forEach((item, i) => {
			if (item.kind === "entry") return;
			const id = item.kind === "tools" ? (item.entryIds.at(-1) ?? item.entryId) : item.entryId;
			if (id !== null && Object.hasOwn(turnPlan.byEntry, id)) lastItem[turnPlan.byEntry[id]!] = i;
		});
		const ends: Record<number, number> = {};
		for (const [turn, i] of Object.entries(lastItem)) ends[i] = Number(turn);
		return ends;
	}, [chatItems, turnPlan]);
	const finished = !working && stream === null;
	/** The action row for turn `t`, once its agent work is done. */
	const turnActions = (t: number | undefined): ReactNode => {
		const turn = t === undefined ? undefined : turnPlan.turns[t];
		if (turn === undefined || !turn.agent) return null;
		if (t === turnPlan.turns.length - 1 && !finished) return null;
		return <TurnActions entries={entries} turn={turn} />;
	};

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
				if (index < floor) trimmed?.onShowAll();
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

	// Keys for this transcript: jump to the latest message, copy the last reply, edit the last prompt.
	// They act on the pane the reader last touched, and the agent drawer's compact transcript leaves them out.
	const keysRef = useRef({ blocks, jumpToLatest, copyBlock: blockUi.copyBlock, onEdit });
	keysRef.current = { blocks, jumpToLatest, copyBlock: blockUi.copyBlock, onEdit };
	useEffect(() => {
		if (compact === true) return;
		const onKey = (e: KeyboardEvent): void => {
			const root = rootRef.current;
			if (e.isComposing || e.defaultPrevented || root === null || document.querySelector('[role="dialog"]') !== null)
				return;
			if ((root.closest("[data-pane]")?.getAttribute("data-pane") ?? "main") !== focusedPane()) return;
			const current = keysRef.current;
			if (shortcutFires("jumpLatest", e, e.target, IS_MAC)) {
				e.preventDefault();
				current.jumpToLatest();
			} else if (shortcutFires("copyReply", e, e.target, IS_MAC)) {
				const reply = current.blocks.findLast(block => block.kind === "reply");
				if (reply === undefined) return;
				e.preventDefault();
				current.copyBlock(reply.id);
			} else if (shortcutFires("editPrompt", e, e.target, IS_MAC)) {
				const prompt = current.blocks.findLast(block => block.kind === "prompt" && block.editable);
				if (prompt === undefined || current.onEdit === undefined) return;
				e.preventDefault();
				current.onEdit(prompt.entryId ?? prompt.id);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [compact]);

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
		if (index < floor) trimmed?.onShowAll();
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
			{...blockUi.rootProps}
			onScroll={() => {
				blockUi.cancelPress();
				const el = rootRef.current;
				if (el === null) return;
				const top = el.scrollTop;
				const up = top < lastTopRef.current;
				lastTopRef.current = top;
				const own = ownTopRef.current !== null && Math.abs(top - ownTopRef.current) < 1;
				ownTopRef.current = null;
				if (own) return;
				updateTranscriptTailLock(el, lockRef);
				if (away === lockRef.current) setAway(!lockRef.current);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				// Only the reader heading up mounts earlier rows. Following the tail of a
				// short window also sits near the top, and a taller viewport (the keyboard
				// closing, the composer shrinking) clamps the view upward to the bottom.
				const atBottom = el.scrollHeight - el.clientHeight - top < 1;
				if (top <= EARLIER_TRIGGER_PX && (!lockRef.current || (up && !atBottom))) showEarlier();
				if (pillActive && dividerInView()) onNewSeen?.();
			}}
		>
			<BlocksContext.Provider value={blockUi.context}>
				{settled && entries.length === 0 && stream === null && !working && (
					<div className="tr-empty">no activity yet</div>
				)}
				{start > floor && (
					<button type="button" className="tr-earlier" onClick={showEarlier}>
						show {(start - floor).toLocaleString("en-US")} earlier
					</button>
				)}
				{start === floor && trimmed !== undefined && trimmed.hiddenTurns > 0 && (
					<div className="tr-trimmed">
						<span>
							{trimmed.hiddenTurns.toLocaleString("en-US")} earlier turn{trimmed.hiddenTurns === 1 ? "" : "s"}{" "}
							hidden on this device
						</span>
						<button type="button" className="tr-trimmed-show" onClick={showAll}>
							Show all
						</button>
					</div>
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
								<ChatRow
									item={item}
									results={results}
									active={activeTools}
									host={host}
									onEdit={onEdit}
									otherModels={otherModels}
								/>
								{Object.hasOwn(chatTurnEnds, i) && turnActions(chatTurnEnds[i])}
							</Fragment>
						))
					: visible.map((entry, i) => (
							<Fragment key={entry.id}>
								{i === dividerAt && <NewDivider />}
								<EntryRow
									entry={entry}
									results={results}
									active={activeTools}
									host={host}
									onEdit={onEdit}
									answeredBy={otherModels.get(entry.id)}
								/>
								{Object.hasOwn(turnPlan.endOf, entry.id) && turnActions(turnPlan.endOf[entry.id])}
							</Fragment>
						))}
				{chatItems === null && stream !== null && (
					<Row kind="assistant" gutter="agent">
						<AssistantBody
							message={stream}
							entryId={null}
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
							<BlockShell key={tool.toolCallId} id={null} kind="tool">
								<ToolCard
									toolCallId={tool.toolCallId}
									name={tool.toolName}
									intent={tool.intent}
									args={tool.args}
									running
									partialResult={tool.partialResult}
									host={host}
									framed
								/>
							</BlockShell>
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
							{prompt.model !== undefined && (
								<span className="tr-queued-meta">
									{prompt.model}
									{prompt.thinking !== undefined && ` · ${prompt.thinking}`}
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
			</BlocksContext.Provider>
			{blockUi.overlay}
		</div>
	);
}
