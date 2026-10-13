import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { GuestClient } from "../src/lib/client";
import { DEFAULT_RELAY_URL, formatCollabLink } from "../src/lib/link";
import {
	LOCAL_CONNECT_TIMEOUT_MS,
	LOCAL_RELAY_COOLDOWN_MS,
	LocalRelayHealth,
	localRelayToTry,
	servedByLabel,
	servedRelay,
	servedRoomUrl,
} from "../src/lib/relay-route";

const LOCAL = "ws://127.0.0.1:7467/r/RouteRoom_12345";

describe("local relay routing decision", () => {
	it("tries the local relay only on a computer that can be the host's, and only when the link names one", () => {
		const health = new LocalRelayHealth();
		expect(localRelayToTry(LOCAL, false, health, 0)).toBe(LOCAL);
		expect(localRelayToTry(undefined, false, health, 0)).toBeNull();
		expect(localRelayToTry(LOCAL, true, health, 0)).toBeNull();
	});

	it("leaves a failed relay alone for the cooldown, then tries it again", () => {
		const health = new LocalRelayHealth();
		health.markDown(LOCAL, "relay", 1_000);
		expect(localRelayToTry(LOCAL, false, health, 1_000 + LOCAL_RELAY_COOLDOWN_MS - 1)).toBeNull();
		expect(localRelayToTry(LOCAL, false, health, 1_000 + LOCAL_RELAY_COOLDOWN_MS)).toBe(LOCAL);
	});

	it("blames the relay for every room on it, but a missing room only for that room", () => {
		const health = new LocalRelayHealth();
		const otherRoom = "ws://127.0.0.1:7467/r/AnotherRoom_9876";
		health.markDown(LOCAL, "room", 0);
		expect(health.isDown(LOCAL, 1)).toBe(true);
		expect(health.isDown(otherRoom, 1)).toBe(false);
		health.markDown(LOCAL, "relay", 0);
		expect(health.isDown(otherRoom, 1)).toBe(true);
	});
});

const page = (url: string) => new URL(url);

describe("a page served by the companion's loopback relay", () => {
	it("knows its relay from its own origin: http on 127.0.0.1 or localhost, nothing else", () => {
		expect(servedRelay(page("http://127.0.0.1:7467/"))).toBe("ws://127.0.0.1:7467");
		expect(servedRelay(page("http://localhost:7468/#pair:x"))).toBe("ws://localhost:7468");
		expect(servedRelay(page("https://ctrlc03.github.io/oh-my-pi/"))).toBeNull();
		expect(servedRelay(page("https://127.0.0.1:7467/"))).toBeNull();
		expect(servedRelay(page("http://192.168.1.20:7467/"))).toBeNull();
		expect(servedRelay(page("http://127.0.0.1.evil.example:7467/"))).toBeNull();
	});

	it("tries every room on that relay first, whatever the link says, and none anywhere else", () => {
		const relay = servedRelay(page("http://127.0.0.1:7467/"));
		expect(servedRoomUrl("wss://my.omp.sh/r/CompanionRoom_123", relay)).toBe(
			"ws://127.0.0.1:7467/r/CompanionRoom_123",
		);
		expect(servedRoomUrl("wss://other.example:8443/r/RouteRoom_12345", relay)).toBe(
			"ws://127.0.0.1:7467/r/RouteRoom_12345",
		);
		expect(servedRoomUrl("wss://my.omp.sh/r/CompanionRoom_123", null)).toBeUndefined();
	});

	it("says who serves the app", () => {
		expect(servedByLabel(page("http://127.0.0.1:7467/"))).toBe("This computer");
		expect(servedByLabel(page("https://ctrlc03.github.io/oh-my-pi/"))).toBe("GitHub Pages");
		expect(servedByLabel(page("https://my.omp.sh/"))).toBe("my.omp.sh");
	});
});

class ScriptedWebSocket {
	static instances: ScriptedWebSocket[] = [];
	/** Hosts the page refuses to construct a socket for, as Safari refuses ws:// from https. */
	static refused = new Set<string>();

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = 0;

	constructor(url: string | URL) {
		this.url = String(url);
		if (ScriptedWebSocket.refused.has(new URL(this.url).host)) throw new Error("SecurityError");
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	fail(code: number, reason = ""): void {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000): void {
		if (this.readyState !== 3) this.fail(code);
	}
}

const NativeWebSocket = globalThis.WebSocket;
let nextPort = 20_000;

/** A guest on a link naming a local relay. A port per test: the page-wide relay health outlives a client. */
function guestWithLocalRelay(): { client: GuestClient; localHost: string } {
	const port = nextPort++;
	const link = formatCollabLink(
		DEFAULT_RELAY_URL,
		"RouteRoom_12345",
		new Uint8Array(32),
		undefined,
		`ws://127.0.0.1:${port}`,
	);
	return { client: new GuestClient(link, "tester"), localHost: `127.0.0.1:${port}` };
}

const urls = (): string[] => ScriptedWebSocket.instances.map(ws => new URL(ws.url).host);

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	ScriptedWebSocket.refused = new Set();
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	vi.useRealTimers();
	setSystemTime();
});

describe("guest connecting through a local relay", () => {
	it("prefers the local relay when it answers", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const { client, localHost } = guestWithLocalRelay();
		try {
			client.connect();
			expect(urls()).toEqual([localHost]);
			ScriptedWebSocket.instances[0]!.open();
			vi.advanceTimersByTime(LOCAL_CONNECT_TIMEOUT_MS * 2);
			expect(urls()).toEqual([localHost]);
		} finally {
			client.close();
		}
	});

	it("falls back to the public relay at once when the local one refuses the connection", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const { client, localHost } = guestWithLocalRelay();
		try {
			client.connect();
			ScriptedWebSocket.instances[0]!.fail(1006);
			expect(urls()).toEqual([localHost, "my.omp.sh"]);
			expect(client.getSnapshot().phase).not.toBe("ended");
		} finally {
			client.close();
		}
	});

	it("falls back when the local relay never opens, and when the page refuses the socket outright", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const silent = guestWithLocalRelay();
		try {
			silent.client.connect();
			vi.advanceTimersByTime(LOCAL_CONNECT_TIMEOUT_MS);
			expect(urls()).toEqual([silent.localHost, "my.omp.sh"]);
		} finally {
			silent.client.close();
		}

		installScriptedWebSocket();
		const refused = guestWithLocalRelay();
		ScriptedWebSocket.refused.add(refused.localHost);
		try {
			refused.client.connect();
			expect(urls()).toEqual(["my.omp.sh"]);
		} finally {
			refused.client.close();
		}
	});

	it("falls back when the local relay does not hold the room, and does not retry it within the cooldown", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const { client, localHost } = guestWithLocalRelay();
		try {
			client.connect();
			ScriptedWebSocket.instances[0]!.open();
			ScriptedWebSocket.instances[0]!.fail(4004, "no such room");
			expect(urls()).toEqual([localHost, "my.omp.sh"]);
			// The public relay then drops the connection: the retry skips the local relay.
			ScriptedWebSocket.instances[1]!.open();
			ScriptedWebSocket.instances[1]!.fail(1006);
			vi.advanceTimersByTime(60_000);
			expect(urls().every((host, i) => i === 0 || host === "my.omp.sh")).toBe(true);
			expect(urls().length).toBeGreaterThan(2);
		} finally {
			client.close();
		}
	});

	it("tries the local relay again once the cooldown has passed", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const { client, localHost } = guestWithLocalRelay();
		try {
			client.connect();
			ScriptedWebSocket.instances[0]!.fail(1006);
			ScriptedWebSocket.instances[1]!.open();
			setSystemTime(Date.now() + LOCAL_RELAY_COOLDOWN_MS + 1);
			ScriptedWebSocket.instances[1]!.fail(1006);
			vi.advanceTimersByTime(60_000);
			expect(urls().slice(2).includes(localHost)).toBe(true);
		} finally {
			client.close();
		}
	});
});
