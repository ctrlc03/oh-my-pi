import type { SessionCommand, SessionHeader, SessionState, WireModel } from "@oh-my-pi/pi-wire";
import { Ellipsis, LogOut, PanelLeft, PanelRight, Search, ShieldCheck, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useState } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import type { SessionUsage } from "../../lib/usage";
import { OmpMark } from "./OmpMark";
import { SessionSheet } from "./SessionSheet";
import { ThemeToggle } from "./ThemeToggle";

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
	chat: boolean;
	onChatChange(chat: boolean): void;
	changeCount: number;
	onOpenChanges(): void;
	/** Usage and all-sessions screens; null when no computer is paired. */
	onOpenUsage: (() => void) | null;
	onOpenSessions: (() => void) | null;
	/** Code map of the session's repository; null unless the paired computer can build one. */
	onOpenCodemap: (() => void) | null;
	/** The session's terminal (tmux pane); null unless the paired computer hosts this session. */
	onOpenPane: (() => void) | null;
	/** The paired computer can show this session's git working tree. */
	workingTree: boolean;
	/** Cost and token totals for the session sheet; null when no message reported usage. */
	sessionUsage: SessionUsage | null;
	/** Models this writer may switch to; null when the host predates session controls. */
	models: readonly WireModel[] | null;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	push: PushControl;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	sandboxed,
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
	onChatChange,
	changeCount,
	onOpenChanges,
	onOpenUsage,
	onOpenSessions,
	onOpenCodemap,
	onOpenPane,
	workingTree,
	sessionUsage,
	models,
	onSessionCommand,
	push,
}: HeaderBarProps): ReactNode {
	const title = header?.title ?? state?.sessionName ?? "session";
	const [sheetOpen, setSheetOpen] = useState(false);
	const closeSheet = useCallback(() => setSheetOpen(false), []);
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
						title={sidebarAlert ? "sessions · one needs input" : sidebarOpen ? "hide sessions" : "show sessions"}
						aria-label={
							sidebarAlert
								? "sessions, another session needs input"
								: sidebarOpen
									? "hide sessions"
									: "show sessions"
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
								aria-label="sandboxed"
								title="sandboxed: file tools only, edits stay in its folder"
							>
								<ShieldCheck size={12} />
							</span>
						)}
						{state?.cwd && <span className="sh-cwd">{shortenPath(state.cwd)}</span>}
					</span>
				</button>
			</div>
			<div className="sh-header-right">
				<span className={`sh-status sh-status-${phase}`} title={`connection: ${phase}`}>
					<span className={`sh-dot sh-dot-${phase}`} />
					{PHASE_LABEL[phase]}
				</span>
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<ThemeToggle />
				<button
					type="button"
					className={searchOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleSearch}
					title="find in session"
					aria-label="find in session"
					aria-pressed={searchOpen}
				>
					<Search size={16} />
				</button>
				{onOpenCodemap && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-codemap-toggle"
						onClick={onOpenCodemap}
						title="code map"
						aria-label="code map"
					>
						<Waypoints size={16} />
					</button>
				)}
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
					aria-label={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={16} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-leave"
					onClick={onLeave}
					title="leave session"
					aria-label="leave session"
				>
					<LogOut size={16} />
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-mobile-only"
					onClick={() => setSheetOpen(true)}
					aria-label="session details"
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
					contextPct={pct}
					chat={chat}
					onChatChange={onChatChange}
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
					onOpenPane={
						onOpenPane &&
						(() => {
							setSheetOpen(false);
							onOpenPane();
						})
					}
					workingTree={workingTree}
					usage={sessionUsage}
					models={models}
					onSessionCommand={onSessionCommand}
					push={push}
					onLeave={onLeave}
					onClose={closeSheet}
				/>
			)}
		</header>
	);
});
