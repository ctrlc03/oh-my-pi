/**
 * Per-device composer preferences. `enter`: what Enter does while the agent is working and the host can queue
 * follow-ups: `steer` sends the message into the running turn (the default, as before), `queue` holds it until
 * the turn ends. The other action stays on Alt+Enter and its own button.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export type EnterWhileRunning = "steer" | "queue";

const KEY = "omp.collab.composer";

let enter: EnterWhileRunning | undefined;
const listeners = new Set<() => void>();

export function enterWhileRunning(): EnterWhileRunning {
	if (enter === undefined) {
		const raw = readJson(KEY);
		const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).enter : undefined;
		enter = stored === "queue" ? "queue" : "steer";
	}
	return enter;
}

export function setEnterWhileRunning(next: EnterWhileRunning): void {
	enter = next;
	writeJson(KEY, next === "steer" ? null : { enter: next });
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The preference; re-renders when it changes, here or in another composer. */
export function useEnterWhileRunning(): EnterWhileRunning {
	return useSyncExternalStore(subscribe, enterWhileRunning, () => "steer");
}
