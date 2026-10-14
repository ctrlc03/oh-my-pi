import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "./companion";
import { type ComputerHandle, type Feature, unavailableReason } from "./computers";
import type { RequestState } from "./use-request";

/** One computer's share of a request made to every computer. */
export interface ComputerRequest<T> {
	computer: ComputerHandle;
	/** null when the computer was not asked: `reason` says why. */
	state: RequestState<T> | null;
	/** Why the computer was not asked (not live, or it lacks the feature); null when it was. */
	reason: string | null;
}

/**
 * Why `computer` cannot be asked now: not live, or (when `feature` is given) it lacks the feature. Without a
 * feature only liveness matters; a computer that is not live is described by the first thing {@link unavailableReason}
 * checks, which is the connection.
 */
function askReason(computer: ComputerHandle, feature: Feature | null): string | null {
	if (computer.client === null) return computer.error ?? "Not reachable";
	if (feature !== null) return unavailableReason(computer, feature);
	return computer.snap.phase === "live" ? null : unavailableReason(computer, "start");
}

/**
 * Makes `request` to every computer that can be asked (live, and with `feature` when given), in parallel, and
 * again on `reload()`, when the set of computers that can be asked changes, or when `query` changes (name what
 * `request` asks for, e.g. a range). A computer's answer, or failure, stands alone: one failing does not hide
 * the others. The last answer of a computer stays while it reloads.
 */
export function useComputerRequests<T>(
	computers: readonly ComputerHandle[],
	feature: Feature | null,
	request: (client: CompanionClient) => Promise<T>,
	query = "",
): { entries: ComputerRequest<T>[]; loading: boolean; reload(): void } {
	const latest = useRef({ computers, request });
	latest.current = { computers, request };
	const askable = computers.filter(computer => askReason(computer, feature) === null).map(computer => computer.id);
	const key = askable.join("\n");
	const [states, setStates] = useState<ReadonlyMap<string, RequestState<T>>>(new Map());
	const [pending, setPending] = useState(0);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		let stale = false;
		const ids = key === "" ? [] : key.split("\n");
		setStates(
			prev => new Map(ids.map((id): [string, RequestState<T>] => [id, prev.get(id) ?? { status: "loading" }])),
		);
		setPending(ids.length);
		for (const id of ids) {
			const client = latest.current.computers.find(computer => computer.id === id)?.client ?? null;
			const settle = (state: RequestState<T>): void => {
				if (stale) return;
				setStates(prev => new Map(prev).set(id, state));
				setPending(count => count - 1);
			};
			if (client === null) {
				settle({ status: "error", message: "Not reachable" });
				continue;
			}
			latest.current.request(client).then(
				value => settle({ status: "ready", value }),
				(err: unknown) => settle({ status: "error", message: err instanceof Error ? err.message : String(err) }),
			);
		}
		return () => {
			stale = true;
		};
	}, [key, tick, query]);

	const reload = useCallback(() => setTick(n => n + 1), []);
	const entries = computers.map<ComputerRequest<T>>(computer => {
		const reason = askReason(computer, feature);
		return { computer, reason, state: reason === null ? (states.get(computer.id) ?? { status: "loading" }) : null };
	});
	return { entries, loading: pending > 0, reload };
}
