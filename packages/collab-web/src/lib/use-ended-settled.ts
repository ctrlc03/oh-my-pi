import { useCallback, useRef } from "react";
import type { CompanionClient, SessionOverview } from "./companion";
import { useRequest } from "./use-request";

/** The same window the all-sessions list reads: settled sessions that fell out of it are not listed. */
const SESSION_LIMIT = 200;

/**
 * The history rows of the sessions in `keys` (settled ones the computer lists as no longer running): they stay
 * under Settled after the computer ended them, and are resumed from there. Nothing is asked while `keys` is empty
 * or the computer is not reachable; the last answer stays while a new one loads.
 */
export function useEndedSettled(
	client: CompanionClient | null,
	live: boolean,
	keys: readonly string[],
): SessionOverview[] {
	const wanted = keys.join(",");
	const load = useCallback(
		() =>
			client !== null && live && wanted !== ""
				? client.requestSessions({ limit: SESSION_LIMIT })
				: Promise.resolve([]),
		[client, live, wanted],
	);
	const { state } = useRequest(load);
	const answer = useRef<SessionOverview[]>([]);
	if (state.status === "ready") answer.current = state.value;
	return answer.current.filter(session => session.live === undefined && keys.includes(session.sessionId));
}
