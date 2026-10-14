import { afterEach, describe, expect, it, vi } from "bun:test";
import { CompanionClient } from "../src/lib/companion";
import { encodeBase64Url } from "../src/lib/link";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `ws://127.0.0.1:1/r/offline-companion-room.${encodeBase64Url(new Uint8Array(32))}`;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

function connected(): CompanionClient {
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
	const client = new CompanionClient({ link: LINK }, () => {});
	client.connect();
	instance(0).open();
	return client;
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("a computer whose companion stops", () => {
	it("reads offline once the relay closes its room, and is retried until it returns", () => {
		const client = connected();
		try {
			expect(client.getSnapshot().phase).toBe("connecting");
			instance(0).relayClose(4001, "room closed");
			const gone = client.getSnapshot();
			expect(gone.phase).toBe("offline");

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("offline");
		} finally {
			client.close();
		}
	});

	it("stays connecting while the relay itself is unreachable", () => {
		const client = connected();
		try {
			instance(0).relayClose(1006, "");
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("connecting");
			expect(snap.error).toBeNull();
		} finally {
			client.close();
		}
	});

	it("retries at once when the app returns to the foreground, without waiting out the backoff", () => {
		const client = connected();
		try {
			instance(0).relayClose(4001, "room closed");
			expect(client.getSnapshot().phase).toBe("offline");
			expect(ScriptedWebSocket.instances).toHaveLength(1);
			client.resume();
			expect(ScriptedWebSocket.instances).toHaveLength(2);
		} finally {
			client.close();
		}
	});
});
