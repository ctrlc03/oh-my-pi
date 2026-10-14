import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { CompanionClient, CompanionDiag, CompanionPower, MaintainAction } from "../../lib/companion";
import { type DiagEvent, getEvents, mergeEvents, subscribeEvents } from "../../lib/diag-log";
import { fmtDuration } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import "./stats.css";
import "./diagnostics.css";

/** Newest events shown; the app keeps 50 and the companion 20. */
const EVENTS_SHOWN = 30;

function confirmText(action: MaintainAction, computer: string): string {
	switch (action) {
		case "restart-companion":
			return `Restart the companion? The app loses contact with ${computer} for a few seconds. Running sessions are not affected.`;
		case "update-omp":
			return `Update omp on ${computer}? This installs the newest release. Sessions already running keep the old version until they are restarted.`;
	}
}

const SOURCE_LABEL: Record<DiagEvent["source"], string> = {
	companion: "app → computer",
	session: "app → session",
	computer: "computer → relay",
};

export interface DiagnosticsPanelProps {
	client: CompanionClient;
	/** The computer's name, given when several are paired so the text can say which one; undefined: "your computer". */
	computerName?: string;
}

interface Reading {
	diag: CompanionDiag;
	rttMs: number;
	/** This device's clock minus the computer's: puts the computer's event times on this clock. */
	skewMs: number;
}

function powerText(power: CompanionPower | null): string {
	if (power === null) return "unknown";
	const charge = power.battery === null ? "" : ` · ${power.battery}%`;
	return power.source === "battery" ? `battery${charge}` : power.source === "ac" ? `mains${charge}` : "unknown";
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
	return (
		<div className="sh-diag-row">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

/** Connection health between this app, the companion on the computer, and the sessions it joins, plus computer maintenance. */
export function DiagnosticsPanel({ client, computerName }: DiagnosticsPanelProps): ReactNode {
	const yours = computerName ?? "your computer";
	const load = useCallback(async (): Promise<Reading> => {
		const rttMs = await client.measureRtt();
		const diag = await client.requestDiag();
		// The answer left the computer about half a round trip ago.
		return { diag, rttMs, skewMs: Date.now() - rttMs / 2 - diag.now };
	}, [client]);
	const { state, reload } = useRequest(load);
	// Keep the previous reading on screen (dimmed) while a refresh runs.
	const shown = useRef<Reading | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const reading = shown.current;
	const loading = state.status === "loading";
	const appEvents = useSyncExternalStore(subscribeEvents, getEvents);

	const [running, setRunning] = useState<MaintainAction | null>(null);
	const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
	const maintain = async (action: MaintainAction): Promise<void> => {
		if (running || !window.confirm(confirmText(action, yours))) return;
		setRunning(action);
		setOutcome(null);
		try {
			const text = await client.maintain(action);
			setOutcome({ ok: true, text });
			// The restart drops this link: there is nothing to refresh until it returns.
			if (action === "update-omp") reload();
		} catch (err) {
			setOutcome({ ok: false, text: err instanceof Error ? err.message : String(err) });
		} finally {
			setRunning(null);
		}
	};

	const diag = reading?.diag ?? null;
	const events = mergeEvents(appEvents, diag?.events ?? [], reading?.skewMs ?? 0).slice(0, EVENTS_SHOWN);

	return (
		<div className="sh-diag">
			<div className="sh-diag-bar">
				<span className="sh-field-hint">
					How this app reaches {yours}, and what {computerName ?? "the computer"} is doing.
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={reload}
					disabled={loading}
					aria-label="Refresh diagnostics"
				>
					{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
				</button>
			</div>
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">
						{state.message === "the companion did not answer"
							? `The companion did not answer. It may predate diagnostics: restart it on ${yours} to pick up the new version.`
							: state.message}
					</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{reading === null ? (
				state.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Measuring the connection…
					</div>
				)
			) : (
				<div className={loading ? "sh-stats-body sh-stats-stale" : "sh-stats-body"}>
					<section className="sh-stats-section" aria-label="Computer">
						<h2 className="sh-recents-title">Computer</h2>
						<dl className="sh-diag-list">
							<Row label="Companion build">
								{reading.diag.version ?? "unknown"}
								{reading.diag.dirty && <span className="sh-chip">modified</span>}
							</Row>
							<Row label="Omp">{reading.diag.omp ?? "not answering"}</Row>
							<Row label="Uptime">{fmtDuration(reading.diag.uptimeMs)}</Row>
							<Row label="Started by">{reading.diag.managed === "manual" ? "hand" : reading.diag.managed}</Row>
							<Row label="Keep awake">{reading.diag.keepAwake ? "held" : "not held"}</Row>
							<Row label="Power">{powerText(reading.diag.power)}</Row>
							<Row label="Session list">
								{reading.diag.listing.method}
								{reading.diag.listing.lastMs !== null && ` · ${fmtDuration(reading.diag.listing.lastMs)}`}
							</Row>
							<Row label="Devices">{reading.diag.devices}</Row>
						</dl>
					</section>
					<section className="sh-stats-section" aria-label="Connection">
						<h2 className="sh-recents-title">Connection</h2>
						<dl className="sh-diag-list">
							<Row label="Round trip">{fmtDuration(reading.rttMs)}</Row>
						</dl>
					</section>
					<section className="sh-stats-section" aria-label="Recent events">
						<h2 className="sh-recents-title">Recent events</h2>
						{events.length === 0 ? (
							<div className="sh-field-hint">Nothing yet.</div>
						) : (
							<ul className="sh-diag-events">
								{events.map(event => (
									<li
										key={`${event.at}:${event.source}:${event.kind}:${event.detail ?? ""}`}
										className={event.kind === "closed" ? "sh-diag-event sh-diag-event-bad" : "sh-diag-event"}
									>
										<span className="sh-diag-time">{new Date(event.at).toLocaleTimeString()}</span>
										<span className="sh-diag-source">{SOURCE_LABEL[event.source]}</span>
										<span>
											{event.kind}
											{event.detail && ` · ${event.detail}`}
										</span>
									</li>
								))}
							</ul>
						)}
					</section>
					{reading.diag.errors.length > 0 && (
						<section className="sh-stats-section" aria-label="Request errors">
							<h2 className="sh-recents-title">Request errors</h2>
							<ul className="sh-diag-events">
								{[...reading.diag.errors].reverse().map(error => (
									<li key={`${error.at}:${error.type}`} className="sh-diag-event sh-diag-event-bad">
										<span className="sh-diag-time">
											{new Date(error.at + reading.skewMs).toLocaleTimeString()}
										</span>
										<span className="sh-diag-source">{error.type}</span>
										<span>{error.message}</span>
									</li>
								))}
							</ul>
						</section>
					)}
					<section className="sh-stats-section" aria-label="Maintenance">
						<h2 className="sh-recents-title">Maintenance</h2>
						<div className="sh-card-actions">
							<button
								type="button"
								className="sh-btn sh-card-action"
								onClick={() => maintain("restart-companion")}
								disabled={running !== null || reading.diag.managed === "manual"}
							>
								{running === "restart-companion" && <LoaderCircle size={14} className="sh-spin" />} Restart
								companion
							</button>
							<button
								type="button"
								className="sh-btn sh-card-action"
								onClick={() => maintain("update-omp")}
								disabled={running !== null}
							>
								{running === "update-omp" && <LoaderCircle size={14} className="sh-spin" />} Update omp
							</button>
						</div>
						{reading.diag.managed === "manual" && (
							<div className="sh-field-hint">
								The companion was started by hand, so the app cannot restart it. <code>--install</code> makes
								the computer's service manager (launchd on macOS, systemd on Linux) run it.
							</div>
						)}
						{outcome &&
							(outcome.ok ? (
								<pre className="sh-diag-output">{outcome.text}</pre>
							) : (
								<div className="sh-connect-error">{outcome.text}</div>
							))}
					</section>
				</div>
			)}
		</div>
	);
}
