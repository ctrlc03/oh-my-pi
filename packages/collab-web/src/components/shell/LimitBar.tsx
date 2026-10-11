import type { SessionCommand, SessionLimited, WireModel } from "@oh-my-pi/pi-wire";
import { ArrowLeftRight, BellOff, Hourglass, Play, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { UsageLimitsInfo } from "../../lib/client";
import { canResumeAtReset, clockLabel, limitedText } from "../../lib/usage-limits";
import { useNow } from "../../lib/use-now";
import { LimitWindows } from "./LimitWindows";
import { ModelList } from "./ModelControls";
import { Sheet } from "./Sheet";
import "./limits.css";

const TICK_MS = 30_000;

export interface LimitsSheetProps {
	info: UsageLimitsInfo | null;
	/** Provider of the open session. */
	activeProvider: string | undefined;
	/** Models this writer may switch to; null for view-only guests and hosts without `session-cmd`. */
	models: readonly WireModel[] | null;
	model: WireModel | undefined;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	onClose(): void;
}

/** The limit windows, plus (for writers) the model list, so a limited session can move to another provider. */
export function LimitsSheet({
	info,
	activeProvider,
	models,
	model,
	onSessionCommand,
	onClose,
}: LimitsSheetProps): ReactNode {
	return (
		<Sheet label="usage limits" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Usage limits</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-stats-body">
				<LimitWindows
					info={info}
					activeProvider={activeProvider}
					onRefresh={() => onSessionCommand("usage-limits", "refresh")}
				/>
				{models !== null && models.length > 0 && (
					<section className="sh-stats-section" aria-label="switch model">
						<h2 className="sh-recents-title">Switch model now</h2>
						<ModelList
							models={models}
							current={model}
							onChange={spec => onSessionCommand("model", spec)}
							onDone={onClose}
						/>
					</section>
				)}
			</div>
		</Sheet>
	);
}

export interface LimitBarProps {
	/** The host's limited stage; absent while the session is not limited (or the host predates `usage-limits`). */
	limited: SessionLimited | undefined;
	info: UsageLimitsInfo | null;
	models: readonly WireModel[] | null;
	model: WireModel | undefined;
	readOnly: boolean;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	/** Snooze the session in the sessions list until the limit resets; absent hides the action. */
	onSnooze?(until: number): void;
}

/**
 * Shown above the composer while the session's account is at its usage limit: when it resets, and what
 * to do meanwhile: have the host continue by itself at the reset, snooze the session until then, or
 * switch to a model on another account.
 */
export function LimitBar({
	limited,
	info,
	models,
	model,
	readOnly,
	onSessionCommand,
	onSnooze,
}: LimitBarProps): ReactNode {
	const now = useNow(TICK_MS, limited !== undefined);
	const [sheet, setSheet] = useState(false);
	const [snoozed, setSnoozed] = useState(false);
	if (limited === undefined) return null;
	const until = limited.until;
	const armed = limited.resumeAt;
	return (
		<div className="sh-limit-bar" role="status">
			<div className="sh-limit-bar-msg">
				<Hourglass size={14} aria-hidden />
				<span className="sh-limit-bar-text">
					{armed === undefined
						? limitedText(limited, now)
						: `${limitedText(limited, now)} · continuing at ${clockLabel(armed, now)}`}
				</span>
			</div>
			<div className="sh-limit-bar-actions">
				{!readOnly && armed !== undefined && (
					<button type="button" className="sh-btn" onClick={() => onSessionCommand("resume-cancel")}>
						<X size={14} aria-hidden /> Cancel resume
					</button>
				)}
				{!readOnly && armed === undefined && canResumeAtReset(limited, now) && (
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => onSessionCommand("resume-at-reset")}
					>
						<Play size={14} aria-hidden /> Resume at reset
					</button>
				)}
				{onSnooze !== undefined && until !== undefined && until > now && (
					<button
						type="button"
						className="sh-btn"
						disabled={snoozed}
						onClick={() => {
							onSnooze(until);
							setSnoozed(true);
						}}
					>
						<BellOff size={14} aria-hidden /> {snoozed ? "Snoozed" : "Snooze until reset"}
					</button>
				)}
				<button type="button" className="sh-btn" onClick={() => setSheet(true)}>
					<ArrowLeftRight size={14} aria-hidden /> {readOnly || models === null ? "Limits" : "Switch model"}
				</button>
			</div>
			{sheet && (
				<LimitsSheet
					info={info}
					activeProvider={limited.provider}
					models={readOnly ? null : models}
					model={model}
					onSessionCommand={onSessionCommand}
					onClose={() => setSheet(false)}
				/>
			)}
		</div>
	);
}
