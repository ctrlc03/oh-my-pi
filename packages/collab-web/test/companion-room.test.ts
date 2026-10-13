import { afterEach, describe, expect, it } from "bun:test";
import { LOCAL_PEER_BASE, type RoomRoute, RoomHost } from "../scripts/companion-room";
import { startLocalRelay } from "../scripts/local-relay";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { CollabSocket } from "../src/lib/socket";

const ROOM = "CompanionRoom_1234";
const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

function until<T>(label: string, pick: () => T | undefined): Promise<T> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 3_000;
		const poll = (): void => {
			const value = pick();
			if (value !== undefined) resolve(value);
			else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
			else setTimeout(poll, 10);
		};
		poll();
	});
}

describe("the companion's room on two relays", () => {
	it("keeps guests of different relays apart, even when both relays number them 1", async () => {
		const key = generateRoomKey();
		const publicRelay = startLocalRelay(0);
		const localRelay = startLocalRelay(0);
		stops.push(
			() => publicRelay.stop(),
			() => localRelay.stop(),
		);
		const host = new RoomHost<{ t: string; from?: string }, { t: string; name: string }>({
			publicUrl: `${publicRelay.url}/r/${ROOM}`,
			localUrl: `${localRelay.url}/r/${ROOM}`,
			key: importRoomKey(key),
		});
		stops.push(() => host.close());
		const opened = new Set<RoomRoute>();
		const heard: Array<{ name: string; peer: number }> = [];
		host.onOpen = route => opened.add(route);
		host.onFrame = (frame, peer) => heard.push({ name: frame.name, peer });
		host.connect();
		await until("both relays open", () => (opened.size === 2 ? true : undefined));

		const guest = (relay: string, name: string) => {
			const socket = new CollabSocket<{ t: string; name: string }, { t: string; from?: string }>({
				wsUrl: `${relay}/r/${ROOM}`,
				role: "guest",
				key: importRoomKey(key),
			});
			const received: Array<{ t: string; from?: string }> = [];
			socket.onFrame = frame => received.push(frame);
			socket.onOpen = () => socket.send({ t: "hello", name });
			stops.push(() => socket.close());
			socket.connect();
			return received;
		};
		const viaPublic = guest(publicRelay.url, "public guest");
		const viaLocal = guest(localRelay.url, "local guest");
		await until("both hellos", () => (heard.length === 2 ? true : undefined));

		const peerOf = (name: string): number => heard.find(entry => entry.name === name)!.peer;
		expect(peerOf("public guest")).toBe(1);
		expect(peerOf("local guest")).toBe(LOCAL_PEER_BASE + 1);
		expect(RoomHost.routeOf(peerOf("public guest"))).toBe("public");
		expect(RoomHost.routeOf(peerOf("local guest"))).toBe("local");

		// A reply reaches only the guest it is addressed to ...
		host.send({ t: "reply", from: "to local" }, peerOf("local guest"));
		await until("the local reply", () => (viaLocal.length === 1 ? true : undefined));
		expect(viaLocal[0]!.from).toBe("to local");
		expect(viaPublic).toHaveLength(0);
		host.send({ t: "reply", from: "to public" }, peerOf("public guest"));
		await until("the public reply", () => (viaPublic.length === 1 ? true : undefined));
		expect(viaPublic[0]!.from).toBe("to public");
		expect(viaLocal).toHaveLength(1);
		// ... and a broadcast reaches both.
		host.send({ t: "reply", from: "everyone" });
		await until("both broadcasts", () => (viaPublic.length === 2 && viaLocal.length === 2 ? true : undefined));
	});

	it("reports which relay a closure belongs to", async () => {
		const key = generateRoomKey();
		const publicRelay = startLocalRelay(0);
		const localRelay = startLocalRelay(0);
		stops.push(() => publicRelay.stop());
		const host = new RoomHost<{ t: string }, { t: string }>({
			publicUrl: `${publicRelay.url}/r/${ROOM}`,
			localUrl: `${localRelay.url}/r/${ROOM}`,
			key: importRoomKey(key),
		});
		stops.push(() => host.close());
		const opened = new Set<RoomRoute>();
		const closed: RoomRoute[] = [];
		host.onOpen = route => opened.add(route);
		host.onClose = route => closed.push(route);
		host.connect();
		await until("both relays open", () => (opened.size === 2 ? true : undefined));
		localRelay.stop();
		await until("a close", () => (closed.length > 0 ? true : undefined));
		expect(closed[0]).toBe("local");
	});
});
