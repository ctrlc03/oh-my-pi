import {
	BatteryMedium,
	BatteryWarning,
	Bell,
	BellOff,
	ChartColumn,
	Laptop,
	LayoutList,
	LoaderCircle,
	Moon,
	Plus,
	RefreshCw,
	Share2,
	ShieldCheck,
	Unlink,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionPower,
	LOW_BATTERY_PCT,
} from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import { extractLink } from "../../lib/rooms";
import type { CompanionHandle } from "../../lib/use-companion";
import { SessionsSheet } from "./SessionsSheet";
import { StartSessionSheet } from "./StartSessionSheet";
import { UsageSheet } from "./UsageSheet";

export interface CompanionCardProps {
	companion: CompanionHandle;
	push: PushControl;
	onJoin(link: string): void;
	onUnpair(): void;
}

export function hostTitle(host: { sessionName: string | null; cwd: string }): string {
	return host.sessionName || host.cwd.split("/").filter(Boolean).pop() || "session";
}

/** Live list of every collab session on the paired computer; tap one to join it. */
export function CompanionCard({ companion, push, onJoin, onUnpair }: CompanionCardProps): ReactNode {
	const { client, snap } = companion;
	const [error, setError] = useState<string | null>(null);
	const [joining, setJoining] = useState<string | null>(null);
	const live = snap.phase === "live";

	const [starting, setStarting] = useState(false);
	const [statsSheet, setStatsSheet] = useState<"usage" | "sessions" | null>(null);

	/** Open a hosted session's control link. */
	const open = async (instanceId: string): Promise<void> => {
		if (!client) throw new Error("no paired computer");
		const link = extractLink(await client.requestLink(instanceId));
		if (!link) throw new Error("the computer returned an unreadable link");
		onJoin(link);
	};

	const join = async (host: CompanionHost): Promise<void> => {
		if (joining) return;
		setJoining(host.instanceId);
		setError(null);
		try {
			await open(host.instanceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(null);
		}
	};

	/** Make an idle session host collab, then join it. */
	const shareIdle = async (instanceId: string): Promise<void> => {
		if (!client) throw new Error("no paired computer");
		const link = extractLink(await client.shareSession(instanceId));
		if (!link) throw new Error("the computer returned an unreadable link");
		onJoin(link);
	};

	const share = async (session: CompanionIdleSession): Promise<void> => {
		if (joining) return;
		setJoining(session.instanceId);
		setError(null);
		try {
			await shareIdle(session.instanceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(null);
		}
	};

	const shown = companion.error ?? error ?? push.error;
	return (
		<section className="sh-connect-card sh-recents sh-companion" aria-label="sessions on your computer">
			<div className="sh-companion-head">
				<h2 className="sh-recents-title">
					<Laptop size={14} />
					{snap.machine ?? "Your computer"}
					<span className={`sh-dot${live ? " sh-dot-live" : ""}`} aria-label={live ? "online" : "offline"} />
				</h2>
				<span className="sh-companion-actions">
					<PushButton push={push} />
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onUnpair}
						aria-label="unpair this computer"
						title="unpair"
					>
						<Unlink size={15} />
					</button>
				</span>
			</div>
			{live && <PowerNote power={snap.power} />}
			{client &&
				(snap.phase === "offline" ? (
					<div className="sh-companion-offline">
						<span>{snap.error ?? "Your computer is unreachable."}</span>
						<button type="button" className="sh-btn" onClick={() => client.connect()}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				) : snap.phase === "connecting" && snap.hosts.length === 0 ? (
					<div className="sh-companion-empty">Connecting…</div>
				) : (
					<>
						{snap.hosts.length === 0 ? (
							<div className="sh-companion-empty">
								No session is sharing. Run <code>/collab</code> in omp.
							</div>
						) : (
							<HostList hosts={snap.hosts} joining={joining} disabled={!live} onJoin={join} />
						)}
						<IdleList idle={snap.idle} joining={joining} disabled={!live} onShare={share} />
						<div className="sh-card-actions">
							{snap.canStart && live && (
								<button type="button" className="sh-btn sh-card-action" onClick={() => setStarting(true)}>
									<Plus size={15} /> Start session
								</button>
							)}
							{live && (
								<>
									<button
										type="button"
										className="sh-btn sh-card-action"
										onClick={() => setStatsSheet("usage")}
									>
										<ChartColumn size={15} /> Usage
									</button>
									<button
										type="button"
										className="sh-btn sh-card-action"
										onClick={() => setStatsSheet("sessions")}
									>
										<LayoutList size={15} /> All sessions
									</button>
								</>
							)}
						</div>
					</>
				))}
			{shown && <div className="sh-connect-error">{shown}</div>}
			{starting && client && (
				<StartSessionSheet
					client={client}
					canSandbox={snap.canSandbox}
					onOpen={open}
					onClose={() => setStarting(false)}
				/>
			)}
			{statsSheet === "usage" && client && <UsageSheet client={client} onClose={() => setStatsSheet(null)} />}
			{statsSheet === "sessions" && client && (
				<SessionsSheet
					client={client}
					canStart={snap.canStart}
					onOpenHost={open}
					onOpenLink={onJoin}
					onClose={() => setStatsSheet(null)}
				/>
			)}
		</section>
	);
}

/** Bell toggle for companion notifications; renders nothing where push is unavailable. */
export function PushButton({ push }: { push: PushControl }): ReactNode {
	if (push.status === "unsupported") return null;
	const on = push.status === "on";
	const label =
		push.status === "denied"
			? "notifications are blocked in settings"
			: on
				? "turn notifications off"
				: "notify me when a session needs input or finishes";
	return (
		<button
			type="button"
			className={on ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
			onClick={push.toggle}
			disabled={push.status === "busy" || push.status === "denied"}
			aria-label={label}
			aria-pressed={on}
			title={label}
		>
			{push.status === "busy" ? (
				<LoaderCircle size={15} className="sh-spin" />
			) : on ? (
				<Bell size={15} />
			) : (
				<BellOff size={15} />
			)}
		</button>
	);
}

export interface HostListProps {
	hosts: readonly CompanionHost[];
	/** instanceId whose link is being fetched. */
	joining: string | null;
	disabled: boolean;
	/** The session on screen: marked and not joinable. */
	currentSessionId?: string | null;
	onJoin(host: CompanionHost): void;
}

export function HostList({ hosts, joining, disabled, currentSessionId, onJoin }: HostListProps): ReactNode {
	return (
		<ul className="sh-recents-list">
			{hosts.map(host => {
				const current = host.sessionId === currentSessionId;
				return (
					<li key={host.instanceId} className="sh-recent">
						<button
							type="button"
							className="sh-recent-join"
							onClick={() => onJoin(host)}
							disabled={joining !== null || disabled || current}
							aria-current={current || undefined}
							title={host.cwd}
						>
							<span className="sh-recent-title">
								<span className="sh-recent-name">{hostTitle(host)}</span>
								{current && <span className="sh-chip">here</span>}
								{host.sandboxed && <SandboxedChip />}
								{joining === host.instanceId && <LoaderCircle size={13} className="sh-spin" />}
							</span>
							<span className="sh-recent-meta">
								<HostState host={host} />
								<span className="sh-recent-cwd">{shortenPath(host.cwd)}</span>
								{host.participants > 1 && (
									<span className="sh-companion-people">
										<Users size={11} /> {host.participants - 1}
									</span>
								)}
								<span>{relTime(host.startedAt)}</span>
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export interface IdleListProps {
	idle: readonly CompanionIdleSession[];
	/** instanceId being shared (or any open in flight): disables every action. */
	joining: string | null;
	disabled: boolean;
	onShare(session: CompanionIdleSession): void;
}

/** Sessions on the computer that are not hosting collab yet, each with a Share button. */
export function IdleList({ idle, joining, disabled, onShare }: IdleListProps): ReactNode {
	if (idle.length === 0) return null;
	return (
		<section className="sh-idle" aria-label="sessions not sharing">
			<h3 className="sh-recents-title">Not sharing</h3>
			<ul className="sh-recents-list">
				{idle.map(session => (
					<li key={session.instanceId} className="sh-recent">
						<div className="sh-recent-join sh-idle-info" title={session.cwd}>
							<span className="sh-recent-title">
								<span className="sh-recent-name">{hostTitle(session)}</span>
								{session.sandboxed && <SandboxedChip />}
							</span>
							<span className="sh-recent-meta">
								{session.busy && <span className="sh-host-state sh-host-state-busy">working</span>}
								<span className="sh-recent-cwd">{shortenPath(session.cwd)}</span>
								<span>{relTime(session.startedAt)}</span>
							</span>
						</div>
						<button
							type="button"
							className="sh-btn sh-idle-share"
							onClick={() => onShare(session)}
							disabled={joining !== null || disabled}
							aria-label={`share ${hostTitle(session)}`}
						>
							{joining === session.instanceId ? (
								<LoaderCircle size={14} className="sh-spin" />
							) : (
								<Share2 size={14} />
							)}
							Share
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

function HostState({ host }: { host: CompanionHost }): ReactNode {
	if (!host.relayConnected) return <span className="sh-host-state">offline</span>;
	if (host.inputRequired) return <span className="sh-host-state sh-host-state-input">needs input</span>;
	if (host.busy) return <span className="sh-host-state sh-host-state-busy">working</span>;
	if (host.busy === false) return <span className="sh-host-state">idle</span>;
	return null;
}

export function SandboxedChip(): ReactNode {
	return (
		<span className="sh-chip sh-chip-sandboxed" title="sandboxed: file tools only, edits stay in its folder">
			<ShieldCheck size={11} /> sandboxed
		</span>
	);
}

/**
 * Why the computer may drop offline: on battery, or not held awake. Nothing while
 * it is plugged in and held awake, the state that keeps sessions reachable.
 */
export function PowerNote({ power }: { power: CompanionPower | null }): ReactNode {
	if (power === null) return null;
	if (power.source === "battery") {
		const low = power.battery !== null && power.battery <= LOW_BATTERY_PCT;
		const Icon = low ? BatteryWarning : BatteryMedium;
		return (
			<div className={low ? "sh-power sh-power-low" : "sh-power"} role="status">
				<Icon size={14} />
				<span>
					On battery{power.battery !== null && ` · ${power.battery}%`}. Sessions go offline when it sleeps; plug it
					in to keep them reachable.
				</span>
			</div>
		);
	}
	if (!power.awake) {
		return (
			<div className="sh-power" role="status">
				<Moon size={14} />
				<span>May sleep when idle: the companion could not keep it awake.</span>
			</div>
		);
	}
	return null;
}
