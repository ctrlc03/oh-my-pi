import { ChartColumn, LayoutList, Laptop, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionHost, CompanionIdleSession } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import type { CompanionHandle } from "../../lib/use-companion";
import { HostList, IdleList } from "./CompanionCard";
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
	onClose(): void;
}

/**
 * Every session one tap away: docked beside the transcript on wide screens, a
 * slide-over drawer (with a close button and backdrop) below the dock breakpoint.
 */
export function SessionsSidebar({
	companion,
	rooms,
	currentSessionId,
	currentRoomId,
	onOpenHost,
	onOpenLink,
	onOpenUsage,
	onOpenSessions,
	onClose,
}: SessionsSidebarProps): ReactNode {
	const [joining, setJoining] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const recents = rooms.filter(room => room.roomId !== currentRoomId);
	const snap = companion?.snap;
	const live = snap?.phase === "live";

	const join = (host: CompanionHost): void => {
		setJoining(host.instanceId);
		setError(null);
		onOpenHost(host.instanceId).catch((err: unknown) => {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(null);
		});
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
		<nav className="sh-sidebar" aria-label="sessions">
			<div className="sh-sidebar-head">
				<span className="sh-sidebar-title">Sessions</span>
				<button type="button" className="sh-btn sh-btn-icon sh-sidebar-close" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-sidebar-body">
				{snap && (
					<section className="sh-switch-section" aria-label="sessions on your computer">
						<h2 className="sh-recents-title">
							<Laptop size={14} />
							{snap.machine ?? "Your computer"}
							<span className={`sh-dot${live ? " sh-dot-live" : ""}`} aria-label={live ? "online" : "offline"} />
						</h2>
						{snap.hosts.length === 0 ? (
							<div className="sh-companion-empty">
								{snap.phase === "offline"
									? (snap.error ?? "Your computer is unreachable.")
									: snap.phase === "connecting"
										? "Connecting…"
										: "No session is sharing."}
							</div>
						) : (
							<HostList
								hosts={snap.hosts}
								joining={joining}
								disabled={!live}
								currentSessionId={currentSessionId}
								onJoin={join}
							/>
						)}
						<IdleList idle={snap.idle} joining={joining} disabled={!live} onShare={share} />
					</section>
				)}
				{recents.length > 0 && (
					<section className="sh-switch-section" aria-label="recent sessions">
						<h2 className="sh-recents-title">Recent</h2>
						<ul className="sh-recents-list">
							{recents.map(room => (
								<li key={room.roomId} className="sh-recent">
									<button
										type="button"
										className="sh-recent-join"
										onClick={() => onOpenLink(room.link)}
										disabled={joining !== null}
									>
										<span className="sh-recent-title">
											<span className="sh-recent-name">{room.title}</span>
											{room.readOnly && <span className="sh-chip">read-only</span>}
										</span>
										<span className="sh-recent-meta">
											{room.cwd && <span className="sh-recent-cwd">{shortenPath(room.cwd)}</span>}
											<span>{relTime(room.lastSeen)}</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				)}
				{!snap && recents.length === 0 && (
					<div className="sh-companion-empty">
						No other sessions yet. Pair your computer from the start screen to list all of them here.
					</div>
				)}
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
							aria-label="usage"
							title="usage"
						>
							<ChartColumn size={15} />
						</button>
					)}
					{onOpenSessions && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onOpenSessions}
							aria-label="all sessions"
							title="all sessions"
						>
							<LayoutList size={15} />
						</button>
					)}
				</div>
			)}
			{starting && companion?.client && (
				<StartSessionSheet
					client={companion.client}
					canSandbox={companion.snap.canSandbox}
					onOpen={onOpenHost}
					onClose={() => setStarting(false)}
				/>
			)}
		</nav>
	);
}
