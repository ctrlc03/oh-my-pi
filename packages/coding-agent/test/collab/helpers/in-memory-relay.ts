/**
 * In-memory collab transport shared by the collab test suites.
 *
 * `FakeWebSocket` + `InMemoryRelay` replace the real Bun.serve relay and
 * loopback WebSocket. They mirror the production relay's forwarding contract
 * exactly (4-byte peerId envelope routing, peer-joined/peer-left control
 * frames) but deliver every frame on a microtask with zero network or timer
 * latency. Real `CollabSocket` / `CollabHost` / `CollabGuestLink` run
 * unchanged on top, so sealing, enveloping, the hello→welcome handshake, and
 * permission enforcement are all exercised.
 *
 * Usage: `installInMemoryRelay()` in `beforeAll`/`beforeEach`,
 * `uninstallInMemoryRelay()` in the matching `afterAll`/`afterEach`.
 */
import { rewriteEnvelopePeer, unpackEnvelope } from "@oh-my-pi/pi-coding-agent/collab/protocol";

/** Active relay the fake transport routes through; set between install/uninstall. */
let activeRelay: InMemoryRelay | null = null;
/** Extra relays addressed by the `host[:port]` of the URL a socket connects to; everything else uses {@link activeRelay}. */
const relaysByHost = new Map<string, InMemoryRelay>();

/** Pristine constructor captured before any test swaps it. */
const RealWebSocket = globalThis.WebSocket;

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	binaryType = "blob";
	/** Always 0 unless a test drives it; CollabSocket reads it as its high-water mark. */
	bufferedAmount = 0;
	readyState: number = FakeWebSocket.CONNECTING;
	readonly role: "host" | "guest";
	peerId = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly #relay: InMemoryRelay;
	readonly #pongListeners: Array<() => void> = [];

	constructor(url: string) {
		const target = new URL(url);
		const relay = relaysByHost.get(target.host) ?? activeRelay;
		if (!relay) throw new Error("FakeWebSocket: no active in-memory relay");
		this.#relay = relay;
		this.role = target.searchParams.get("role") === "host" ? "host" : "guest";
		queueMicrotask(() => {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			if (relay.offline) {
				// Refused connection: the close arrives without an open, as for an unreachable host.
				this.readyState = FakeWebSocket.CLOSED;
				this.onclose?.({ code: 1006, reason: "" });
				return;
			}
			this.readyState = FakeWebSocket.OPEN;
			relay.connect(this);
			this.onopen?.();
		});
	}

	send(data: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		// Snapshot: the relay rewrites the peerId in place, and the sender may
		// reuse the buffer once send() returns. Routing happens now, against the
		// room as it is at send time, so a frame written just before close() still
		// reaches peers the close will retire; delivery itself stays asynchronous.
		const bytes = new Uint8Array(data);
		this.#relay.forward(this, bytes);
	}

	addEventListener(type: string, listener: () => void): void {
		if (type === "pong") this.#pongListeners.push(listener);
	}

	/** The relay answers every ping, as a live one does. */
	ping(): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => {
			for (const listener of this.#pongListeners) listener();
		});
	}

	terminate(): void {
		this.close();
	}

	close(_code?: number): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.#relay.disconnect(this);
		queueMicrotask(() => this.onclose?.({ code: 1000, reason: "closed" }));
	}

	/** Relay-initiated close with a fatal code, as when the room disappears. */
	closeFatal(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		queueMicrotask(() => this.onclose?.({ code: 4001, reason: "room closed" }));
	}

	/** The transport died under this socket (relay process killed): abnormal closure, no goodbye. */
	drop(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		queueMicrotask(() => this.onclose?.({ code: 1006, reason: "" }));
	}

	/** Relay → this socket: a binary frame, delivered as ArrayBuffer (binaryType "arraybuffer"). */
	deliver(bytes: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const copy = new Uint8Array(bytes);
		queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
	}

	/** Relay → this socket: a JSON control message. */
	deliverControl(json: string): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => this.onmessage?.({ data: json }));
	}
}

/** Single-room in-memory relay mirroring the production forwarding contract. */
export class InMemoryRelay {
	#host: FakeWebSocket | null = null;
	readonly #guests = new Map<number, FakeWebSocket>();
	#nextPeerId = 1;
	/** While set, new connections are refused without ever opening. */
	offline = false;

	/** Whether a host currently holds the room. */
	get hasHost(): boolean {
		return this.#host !== null;
	}

	/** Kill the relay process: every connection drops, the room is gone, and new connections are refused. */
	goOffline(): void {
		this.offline = true;
		const sockets = [...(this.#host ? [this.#host] : []), ...this.#guests.values()];
		this.#host = null;
		this.#guests.clear();
		this.#nextPeerId = 1;
		for (const socket of sockets) socket.drop();
	}

	connect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			this.#host = ws;
			return;
		}
		ws.peerId = this.#nextPeerId++;
		this.#guests.set(ws.peerId, ws);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-joined", peer: ws.peerId }));
	}

	forward(from: FakeWebSocket, bytes: Uint8Array): void {
		if (from.role === "host") {
			const envelope = unpackEnvelope(bytes);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of this.#guests.values()) guest.deliver(bytes);
			} else {
				this.#guests.get(envelope.peerId)?.deliver(bytes);
			}
			return;
		}
		rewriteEnvelopePeer(bytes, from.peerId);
		this.#host?.deliver(bytes);
	}

	disconnect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			if (this.#host !== ws) return;
			this.#host = null;
			// Mirrors local-relay.ts: losing the host destroys the room. Every guest
			// is closed with the fatal 4001, and a reconnecting host gets a fresh
			// room that issues peer ids from 1 again.
			for (const guest of this.#guests.values()) guest.closeFatal();
			this.#guests.clear();
			this.#nextPeerId = 1;
			return;
		}
		this.#guests.delete(ws.peerId);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-left", peer: ws.peerId }));
	}
}

/**
 * Create a fresh relay and route `new WebSocket(...)` through it.
 * Pair with {@link uninstallInMemoryRelay} in the matching after-hook.
 */
export function installInMemoryRelay(): InMemoryRelay {
	activeRelay = new InMemoryRelay();
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return activeRelay;
}

/** A second relay that sockets reach by connecting to a URL with this `host[:port]`; call after {@link installInMemoryRelay}. */
export function addInMemoryRelay(host: string): InMemoryRelay {
	const relay = new InMemoryRelay();
	relaysByHost.set(host, relay);
	return relay;
}

/**
 * Restore the real WebSocket constructor and drop the active relay. Sockets
 * already constructed keep their own relay reference, so in-flight teardown
 * (e.g. `host.stop()`) still works after uninstall.
 */
export function uninstallInMemoryRelay(): void {
	globalThis.WebSocket = RealWebSocket;
	activeRelay = null;
	relaysByHost.clear();
}
