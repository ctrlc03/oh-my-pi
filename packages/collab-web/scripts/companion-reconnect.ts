/**
 * When the companion reconnects to a relay after its socket gave up. Most closes retry after a fixed beat; "a host is
 * already connected for this room" (4009: another companion holds the room, or the relay still holds this companion's
 * own dead socket) retries with a growing delay and is logged once per streak, with a summary when the streak ends: a
 * second companion left running would otherwise fill the log and the relay's connection table every few seconds for as
 * long as it runs.
 *
 * The relay accepts the WebSocket and only then refuses a second host, so an open proves nothing. A room counts as
 * hosted once the connection has lasted {@link OPEN_CONFIRM_MS} or the relay sent something.
 */
import type { RoomRoute } from "./companion-room";
import { HOST_TAKEN_REASON } from "../src/lib/socket";

/** Delay before reconnecting after any close but {@link HOST_TAKEN_REASON}, and the first delay of a streak. */
export const RECONNECT_MS = 5_000;
/** The longest delay of a streak. */
export const RECONNECT_MAX_MS = 5 * 60_000;
/** After this companion's own open or drop the relay may still hold its dead socket (about 40 s on the public relay, up to 120 s behind Bun's idle timeout): retries stay at {@link RECONNECT_MS} that long. */
export const RECLAIM_WINDOW_MS = 150_000;
/** An open that lasts this long was accepted: the relay refuses a second host right after accepting the socket. */
export const OPEN_CONFIRM_MS = 1_000;

export interface ReconnectDecision {
	delayMs: number;
	/** A repeat of the close that opened the streak: nothing to log. */
	quiet: boolean;
	/** The summary of the streak this close ended (the relay closed for another reason), if any. */
	summary: string[];
}

/** Tracks one relay connection. */
export class ReconnectPlan {
	readonly #now: () => number;
	#streakStart = 0;
	#retries = 0;
	/** Retries made after the reclaim window; the delay doubles with each. */
	#grown = 0;
	#confirmed = false;
	#reclaimFrom: number | null = null;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** The relay closed the socket for good with `reason`: how long to wait before connecting again. */
	closed(reason: string): ReconnectDecision {
		this.dropped();
		if (reason !== HOST_TAKEN_REASON) return { delayMs: RECONNECT_MS, quiet: false, summary: this.#summary() };
		const first = this.#retries === 0;
		const now = this.#now();
		if (first) this.#streakStart = now;
		const reclaiming = this.#reclaimFrom !== null && now - this.#reclaimFrom < RECLAIM_WINDOW_MS;
		let delayMs = RECONNECT_MS;
		if (!reclaiming) {
			delayMs = Math.min(RECONNECT_MS * 2 ** this.#grown, RECONNECT_MAX_MS);
			this.#grown++;
		}
		this.#retries++;
		return { delayMs, quiet: !first, summary: [] };
	}

	/** The relay kept this companion as host: the summary of the streak that just ended, if there was one. */
	opened(): string[] {
		this.#confirmed = true;
		this.#reclaimFrom = this.#now();
		return this.#summary();
	}

	/** A connection that was hosting the room is gone; the relay may hold it for a while longer. */
	dropped(): void {
		if (!this.#confirmed) return;
		this.#confirmed = false;
		this.#reclaimFrom = this.#now();
	}

	#summary(): string[] {
		if (this.#retries === 0) return [];
		const retries = this.#retries;
		const seconds = Math.round((this.#now() - this.#streakStart) / 1_000);
		this.#retries = 0;
		this.#grown = 0;
		const held = seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
		return [`room was held by another host for ${held}, ${retries} ${retries === 1 ? "retry" : "retries"}`];
	}
}

export interface RoomReconnectorOptions {
	/** Connect the room on `route` again (`RoomHost.connect`). */
	connect(route: RoomRoute): void;
	/** Run `fn` after `ms`; returns what cancels it. */
	schedule(fn: () => void, ms: number): () => void;
	/** A relay accepted the host for good: tell the user. */
	confirmed(route: RoomRoute): void;
	/** One line for the log and the diagnostics' relay events. `kind` is what the event is: the room opened or closed. */
	report(route: RoomRoute, kind: "open" | "close", line: string): void;
	now?: () => number;
	openConfirmMs?: number;
}

/** Decides, per relay, when an open counts and when to connect again. */
export class RoomReconnector {
	readonly #options: RoomReconnectorOptions;
	readonly #plans: Record<RoomRoute, ReconnectPlan>;
	readonly #cancelConfirm: Partial<Record<RoomRoute, () => void>> = {};
	readonly #cancelRetry: Partial<Record<RoomRoute, () => void>> = {};
	#stopped = false;

	constructor(options: RoomReconnectorOptions) {
		this.#options = options;
		this.#plans = { public: new ReconnectPlan(options.now), local: new ReconnectPlan(options.now) };
	}

	/** The socket opened: it counts once it lasts, or the relay sends something ({@link activity}). */
	opened(route: RoomRoute): void {
		this.#cancelConfirm[route]?.();
		this.#cancelConfirm[route] = this.#options.schedule(
			() => this.activity(route),
			this.#options.openConfirmMs ?? OPEN_CONFIRM_MS,
		);
	}

	/** The relay sent something on `route`: it holds this companion as host. */
	activity(route: RoomRoute): void {
		if (this.#cancelConfirm[route] === undefined) return;
		this.#cancelConfirm[route]!();
		delete this.#cancelConfirm[route];
		this.#options.confirmed(route);
		for (const line of this.#plans[route].opened()) this.#options.report(route, "open", `${route} relay: ${line}`);
	}

	/** The socket closed. `willReconnect` is false when it gave up: the reconnector then connects again, later. */
	closed(route: RoomRoute, reason: string, willReconnect: boolean): void {
		this.#cancelConfirm[route]?.();
		delete this.#cancelConfirm[route];
		const plan = this.#plans[route];
		if (willReconnect) {
			plan.dropped();
			this.#options.report(route, "close", `${route} relay: ${reason}, reconnecting`);
			return;
		}
		const { delayMs, quiet, summary } = plan.closed(reason);
		for (const line of summary) this.#options.report(route, "close", `${route} relay: ${line}`);
		if (!quiet) {
			const retry = reason === HOST_TAKEN_REASON ? ", retrying" : "";
			this.#options.report(route, "close", `${route} relay closed (${reason})${retry}`);
		}
		if (this.#stopped) return;
		this.#cancelRetry[route]?.();
		this.#cancelRetry[route] = this.#options.schedule(() => {
			delete this.#cancelRetry[route];
			this.#options.connect(route);
		}, delayMs);
	}

	/** No more reconnects: the companion is shutting down. */
	stop(): void {
		this.#stopped = true;
		for (const cancel of [...Object.values(this.#cancelConfirm), ...Object.values(this.#cancelRetry)]) cancel();
	}
}
