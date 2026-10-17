/**
 * Contract: a host's local relay that stays unreachable is replaced by the one the companion's
 * endpoint lookup names, so a companion that came back on another port is followed. The lookup
 * runs only after repeated failures and at most every {@link LOCAL_MOVE_RECHECK_MS}; a lookup
 * that names nothing, or the port already in use, changes nothing; the public relay is never
 * touched; without a lookup the socket behaves as it always has.
 *
 * With `Math.random` pinned to 0.5 the socket's retry delays are exactly 1 s, 2 s, 4 s, 8 s, …,
 * so its failures land at t = 0, 1, 3, 7, 15, 31, 61 s after the old relay goes away.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { FanoutSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-fanout";
import {
	addInMemoryRelay,
	type InMemoryRelay,
	installInMemoryRelay,
	uninstallInMemoryRelay,
} from "./helpers/in-memory-relay";

const PUBLIC_WS = "ws://localhost:8788/r/room";
const OLD_PORT = 8789;
const NEW_PORT = 8790;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Let the in-memory sockets' microtasks run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += 500) {
		vi.advanceTimersByTime(500);
		await settle();
	}
}

interface Setup {
	publicRelay: InMemoryRelay;
	oldRelay: InMemoryRelay;
	newRelay: InMemoryRelay;
	socket: FanoutSocket;
	moves: string[];
	/** What the lookup answers; settable per test. */
	answer: { port: number | undefined };
	lookups: { count: number };
}

async function setup(withLookup: boolean): Promise<Setup> {
	const key = await importRoomKey(generateRoomKey());
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const publicRelay = installInMemoryRelay();
	const oldRelay = addInMemoryRelay(`127.0.0.1:${OLD_PORT}`);
	const newRelay = addInMemoryRelay(`127.0.0.1:${NEW_PORT}`);
	const answer: Setup["answer"] = { port: NEW_PORT };
	const lookups = { count: 0 };
	const socket = new FanoutSocket({
		wsUrl: PUBLIC_WS,
		localWsUrl: `ws://127.0.0.1:${OLD_PORT}/r/room`,
		locateLocalRelay: withLookup
			? () => {
					lookups.count++;
					return answer.port;
				}
			: undefined,
		key,
	});
	const moves: string[] = [];
	socket.onLocalRelayMoved = url => moves.push(url);
	cleanups.push(() => socket.close());
	socket.connect();
	await settle();
	expect(oldRelay.hasHost && socket.localOpen).toBe(true);
	return { publicRelay, oldRelay, newRelay, socket, moves, answer, lookups };
}

it("follows the lookup to the new port after the old local relay goes away, keeping the public relay", async () => {
	const s = await setup(true);
	s.oldRelay.goOffline();
	await settle();
	await advance(2_500);
	expect(s.newRelay.hasHost).toBe(false);
	await advance(1_000);
	expect(s.newRelay.hasHost).toBe(true);
	expect(s.moves).toEqual([`ws://127.0.0.1:${NEW_PORT}`]);
	expect(s.socket.localOpen).toBe(true);
	expect(s.socket.isOpen).toBe(true);
	expect(s.publicRelay.hasHost).toBe(true);
});

it("changes nothing when the lookup names the port already in use or nothing", async () => {
	const s = await setup(true);
	s.answer.port = OLD_PORT;
	s.oldRelay.goOffline();
	await settle();
	await advance(4_000);
	expect(s.lookups.count).toBe(1);
	expect(s.moves).toEqual([]);
	expect(s.newRelay.hasHost).toBe(false);

	// The old relay returning is still picked up by the same socket's own retries.
	s.oldRelay.offline = false;
	await advance(10_000);
	expect(s.oldRelay.hasHost).toBe(true);
	expect(s.moves).toEqual([]);
});

it("asks again only after the recheck interval", async () => {
	const s = await setup(true);
	s.answer.port = undefined;
	s.oldRelay.goOffline();
	await settle();
	await advance(4_000);
	expect(s.lookups.count).toBe(1);

	s.answer.port = NEW_PORT;
	// The failures at 7, 15 and 31 s all fall within 30 s of the lookup at 3 s.
	await advance(40_000 - 4_000);
	expect(s.lookups.count).toBe(1);
	expect(s.newRelay.hasHost).toBe(false);

	await advance(25_000);
	expect(s.lookups.count).toBe(2);
	expect(s.newRelay.hasHost).toBe(true);
});

it("keeps retrying the configured relay when no lookup is given", async () => {
	const s = await setup(false);
	s.oldRelay.goOffline();
	await settle();
	await advance(10_000);
	expect(s.newRelay.hasHost).toBe(false);
	expect(s.moves).toEqual([]);
	s.oldRelay.offline = false;
	await advance(10_000);
	expect(s.oldRelay.hasHost).toBe(true);
});
