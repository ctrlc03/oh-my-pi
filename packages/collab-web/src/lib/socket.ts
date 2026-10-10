/**
 * Browser WebSocket wrapper for collab live-session sharing (vendored mirror
 * of `@oh-my-pi/pi-coding-agent/src/collab/relay-client.ts` semantics).
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff. Guests survive host-drop teardown while the host recreates the room.
 */

import type { GuestFrame, HostFrame, RelayControlMessage } from "@oh-my-pi/pi-wire";
import { open, seal } from "./codec";
import { packEnvelope, unpackEnvelope } from "./link";

const RELAY_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Max enveloped frames buffered while a reconnect is pending; overflow is dropped. */
const MAX_PENDING_SENDS = 256;
/**
 * A page hidden this long is presumed suspended, and its sockets dead. Longer than an
 * app-switcher glance or a notification pull-down, shorter than the OS's typical suspend.
 */
const STALE_AFTER_HIDDEN_MS = 10_000;

/**
 * Whether the OS suspends this page's sockets while it is hidden: true on touch devices
 * (phones and tablets). Desktop browsers keep a hidden tab's sockets alive, so replacing
 * them there would only flash a reconnect on every tab return. Gate {@link CollabSocket.suspend} on it.
 */
export function suspendsHiddenPages(): boolean {
	return matchMedia("(pointer: coarse)").matches;
}

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
}

/** `Out` is what this end seals and sends, `In` what it opens: guest frames out / host frames in by default. */
export class CollabSocket<Out extends object = GuestFrame, In = HostFrame> {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: In, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires on each close; `willReconnect` distinguishes retries from terminal shutdown. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Allows a previously joined guest to outlive room recreation races. */
	#retryMissingRoom = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];
	/** When the page last went to the background; null while foregrounded. */
	#hiddenAt: number | null = null;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#hiddenAt = null;
		this.#retryMissingRoom = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	/**
	 * The page went to the background on a device that suspends hidden pages
	 * ({@link suspendsHiddenPages}). Recorded so {@link resume} can tell a glance at the app
	 * switcher from a stretch long enough for the OS to have suspended the page.
	 */
	suspend(): void {
		this.#hiddenAt = Date.now();
	}

	/**
	 * The page is back in the foreground (`foreground`) or the network came back (`online`).
	 *
	 * A suspended page can hold a socket that still reads OPEN while the connection died
	 * under it: no `close` ever fires, the relay's protocol pings go unseen from script, and
	 * the host answers no guest frame cheaply, so a probe has nothing to listen for. Instead
	 * a connection that is not provably fresh is replaced: after `online` always (the
	 * network under it changed), and after a recorded stay in the background of at least
	 * {@link STALE_AFTER_HIDDEN_MS}. Without {@link suspend} (desktop) only `online` replaces. A delta resume makes the replacement cheap, a short
	 * hide leaves the connection alone, and recovery takes one round trip instead of
	 * waiting for the caller's welcome/snapshot timers.
	 *
	 * A pending backoff is skipped in either case, since a retry scheduled while hidden may be
	 * up to {@link BACKOFF_MAX_MS} out. No-op while terminally closed.
	 */
	resume(cause: "foreground" | "online" = "foreground"): void {
		const hiddenAt = this.#hiddenAt;
		this.#hiddenAt = null;
		if (this.#closed) return;
		const stale = cause === "online" || (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_HIDDEN_MS);
		if (stale && this.#ws) this.reconnect(cause === "online" ? "network changed" : "page was in the background");
		if (this.#retryTimer === undefined) return;
		this.#clearRetry();
		this.#openSocket();
	}

	/**
	 * Drop a connection the browser still reports open but the other end stopped
	 * answering on, and retry with backoff. Reported to `onClose` as a retry.
	 * No-op once terminally closed.
	 */
	reconnect(reason: string): void {
		if (this.#closed) return;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.#clearRetry();
		this.onClose?.(reason, true);
		this.#scheduleRetry();
	}

	/**
	 * `compress` deflates the frame when large; set it only toward a peer that
	 * advertised it can open compressed frames (`hello.zip` / `list.zip`).
	 */
	send(frame: Out, targetPeer = 0, compress = false): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) return;
				const sealed = await seal(await this.#opts.key, frame, compress);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(envelope);
					return;
				}
				if (this.#pendingSends.length >= MAX_PENDING_SENDS) return;
				this.#pendingSends.push(envelope);
			})
			.catch(() => {
				// dropped frame; the socket-level close path reports actionable failures
			});
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#retryMissingRoom = false;
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			if (!this.#retryMissingRoom) this.#attempt = 0;
			for (const envelope of this.#pendingSends) ws.send(envelope);
			this.#pendingSends.length = 0;
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: In;
				try {
					frame = await open<In>(await this.#opts.key, envelope.payload);
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.#retryMissingRoom = false;
				this.#attempt = 0;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		const fatalReason = RELAY_CLOSE_REASONS[code];
		const closeReason = fatalReason ?? (reason || `connection lost (code ${code})`);
		const retryRoom = this.#opts.role === "guest" && (code === 4001 || (code === 4004 && this.#retryMissingRoom));
		if (retryRoom) {
			this.#retryMissingRoom = true;
			this.onClose?.(closeReason, true);
			this.#scheduleRetry();
			return;
		}
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt++;
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
