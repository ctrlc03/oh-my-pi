import { afterEach, describe, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { CollabSocket, RELAY_PING_INTERVAL_MS, RELAY_SILENCE_LIMIT_MS } from "../src/lib/socket";

const NativeWebSocket = globalThis.WebSocket;
const ROOM_URL = "wss://relay.example/r/CompanionRoom_1234";

/** Bun's WebSocket as the companion sees it: protocol `ping()`, `terminate()` and a `pong` event, none of it in browsers. */
class PingableWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: PingableWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = PingableWebSocket.CONNECTING;
	pings = 0;
	terminated = false;
	readonly #pongListeners: Array<() => void> = [];

	constructor(url: string | URL) {
		this.url = String(url);
		PingableWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	ping(): void {
		this.pings++;
	}

	terminate(): void {
		this.terminated = true;
		this.readyState = PingableWebSocket.CLOSED;
	}

	addEventListener(type: string, listener: () => void): void {
		if (type === "pong") this.#pongListeners.push(listener);
	}

	pong(): void {
		for (const listener of this.#pongListeners) listener();
	}

	open(): void {
		this.readyState = PingableWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === PingableWebSocket.CLOSED) return;
		this.readyState = PingableWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
}

function instance(index: number): PingableWebSocket {
	const ws = PingableWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

function hostSocket(): { socket: CollabSocket; closes: Array<[string, boolean]> } {
	PingableWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: PingableWebSocket });
	const socket = new CollabSocket({ wsUrl: ROOM_URL, role: "host", key: importRoomKey(generateRoomKey()) });
	const closes: Array<[string, boolean]> = [];
	socket.onClose = (reason, willReconnect) => closes.push([reason, willReconnect]);
	return { socket, closes };
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("a host socket's liveness on the relay", () => {
	it("pings, then replaces a socket that heard nothing for the silence limit, hosting the same room again", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { socket, closes } = hostSocket();

		try {
			socket.connect();
			instance(0).open();

			vi.advanceTimersByTime(RELAY_SILENCE_LIMIT_MS);
			expect(instance(0).pings).toBe(2);
			expect(closes).toEqual([]);
			expect(instance(0).readyState).toBe(PingableWebSocket.OPEN);

			// The first check after the limit passed (the third tick, 45 s) finds nothing heard: drop the socket, detach
			// it, retry with backoff. Stop at the tick: the retry is 1 s later.
			vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 3 - RELAY_SILENCE_LIMIT_MS);
			expect(closes).toEqual([["relay stopped responding", true]]);
			expect(instance(0).terminated).toBe(true);
			expect(instance(0).onmessage).toBeNull();
			expect(instance(0).onclose).toBeNull();
			expect(PingableWebSocket.instances).toHaveLength(1);

			vi.advanceTimersByTime(1_000);
			expect(PingableWebSocket.instances).toHaveLength(2);
			expect(instance(1).url).toBe(`${ROOM_URL}?role=host`);
			instance(1).open();
			expect(socket.isOpen).toBe(true);

			// The old socket is not pinged any more; only the new one is.
			const oldPings = instance(0).pings;
			vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
			expect(instance(0).pings).toBe(oldPings);
			expect(instance(1).pings).toBe(1);
		} finally {
			socket.close();
		}
	});

	it("keeps a socket whose relay answers, by pong or by any message", () => {
		vi.useFakeTimers();
		const { socket, closes } = hostSocket();

		try {
			socket.connect();
			instance(0).open();

			vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 2);
			instance(0).pong();
			vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 2);
			instance(0).onmessage?.(new MessageEvent("message", { data: '{"t":"peer-joined","peer":1}' }));
			vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 2);

			expect(closes).toEqual([]);
			expect(PingableWebSocket.instances).toHaveLength(1);
			expect(instance(0).terminated).toBe(false);
		} finally {
			socket.close();
		}
	});

	it("stops pinging and never reconnects once closed", () => {
		vi.useFakeTimers();
		const { socket } = hostSocket();

		socket.connect();
		instance(0).open();
		socket.close();
		const pings = instance(0).pings;

		vi.advanceTimersByTime(RELAY_SILENCE_LIMIT_MS * 3);
		expect(instance(0).pings).toBe(pings);
		expect(PingableWebSocket.instances).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
