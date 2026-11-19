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
import {
	LOCAL_CONNECT_TIMEOUT_MS,
	type LocalFailure,
	localRelayHealth,
	localRelayToTry,
	pageRelay,
	servedRoomUrl,
} from "./relay-route";

/** Close reason for relay code 4009: another host holds the room. A companion retries it on its own schedule. */
export const HOST_TAKEN_REASON = "a host is already connected for this room";

const RELAY_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: HOST_TAKEN_REASON,
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
 * How often an open socket is pinged, where the runtime can ping (Bun: the companion, and any other non-browser
 * host). A network that drops without a reset (Wi-Fi switch, sleep, the relay redeploying) leaves the socket reading
 * as open and the relay without the host's room: nothing reveals it until a write, so an idle companion would stay
 * unreachable until someone typed. Mirrors the omp host's relay client.
 */
export const RELAY_PING_INTERVAL_MS = 15_000;
/** A socket that has heard nothing, not even a pong, for this long is replaced; see {@link RELAY_PING_INTERVAL_MS}. */
export const RELAY_SILENCE_LIMIT_MS = 40_000;

/**
 * Whether the OS suspends this page's sockets while it is hidden: true on touch devices
 * (phones and tablets). Desktop browsers keep a hidden tab's sockets alive, so replacing
 * them there would only flash a reconnect on every tab return. Gate {@link CollabSocket.suspend} on it.
 */
export function suspendsHiddenPages(): boolean {
	return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Bun's WebSocket constructor: the DOM typings this file compiles against know no options object. */
type BunWebSocket = new (url: string, options: { proxy: string }) => WebSocket;

/** Bun's WebSocket answers protocol pings and can drop a connection without a closing handshake; browsers' cannot. */
interface PingableWebSocket extends WebSocket {
	ping(): void;
	terminate(): void;
}

function isPingable(ws: WebSocket): ws is PingableWebSocket {
	return "ping" in ws && typeof ws.ping === "function" && "terminate" in ws && typeof ws.terminate === "function";
}

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	/**
	 * ws://127.0.0.1:<port>/r/<roomId>: the same room on a relay on the host's machine. Tried first
	 * where the device could be that machine, abandoned for `wsUrl` at once when it does not answer
	 * (see `relay-route.ts`). A guest page that the companion serves from that relay tries it for every room, link or not.
	 */
	localWsUrl?: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
	/**
	 * HTTP proxy for the connection to `wsUrl` (Bun only; browsers use their own proxy settings). The companion sets
	 * it in a VM whose only way out is the host's egress proxy, where Bun's WebSocket would otherwise ignore `https_proxy`.
	 */
	proxy?: string;
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
	/** The loopback room to try first: the link's, else the relay this page was served from (guests only). */
	readonly #localWsUrl: string | undefined;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/**
	 * The relay has told this guest its host is away (4001, or 4004 after one) and the host has not answered since:
	 * holds the backoff across the relay accepting each upgrade only to close it. Cleared by the next decrypted frame.
	 */
	#hostAway = false;
	/** This guest received a decrypted frame on this link, so its room existed: a later 4004 is the host being away, not a bad link. */
	#joined = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];
	/** When the page last went to the background; null while foregrounded. */
	#hiddenAt: number | null = null;
	/** Which relay the current connection attempt targets. */
	#route: "local" | "public" = "public";
	/** The current connection delivered a decrypted frame: its relay holds the room and works. */
	#established = false;
	#localTimer: Timer | undefined;
	#heartbeatTimer: Timer | undefined;
	/** When the current socket last received anything, pongs included. */
	#lastHeard = 0;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
		this.#localWsUrl = opts.localWsUrl ?? (opts.role === "guest" ? servedRoomUrl(opts.wsUrl) : undefined);
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	/** Bytes handed to the open WebSocket that it has not sent yet; 0 without one. */
	get bufferedAmount(): number {
		return this.#ws?.bufferedAmount ?? 0;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#hiddenAt = null;
		this.#hostAway = false;
		this.#joined = false;
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
		this.#stopHeartbeat();
		// A local connection that never delivered anything was no good; do not pick it again at once.
		if (this.#route === "local" && !this.#established) this.#markLocalDown("relay");
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
		this.#clearLocalTimer();
		this.#stopHeartbeat();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#hostAway = false;
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
		// A page served by the loopback relay is on the host's machine whatever its pointer.
		const touch = suspendsHiddenPages() && pageRelay() === null;
		const local = localRelayToTry(this.#localWsUrl, touch, localRelayHealth, Date.now());
		this.#connect(local === null ? this.#opts.wsUrl : local, local === null ? "public" : "local");
	}

	#markLocalDown(failure: LocalFailure): void {
		if (this.#localWsUrl !== undefined) localRelayHealth.markDown(this.#localWsUrl, failure, Date.now());
	}

	/** The local attempt is over: remember it and take the public relay, with no backoff. */
	#fallBackToPublic(failure: LocalFailure): void {
		this.#clearLocalTimer();
		this.#markLocalDown(failure);
		this.#openSocket();
	}

	#connect(wsUrl: string, route: "local" | "public"): void {
		this.#route = route;
		this.#established = false;
		let ws: WebSocket;
		try {
			const url = `${wsUrl}?role=${this.#opts.role}`;
			const proxy = route === "public" ? this.#opts.proxy : undefined;
			ws = proxy ? new (WebSocket as unknown as BunWebSocket)(url, { proxy }) : new WebSocket(url);
		} catch (err) {
			// The browser refused outright (Safari: ws:// from an https page).
			if (route === "public") throw err;
			this.#fallBackToPublic("relay");
			return;
		}
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		if (route === "local") {
			this.#localTimer = setTimeout(() => {
				this.#localTimer = undefined;
				if (this.#ws !== ws) return;
				this.#ws = null;
				try {
					ws.close();
				} catch {
					// already closing/closed
				}
				this.#fallBackToPublic("relay");
			}, LOCAL_CONNECT_TIMEOUT_MS);
		}
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#clearLocalTimer();
			this.#startHeartbeat(ws);
			if (!this.#hostAway) this.#attempt = 0;
			for (const envelope of this.#pendingSends) ws.send(envelope);
			this.#pendingSends.length = 0;
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			this.#handleMessage(ws, event.data);
		};
		if (isPingable(ws)) {
			ws.addEventListener("pong", () => {
				if (this.#ws === ws) this.#lastHeard = Date.now();
			});
		}
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearLocalTimer();
			this.#stopHeartbeat();
			this.#ws = null;
			// 4001 is the host leaving, which the public relay will report too: the normal path.
			if (route === "local" && event.code !== 4001) {
				if (!this.#established) {
					this.#fallBackToPublic(event.code === 4004 || event.code === 4029 ? "room" : "relay");
					return;
				}
				if (event.code < 4000) this.#markLocalDown("relay");
			}
			this.#handleClose(event.code, event.reason);
		};
	}

	/**
	 * Pings `ws` every {@link RELAY_PING_INTERVAL_MS} (a no-op where the runtime cannot ping: browsers) and replaces it
	 * once it has heard nothing for {@link RELAY_SILENCE_LIMIT_MS}. No close handshake can finish over a dead network, so
	 * the socket is terminated and detached rather than awaiting a close event that may never come; the replacement hosts
	 * the same room with the same key, so paired devices reconnect on their own.
	 */
	#startHeartbeat(ws: WebSocket): void {
		this.#stopHeartbeat();
		if (!isPingable(ws)) return;
		this.#lastHeard = Date.now();
		this.#heartbeatTimer = setInterval(() => {
			if (this.#ws !== ws) {
				this.#stopHeartbeat();
				return;
			}
			if (Date.now() - this.#lastHeard <= RELAY_SILENCE_LIMIT_MS) {
				try {
					ws.ping();
				} catch {
					// A failed write surfaces as the socket's own close event.
				}
				return;
			}
			this.reconnect("relay stopped responding");
			ws.onopen = null;
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			try {
				ws.terminate();
			} catch {
				// already gone
			}
		}, RELAY_PING_INTERVAL_MS);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer !== undefined) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = undefined;
		}
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
				this.#hostAway = false;
				this.#joined = true;
				this.#attempt = 0;
				this.#established = true;
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
		// A guest that has heard from its host on this link treats a missing room as the host being away (it reconnects
		// through the relay, or the relay redeployed): keep retrying. A link that never connected is bad or expired.
		const hostAway = this.#hostAway || this.#joined;
		const retryRoom = this.#opts.role === "guest" && (code === 4001 || (code === 4004 && hostAway));
		if (retryRoom) {
			this.#hostAway = true;
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
		this.#clearLocalTimer();
		this.#stopHeartbeat();
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

	#clearLocalTimer(): void {
		if (this.#localTimer !== undefined) {
			clearTimeout(this.#localTimer);
			this.#localTimer = undefined;
		}
	}
}
