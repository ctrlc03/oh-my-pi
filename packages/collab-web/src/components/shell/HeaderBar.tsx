import type { SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { Ellipsis, LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useState } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";
import { SessionSheet } from "./SessionSheet";

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
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	subCount,
	railOpen,
	onToggleRail,
	onLeave,
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
					contextPct={pct}
					onLeave={onLeave}
					onClose={closeSheet}
				/>
			)}
		</header>
	);
});
