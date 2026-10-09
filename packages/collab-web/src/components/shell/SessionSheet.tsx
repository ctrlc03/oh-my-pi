import type { SessionState } from "@oh-my-pi/pi-wire";
import { type LucideIcon, LogOut, Monitor, Moon, Sun, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent } from "../../lib/format";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

const THEMES: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
	{ value: "system", label: "System", Icon: Monitor },
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
];

export interface SessionSheetProps {
	title: string;
	state: SessionState | null;
	phase: ConnectionPhase;
	phaseLabel: string;
	readOnly: boolean;
	contextPct: number | null;
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
	onLeave,
	onClose,
}: SessionSheetProps): ReactNode {
	const { preference, setPreference } = useThemePreference();

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Portaled: the glass header's backdrop-filter would otherwise become the
	// containing block for this fixed-position sheet.
	return createPortal(
		<>
			<div className="sh-sheet-backdrop" onClick={onClose} />
			<div className="sh-sheet" role="dialog" aria-label="session details">
				<div className="sh-sheet-grip" aria-hidden />
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

				<button type="button" className="sh-btn sh-sheet-leave" onClick={onLeave}>
					<LogOut size={15} /> Leave session
				</button>
			</div>
		</>,
		document.body,
	);
}
