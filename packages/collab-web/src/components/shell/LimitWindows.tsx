import type { WireLimitWindow } from "@oh-my-pi/pi-wire";
import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { type AccountsSection, limitSections } from "../../lib/accounts";
import type { UsageLimitsInfo } from "../../lib/client";
import type { CompanionClient } from "../../lib/companion";
import { barPercent, clockLabel, countdown, groupWindows, usedPercent, windowTone } from "../../lib/usage-limits";
import { type AccountsControl, useAccounts } from "../../lib/use-accounts";
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
	/**
	 * The companion of the computer that hosts the session, when this device may change that computer's
	 * settings and it advertises `canAccounts`; null or absent keeps the windows but offers no account choice.
	 */
	accountsClient?: CompanionClient | null;
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

function WindowList({ windows, now }: { windows: readonly WireLimitWindow[]; now: number }): ReactNode {
	return (
		<ul className="sh-limit-list">
			{windows.map((window, index) => (
				<WindowRow key={`${window.windowId ?? window.label}:${index}`} window={window} now={now} />
			))}
		</ul>
	);
}

/**
 * A provider with several stored accounts: each with its own windows, the one new sessions start on marked,
 * and *Use this account* to change it. With no default the provider is automatic, which is how omp works
 * unless told otherwise: it ranks the accounts by usage headroom for every new session.
 */
function AccountsBlock({
	section,
	now,
	control,
}: {
	section: AccountsSection;
	now: number;
	control: AccountsControl;
}): ReactNode {
	const waiting = control.switching === section.provider;
	return (
		<div className="sh-limit-group">
			<div className="sh-limit-group-head">
				<span className="sh-limit-provider">{section.provider}</span>
				<span className="sh-sheet-faint">{section.accounts.length} accounts</span>
				{section.active && <span className="sh-limit-tag">this session</span>}
			</div>
			<div className="sh-field-hint">
				{section.automatic
					? "Automatic: each new session starts on the account with the most room left."
					: "New sessions start on the default account. Sessions already running keep theirs."}
			</div>
			{section.accounts.map(entry => (
				<div
					key={entry.row.identityKey}
					className={entry.row.preferred ? "sh-limit-account sh-limit-account-on" : "sh-limit-account"}
				>
					<div className="sh-limit-account-head">
						<span className="sh-limit-account-name">{entry.label}</span>
						{entry.row.orgName !== undefined && <span className="sh-sheet-faint">{entry.row.orgName}</span>}
						{entry.row.preferred ? (
							<span className="sh-limit-tag">
								<Check size={12} aria-hidden /> Default
							</span>
						) : (
							<button
								type="button"
								className="sh-btn sh-limit-use"
								disabled={waiting}
								onClick={() => control.use({ provider: section.provider, identityKey: entry.row.identityKey })}
							>
								Use this account
							</button>
						)}
					</div>
					{entry.windows.length > 0 ? (
						<WindowList windows={entry.windows} now={now} />
					) : (
						<div className="sh-limit-empty">No limits reported for this account.</div>
					)}
				</div>
			))}
			{section.unattributed.map(group => (
				<div key={group.key} className="sh-limit-account">
					<div className="sh-limit-account-head">
						<span className="sh-limit-account-name">{group.account ?? "Unnamed account"}</span>
						<span className="sh-sheet-faint">more than one account answers to this name</span>
					</div>
					<WindowList windows={group.windows} now={now} />
				</div>
			))}
			{!section.automatic && (
				<button
					type="button"
					className="sh-btn sh-limit-auto"
					disabled={waiting}
					onClick={() => control.use({ provider: section.provider, identityKey: null })}
				>
					{waiting ? <LoaderCircle size={14} className="sh-spin" /> : null} Back to automatic
				</button>
			)}
		</div>
	);
}

/** The subscription windows the host reads from its providers: used share as a bar, the reset as a clock time and a countdown. */
export function LimitWindows({ info, activeProvider, onRefresh, accountsClient = null }: LimitWindowsProps): ReactNode {
	const now = useNow(TICK_MS);
	const accounts = useAccounts(accountsClient);
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

	const sections = limitSections(info === null ? [] : groupWindows(info.windows, activeProvider), accounts.rows, activeProvider);
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
			) : sections.length === 0 ? (
				<div className="sh-limit-empty">No subscription limits are reported for this host's providers.</div>
			) : (
				sections.map(section =>
					section.kind === "accounts" ? (
						<AccountsBlock key={`accounts:${section.provider}`} section={section} now={now} control={accounts} />
					) : (
						<div key={section.group.key} className="sh-limit-group">
							<div className="sh-limit-group-head">
								<span className="sh-limit-provider">{section.group.provider}</span>
								{section.group.account !== undefined && (
									<span className="sh-sheet-faint">{section.group.account}</span>
								)}
								{section.group.active && <span className="sh-limit-tag">this session</span>}
							</div>
							<WindowList windows={section.group.windows} now={now} />
						</div>
					),
				)
			)}
			{accounts.error !== null && <div className="sh-connect-error">{accounts.error}</div>}
		</section>
	);
}
