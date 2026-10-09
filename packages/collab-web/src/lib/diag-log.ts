/**
 * Connection events of this app, kept for the diagnostics screen: the link to
 * the paired computer and the link to the session on screen, each with the
 * reason it closed. A ring buffer in memory; reloading the app clears it.
 */

import type { CompanionRelayEvent } from "./companion";

const MAX_EVENTS = 50;

/** `companion`: this app's link to the computer; `session`: its link to a session; `computer`: the companion's own relay link. */
export type DiagSource = "companion" | "session" | "computer";
export type DiagKind = "connected" | "reconnected" | "closed" | "welcome";

export interface DiagEvent {
	/** Epoch ms on this device's clock. */
	at: number;
	source: DiagSource;
	kind: DiagKind;
	detail?: string;
}

let events: readonly DiagEvent[] = [];
const listeners = new Set<() => void>();

/** Append an event, dropping the oldest beyond the last 50. */
export function recordEvent(source: "companion" | "session", kind: DiagKind, detail?: string): void {
	events = [...events.slice(1 - MAX_EVENTS), { at: Date.now(), source, kind, detail }];
	for (const listener of listeners) listener();
}

/** `useSyncExternalStore` pair: the same array is returned until an event is recorded. */
export function subscribeEvents(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getEvents(): readonly DiagEvent[] {
	return events;
}

/**
 * This app's events and the computer's relay events in one list, newest first.
 * The computer stamps events with its own clock: `skewMs` (this device's clock
 * minus the computer's, at the time they were fetched) moves them onto this one.
 */
export function mergeEvents(
	app: readonly DiagEvent[],
	computer: readonly CompanionRelayEvent[],
	skewMs: number,
): DiagEvent[] {
	const remote = computer.map((event): DiagEvent => ({
		at: event.at + skewMs,
		source: "computer",
		kind: event.kind === "open" ? "connected" : "closed",
		detail: event.detail,
	}));
	return [...app, ...remote].sort((a, b) => b.at - a.at);
}
