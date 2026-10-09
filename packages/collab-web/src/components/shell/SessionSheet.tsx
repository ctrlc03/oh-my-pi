import type { SessionState } from "@oh-my-pi/pi-wire";
import { ChevronRight, type LucideIcon, LogOut, MessageSquare, Monitor, Moon, Rows3, Sun, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { PushButton } from "./CompanionCard";
import { Sheet } from "./Sheet";

const THEMES: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
	{ value: "system", label: "System", Icon: Monitor },
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
];

const VIEWS: readonly { chat: boolean; label: string; Icon: LucideIcon }[] = [
	{ chat: true, label: "Chat", Icon: MessageSquare },
	{ chat: false, label: "Full", Icon: Rows3 },
];

const PUSH_LABEL: Record<PushControl["status"], string> = {
	unsupported: "",
	off: "Off",
	on: "On",
	busy: "…",
	denied: "Blocked in settings",
};

export interface SessionSheetProps {
	title: string;
	state: SessionState | null;
	phase: ConnectionPhase;
	phaseLabel: string;
	readOnly: boolean;
	contextPct: number | null;
	/** Chat view: prompts and replies only, tool runs folded. */
	chat: boolean;
	onChatChange(chat: boolean): void;
	/** Files the agent changed this session. */
	changeCount: number;
	onOpenChanges(): void;
	push: PushControl;
	onLeave(): void;
	onClose(): void;
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
	contextPct,
	chat,
	onChatChange,
	changeCount,
	onOpenChanges,
	push,
	onLeave,
	onClose,
}: SessionSheetProps): ReactNode {
	const { preference, setPreference } = useThemePreference();

	return (
		<Sheet label="session details" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{title}</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{state?.cwd && <div className="sh-sheet-cwd">{state.cwd}</div>}

			<dl className="sh-sheet-rows">
				<div className="sh-sheet-row">
					<dt>Connection</dt>
					<dd>
						<span className={`sh-dot sh-dot-${phase}`} />
						{phaseLabel}
						{readOnly && <span className="sh-chip">read-only</span>}
					</dd>
				</div>
				{state?.model && (
					<div className="sh-sheet-row">
						<dt>Model</dt>
						<dd className="sh-sheet-mono">
							{state.model.name}
							{state.thinkingLevel && <span className="sh-sheet-faint"> · {state.thinkingLevel}</span>}
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
						<div className="sh-segmented" role="radiogroup" aria-label="transcript view">
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
				<div className="sh-sheet-row">
					<dt>Changes</dt>
					<dd>
						<button type="button" className="sh-sheet-link" onClick={onOpenChanges} disabled={changeCount === 0}>
							{changeCount === 0 ? "No files yet" : `${changeCount} file${changeCount === 1 ? "" : "s"}`}
							{changeCount > 0 && <ChevronRight size={14} />}
						</button>
					</dd>
				</div>
				{push.status !== "unsupported" && (
					<div className="sh-sheet-row">
						<dt>Notify</dt>
						<dd>
							<PushButton push={push} />
							<span className="sh-sheet-faint">{PUSH_LABEL[push.status]}</span>
						</dd>
					</div>
				)}
				<div className="sh-sheet-row">
					<dt>Theme</dt>
					<dd>
						<div className="sh-segmented" role="radiogroup" aria-label="theme">
							{THEMES.map(({ value, label, Icon }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={preference === value}
									className={preference === value ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => setPreference(value)}
								>
									<Icon size={14} /> {label}
								</button>
							))}
						</div>
					</dd>
				</div>
			</dl>
			{push.error && <div className="sh-connect-error">{push.error}</div>}

			<button type="button" className="sh-btn sh-sheet-leave" onClick={onLeave}>
				<LogOut size={15} /> Leave session
			</button>
		</Sheet>
	);
}
