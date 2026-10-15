import type { AgentRef, SessionCommand, SessionState, WireModel } from "@oh-my-pi/pi-wire";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Download,
	Eye,
	type LucideIcon,
	LogOut,
	MessageSquare,
	Pencil,
	Redo2,
	Rows3,
	Share2,
	Undo2,
	X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ConnectionPhase, ContextItemsInfo } from "../../lib/client";
import { shouldShare } from "../../lib/download";
import { exportFilename } from "../../lib/export";
import { TRIM_CHOICES } from "../../lib/trim";
import { fmtPercent, fmtTokens } from "../../lib/format";
import { openPalette } from "../../lib/palette";
import { openSettings } from "../../lib/settings-ui";
import { effectiveKeys, formatCombo, IS_MAC, useOverrides } from "../../lib/shortcuts";
import { formatUsage, type SessionUsage } from "../../lib/usage";
import { ContextItems } from "./ContextItems";
import type { HiddenMessagesControl } from "./HiddenMessages";
import { AgentChip } from "./AgentChip";
import { PermissionControl } from "./PermissionControl";
import { PrWatch } from "./PrWatch";
import { SandboxedChip } from "./CompanionCard";
import { HighStakesChip, HighStakesRow, type StakesControl } from "./StakesControl";
import { ModelList } from "./ModelControls";
import { Sheet } from "./Sheet";
import type { TurnUndoControl } from "./TurnUndo";

const VIEWS: readonly { chat: boolean; label: string; Icon: LucideIcon }[] = [
	{ chat: true, label: "Chat", Icon: MessageSquare },
	{ chat: false, label: "Full", Icon: Rows3 },
];

/** Desktop shortcuts, wired in app.tsx with the keys the reader chose; shown only where a pointer can use them. */
function shortcutHints(): readonly { keys: string; action: string }[] {
	return [
		{ keys: formatCombo(effectiveKeys("palette"), IS_MAC), action: "command palette" },
		{ keys: formatCombo(effectiveKeys("find"), IS_MAC), action: "find in session" },
		{ keys: formatCombo(effectiveKeys("escape"), IS_MAC), action: "close, or stop a running turn" },
	];
}

export interface SessionSheetProps {
	title: string;
	state: SessionState | null;
	phase: ConnectionPhase;
	phaseLabel: string;
	readOnly: boolean;
	sandboxed: boolean;
	/** This session's high-stakes mode; null unless the paired computer can gate pushes behind a quiz and this is an omp session. */
	highStakes: StakesControl | null;
	/** The vendor agent behind this session; null for an omp session. */
	agent: AgentRef | null;
	/** The host advertises `permission-mode`. */
	canPermission: boolean;
	contextPct: number | null;
	/** Chat view: prompts and replies only, tool runs folded. */
	chat: boolean;
	onChatChange(chat: boolean): void;
	/** Latest turns this device keeps showing (null: all); undefined until the session is known. */
	keepTurns: number | null | undefined;
	onKeepTurnsChange(keep: number | null): void;
	/** Find bar open; the ⋯ sheet toggles it like the header's magnifier, which may be hidden from the bar. */
	searchOpen: boolean;
	onToggleSearch(): void;
	/** Agents rail open and the number of active subagents; the header's button for it may be hidden from the bar. */
	railOpen: boolean;
	subCount: number;
	onToggleRail(): void;
	/** Files the agent changed this session. */
	changeCount: number;
	onOpenChanges(): void;
	/** Usage and all-sessions screens; null when no computer is paired. */
	onOpenUsage: (() => void) | null;
	onOpenSessions: (() => void) | null;
	/** Code map of the session's repository; null unless the paired computer can build one. */
	onOpenCodemap: (() => void) | null;
	/** Architecture maps of the session's repository; null unless the paired computer can make them. */
	onOpenArchitecture: (() => void) | null;
	/** A changes map of this session's edits; null unless maps can be made and the session changed files. */
	onMapChanges: (() => void) | null;
	/** This repository's quizzes, with *New quiz* on this session's changes; null unless this computer writes quizzes. */
	onOpenQuizzes: (() => void) | null;
	/** A quiz on this session's topic, design and implementation; null unless this computer writes those and a session is open. */
	onQuizTopic: (() => void) | null;
	/** This repository's sparring sessions, with *Spar with this change* on this session's changes; null unless this computer can spar. */
	onOpenSparring: (() => void) | null;
	/** This repository's bake-offs, with *Bake off these changes* on this session's changes; null unless this computer can run bake-offs. */
	onOpenBakeoff: (() => void) | null;
	/** The session's terminal (tmux pane); null unless the paired computer hosts this session. */
	onOpenPane: (() => void) | null;
	/** Live screenshot of a dev server the session runs; null unless the paired computer can capture pages. */
	onOpenPreview: (() => void) | null;
	/** Issues and pull requests of the session's repository; null unless the paired computer's `gh` is signed in. */
	onOpenGithub: (() => void) | null;
	/** File tree and editor of the session's folder; null unless the paired computer can edit its files. */
	onOpenEditor: (() => void) | null;
	/** Per-request timeline (timing, cache, injected context); null unless the host advertises `inspect` and this guest may write. */
	onOpenTimeline: (() => void) | null;
	/** Scripts and build targets of the session's repository, run on the computer; null unless the companion can run them (and never for view-only or sandboxed sessions). */
	onOpenRun: (() => void) | null;
	/** Images the agent's tools produced this session. */
	screenCount: number;
	onOpenScreens(): void;
	onLeave(): void;
	onClose(): void;
	/** The paired computer can show this session's git working tree. */
	workingTree: boolean;
	/** Totals summed from assistant messages; null when none reported usage. */
	usage: SessionUsage | null;
	/** Models this writer may switch to; null when the host predates session controls. */
	models: readonly WireModel[] | null;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	/** Undo and redo of the last turn; undefined unless the host advertises `undo` and this guest may write. */
	turnUndo: TurnUndoControl | undefined;
	/** Messages hidden from this session's chat; undefined where none can be. */
	hiddenMessages: HiddenMessagesControl | undefined;
	/** The host's latest "what fills the context" ranking; undefined unless the host advertises `context-items`, null until it replies. */
	contextItems: ContextItemsInfo | null | undefined;
	/** The host can watch pull requests (feature `pr-watch`). */
	canWatchPr: boolean;
	/** The session as Markdown, built on demand from every entry (not the trimmed view). */
	exportMarkdown(title: string): string;
}

/**
 * Session details and the actions the compact header drops: connection, model,
 * context, participants, theme, and leave. A bottom sheet on phones, a dropdown
 * card under the header elsewhere.
 */
export function SessionSheet({
	title,
	state,
	phase,
	phaseLabel,
	readOnly,
	sandboxed,
	highStakes,
	agent,
	canPermission,
	contextPct,
	chat,
	onChatChange,
	keepTurns,
	onKeepTurnsChange,
	searchOpen,
	onToggleSearch,
	railOpen,
	subCount,
	onToggleRail,
	changeCount,
	onOpenChanges,
	onOpenUsage,
	onOpenSessions,
	onOpenCodemap,
	onOpenArchitecture,
	onMapChanges,
	onOpenQuizzes,
	onQuizTopic,
	onOpenSparring,
	onOpenBakeoff,
	onOpenPane,
	onOpenPreview,
	onOpenGithub,
	onOpenEditor,
	onOpenTimeline,
	onOpenRun,
	screenCount,
	onOpenScreens,
	workingTree,
	usage,
	models,
	onSessionCommand,
	turnUndo,
	hiddenMessages,
	contextItems,
	canWatchPr,
	exportMarkdown,
	onLeave,
	onClose,
}: SessionSheetProps): ReactNode {
	useOverrides();
	const hints = shortcutHints();
	const [pickerOpen, setPickerOpen] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [instructions, setInstructions] = useState("");
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
	// The draft name while renaming; null when the title shows.
	const [renaming, setRenaming] = useState<string | null>(null);
	const canControl = models !== null && !readOnly && phase === "live";
	const levels = state?.thinkingLevels ?? [];

	const rename = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const name = renaming?.trim();
		if (name && name !== title) onSessionCommand("rename", name);
		setRenaming(null);
	};

	const filename = exportFilename(title);
	const downloadExport = (): void => {
		const url = URL.createObjectURL(new Blob([exportMarkdown(title)], { type: "text/markdown" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		link.click();
		URL.revokeObjectURL(url);
	};
	const shareExport = async (): Promise<void> => {
		const text = exportMarkdown(title);
		const file = new File([text], filename, { type: "text/markdown" });
		try {
			// The file only where the share sheet saves it (phones, tablets): Chrome on macOS says it can share a
			// Markdown file, then refuses with NotAllowedError, so a desktop shares the text.
			await navigator.share(shouldShare(navigator, file) ? { title, files: [file] } : { title, text });
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			// Refused: the export still reaches the user, as a file.
			downloadExport();
		}
	};
	const copyExport = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(exportMarkdown(title));
		} catch {
			return;
		}
		setCopied(true);
		window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
	};

	return (
		<Sheet label="session details" onClose={onClose}>
			{renaming === null ? (
				<div className="sh-sheet-head">
					<div className="sh-sheet-title">{title}</div>
					<span className="sh-sheet-head-actions">
						{canControl && (
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => setRenaming(title)}
								aria-label="Rename session"
								title="Rename session"
							>
								<Pencil size={15} />
							</button>
						)}
						<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
							<X size={16} />
						</button>
					</span>
				</div>
			) : (
				<form className="sh-sheet-rename" onSubmit={rename}>
					<input
						className="sh-sheet-input"
						value={renaming}
						onChange={e => setRenaming(e.currentTarget.value)}
						onKeyDown={e => {
							if (e.key === "Escape") {
								// Leave the sheet open: Escape only abandons the rename.
								e.stopPropagation();
								setRenaming(null);
							}
						}}
						aria-label="Session name"
						placeholder="Session name"
						enterKeyHint="done"
						maxLength={200}
						autoFocus
					/>
					<span className="sh-sheet-actions">
						<button type="button" className="sh-btn" onClick={() => setRenaming(null)}>
							Cancel
						</button>
						<button type="submit" className="sh-btn sh-btn-primary" disabled={!renaming.trim()}>
							Rename
						</button>
					</span>
				</form>
			)}
			{state?.cwd && <div className="sh-sheet-cwd">{state.cwd}</div>}

			<dl className="sh-sheet-rows">
				<div className="sh-sheet-row">
					<dt>Search</dt>
					<dd>
						<button
							type="button"
							className="sh-sheet-link"
							onClick={() => {
								onClose();
								openPalette();
							}}
						>
							Actions, sessions and messages
							<ChevronRight size={14} />
						</button>
					</dd>
				</div>
				<div className="sh-sheet-row">
					<dt>Find</dt>
					<dd>
						<button type="button" className="sh-sheet-link" onClick={onToggleSearch}>
							{searchOpen ? "Close the search bar" : "Search this conversation"}
							<ChevronRight size={14} />
						</button>
					</dd>
				</div>
				<div className="sh-sheet-row">
					<dt>Connection</dt>
					<dd>
						<span className={`sh-dot sh-dot-${phase}`} />
						{phaseLabel}
						{readOnly && <span className="sh-chip">read-only</span>}
						<AgentChip agent={agent} />
						{sandboxed && <SandboxedChip />}
						{highStakes?.on && <HighStakesChip />}
					</dd>
				</div>
				{canPermission && state?.permission !== undefined && !readOnly && phase === "live" && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Permissions</dt>
						<dd className="sh-sheet-compact">
							<PermissionControl
								value={state.permission}
								onChange={permission => onSessionCommand("permission", permission)}
							/>
						</dd>
					</div>
				)}
				{highStakes !== null && <HighStakesRow control={highStakes} />}
				{state?.model && (
					<div className="sh-sheet-row">
						<dt>Model</dt>
						<dd className="sh-sheet-mono">
							{canControl ? (
								<button
									type="button"
									className="sh-sheet-link sh-sheet-mono"
									onClick={() => setPickerOpen(open => !open)}
									aria-expanded={pickerOpen}
								>
									{state.model.name}
									<ChevronDown size={14} />
								</button>
							) : (
								state.model.name
							)}
							{!(canControl && levels.length > 0) && state.thinkingLevel && (
								<span className="sh-sheet-faint"> · {state.thinkingLevel}</span>
							)}
						</dd>
					</div>
				)}
				{canControl && pickerOpen && models && (
					<ModelList
						models={models}
						current={state?.model}
						onChange={spec => onSessionCommand("model", spec)}
						onDone={() => setPickerOpen(false)}
						autoFocus
					/>
				)}
				{canControl && levels.length > 0 && (
					<div className="sh-sheet-row">
						<dt>Thinking</dt>
						<dd>
							<select
								className="sh-input sh-sheet-select"
								aria-label="Thinking level"
								value={state?.thinkingLevel ?? ""}
								onChange={e => onSessionCommand("thinking", e.currentTarget.value)}
							>
								{!state?.thinkingLevel && <option value="">Choose a level</option>}
								{levels.map(level => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</dd>
					</div>
				)}
				{contextPct != null && (
					<div className="sh-sheet-row">
						<dt>Context</dt>
						<dd>
							<span className={contextPct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}>
								<span className="sh-gauge-track sh-sheet-gauge">
									<span
										className="sh-gauge-fill"
										style={{ width: `${Math.min(100, Math.max(0, contextPct))}%` }}
									/>
								</span>
								<span className="sh-gauge-pct">{fmtPercent(contextPct)}</span>
							</span>
						</dd>
					</div>
				)}
				{usage && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Usage</dt>
						<dd className="sh-sheet-usage">
							<span className="sh-sheet-mono">{formatUsage(usage.total)}</span>
							<span className="sh-sheet-faint">
								cache {fmtTokens(usage.total.cacheRead)} read · {fmtTokens(usage.total.cacheWrite)} write
							</span>
							{usage.last && <span className="sh-sheet-faint">last turn {formatUsage(usage.last)}</span>}
						</dd>
					</div>
				)}
				{canControl && agent === null && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Compact</dt>
						<dd className="sh-sheet-compact">
							{compacting ? (
								<>
									<span className="sh-sheet-faint">Summarize the conversation to free context?</span>
									<textarea
										className="sh-sheet-input"
										value={instructions}
										onChange={e => setInstructions(e.target.value)}
										placeholder="Instructions (optional)"
										rows={2}
										spellCheck={false}
									/>
									<span className="sh-sheet-actions">
										<button type="button" className="sh-btn" onClick={() => setCompacting(false)}>
											Cancel
										</button>
										<button
											type="button"
											className="sh-btn sh-btn-primary"
											onClick={() => {
												onSessionCommand("compact", instructions.trim() || undefined);
												setCompacting(false);
												setInstructions("");
											}}
										>
											Compact
										</button>
									</span>
								</>
							) : (
								<button type="button" className="sh-btn" onClick={() => setCompacting(true)}>
									Compact…
								</button>
							)}
						</dd>
					</div>
				)}
				{turnUndo !== undefined && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Last turn</dt>
						<dd className="sh-sheet-compact">
							<span className="sh-sheet-actions">
								<button
									type="button"
									className="sh-btn"
									disabled={!turnUndo.canUndo}
									onClick={() => {
										turnUndo.onUndo();
										onClose();
									}}
								>
									<Undo2 size={13} /> Undo
								</button>
								<button
									type="button"
									className="sh-btn"
									disabled={!turnUndo.canRedo}
									onClick={() => {
										turnUndo.onRedo();
										onClose();
									}}
								>
									<Redo2 size={13} /> Redo
								</button>
							</span>
							<span className="sh-sheet-faint">
								Undo rewinds the conversation to before your last prompt, puts the prompt back in the message
								box, and restores the files the turn changed.
							</span>
						</dd>
					</div>
				)}
				{canControl && contextItems !== undefined && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Fills context</dt>
						<dd className="sh-sheet-compact">
							<ContextItems info={contextItems} canPrune onSessionCommand={onSessionCommand} />
						</dd>
					</div>
				)}
				{state && ((state.prWatch?.length ?? 0) > 0 || (canControl && canWatchPr)) && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Pull requests</dt>
						<dd className="sh-sheet-compact">
							<PrWatch
								prs={state.prWatch ?? []}
								canWatch={canControl && canWatchPr}
								onSessionCommand={onSessionCommand}
							/>
						</dd>
					</div>
				)}
				{canControl && onOpenTimeline && (
					<div className="sh-sheet-row">
						<dt>Timeline</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenTimeline}>
								Requests, timing and cache
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{state && state.participants.length > 0 && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>People</dt>
						<dd className="sh-sheet-people">
							{state.participants.map((p, i) => (
								<span key={`${p.name}:${i}`} className="sh-sheet-person">
									<span className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}>
										{(p.name[0] ?? "?").toUpperCase()}
									</span>
									{p.name}
									<span className="sh-sheet-faint">
										{p.role}
										{p.readOnly ? " · view-only" : ""}
									</span>
								</span>
							))}
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>View</dt>
					<dd>
						<div className="sh-segmented" role="radiogroup" aria-label="Transcript view">
							{VIEWS.map(view => (
								<button
									key={view.label}
									type="button"
									role="radio"
									aria-checked={chat === view.chat}
									className={chat === view.chat ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => onChatChange(view.chat)}
								>
									<view.Icon size={14} /> {view.label}
								</button>
							))}
						</div>
					</dd>
				</div>
				{keepTurns !== undefined && (
					<div className="sh-sheet-row">
						<dt>Keep</dt>
						<dd>
							<div className="sh-segmented" role="radiogroup" aria-label="Turns shown on this device">
								{TRIM_CHOICES.map(keep => (
									<button
										key={keep ?? "all"}
										type="button"
										role="radio"
										aria-checked={keepTurns === keep}
										className={keepTurns === keep ? "sh-segment sh-segment-on" : "sh-segment"}
										onClick={() => onKeepTurnsChange(keep)}
										title={
											keep === null
												? "Show the whole session"
												: `Show only the last ${keep} turn${keep === 1 ? "" : "s"} on this device`
										}
									>
										{keep === null ? "All" : `Last ${keep}`}
									</button>
								))}
							</div>
						</dd>
					</div>
				)}
				{hiddenMessages !== undefined && (hiddenMessages.any || hiddenMessages.showing) && (
					<div className="sh-sheet-row sh-sheet-row-top">
						<dt>Hidden</dt>
						<dd className="sh-sheet-compact">
							<button
								type="button"
								className={hiddenMessages.showing ? "sh-btn sh-btn-on" : "sh-btn"}
								aria-pressed={hiddenMessages.showing}
								onClick={() => hiddenMessages.setShowing(!hiddenMessages.showing)}
							>
								<Eye size={13} /> Show hidden messages
							</button>
							<span className="sh-sheet-faint">
								{hiddenMessages.synced
									? "Hidden from the chat on all your devices; the agent still sees them."
									: "Hidden from the chat on this device; the agent still sees them."}
							</span>
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>Changes</dt>
					<dd>
						<button
							type="button"
							className="sh-sheet-link"
							onClick={onOpenChanges}
							disabled={changeCount === 0 && !workingTree}
						>
							{changeCount > 0
								? `${changeCount} file${changeCount === 1 ? "" : "s"}`
								: workingTree
									? "Working tree"
									: "No files yet"}
							{(changeCount > 0 || workingTree) && <ChevronRight size={14} />}
						</button>
					</dd>
				</div>
				{onOpenEditor && (
					<div className="sh-sheet-row">
						<dt>Editor</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenEditor}>
								{readOnly ? "Browse the files" : "Browse and edit files"}
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenCodemap && (
					<div className="sh-sheet-row">
						<dt>Code map</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenCodemap}>
								Browse the repository
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenArchitecture && (
					<div className="sh-sheet-row">
						<dt>Architecture</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenArchitecture}>
								Maps of the system
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onMapChanges && (
					<div className="sh-sheet-row">
						<dt>Changes</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onMapChanges}>
								Map what changed
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenQuizzes && (
					<div className="sh-sheet-row">
						<dt>Quizzes</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenQuizzes}>
								This repository's quizzes
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onQuizTopic && (
					<div className="sh-sheet-row">
						<dt>Topic quiz</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onQuizTopic}>
								Quiz me on this session
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenSparring && (
					<div className="sh-sheet-row">
						<dt>Sparring</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenSparring}>
								Defend your decisions
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenBakeoff && (
					<div className="sh-sheet-row">
						<dt>Bake-off</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenBakeoff}>
								Compare several models' answers
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenPane && (
					<div className="sh-sheet-row">
						<dt>Terminal</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenPane}>
								Watch the screen
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenPreview && (
					<div className="sh-sheet-row">
						<dt>Preview</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenPreview}>
								See the running app
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenRun && (
					<div className="sh-sheet-row">
						<dt>Run</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenRun}>
								Scripts and build targets
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenGithub && (
					<div className="sh-sheet-row">
						<dt>GitHub</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenGithub}>
								Issues and pull requests
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>Agents</dt>
					<dd>
						<button type="button" className="sh-sheet-link" onClick={onToggleRail}>
							{railOpen
								? "Hide the agents panel"
								: subCount > 0
									? `${subCount} active`
									: "Show the agents panel"}
							<ChevronRight size={14} />
						</button>
					</dd>
				</div>
				<div className="sh-sheet-row">
					<dt>Screens</dt>
					<dd>
						<button type="button" className="sh-sheet-link" onClick={onOpenScreens}>
							{screenCount > 0 ? `${screenCount} image${screenCount === 1 ? "" : "s"}` : "None yet"}
							<ChevronRight size={14} />
						</button>
					</dd>
				</div>
				<div className="sh-sheet-row">
					<dt>Export</dt>
					<dd>
						{typeof navigator.share === "function" && (
							<button type="button" className="sh-btn" onClick={() => void shareExport()}>
								<Share2 size={14} /> Share
							</button>
						)}
						<button type="button" className="sh-btn" onClick={downloadExport}>
							<Download size={14} /> Download
						</button>
						<button type="button" className="sh-btn" onClick={() => void copyExport()}>
							{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
						</button>
					</dd>
				</div>
				{onOpenUsage && (
					<div className="sh-sheet-row">
						<dt>Usage</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenUsage}>
								Spend and tokens
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				{onOpenSessions && (
					<div className="sh-sheet-row">
						<dt>Sessions</dt>
						<dd>
							<button type="button" className="sh-sheet-link" onClick={onOpenSessions}>
								All projects
								<ChevronRight size={14} />
							</button>
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>Settings</dt>
					<dd>
						<button
							type="button"
							className="sh-sheet-link"
							onClick={() => {
								onClose();
								openSettings();
							}}
						>
							Theme, alerts, devices
							<ChevronRight size={14} />
						</button>
					</dd>
				</div>
			</dl>
			<div className="sh-shortcuts">
				<div className="sh-shortcuts-title">Shortcuts</div>
				{hints.map(shortcut => (
					<div key={shortcut.keys} className="sh-shortcut">
						<kbd>{shortcut.keys}</kbd>
						<span>{shortcut.action}</span>
					</div>
				))}
			</div>

			<button type="button" className="sh-btn sh-sheet-leave" onClick={onLeave}>
				<LogOut size={15} /> Leave session
			</button>
		</Sheet>
	);
}
