import { Activity, ChartColumn, LayoutList, Laptop, Plus, Smartphone, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionHost, CompanionIdleSession, SessionOverview } from "../../lib/companion";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import { endedSettledKeys } from "../../lib/session-org";
import type { CompanionHandle } from "../../lib/use-companion";
import { useEndedSettled } from "../../lib/use-ended-settled";
import type { SessionOrgControl } from "../../lib/use-session-org";
import type { BesideControl } from "../../lib/use-split";
import { PowerNote } from "./CompanionCard";
import { DevicesSheet } from "./DevicesSheet";
import { DiagnosticsSheet } from "./DiagnosticsSheet";
import { FanoutGroups } from "./FanoutSheet";
import { InboxEntry } from "./InboxSheet";
import { useOpenElsewhere } from "./OpenElsewhere";
import { OrgSessions } from "./OrgSessions";
import { SchedulesEntry } from "./SchedulesSheet";
import { StartSessionSheet } from "./StartSessionSheet";

export interface SessionsSidebarProps {
	companion: CompanionHandle | null;
	rooms: readonly RecentRoom[];
	/** Session on screen: its companion row is highlighted, its room hidden from recents. */
	currentSessionId: string | null;
	currentRoomId: string | null;
	/** Fetch a link for a companion host and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Usage and all-sessions screens; null when no computer is paired. */
	onOpenUsage: (() => void) | null;
	onOpenSessions: (() => void) | null;
	/** Split view: sessions can open in a second pane beside the transcript. null where the screen has no room. */
	beside?: Pick<BesideControl, "openHost" | "openLink"> | null;
	/** Pin / snooze / settle state of every session. */
	org: SessionOrgControl;
	/** When the open session's usage limit resets (ms): offered as a snooze time for it. */
	limitResetAt?: number | null;
	onClose(): void;
}

/**
 * Every session one tap away: docked beside the transcript on wide screens, a
 * slide-over drawer (with a close button and backdrop) below the dock breakpoint.
 */
export function SessionsSidebar({
	companion,
	rooms,
	org,
	currentSessionId,
	currentRoomId,
	onOpenHost,
	onOpenLink,
	onOpenUsage,
	onOpenSessions,
	onClose,
	beside = null,
	limitResetAt = null,
}: SessionsSidebarProps): ReactNode {
	const [joining, setJoining] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [diagnosing, setDiagnosing] = useState(false);
	const [devicesOpen, setDevicesOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const recents = rooms.filter(room => room.roomId !== currentRoomId);
	const snap = companion?.snap;
	const live = snap?.phase === "live";
	const liveIds = new Set([...(snap?.hosts ?? []), ...(snap?.idle ?? [])].map(session => session.sessionId));
	// Sessions that ended while settled (the computer ends them when they settle, if asked) stay under Settled.
	const ended = useEndedSettled(companion?.client ?? null, live, endedSettledKeys(org.doc, liveIds));
	const openElsewhere = useOpenElsewhere();

	/** Resume an ended session with the all-sessions list's own request, then open it when `open`; false (with the reason shown) when it did not come back. */
	const resumeEnded = async (session: SessionOverview, open: boolean, force = false): Promise<boolean> => {
		if (!companion?.client) return false;
		setJoining(session.sessionId);
		setError(null);
		openElsewhere.dismiss();
		try {
			const instanceId = await companion.client.startSession(session.folder, {
				resume: session.sessionId,
				agent: session.agent?.id,
				force: force || undefined,
			});
			if (open) await onOpenHost(instanceId);
			return true;
		} catch (err) {
			if (!openElsewhere.intercept(err, () => void resumeEnded(session, open, true)))
				setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setJoining(null);
		}
	};

	const join = (host: CompanionHost): void => {
		setJoining(host.instanceId);
		setError(null);
		onOpenHost(host.instanceId).catch((err: unknown) => {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(null);
		});
	};

	/** Open a companion host in the second pane; the sidebar stays as it is. */
	const joinBeside = (host: CompanionHost): void => {
		if (beside === null) return;
		setJoining(host.instanceId);
		setError(null);
		beside
			.openHost(host.instanceId)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setJoining(null));
	};

	const openRoomBeside = (link: string): void => {
		if (beside === null) return;
		setError(beside.openLink(link));
	};

	/** Make an idle session host collab, then open its control link. */
	const share = async (session: CompanionIdleSession): Promise<void> => {
		if (!companion?.client || joining) return;
		setJoining(session.instanceId);
		setError(null);
		try {
			const link = extractLink(await companion.client.shareSession(session.instanceId));
			if (!link) throw new Error("the computer returned an unreadable link");
			onOpenLink(link);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(null);
		}
	};

	return (
		<nav className="sh-sidebar" aria-label="Sessions">
			<div className="sh-sidebar-head">
				<span className="sh-sidebar-title">Sessions</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon sh-sidebar-close"
					onClick={onClose}
					aria-label="Close sessions"
					title="Close sessions"
				>
					<X size={16} />
				</button>
			</div>
			<div className="sh-sidebar-body">
				{snap && (
					<section className="sh-switch-section" aria-label="Sessions on your computer">
						<h2 className="sh-recents-title">
							<Laptop size={14} />
							{snap.machine ?? "Your computer"}
							<span
								className={`sh-dot${live ? " sh-dot-live" : ""}`}
								role="img"
								aria-label={live ? "Online" : "Offline"}
							/>
						</h2>
						{live && <PowerNote power={snap.power} />}
						{snap.hosts.length === 0 && snap.idle.length === 0 && (
							<div className="sh-companion-empty">
								{snap.phase === "unpaired"
									? snap.error
									: snap.phase === "offline"
										? (snap.error ?? "Your computer is unreachable.")
										: snap.phase === "connecting"
											? "Connecting…"
											: "No session is sharing."}
							</div>
						)}
					</section>
				)}
				{snap && companion?.client && live && (
					<FanoutGroups hosts={snap.hosts} client={companion.client} onOpen={onOpenHost} />
				)}
				<OrgSessions
					hosts={snap?.hosts ?? []}
					idle={snap?.idle ?? []}
					rooms={recents}
					org={org}
					joining={joining}
					disabled={!live}
					currentSessionId={currentSessionId}
					limitResetAt={limitResetAt}
					onJoinHost={join}
					onOpenHostBeside={beside === null ? undefined : joinBeside}
					onShare={share}
					onOpenRoom={room => onOpenLink(room.link)}
					onOpenRoomBeside={beside === null ? undefined : room => openRoomBeside(room.link)}
					ended={ended}
					canResume={snap?.canStart === true}
					onResumeEnded={resumeEnded}
				/>
				{!snap && recents.length === 0 && (
					<div className="sh-companion-empty">
						No other sessions yet. Pair your computer from the start screen to list all of them here.
					</div>
				)}
				{openElsewhere.notice}
				{error && <div className="sh-connect-error">{error}</div>}
			</div>
			{snap && live && (
				<div className="sh-sidebar-foot">
					{snap.canStart && (
						<button type="button" className="sh-btn" onClick={() => setStarting(true)}>
							<Plus size={15} /> Start session
						</button>
					)}
					{onOpenUsage && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onOpenUsage}
							aria-label="Usage"
							title="Usage"
						>
							<ChartColumn size={15} />
						</button>
					)}
					{onOpenSessions && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onOpenSessions}
							aria-label="All sessions"
							title="All sessions"
						>
							<LayoutList size={15} />
						</button>
					)}
					{companion?.client && (
						<InboxEntry
							client={companion.client}
							count={snap.hosts.filter(host => host.inputRequired).length}
							onOpenHost={onOpenHost}
							variant="icon"
						/>
					)}
					{companion?.client && snap.canSchedule && (
						<SchedulesEntry
							client={companion.client}
							canSandbox={snap.canSandbox}
							canCron={snap.canScheduleCron}
							onOpenHost={onOpenHost}
							variant="icon"
						/>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setDiagnosing(true)}
						aria-label="Open diagnostics"
					>
						<Activity size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setDevicesOpen(true)}
						aria-label="Devices"
						title="Devices"
					>
						<Smartphone size={15} />
					</button>
				</div>
			)}
			{diagnosing && companion?.client && (
				<DiagnosticsSheet client={companion.client} onClose={() => setDiagnosing(false)} />
			)}
			{devicesOpen && companion?.client && live && (
				<DevicesSheet client={companion.client} onClose={() => setDevicesOpen(false)} />
			)}
			{starting && companion?.client && (
				<StartSessionSheet
					client={companion.client}
					canSandbox={companion.snap.canSandbox}
					canFanout={companion.snap.canFanout}
					onOpen={onOpenHost}
					onClose={() => setStarting(false)}
				/>
			)}
		</nav>
	);
}
