import type { AgentRef, SessionCommand, SessionHeader, SessionState, WireModel } from "@oh-my-pi/pi-wire";
import {
	Ellipsis,
	GitPullRequest,
	LogOut,
	PanelLeft,
	PanelRight,
	Search,
	Settings,
	ShieldAlert,
	ShieldCheck,
	SquareCode,
	Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import type { ConnectionPhase, ContextItemsInfo } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { openSettings } from "../../lib/settings-ui";
import { shortcutKeys, useOverrides } from "../../lib/shortcuts";
import type { SessionUsage } from "../../lib/usage";
import { AgentChip } from "./AgentChip";
import { OmpMark } from "./OmpMark";
import { SessionSheet } from "./SessionSheet";
import type { TurnUndoControl } from "./TurnUndo";

const PHASE_LABEL: Record<ConnectionPhase, string> = {
	connecting: "Connecting",
	waiting: "Joining",
	live: "Live",
	reconnecting: "Reconnecting",
	ended: "Ended",
};

export interface HeaderBarProps {
	header: SessionHeader | null;
	state: SessionState | null;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** The paired computer reports this session as sandboxed (file tools only, edits confined to its folder). */
	sandboxed: boolean;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	searchOpen: boolean;
	onToggleSearch(): void;
	/** Toggles the sessions sidebar; null when there is nothing to list. */
	onToggleSidebar: (() => void) | null;
	sidebarOpen: boolean;
	/** Another session on the paired computer is waiting for input. */
	sidebarAlert: boolean;
	/** The vendor agent behind this session (Claude Code, Codex, …); null for an omp session. */
	agent: AgentRef | null;
	/** The host advertises `permission-mode`: the session sheet offers Supervised / Full access. */
	canPermission: boolean;
	chat: boolean;
	/** The session sheet; the app owns it so a shortcut can open it. */
	sheetOpen: boolean;
	setSheetOpen(open: boolean): void;
	onChatChange(chat: boolean): void;
	/** Latest turns this device keeps showing (null: all); undefined until the session is known. */
	keepTurns: number | null | undefined;
	onKeepTurnsChange(keep: number | null): void;
	changeCount: number;
	onOpenChanges(): void;
	/** Usage and all-sessions screens; null when no computer is paired. */
	onOpenUsage: (() => void) | null;
	onOpenSessions: (() => void) | null;
	/** Code map of the session's repository; null unless the paired computer can build one. */
	onOpenCodemap: (() => void) | null;
	/** Architecture maps of the session's repository; null unless the paired computer can make them. */
	onOpenArchitecture: (() => void) | null;
	/** A changes map of this session's edits; null unless maps can be made and files changed. */
	onMapChanges: (() => void) | null;
	/** A quiz on this session's changes; null unless quizzes can be written and files changed. */
	onQuizChanges: (() => void) | null;
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
	/** Scripts and build targets of the session's repository, run on the computer; null unless allowed for this session. */
	onOpenRun: (() => void) | null;
	/** Images the agent's tools produced this session. */
	screenCount: number;
	onOpenScreens(): void;
	/** The paired computer can show this session's git working tree. */
	workingTree: boolean;
	/** Cost and token totals for the session sheet; null when no message reported usage. */
	sessionUsage: SessionUsage | null;
	/** Models this writer may switch to; null when the host predates session controls. */
	models: readonly WireModel[] | null;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	/** Undo and redo of the last turn; undefined unless the host advertises `undo` and this guest may write. */
	turnUndo: TurnUndoControl | undefined;
	/** Host ranking of what fills the context; undefined unless the host advertises `context-items`, null until it replies. */
	contextItems: ContextItemsInfo | null | undefined;
	/** The host can watch pull requests (feature `pr-watch`). */
	canWatchPr: boolean;
	/** The session as Markdown, built on demand from every entry (not the trimmed view). Stable across renders. */
	exportMarkdown(title: string): string;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	sandboxed,
	agent,
	canPermission,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
	searchOpen,
	onToggleSearch,
	onToggleSidebar,
	sidebarOpen,
	sidebarAlert,
	chat,
	sheetOpen,
	setSheetOpen,
	onChatChange,
	keepTurns,
	onKeepTurnsChange,
	changeCount,
	onOpenChanges,
	onOpenUsage,
	onOpenSessions,
	onOpenCodemap,
	onOpenArchitecture,
	onMapChanges,
	onQuizChanges,
	onOpenPane,
	onOpenPreview,
	onOpenGithub,
	onOpenEditor,
	onOpenTimeline,
	onOpenRun,
	screenCount,
	onOpenScreens,
	workingTree,
	sessionUsage,
	models,
	onSessionCommand,
	turnUndo,
	contextItems,
	canWatchPr,
	exportMarkdown,
}: HeaderBarProps): ReactNode {
	useOverrides();
	// The live name first: `header.title` is the session file's title as of joining.
	const title = state?.sessionName ?? header?.title ?? "session";
	const closeSheet = useCallback(() => setSheetOpen(false), [setSheetOpen]);
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				{onToggleSidebar && (
					<button
						type="button"
						className={
							sidebarOpen
								? "sh-btn sh-btn-icon sh-btn-on sh-sidebar-toggle"
								: "sh-btn sh-btn-icon sh-sidebar-toggle"
						}
						onClick={onToggleSidebar}
						title={sidebarAlert ? "Sessions · one needs input" : sidebarOpen ? "Hide sessions" : "Show sessions"}
						data-shortcut={shortcutKeys("sidebar")}
						aria-label={
							sidebarAlert
								? "Sessions, another session needs input"
								: sidebarOpen
									? "Hide sessions"
									: "Show sessions"
						}
						aria-pressed={sidebarOpen}
					>
						<PanelLeft size={16} />
						{sidebarAlert && <span className="sh-badge sh-badge-dot" />}
					</button>
				)}
				<span className="sh-brand" aria-label="omp collab">
					<OmpMark />
					<span className="sh-brand-slash">/</span>
				</span>
				<button
					type="button"
					className="sh-title-block"
					onClick={() => setSheetOpen(true)}
					title={state?.cwd ? `${title}\n${state.cwd}` : title}
				>
					<span className="sh-title">{title}</span>
					<span className="sh-title-sub">
						<span className={`sh-dot sh-dot-${phase} sh-mobile-only`} />
						{sandboxed && (
							<span
								className="sh-sandboxed-mark"
								role="img"
								aria-label="Sandboxed"
								data-tip="Sandboxed: file tools only, edits stay in its folder"
							>
								<ShieldCheck size={12} />
							</span>
						)}
						<AgentChip agent={agent} variant="mark" />
						{state?.permission === "full" && (
							<span
								className="sh-agent-mark sh-agent-mark-warn"
								role="img"
								aria-label="Full access"
								data-tip="Full access: every tool call runs without asking"
							>
								<ShieldAlert size={12} />
							</span>
						)}
						{state?.cwd && <span className="sh-cwd">{shortenPath(state.cwd)}</span>}
					</span>
				</button>
			</div>
			<div className="sh-header-right">
				<span
					className={`sh-status sh-status-${phase}`}
					data-tip={`Connection: ${PHASE_LABEL[phase].toLowerCase()}`}
				>
					<span className={`sh-dot sh-dot-${phase}`} />
					{PHASE_LABEL[phase]}
				</span>
				{readOnly && (
					<span className="sh-chip" data-tip="You joined with a read-only link: watching only">
						Read-only
					</span>
				)}
				{/* The composer shows model and thinking level, except where a read-only guest has none. */}
				{readOnly && state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{readOnly && state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						role="img"
						aria-label={`Context ${fmtPercent(pct)} full`}
						data-tip={`Context ${fmtPercent(pct)} full`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars" role="group" aria-label="People in this session">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								role="img"
								aria-label={`${p.name}, ${p.role}${p.readOnly ? ", view-only" : ""}`}
								data-tip={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<button
					type="button"
					className="sh-settings-toggle"
					onClick={() => openSettings()}
					data-shortcut={shortcutKeys("settings")}
					aria-label="Open settings"
				>
					<Settings size={16} />
				</button>
				<button
					type="button"
					className={searchOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleSearch}
					title="Find in session"
					data-shortcut={shortcutKeys("find")}
					aria-label="Find in session"
					aria-pressed={searchOpen}
				>
					<Search size={16} />
				</button>
				{onOpenEditor && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onOpenEditor}
						title="Editor"
						aria-label="Editor"
					>
						<SquareCode size={16} />
					</button>
				)}
				{onOpenCodemap && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-codemap-toggle"
						onClick={onOpenCodemap}
						title="Code map"
						aria-label="Code map"
					>
						<Waypoints size={16} />
					</button>
				)}
				{onOpenGithub && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-github-toggle"
						onClick={onOpenGithub}
						aria-label="Open issues and pull requests"
					>
						<GitPullRequest size={16} />
					</button>
				)}
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "Hide agents" : "Show agents"}
					aria-label={`${railOpen ? "Hide" : "Show"} agents${subCount > 0 ? `, ${subCount} active` : ""}`}
				>
					<PanelRight size={16} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-leave"
					onClick={onLeave}
					title="Leave session"
					aria-label="Leave session"
				>
					<LogOut size={16} />
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-mobile-only"
					onClick={() => setSheetOpen(true)}
					aria-label="Session details"
				>
					<Ellipsis size={18} />
				</button>
			</div>
			{sheetOpen && (
				<SessionSheet
					title={title}
					state={state}
					phase={phase}
					phaseLabel={PHASE_LABEL[phase]}
					readOnly={readOnly}
					sandboxed={sandboxed}
					agent={agent}
					canPermission={canPermission}
					contextPct={pct}
					chat={chat}
					onChatChange={onChatChange}
					keepTurns={keepTurns}
					onKeepTurnsChange={onKeepTurnsChange}
					changeCount={changeCount}
					onOpenChanges={() => {
						setSheetOpen(false);
						onOpenChanges();
					}}
					onOpenUsage={
						onOpenUsage &&
						(() => {
							setSheetOpen(false);
							onOpenUsage();
						})
					}
					onOpenSessions={
						onOpenSessions &&
						(() => {
							setSheetOpen(false);
							onOpenSessions();
						})
					}
					onOpenCodemap={
						onOpenCodemap &&
						(() => {
							setSheetOpen(false);
							onOpenCodemap();
						})
					}
					onOpenArchitecture={
						onOpenArchitecture &&
						(() => {
							setSheetOpen(false);
							onOpenArchitecture();
						})
					}
					onMapChanges={
						onMapChanges &&
						(() => {
							setSheetOpen(false);
							onMapChanges();
						})
					}
					onQuizChanges={
						onQuizChanges &&
						(() => {
							setSheetOpen(false);
							onQuizChanges();
						})
					}
					onOpenPane={
						onOpenPane &&
						(() => {
							setSheetOpen(false);
							onOpenPane();
						})
					}
					onOpenPreview={
						onOpenPreview &&
						(() => {
							setSheetOpen(false);
							onOpenPreview();
						})
					}
					onOpenGithub={
						onOpenGithub &&
						(() => {
							setSheetOpen(false);
							onOpenGithub();
						})
					}
					onOpenEditor={
						onOpenEditor &&
						(() => {
							setSheetOpen(false);
							onOpenEditor();
						})
					}
					onOpenTimeline={
						onOpenTimeline &&
						(() => {
							setSheetOpen(false);
							onOpenTimeline();
						})
					}
					onOpenRun={
						onOpenRun &&
						(() => {
							setSheetOpen(false);
							onOpenRun();
						})
					}
					screenCount={screenCount}
					onOpenScreens={() => {
						setSheetOpen(false);
						onOpenScreens();
					}}
					workingTree={workingTree}
					usage={sessionUsage}
					models={models}
					onSessionCommand={onSessionCommand}
					turnUndo={turnUndo}
					contextItems={contextItems}
					canWatchPr={canWatchPr}
					exportMarkdown={exportMarkdown}
					onLeave={onLeave}
					onClose={closeSheet}
				/>
			)}
		</header>
	);
});
