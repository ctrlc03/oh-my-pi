import { Laptop, LoaderCircle, RefreshCw, Unlink, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CompanionClient, type CompanionHost } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { extractLink } from "../../lib/rooms";

export interface CompanionCardProps {
	/** Companion room link from the pairing QR code. */
	pairing: string;
	onJoin(link: string): void;
	onUnpair(): void;
}

function hostTitle(host: CompanionHost): string {
	return host.sessionName || host.cwd.split("/").filter(Boolean).pop() || "session";
}

/** Live list of every collab session on the paired computer; tap one to join it. */
export function CompanionCard({ pairing, onJoin, onUnpair }: CompanionCardProps): ReactNode {
	const [client, setClient] = useState<CompanionClient | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [joining, setJoining] = useState<string | null>(null);

	useEffect(() => {
		let next: CompanionClient;
		try {
			next = new CompanionClient(pairing);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		setClient(next);
		const wake = (): void => {
			if (document.visibilityState === "visible") next.resume();
		};
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
			next.close();
		};
	}, [pairing]);

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

	return (
		<section className="sh-connect-card sh-recents sh-companion" aria-label="sessions on your computer">
			{client ? (
				<CompanionBody client={client} joining={joining} onJoin={join} onUnpair={onUnpair} />
			) : (
				<CompanionHead machine={null} live={false} onUnpair={onUnpair} />
			)}
			{error && <div className="sh-connect-error">{error}</div>}
		</section>
	);
}

interface CompanionBodyProps {
	client: CompanionClient;
	joining: string | null;
	onJoin(host: CompanionHost): void;
	onUnpair(): void;
}

function CompanionBody({ client, joining, onJoin, onUnpair }: CompanionBodyProps): ReactNode {
	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
	const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const live = snap.phase === "live";

	return (
		<>
			<CompanionHead machine={snap.machine} live={live} onUnpair={onUnpair} />
			{snap.phase === "offline" ? (
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
				<ul className="sh-recents-list">
					{snap.hosts.map(host => (
						<li key={host.instanceId} className="sh-recent">
							<button
								type="button"
								className="sh-recent-join"
								onClick={() => onJoin(host)}
								disabled={joining !== null || !live}
								title={host.cwd}
							>
								<span className="sh-recent-title">
									{hostTitle(host)}
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
					))}
				</ul>
			)}
		</>
	);
}

function CompanionHead({
	machine,
	live,
	onUnpair,
}: {
	machine: string | null;
	live: boolean;
	onUnpair(): void;
}): ReactNode {
	return (
		<div className="sh-companion-head">
			<h2 className="sh-recents-title">
				<Laptop size={14} />
				{machine ?? "Your computer"}
				<span className={`sh-dot${live ? " sh-dot-live" : ""}`} aria-label={live ? "online" : "offline"} />
			</h2>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				onClick={onUnpair}
				aria-label="unpair this computer"
				title="unpair"
			>
				<Unlink size={15} />
			</button>
		</div>
	);
}

function HostState({ host }: { host: CompanionHost }): ReactNode {
	if (!host.relayConnected) return <span className="sh-host-state">offline</span>;
	if (host.inputRequired) return <span className="sh-host-state sh-host-state-input">needs input</span>;
	if (host.busy) return <span className="sh-host-state sh-host-state-busy">working</span>;
	if (host.busy === false) return <span className="sh-host-state">idle</span>;
	return null;
}
