import { useEffect, useState } from "react";
import type { ConnectionPhase } from "./client";
import { extractLink, roomIdOf } from "./rooms";
import type { CompanionHandle } from "./use-companion";

/** A connection this long out of `live` asks the paired computer for the session's current room. */
const STALL_MS = 8_000;
/** Spacing of repeated asks while the connection keeps retrying. */
const RETRY_MS = 15_000;
/** Spacing of asks after the session ended, while the host may still be opening its next room. */
const ENDED_RETRY_MS = 2_000;
/** An ended room the computer still reports this long after the end is the session's last: it stays ended. */
const SETTLE_MS = 10_000;

/** Whether the paired computer can bring the session back: listed, not listed, or not known yet. */
export type HostRecovery = "listed" | "absent" | "unknown";

/**
 * Rejoins a session through the paired computer when its room goes away under the guest.
 *
 * The host replaces its room (new id and key) when its session switches, when a
 * view-only room is upgraded to control, and when it relaunches after losing the
 * relay: a laptop that slept, a network change. The old link then ends (`bye`,
 * `no such room`) or keeps retrying a room that no longer exists, while the
 * companion still lists the same omp process. Its current link reopens the session.
 *
 * Returns `listed` while that recovery is possible (callers hold off on "ended"
 * and on forgetting the room), `unknown` while the companion has not answered yet.
 */
export function useHostRecovery(
	companion: CompanionHandle | null,
	instanceId: string | null,
	phase: ConnectionPhase,
	roomId: string | null,
	onReplaced: (link: string) => void,
): HostRecovery {
	const client = companion?.client ?? null;
	const companionPhase = companion?.snap.phase ?? "offline";
	const listed = instanceId !== null && companion?.snap.hosts.some(host => host.instanceId === instanceId) === true;
	// The computer confirmed the ended room as the session's current one: it stays ended.
	const [confirmed, setConfirmed] = useState<string | null>(null);
	if (phase !== "ended" && confirmed !== null) setConfirmed(null);
	const settled = confirmed !== null && confirmed === roomId;

	useEffect(() => {
		if (client === null || instanceId === null || !listed || phase === "live" || settled) return;
		const ended = phase === "ended";
		const since = Date.now();
		let cancelled = false;
		const ask = async (): Promise<void> => {
			try {
				const next = extractLink(await client.requestLink(instanceId));
				if (cancelled || next === null) return;
				if (roomIdOf(next) !== roomId) onReplaced(next);
				else if (ended && Date.now() - since >= SETTLE_MS) setConfirmed(roomId);
			} catch {
				// Companion busy or the host between rooms; the next ask retries.
			}
		};
		const first = setTimeout(() => void ask(), ended ? 0 : STALL_MS);
		const again = setInterval(() => void ask(), ended ? ENDED_RETRY_MS : RETRY_MS);
		return () => {
			cancelled = true;
			clearTimeout(first);
			clearInterval(again);
		};
	}, [client, instanceId, listed, phase, roomId, settled, onReplaced]);

	if (instanceId === null || client === null || settled) return "absent";
	if (listed) return "listed";
	return companionPhase === "connecting" ? "unknown" : "absent";
}
