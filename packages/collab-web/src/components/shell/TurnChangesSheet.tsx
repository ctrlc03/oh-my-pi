import type { ReceiptApproval, ReceiptCommand, SessionReceipts, TurnDiffFile } from "@oh-my-pi/pi-wire";
import {
	Check,
	ChevronRight,
	Columns2,
	FileDiff,
	LoaderCircle,
	Receipt,
	RefreshCw,
	Rows2,
	ShieldCheck,
	ShieldX,
	X,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot, TurnDiffInfo } from "../../lib/client";
import { fmtDuration, splitPath } from "../../lib/format";
import { type PaletteEntry, usePaletteEntries } from "../../lib/palette";
import {
	buildReviewPrompt,
	commentId,
	type DiffReview,
	loadReviewComments,
	type ReviewComment,
	saveReviewComments,
} from "../../lib/review-comments";
import { readJson, writeJson } from "../../lib/storage";
import {
	fileSignature,
	loadViewed,
	type PromptTurn,
	promptTurns,
	saveViewed,
	type TurnChangesView,
	viewedPaths,
	viewKey,
} from "../../lib/turn-changes";
import type { ComposerHandle } from "./Composer";
import { UnifiedDiff } from "./ReviewDiff";
import { Sheet } from "./Sheet";
import "./turn-changes.css";

type Tab = "turn" | "session" | "receipts";

const BADGES: Record<TurnDiffFile["status"], { letter: string; tone: string; label: string }> = {
	added: { letter: "A", tone: "add", label: "added" },
	modified: { letter: "M", tone: "mod", label: "modified" },
	deleted: { letter: "D", tone: "del", label: "deleted" },
	typechange: { letter: "T", tone: "move", label: "type changed" },
};

/** Side by side needs room: it is offered from this width. */
const WIDE_QUERY = "(min-width: 900px)";
const LAYOUT_KEY = "omp.collab.diff-layout";
/** How long a request may go unanswered before the sheet offers to ask again. */
const SILENT_MS = 8000;
/** Up to this many files open expanded; more start collapsed. */
const EXPAND_ALL_UP_TO = 3;

function subscribeWide(notify: () => void): () => void {
	const list = matchMedia(WIDE_QUERY);
	list.addEventListener("change", notify);
	return () => list.removeEventListener("change", notify);
}

function useWide(): boolean {
	return useSyncExternalStore(
		subscribeWide,
		() => matchMedia(WIDE_QUERY).matches,
		() => false,
	);
}

function turnTitle(turn: PromptTurn | undefined): string {
	return turn === undefined ? "No turns yet" : `Turn ${turn.turn}${turn.label === "" ? "" : ` · ${turn.label}`}`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface ChangeFileProps {
	file: TurnDiffFile;
	open: boolean;
	viewed: boolean;
	side: boolean;
	review: DiffReview | null;
	onToggle(): void;
	onViewed(): void;
}

function ChangeFile({ file, open, viewed, side, review, onToggle, onViewed }: ChangeFileProps): ReactNode {
	const { dir, base } = splitPath(file.path);
	const badge = BADGES[file.status];
	return (
		<li className="sh-change sh-tc-file" data-viewed={viewed ? "" : undefined}>
			<div className="sh-tc-file-head">
				<button
					type="button"
					className="sh-change-head"
					onClick={onToggle}
					aria-expanded={open}
					title={`${file.path} · ${badge.label}`}
				>
					<ChevronRight size={14} className={open ? "tr-chev tr-chev--open" : "tr-chev"} />
					<span className={`sh-status-badge sh-status-badge-${badge.tone}`} aria-label={badge.label}>
						{badge.letter}
					</span>
					<span className="sh-change-path">
						<span className="sh-change-dir">{dir}</span>
						<span className="sh-change-base">{base}</span>
					</span>
					{file.added === null || file.removed === null ? (
						<span className="sh-tree-sync">binary</span>
					) : (
						<>
							{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
							{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
						</>
					)}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-tc-viewed"
					aria-pressed={viewed}
					aria-label={viewed ? "mark as not viewed" : "mark as viewed"}
					title={viewed ? "Viewed" : "Mark as viewed"}
					onClick={onViewed}
				>
					<Check size={16} />
				</button>
			</div>
			{open && (
				<div className="sh-change-body">
					<UnifiedDiff diff={file.diff} scope="turn" path={file.path} review={review} side={side} />
					{file.truncated === true && <div className="sh-file-note">The diff is longer than the host sends.</div>}
				</div>
			)}
		</li>
	);
}

interface ChangesPanelProps {
	view: TurnChangesView;
	sessionId: string | null;
	info: TurnDiffInfo;
	files: readonly TurnDiffFile[];
	onSendToAgent: ((text: string) => void) | null;
	heading: string;
}

/** One view's files: viewed marks and review comments are kept per session and view. */
function ChangesPanel({ view, sessionId, info, files, onSendToAgent, heading }: ChangesPanelProps): ReactNode {
	const key = sessionId === null ? null : viewKey(sessionId, view);
	const wide = useWide();
	const [layout, setLayout] = useState<"unified" | "split">(() =>
		readJson(LAYOUT_KEY) === "split" ? "split" : "unified",
	);
	const side = wide && layout === "split";
	const [marks, setMarks] = useState<Record<string, string>>(() => (key === null ? {} : loadViewed(key)));
	const [explicit, setExplicit] = useState<Record<string, boolean>>({});
	const [comments, setComments] = useState<Record<string, ReviewComment>>(() =>
		onSendToAgent === null || key === null ? {} : loadReviewComments(key),
	);
	const [discarding, setDiscarding] = useState(false);
	const viewed = useMemo(() => viewedPaths(files, marks), [files, marks]);
	const changeComments = (next: Record<string, ReviewComment>): void => {
		setComments(next);
		if (key !== null) saveReviewComments(key, next);
	};
	const review: DiffReview | null =
		onSendToAgent === null
			? null
			: {
					comments,
					save: comment => changeComments({ ...comments, [commentId(comment)]: comment }),
					remove: id => changeComments(Object.fromEntries(Object.entries(comments).filter(([k]) => k !== id))),
				};
	const count = Object.keys(comments).length;
	const isOpen = (file: TurnDiffFile): boolean =>
		Object.hasOwn(explicit, file.path)
			? explicit[file.path]!
			: files.length <= EXPAND_ALL_UP_TO && !viewed.has(file.path);
	const markViewed = (file: TurnDiffFile): void => {
		const next = { ...marks };
		const done = viewed.has(file.path);
		if (done) delete next[file.path];
		else next[file.path] = fileSignature(file);
		setMarks(next);
		if (key !== null) saveViewed(key, next);
		// Marking a file viewed folds it away; unmarking it leaves it as it is.
		if (!done) setExplicit({ ...explicit, [file.path]: false });
	};
	const pickLayout = (next: "unified" | "split"): void => {
		setLayout(next);
		writeJson(LAYOUT_KEY, next);
	};
	const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
	const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);

	return (
		<>
			<div className="sh-tc-body">
				<div className="sh-tc-summary">
					<span>
						{plural(files.length + info.omitted, "file")} · <span className="sh-change-add">+{added}</span>{" "}
						<span className="sh-change-del">−{removed}</span>
					</span>
					{files.length > 0 && (
						<span className="sh-tab-count">
							{viewed.size}/{files.length} viewed
						</span>
					)}
					{wide && (
						<div className="sh-segmented sh-tc-layout" role="radiogroup" aria-label="diff layout">
							<button
								type="button"
								role="radio"
								aria-checked={layout === "unified"}
								className={layout === "unified" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => pickLayout("unified")}
							>
								<Rows2 size={14} /> Unified
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={layout === "split"}
								className={layout === "split" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => pickLayout("split")}
							>
								<Columns2 size={14} /> Split
							</button>
						</div>
					)}
				</div>
				{view.scope === "turn" && info.spansTurns > 1 && (
					<div className="sh-file-note">
						The next {plural(info.spansTurns - 1, "turn")} had no file snapshot, so this also covers their
						changes.
					</div>
				)}
				{info.omitted > 0 && (
					<div className="sh-file-note">{plural(info.omitted, "more changed file")} not listed.</div>
				)}
				{files.length === 0 ? (
					<div className="sh-companion-empty">No files changed.</div>
				) : (
					<ul className="sh-changes">
						{files.map(file => (
							<ChangeFile
								key={file.path}
								file={file}
								open={isOpen(file)}
								viewed={viewed.has(file.path)}
								side={side}
								review={review}
								onToggle={() => setExplicit({ ...explicit, [file.path]: !isOpen(file) })}
								onViewed={() => markViewed(file)}
							/>
						))}
					</ul>
				)}
			</div>
			{review !== null && count > 0 && (
				<div className="sh-review-bar" role="group" aria-label="review">
					{discarding ? (
						<>
							<span className="sh-review-bar-text">
								Discard {count === 1 ? "the comment" : `all ${count} comments`}?
							</span>
							<button type="button" className="sh-btn" onClick={() => setDiscarding(false)}>
								Keep
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => {
									changeComments({});
									setDiscarding(false);
								}}
							>
								Discard
							</button>
						</>
					) : (
						<>
							<span className="sh-review-bar-text">{plural(count, "comment")}</span>
							<button type="button" className="sh-btn" onClick={() => setDiscarding(true)}>
								Discard
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								onClick={() => {
									onSendToAgent?.(buildReviewPrompt(Object.values(comments), heading));
									changeComments({});
								}}
							>
								Send to agent
							</button>
						</>
					)}
				</div>
			)}
		</>
	);
}

function ExitBadge({ code }: { code: number | null }): ReactNode {
	if (code === null) return <span className="sh-tc-exit sh-tc-exit-none">no exit</span>;
	return <span className={code === 0 ? "sh-tc-exit sh-tc-exit-ok" : "sh-tc-exit sh-tc-exit-fail"}>exit {code}</span>;
}

function ApprovalRow({ approval }: { approval: ReceiptApproval }): ReactNode {
	return (
		<>
			{approval.approved ? (
				<ShieldCheck size={14} className="sh-tc-ok" />
			) : (
				<ShieldX size={14} className="sh-tc-fail" />
			)}
			<span className="sh-tc-main">
				<span className="sh-tc-strong">{approval.tool}</span> {approval.approved ? "granted" : "denied"} by{" "}
				{approval.by}
				{approval.reason !== undefined && <span className="sh-tc-faint"> · {approval.reason}</span>}
			</span>
		</>
	);
}

function CommandRow({ command }: { command: ReceiptCommand }): ReactNode {
	return (
		<>
			<ExitBadge code={command.exitCode} />
			<span className="sh-tc-main sh-tc-mono">
				{command.source === "user" && <span className="sh-tc-faint">you: </span>}
				{command.command}
			</span>
		</>
	);
}

interface ReceiptsPanelProps {
	receipts: SessionReceipts;
	onOpenTurn(promptId: string): void;
}

/** A row's turn: a button into that turn's diff when the host named the prompt. */
function TurnLink({
	turn,
	promptId,
	onOpenTurn,
}: {
	turn: number;
	promptId: string | null;
	onOpenTurn(id: string): void;
}): ReactNode {
	if (promptId === null) return <span className="sh-tc-turn">before the first prompt</span>;
	return (
		<button type="button" className="sh-tc-turn sh-tc-turn-link" onClick={() => onOpenTurn(promptId)}>
			turn {turn}
		</button>
	);
}

function ReceiptsPanel({ receipts, onOpenTurn }: ReceiptsPanelProps): ReactNode {
	const link = (turn: number, promptId: string | null): ReactNode => (
		<TurnLink turn={turn} promptId={promptId} onOpenTurn={onOpenTurn} />
	);
	const empty =
		receipts.files.length + receipts.commands.length + receipts.approvals.length + receipts.subagents.length === 0;
	return (
		<div className="sh-tc-body">
			<div className="sh-tc-summary">
				<span>
					{plural(receipts.turns, "turn")} · {plural(receipts.files.length, "file")} ·{" "}
					{plural(receipts.commands.length, "command")} · {plural(receipts.approvals.length, "approval")} ·{" "}
					{plural(receipts.subagents.length, "subagent")}
				</span>
			</div>
			{receipts.truncated === true && (
				<div className="sh-file-note">Long lists show only their most recent rows.</div>
			)}
			{empty && <div className="sh-companion-empty">Nothing recorded yet.</div>}
			{receipts.files.length > 0 && (
				<section className="sh-tc-section" aria-label="files changed">
					<h3 className="sh-tc-heading">Files changed</h3>
					<ul className="sh-tc-list">
						{receipts.files.map((file, i) => (
							<li key={i} className="sh-tc-row">
								<span className="sh-tc-main sh-tc-mono">{file.path}</span>
								<span className="sh-tc-faint">{file.tool}</span>
								{link(file.turn, file.promptId)}
							</li>
						))}
					</ul>
				</section>
			)}
			{receipts.commands.length > 0 && (
				<section className="sh-tc-section" aria-label="commands run">
					<h3 className="sh-tc-heading">Commands</h3>
					<ul className="sh-tc-list">
						{receipts.commands.map((command, i) => (
							<li key={i} className="sh-tc-row">
								<CommandRow command={command} />
								{link(command.turn, command.promptId)}
							</li>
						))}
					</ul>
				</section>
			)}
			{receipts.approvals.length > 0 && (
				<section className="sh-tc-section" aria-label="approvals">
					<h3 className="sh-tc-heading">Approvals</h3>
					<ul className="sh-tc-list">
						{receipts.approvals.map((approval, i) => (
							<li key={i} className="sh-tc-row">
								<ApprovalRow approval={approval} />
								{link(approval.turn, approval.promptId)}
							</li>
						))}
					</ul>
				</section>
			)}
			{receipts.subagents.length > 0 && (
				<section className="sh-tc-section" aria-label="subagents">
					<h3 className="sh-tc-heading">Subagents</h3>
					<ul className="sh-tc-list">
						{receipts.subagents.map((agent, i) => (
							<li key={i} className="sh-tc-row">
								<ExitBadge code={agent.exitCode} />
								<span className="sh-tc-main">
									<span className="sh-tc-strong">{agent.agent}</span> {agent.label}
									{agent.durationMs !== null && (
										<span className="sh-tc-faint"> · {fmtDuration(agent.durationMs)}</span>
									)}
								</span>
								{link(agent.turn, agent.promptId)}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

export interface TurnChangesSheetProps {
	client: GuestClient;
	snap: GuestSnapshot;
	sessionId: string | null;
	/** `turn-diff` is advertised: the Turn and Session tabs. */
	canDiff: boolean;
	/** `receipts` is advertised. */
	canReceipts: boolean;
	initialTab: Tab;
	/** The turn the Turn tab opens on; the latest when null. */
	initialEntryId: string | null;
	onSendToAgent: ((text: string) => void) | null;
	onClose(): void;
}

/**
 * What the agent did: one turn's file changes, the whole session's, and its receipts (commands run,
 * approvals, subagents). The host reads them from its file snapshots and session entries; this asks
 * and shows the latest answer.
 */
export function TurnChangesSheet({
	client,
	snap,
	sessionId,
	canDiff,
	canReceipts,
	initialTab,
	initialEntryId,
	onSendToAgent,
	onClose,
}: TurnChangesSheetProps): ReactNode {
	const [tab, setTab] = useState<Tab>(initialTab);
	const turns = useMemo(() => promptTurns(snap.entries), [snap.entries]);
	const [pickedId, setPickedId] = useState<string | null>(initialEntryId);
	const [nonce, setNonce] = useState(0);
	const [silent, setSilent] = useState(false);
	const index = pickedId === null ? turns.length - 1 : turns.findIndex(turn => turn.id === pickedId);
	const turn: PromptTurn | undefined = turns[index];
	const entryId = tab === "turn" ? (turn?.id ?? null) : null;
	const live = snap.phase === "live";
	const { working } = snap;

	const request = useCallback(() => {
		if (!live) return;
		if (tab === "receipts") client.sendSessionCommand("receipts");
		else if (tab === "session") client.sendSessionCommand("session-diff");
		else if (entryId !== null) client.sendSessionCommand("turn-diff", entryId);
	}, [client, live, tab, entryId]);
	// The latest turn's changes move while the agent works: ask again when it stops.
	useEffect(() => request(), [request, working]);
	const ask = (): void => {
		request();
		setNonce(nonce + 1);
	};

	const info = snap.turnDiff;
	const answered =
		tab === "receipts" ? snap.receipts !== null : info !== null && info.scope === tab && info.entryId === entryId;
	useEffect(() => {
		setSilent(false);
		if (answered) return;
		const timer = setTimeout(() => setSilent(true), SILENT_MS);
		return () => clearTimeout(timer);
	}, [answered, tab, entryId, nonce]);

	const tabs: Array<{ id: Tab; label: string }> = [
		...(canDiff
			? [
					{ id: "turn" as const, label: "This turn" },
					{ id: "session" as const, label: "Session" },
				]
			: []),
		...(canReceipts ? [{ id: "receipts" as const, label: "Receipts" }] : []),
	];
	const openTurn = useCallback((promptId: string) => {
		setPickedId(promptId);
		setTab("turn");
	}, []);

	let body: ReactNode;
	if (tab === "turn" && turn === undefined) {
		body = <div className="sh-companion-empty">The session has no prompts yet.</div>;
	} else if (!answered) {
		body = silent ? (
			<div className="sh-companion-empty">
				The host has not answered.{" "}
				<button type="button" className="sh-btn" onClick={ask}>
					Ask again
				</button>
			</div>
		) : (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Reading changes…
			</div>
		);
	} else if (tab === "receipts") {
		body = snap.receipts === null ? null : <ReceiptsPanel receipts={snap.receipts} onOpenTurn={openTurn} />;
	} else if (info === null || info.files === null) {
		body = <div className="sh-companion-empty">{info?.reason ?? "The host could not read the changes."}</div>;
	} else {
		const view: TurnChangesView = tab === "turn" ? { scope: "turn", entryId: entryId ?? "" } : { scope: "session" };
		body = (
			<ChangesPanel
				key={viewKey(sessionId ?? "", view)}
				view={view}
				sessionId={sessionId}
				info={info}
				files={info.files}
				onSendToAgent={onSendToAgent}
				heading={
					tab === "turn"
						? `Review comments on the changes from turn ${turn?.turn ?? ""}:`
						: "Review comments on the changes in this session:"
				}
			/>
		);
	}

	return (
		<Sheet label="what the agent changed" size="full" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{tab === "receipts" ? "Receipts" : "Changes"}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={ask} aria-label="refresh" title="Refresh">
					<RefreshCw size={16} />
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{tabs.length > 1 && (
				<div className="sh-tabs" role="tablist" aria-label="changes view">
					{tabs.map(entry => (
						<button
							key={entry.id}
							type="button"
							role="tab"
							aria-selected={tab === entry.id}
							className="sh-tab"
							onClick={() => setTab(entry.id)}
						>
							{entry.label}
						</button>
					))}
				</div>
			)}
			{tab === "turn" && turns.length > 0 && (
				<div className="sh-tc-turnbar">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						disabled={index <= 0}
						aria-label="previous turn"
						onClick={() => setPickedId(turns[index - 1]?.id ?? null)}
					>
						<ChevronRight size={16} className="sh-tc-flip" />
					</button>
					<span className="sh-tc-turntitle" title={turnTitle(turn)}>
						{turnTitle(turn)}
					</span>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						disabled={index >= turns.length - 1}
						aria-label="next turn"
						onClick={() => setPickedId(turns[index + 1]?.id ?? null)}
					>
						<ChevronRight size={16} />
					</button>
				</div>
			)}
			{body}
		</Sheet>
	);
}

/**
 * The per-turn changes sheet and the ways to open it. `onTurnChanges` (a transcript's Changes action)
 * is undefined unless the host advertises `turn-diff` and this device can send it commands; the
 * palette entries (registered once, by the pane that asks) open the session view and the receipts.
 */
export function useTurnChanges(
	client: GuestClient,
	snap: GuestSnapshot,
	sessionId: string | null,
	composerRef: RefObject<ComposerHandle | null>,
	registerPalette = false,
): { onTurnChanges: ((entryId: string) => void) | undefined; sheet: ReactNode } {
	const [open, setOpen] = useState<{ tab: Tab; entryId: string | null } | null>(null);
	const usable = !snap.readOnly && snap.phase === "live";
	const canDiff = usable && Object.hasOwn(snap.features, "turn-diff");
	const canReceipts = usable && Object.hasOwn(snap.features, "receipts");
	const close = useCallback(() => setOpen(null), []);
	useEffect(() => {
		if (!canDiff && !canReceipts) setOpen(null);
	}, [canDiff, canReceipts]);
	const onTurnChanges = useMemo(
		() => (canDiff ? (entryId: string) => setOpen({ tab: "turn", entryId }) : undefined),
		[canDiff],
	);
	const entries = useMemo<PaletteEntry[]>(
		() => [
			...(registerPalette && canDiff
				? [
						{
							id: "turn-changes:turn",
							title: "Show the latest turn's changes",
							section: "View",
							keywords: ["diff", "files", "review"],
							icon: FileDiff,
							run: () => setOpen({ tab: "turn", entryId: null }),
						},
						{
							id: "turn-changes:session",
							title: "Show everything changed in this session",
							section: "View",
							keywords: ["diff", "files", "review"],
							icon: FileDiff,
							run: () => setOpen({ tab: "session", entryId: null }),
						},
					]
				: []),
			...(registerPalette && canReceipts
				? [
						{
							id: "turn-changes:receipts",
							title: "Show receipts: commands, approvals, subagents",
							section: "View",
							keywords: ["audit", "log", "shell", "approved"],
							icon: Receipt,
							run: () => setOpen({ tab: "receipts", entryId: null }),
						},
					]
				: []),
		],
		[registerPalette, canDiff, canReceipts],
	);
	usePaletteEntries(entries);
	const sendToAgent = useCallback(
		(text: string) => {
			setOpen(null);
			composerRef.current?.insert(text);
		},
		[composerRef],
	);
	const sheet =
		open !== null && (canDiff || canReceipts) ? (
			<TurnChangesSheet
				client={client}
				snap={snap}
				sessionId={sessionId}
				canDiff={canDiff}
				canReceipts={canReceipts}
				initialTab={open.tab}
				initialEntryId={open.entryId}
				onSendToAgent={snap.readOnly ? null : sendToAgent}
				onClose={close}
			/>
		) : null;
	return { onTurnChanges, sheet };
}
