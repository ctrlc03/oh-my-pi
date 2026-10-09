/**
 * Companion pairing: one long-lived encrypted room per computer, opened by
 * `scripts/companion.ts`, that lists every omp session hosting collab on that
 * machine and hands out their control links on request.
 *
 * The room rides the normal relay with the normal sealing, so the relay sees
 * ciphertext only. The pairing link carries the room key and is therefore a
 * standing capability for every session on the machine: it lives in this
 * origin's storage and nowhere else.
 *
 * Pairing link form: `pair:<collab link>`, inside a web URL fragment
 * (`https://web/#pair:<link>`) or as plain pasted text.
 */

import { importRoomKey } from "./codec";
import { parseCollabLink } from "./link";
import { CollabSocket } from "./socket";
import { readJson, writeJson } from "./storage";

export const PAIR_PREFIX = "pair:";
const PAIRING_KEY = "omp.collab.companion";
const LINK_TIMEOUT_MS = 15_000;

/** One collab-hosting omp process, as `omp collab list --json` reports it. */
export interface CompanionHost {
	instanceId: string;
	sessionName: string | null;
	cwd: string;
	/** `provider/id`, or null before a model is selected. */
	model: string | null;
	startedAt: number;
	/** Includes the host itself. */
	participants: number;
	/** null when the host omp predates the field: unknown, not idle. */
	busy: boolean | null;
	inputRequired: boolean;
	relayConnected: boolean;
}

export type CompanionRequest = { t: "list" } | { t: "link"; reqId: number; instanceId: string };

export type CompanionReply =
	| { t: "hosts"; machine: string; hosts: CompanionHost[] }
	| { t: "link"; reqId: number; url: string }
	| { t: "link-error"; reqId: number; message: string };

/**
 * The companion room link inside a pasted message, scanned QR code, or URL
 * fragment, or null when the text holds no pairing link.
 */
export function extractPairing(text: string): string | null {
	for (const token of text.trim().split(/\s+/)) {
		const at = token.indexOf(PAIR_PREFIX);
		if (at < 0) continue;
		const candidate = token.slice(at + PAIR_PREFIX.length).replace(/[>)"'`.,;]+$/, "");
		if (!("error" in parseCollabLink(candidate))) return candidate;
	}
	return null;
}

export function loadPairing(): string | null {
	const raw = readJson(PAIRING_KEY);
	return typeof raw === "string" ? raw : null;
}

export function savePairing(link: string | null): void {
	writeJson(PAIRING_KEY, link);
}

export type CompanionPhase = "connecting" | "live" | "offline";

export interface CompanionSnapshot {
	phase: CompanionPhase;
	/** Machine name the companion reports. */
	machine: string | null;
	hosts: readonly CompanionHost[];
	/** Why the room is unreachable while `offline`. */
	error: string | null;
}

interface PendingLink {
	resolve(url: string): void;
	reject(err: Error): void;
	timer: Timer;
}

/** Guest end of the companion room; `useSyncExternalStore`-compatible. */
export class CompanionClient {
	readonly #socket: CollabSocket<CompanionRequest, CompanionReply>;
	readonly #listeners = new Set<() => void>();
	readonly #pending = new Map<number, PendingLink>();
	#reqSeq = 0;
	#snapshot: CompanionSnapshot = { phase: "connecting", machine: null, hosts: [], error: null };

	/** @throws Error when the link does not parse. */
	constructor(link: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#socket.send({ t: "list" });
		this.#socket.onFrame = frame => this.#apply(frame);
		this.#socket.onClose = (reason, willReconnect) => {
			this.#rejectPending(new Error(`companion disconnected: ${reason}`));
			this.#update({
				phase: willReconnect ? "connecting" : "offline",
				error: willReconnect
					? null
					: reason === "no such room"
						? "The companion is not running on your computer."
						: reason,
			});
		};
	}

	connect(): void {
		if (this.#snapshot.phase === "offline") this.#update({ phase: "connecting", error: null });
		this.#socket.connect();
	}

	/** Foreground / online: retry now. An offline room (companion stopped) is retried too. */
	resume(): void {
		if (this.#snapshot.phase === "offline") this.connect();
		else this.#socket.resume();
	}

	close(): void {
		this.#rejectPending(new Error("companion closed"));
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): CompanionSnapshot {
		return this.#snapshot;
	}

	/** A fresh control link for one host, resolved by the companion via `omp collab link`. */
	requestLink(instanceId: string): Promise<string> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			this.#pending.delete(reqId);
			reject(new Error("the companion did not answer"));
		}, LINK_TIMEOUT_MS);
		this.#pending.set(reqId, { resolve, reject, timer });
		this.#socket.send({ t: "link", reqId, instanceId });
		return promise;
	}

	#apply(frame: CompanionReply): void {
		switch (frame.t) {
			case "hosts":
				this.#update({ phase: "live", machine: frame.machine, hosts: frame.hosts, error: null });
				return;
			case "link":
			case "link-error": {
				const pending = this.#pending.get(frame.reqId);
				if (!pending) return;
				this.#pending.delete(frame.reqId);
				clearTimeout(pending.timer);
				if (frame.t === "link") pending.resolve(frame.url);
				else pending.reject(new Error(frame.message));
				return;
			}
		}
	}

	#rejectPending(err: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.#pending.clear();
	}

	#update(patch: Partial<CompanionSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}
}
