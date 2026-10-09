import { Laptop, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionHost, CompanionIdleSession } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { extractLink, type RecentRoom } from "../../lib/rooms";
import type { CompanionHandle } from "../../lib/use-companion";
import { HostList, IdleList } from "./CompanionCard";
import { Sheet } from "./Sheet";
import { StartSessionSheet } from "./StartSessionSheet";

export interface SessionSwitcherProps {
	companion: CompanionHandle | null;
	rooms: readonly RecentRoom[];
	/** Session on screen: its companion row is marked, its room hidden from recents. */
	currentSessionId: string | null;
	currentRoomId: string | null;
	/** Fetch a link for a companion host and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	onClose(): void;
}

/** Jump to another session without going back to the connect screen. */
export function SessionSwitcher({
	companion,
	rooms,
	currentSessionId,
	currentRoomId,
	onOpenHost,
	onOpenLink,
	onClose,
}: SessionSwitcherProps): ReactNode {
	const [joining, setJoining] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const recents = rooms.filter(room => room.roomId !== currentRoomId);
	const snap = companion?.snap;

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
		<Sheet label="switch session" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Sessions</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{snap && (
				<section className="sh-switch-section" aria-label="sessions on your computer">
					<h2 className="sh-recents-title">
						<Laptop size={14} />
						{snap.machine ?? "Your computer"}
						<span
							className={`sh-dot${snap.phase === "live" ? " sh-dot-live" : ""}`}
							aria-label={snap.phase === "live" ? "online" : "offline"}
						/>
					</h2>
					{snap.hosts.length === 0 ? (
						<div className="sh-companion-empty">
							{snap.phase === "offline"
								? (snap.error ?? "Your computer is unreachable.")
								: snap.phase === "connecting"
									? "Connecting…"
									: "No other session is sharing."}
						</div>
					) : (
						<HostList
							hosts={snap.hosts}
							joining={joining}
							disabled={snap.phase !== "live"}
							currentSessionId={currentSessionId}
							onJoin={join}
						/>
					)}
					<IdleList idle={snap.idle} joining={joining} disabled={snap.phase !== "live"} onShare={share} />
					{snap.canStart && snap.phase === "live" && (
						<button type="button" className="sh-btn sh-card-action" onClick={() => setStarting(true)}>
							<Plus size={15} /> Start session
						</button>
					)}
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
			{starting && companion?.client && (
				<StartSessionSheet
					client={companion.client}
					canSandbox={companion.snap.canSandbox}
					onOpen={onOpenHost}
					onClose={() => setStarting(false)}
				/>
			)}
		</Sheet>
	);
}
