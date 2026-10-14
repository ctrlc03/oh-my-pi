import {
	BatteryMedium,
	BatteryWarning,
	ChartColumn,
	Laptop,
	LayoutList,
	LoaderCircle,
	Moon,
	PanelRight,
	Plus,
	RefreshCw,
	ScanLine,
	Share2,
	ShieldCheck,
	Unlink,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
	type CompanionHost,
	type CompanionIdleSession,
	type CompanionPower,
	extractPairing,
	LOW_BATTERY_PCT,
	type PairingLink,
} from "../../lib/companion";
import { ArchitectureEntry } from "../architecture/ArchitectureEntry";
import { QuizEntry } from "../quiz/QuizEntry";
import { type ComputerHandle, stateWord } from "../../lib/computers";
import { relTime, shortenPath } from "../../lib/format";
import { applyOpenIntent } from "../../lib/inbox";
import { extractLink } from "../../lib/rooms";
import { AgentChip } from "./AgentChip";
import { AgentsEntry } from "./AgentsSheet";
import { FanoutChip, FanoutGroups } from "./FanoutSheet";
import { InboxEntry } from "./InboxSheet";
import { QrScanner } from "./QrScanner";
import { SchedulesEntry } from "./SchedulesSheet";
import { SessionsSheet } from "./SessionsSheet";
import { StartSessionSheet } from "./StartSessionSheet";
import { UsageSheet } from "./UsageSheet";

export interface CompanionCardProps {
	computer: ComputerHandle;
	/** Several computers are paired: the heading names this one. */
	showName: boolean;
	onJoin(link: string): void;
	/** A pairing code was scanned while this device is refused (not paired yet, or removed): pairs with the computer it names. */
	onPair(pairing: PairingLink): void;
	/** Take this computer off the device (the caller confirms first). */
	onRemove(): void;
	/** Open one of this computer's hosts the way the app does; without it the card fetches the link and joins it itself. */
	onOpenHost?: (computerId: string, instanceId: string) => Promise<void>;
}

/** Rows one computer's card shows when there are several computers, so the later cards are not far down the page. */
const CARD_ROWS = 5;

/** What a session needs from you first: an answer, then work in progress, then the most recent. */
function attention(host: CompanionHost): number {
	return host.inputRequired ? 0 : host.busy ? 1 : 2;
}

/** The first `limit` sessions of a card (those waiting on you, working, newest), then the idle ones that still fit. */
export function capRows(
	hosts: readonly CompanionHost[],
	idle: readonly CompanionIdleSession[],
	limit: number,
): { hosts: readonly CompanionHost[]; idle: readonly CompanionIdleSession[]; hidden: number } {
	const total = hosts.length + idle.length;
	if (total <= limit) return { hosts, idle, hidden: 0 };
	const ranked = hosts.toSorted((a, b) => attention(a) - attention(b) || b.startedAt - a.startedAt);
	const shownHosts = ranked.slice(0, limit);
	const shownIdle = idle.slice(0, limit - shownHosts.length);
	return { hosts: shownHosts, idle: shownIdle, hidden: total - shownHosts.length - shownIdle.length };
}

export function hostTitle(host: { sessionName: string | null; cwd: string }): string {
	return host.sessionName || host.cwd.split("/").filter(Boolean).pop() || "session";
}

/** Live list of every collab session on one paired computer; tap one to join it. */
export function CompanionCard({
	computer,
	showName,
	onJoin,
	onPair,
	onRemove,
	onOpenHost,
}: CompanionCardProps): ReactNode {
	const { client, snap } = computer;
	const [error, setError] = useState<string | null>(null);
	const [joining, setJoining] = useState<string | null>(null);
	const live = snap.phase === "live";
	// The entries and sheets below take a list of computers; this card scopes them to its own.
	const only = useMemo(() => [computer], [computer]);

	const [starting, setStarting] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [statsSheet, setStatsSheet] = useState<"usage" | "sessions" | null>(null);

	/** Open a hosted session's control link. */
	const open = async (computerId: string, instanceId: string): Promise<void> => {
		if (onOpenHost) return onOpenHost(computerId, instanceId);
		if (!client) throw new Error("no paired computer");
		const link = extractLink(await client.requestLink(instanceId));
		if (!link) throw new Error("the computer returned an unreadable link");
		applyOpenIntent(computerId, instanceId, link);
		onJoin(link);
	};

	const join = async (host: CompanionHost): Promise<void> => {
		if (joining) return;
		setJoining(host.instanceId);
		setError(null);
		try {
			await open(computer.id, host.instanceId);
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

	const name = showName ? computer.name : (snap.machine ?? "Your computer");
	const rows = useMemo(
		() => capRows(snap.hosts, snap.idle, showName && !expanded ? CARD_ROWS : Infinity),
		[snap.hosts, snap.idle, showName, expanded],
	);
	const shown = computer.error ?? error;
	return (
		<section
			className="sh-connect-card sh-recents sh-companion"
			aria-label={showName ? `Sessions on ${computer.name}` : "Sessions on your computer"}
		>
			<div className="sh-companion-head">
				<h2 className="sh-recents-title">
					<Laptop size={14} />
					{name}
					<span className={`sh-dot${live ? " sh-dot-live" : ""}`} aria-label={live ? "Online" : "Offline"} />
					{showName && !live && <span className="sh-group-state">{stateWord(snap.phase)}</span>}
				</h2>
				<span className="sh-companion-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onRemove}
						aria-label={showName ? `Remove ${computer.name}` : "Remove this computer"}
					>
						<Unlink size={15} />
					</button>
				</span>
			</div>
			{live && <PowerNote power={snap.power} />}
			{client &&
				(snap.phase === "unpaired" ? (
					<div className="sh-companion-offline">
						<span>{snap.error}</span>
						<button type="button" className="sh-btn" onClick={() => setScanning(true)}>
							<ScanLine size={14} /> Scan QR
						</button>
					</div>
				) : snap.phase === "offline" ? (
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
						{live && <FanoutGroups hosts={snap.hosts} client={client} onOpen={id => open(computer.id, id)} />}
						{snap.hosts.length === 0 ? (
							<div className="sh-companion-empty">
								No session is sharing. Run <code>/collab</code> in omp.
							</div>
						) : (
							<HostList hosts={rows.hosts} joining={joining} disabled={!live} onJoin={join} />
						)}
						<IdleList idle={rows.idle} joining={joining} disabled={!live} onShare={share} />
						{rows.hidden > 0 && (
							<button type="button" className="sh-btn sh-card-more" onClick={() => setExpanded(true)}>
								Show all {snap.hosts.length + snap.idle.length}
							</button>
						)}
						<div className="sh-card-actions">
							{snap.canStart && live && (
								<button type="button" className="sh-btn sh-card-action" onClick={() => setStarting(true)}>
									<Plus size={15} /> Start session
								</button>
							)}
							{live && (
								<>
									<InboxEntry computers={only} onOpenHost={open} variant="card" />
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
									<SchedulesEntry computers={only} onOpenHost={open} variant="card" />
									<AgentsEntry computers={only} variant="card" />
									{snap.canBlueprint && <ArchitectureEntry computers={only} onOpenHost={open} />}
									{snap.canQuiz && <QuizEntry computers={only} onOpenHost={open} />}
								</>
							)}
						</div>
					</>
				))}
			{shown && <div className="sh-connect-error">{shown}</div>}
			{starting && (
				<StartSessionSheet
					computers={only}
					currentComputerId={computer.id}
					onOpen={open}
					onClose={() => setStarting(false)}
				/>
			)}
			{scanning && (
				<QrScanner
					onLink={found => {
						setScanning(false);
						const pairing = extractPairing(found);
						if (pairing) onPair(pairing);
						else setError("That code is not a pairing code. Show one in Settings → Devices or with --pair.");
					}}
					onClose={() => setScanning(false)}
				/>
			)}
			{statsSheet === "usage" && <UsageSheet computers={only} onClose={() => setStatsSheet(null)} />}
			{statsSheet === "sessions" && (
				<SessionsSheet computers={only} onOpenHost={open} onOpenLink={onJoin} onClose={() => setStatsSheet(null)} />
			)}
		</section>
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
	/** Split view is available: each row offers a second button that opens the session in the pane beside the transcript. */
	onOpenBeside?: (host: CompanionHost) => void;
}

export function HostList({
	hosts,
	joining,
	disabled,
	currentSessionId,
	onJoin,
	onOpenBeside,
}: HostListProps): ReactNode {
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
								<AgentChip agent={host.agent} />
								{host.sandboxed && <SandboxedChip />}
								{host.fanout && <FanoutChip fanout={host.fanout} />}
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
						{onOpenBeside !== undefined && (
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => onOpenBeside(host)}
								disabled={joining !== null || disabled || current}
								aria-label={`Open ${hostTitle(host)} beside`}
							>
								<PanelRight size={15} />
							</button>
						)}
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
		<section className="sh-idle" aria-label="Sessions not sharing">
			<h3 className="sh-recents-title">Not sharing</h3>
			<ul className="sh-recents-list">
				{idle.map(session => (
					<li key={session.instanceId} className="sh-recent">
						<div className="sh-recent-join sh-idle-info" title={session.cwd}>
							<span className="sh-recent-title">
								<span className="sh-recent-name">{hostTitle(session)}</span>
								<AgentChip agent={session.agent} />
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
							aria-label={`Share ${hostTitle(session)}`}
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

export function HostState({ host }: { host: CompanionHost }): ReactNode {
	if (!host.relayConnected) return <span className="sh-host-state">offline</span>;
	if (host.inputRequired) return <span className="sh-host-state sh-host-state-input">needs input</span>;
	if (host.busy) return <span className="sh-host-state sh-host-state-busy">working</span>;
	if (host.busy === false) return <span className="sh-host-state">idle</span>;
	return null;
}

export function SandboxedChip(): ReactNode {
	return (
		<span className="sh-chip sh-chip-sandboxed" title="Sandboxed: file tools only, edits stay in its folder">
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
