/** The pet's state as a React value: the open session's activity, or the computer's sessions on the home screen. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot } from "./client";
import type { CompanionHost } from "./companion";
import {
	derivePetState,
	type FailureTally,
	homePetState,
	IDLE_SIGNALS,
	type PetPulse,
	type PetSignals,
	stepPulse,
	tallyFailures,
} from "./pet-activity";
import type { PetState } from "./pet-state";
import { currentTodos } from "./todos";

const NO_TOOLS: readonly string[] = Object.freeze([]);

/** The client's latest snapshot, or null while no session is open. */
function useOptionalSnapshot(client: GuestClient | null): GuestSnapshot | null {
	const subscribe = useCallback((listener: () => void) => client?.subscribe(listener) ?? (() => {}), [client]);
	const getSnapshot = useCallback(() => client?.getSnapshot() ?? null, [client]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Highest id of an error notice: the notices are capped, so their count can shrink but this cannot. */
function errorNoticeMark(snap: GuestSnapshot): number {
	for (let i = snap.notices.length - 1; i >= 0; i--) if (snap.notices[i].level === "error") return snap.notices[i].id;
	return 0;
}

function lastBlockIsThinking(snap: GuestSnapshot): boolean {
	const stream = snap.stream;
	if (stream === null || snap.streamDone) return false;
	const last = stream.content.at(-1);
	return last !== undefined && (last.type === "thinking" || last.type === "redactedThinking");
}

export interface PetActivity {
	state: PetState;
	/** Seen from an open session, not the home screen. */
	inSession: boolean;
}

/**
 * Derives the pet's state. In a session: its live status, pending question, failures and task list, with
 * the transients (failed, plan done, turn done) raised only by live changes and expiring on their own.
 * On the home screen: waiting if any of the computer's sessions needs you, else running if any works.
 */
export function usePetActivity(
	client: GuestClient | null,
	hosts: readonly CompanionHost[],
	hostsLive: boolean,
): PetActivity {
	const snap = useOptionalSnapshot(client);
	const tally = useRef<{ client: GuestClient | null; value: FailureTally | null }>({ client, value: null });

	const entries = snap?.entries;
	const activeTools = snap?.activeTools;
	const todos = useMemo(
		() => (entries === undefined ? null : currentTodos(entries, activeTools)),
		[entries, activeTools],
	);
	const planDone = todos !== null && todos.total > 0 && todos.done === todos.total;
	if (tally.current.client !== client) tally.current = { client, value: null };
	if (entries !== undefined && tally.current.value?.entries !== entries) {
		tally.current.value = tallyFailures(entries, tally.current.value);
	}
	const failures = snap === null ? 0 : (tally.current.value?.count ?? 0) + errorNoticeMark(snap);

	const open = snap !== null;
	const live = snap !== null && snap.phase === "live" && snap.loading === null;
	const blocked = snap !== null && snap.uiRequest !== null;
	const working = snap !== null && snap.working;
	const thinking = snap !== null && lastBlockIsThinking(snap);
	const tools = useMemo(
		() =>
			activeTools === undefined || activeTools.size === 0
				? NO_TOOLS
				: [...activeTools.values()].map(tool => tool.toolName),
		[activeTools],
	);
	const signals = useMemo<PetSignals>(
		() => (open ? { live, blocked, working, tools, thinking, failures, planDone } : IDLE_SIGNALS),
		[open, live, blocked, working, tools, thinking, failures, planDone],
	);

	// The transient is worked out while rendering, so the turn ending and the wave start in the same frame.
	const [track, setTrack] = useState<{ client: GuestClient | null; signals: PetSignals; pulse: PetPulse | null }>({
		client,
		signals,
		pulse: null,
	});
	let pulse = track.pulse;
	if (track.client !== client || track.signals !== signals) {
		const before = track.client === client ? track.signals : null;
		pulse = stepPulse(before, signals, Date.now(), track.pulse);
		setTrack({ client, signals, pulse });
	}

	const pulseUntil = pulse?.until;
	useEffect(() => {
		if (pulseUntil === undefined) return;
		const timer = setTimeout(
			() => setTrack(current => ({ ...current, pulse: null })),
			Math.max(0, pulseUntil - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [pulseUntil]);

	if (client === null) return { state: homePetState(hosts, hostsLive), inSession: false };
	return { state: derivePetState(signals, pulse, Date.now()), inSession: true };
}
