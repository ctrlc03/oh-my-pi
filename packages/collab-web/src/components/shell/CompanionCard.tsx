import { Bell, BellOff, Laptop, LoaderCircle, RefreshCw, Unlink, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionHost } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import type { PushControl } from "../../lib/push";
import { extractLink } from "../../lib/rooms";
import type { CompanionHandle } from "../../lib/use-companion";

export interface CompanionCardProps {
	companion: CompanionHandle;
	push: PushControl;
	onJoin(link: string): void;
	onUnpair(): void;
}

export function hostTitle(host: CompanionHost): string {
	return host.sessionName || host.cwd.split("/").filter(Boolean).pop() || "session";
}

/** Live list of every collab session on the paired computer; tap one to join it. */
export function CompanionCard({ companion, push, onJoin, onUnpair }: CompanionCardProps): ReactNode {
	const { client, snap } = companion;
	const [error, setError] = useState<string | null>(null);
	const [joining, setJoining] = useState<string | null>(null);
	const live = snap.phase === "live";

	const join = async (host: CompanionHost): Promise<void> => {
		if (!client || joining) return;
		setJoining(host.instanceId);
		setError(null);
		try {
			const url = await client.requestLink(host.instanceId);
			const link = extractLink(url);
			if (!link) throw new Error("the computer returned an unreadable link");
			onJoin(link);
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
				) : snap.hosts.length === 0 ? (
					<div className="sh-companion-empty">
						No session is sharing. Run <code>/collab</code> in omp.
					</div>
				) : (
					<HostList hosts={snap.hosts} joining={joining} disabled={!live} onJoin={join} />
				))}
			{shown && <div className="sh-connect-error">{shown}</div>}
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
								{hostTitle(host)}
								{current && <span className="sh-chip">here</span>}
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

function HostState({ host }: { host: CompanionHost }): ReactNode {
	if (!host.relayConnected) return <span className="sh-host-state">offline</span>;
	if (host.inputRequired) return <span className="sh-host-state sh-host-state-input">needs input</span>;
	if (host.busy) return <span className="sh-host-state sh-host-state-busy">working</span>;
	if (host.busy === false) return <span className="sh-host-state">idle</span>;
	return null;
}
