import type { WireLimitWindow } from "@oh-my-pi/pi-wire";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { UsageLimitsInfo } from "../../lib/client";
import { barPercent, clockLabel, countdown, groupWindows, usedPercent, windowTone } from "../../lib/usage-limits";
import { useNow } from "../../lib/use-now";
import "./limits.css";

/** A refresh with no answer after this long stops spinning. */
const REFRESH_TIMEOUT_MS = 12_000;
const TICK_MS = 30_000;

export interface LimitWindowsProps {
	/** The host's latest windows; null until the first arrives. */
	info: UsageLimitsInfo | null;
	/** Provider of the open session: its windows come first and are marked. */
	activeProvider: string | undefined;
	/** Ask the host to read the providers again; absent hides the button. */
	onRefresh?(): void;
}

function WindowRow({ window, now }: { window: WireLimitWindow; now: number }): ReactNode {
	const percent = usedPercent(window);
	const tone = windowTone(window);
	const reset =
		window.resetsAt === undefined
			? null
			: window.resetsAt <= now
				? "reset"
				: `resets ${clockLabel(window.resetsAt, now)} · in ${countdown(window.resetsAt, now)}`;
	return (
		<li className="sh-limit-row">
			<div className="sh-limit-line">
				<span className="sh-limit-label">{window.label}</span>
				{percent !== null && <span className={`sh-limit-pct sh-limit-${tone}`}>{`${percent}%`}</span>}
			</div>
			{percent !== null && (
				<div
					className="sh-limit-meter"
					role="progressbar"
					aria-label={`${window.label} used`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
				>
					<div
						className={`sh-limit-fill sh-limit-${tone}`}
						style={{ "--used": `${barPercent(window)}%` } as CSSProperties}
					/>
				</div>
			)}
			{reset !== null && <div className="sh-limit-reset">{reset}</div>}
		</li>
	);
}

/** The subscription windows the host reads from its providers: used share as a bar, the reset as a clock time and a countdown. */
export function LimitWindows({ info, activeProvider, onRefresh }: LimitWindowsProps): ReactNode {
	const now = useNow(TICK_MS);
	const [refreshing, setRefreshing] = useState(false);
	const fetchedAt = info?.fetchedAt;
	// A new read ends the spinner; so does waiting too long for one.
	useEffect(() => {
		setRefreshing(false);
	}, [fetchedAt]);
	useEffect(() => {
		if (!refreshing) return;
		const timer = setTimeout(() => setRefreshing(false), REFRESH_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [refreshing]);

	const groups = info === null ? [] : groupWindows(info.windows, activeProvider);
	return (
		<section className="sh-stats-section sh-limits" aria-label="Subscription limits">
			<div className="sh-stats-section-head">
				<h2 className="sh-recents-title">Limits</h2>
				{onRefresh !== undefined && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => {
							setRefreshing(true);
							onRefresh();
						}}
						disabled={refreshing}
						aria-label="Refresh limits"
						title="Refresh limits"
					>
						{refreshing ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
				)}
			</div>
			{info === null ? (
				<div className="sh-limit-empty">Reading limits…</div>
			) : groups.length === 0 ? (
				<div className="sh-limit-empty">No subscription limits are reported for this host's providers.</div>
			) : (
				groups.map(group => (
					<div key={group.key} className="sh-limit-group">
						<div className="sh-limit-group-head">
							<span className="sh-limit-provider">{group.provider}</span>
							{group.account !== undefined && <span className="sh-sheet-faint">{group.account}</span>}
							{group.active && <span className="sh-limit-tag">this session</span>}
						</div>
						<ul className="sh-limit-list">
							{group.windows.map((window, index) => (
								<WindowRow key={`${window.windowId ?? window.label}:${index}`} window={window} now={now} />
							))}
						</ul>
					</div>
				))
			)}
		</section>
	);
}
