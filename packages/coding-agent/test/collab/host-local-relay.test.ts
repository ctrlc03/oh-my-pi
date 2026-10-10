/**
 * Contract: a host given a local relay serves one room on both relays. Guests on either see
 * the same live session and may prompt, peer ids from the two relays never collide, and the
 * local relay is strictly optional: its absence, outage or restart never ends or degrades the
 * public session.
 *
 * Drives the production `CollabHost` over two in-memory relays.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	addInMemoryRelay,
	type InMemoryRelay,
	installInMemoryRelay,
	uninstallInMemoryRelay,
} from "./helpers/in-memory-relay";
import { type HostObservations, makeHostContext, makeSnapshot, waitFor } from "./helpers/throttled-host";

const PUBLIC_RELAY = "ws://localhost:8788";
const LOCAL_RELAY = "ws://127.0.0.1:8789";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
});

interface Guest {
	frames: CollabFrame[];
	prompt(text: string): void;
}

interface Room {
	host: CollabHost;
	seen: HostObservations;
	/** Prompts that reached the session, with the guest name they were attributed to. */
	prompts: { text: string; from: string }[];
	publicRelay: InMemoryRelay;
	localRelay: InMemoryRelay;
	/** The host announces something to every guest, as it does for its own notices. */
	announce(message: string): void;
	join(via: "public" | "local", name: string, withToken: boolean): Promise<Guest>;
}

async function openRoom(options: { localOffline?: boolean } = {}): Promise<Room> {
	const publicRelay = installInMemoryRelay();
	const localRelay = addInMemoryRelay("127.0.0.1:8789");
	localRelay.offline = options.localOffline ?? false;
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const prompts: Room["prompts"] = [];
	const ctx = makeHostContext(makeSnapshot(), seen);
	const session = ctx.session as unknown as {
		promptCustomMessage(message: unknown): Promise<boolean>;
		emitNotice(level: string, message: string, source?: string): void;
	};
	session.promptCustomMessage = async message => {
		const { content, details } = message as { content: string; details: { from: string } };
		prompts.push({ text: content, from: details.from });
		return true;
	};
	const host = new CollabHost(ctx as InteractiveModeContext);
	cleanups.push(() => void host.stop("test done"));
	await host.start(PUBLIC_RELAY, "", LOCAL_RELAY);
	const parsed = parseCollabLink(host.registryLink("control"));
	if ("error" in parsed) throw new Error(parsed.error);
	const { wsUrl: publicWsUrl, localWsUrl, writeToken } = parsed;
	if (!localWsUrl || !writeToken) throw new Error("registry link lacks the local relay or the write token");
	const key = await importRoomKey(parsed.key);
	const token = Buffer.from(writeToken).toString("base64url");

	const join = async (via: "public" | "local", name: string, withToken: boolean): Promise<Guest> => {
		const socket = new CollabSocket({ wsUrl: via === "public" ? publicWsUrl : localWsUrl, role: "guest", key });
		cleanups.push(() => socket.close());
		const frames: CollabFrame[] = [];
		let snapshotDone = false;
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) snapshotDone = true;
		};
		socket.onOpen = () =>
			socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken: withToken ? token : undefined });
		socket.connect();
		await waitFor(() => snapshotDone, `${name} never received its snapshot`);
		return { frames, prompt: text => socket.send({ t: "prompt", text }) };
	};

	return {
		host,
		seen,
		prompts,
		publicRelay,
		localRelay,
		announce: message => session.emitNotice("info", message, "collab"),
		join,
	};
}

const noticesSeenBy = (guest: Guest): string[] =>
	guest.frames.flatMap(frame =>
		frame.t === "event" && frame.event.type === "notice" ? [(frame.event as { message: string }).message] : [],
	);

it("serves one live session to guests on both relays, and both can prompt", async () => {
	const room = await openRoom();
	// What /collab prints is shared with people elsewhere: it never names a loopback relay.
	for (const printed of [room.host.link, room.host.webLink, room.host.viewLink, room.host.webViewLink]) {
		expect(printed).not.toContain("127.0.0.1");
	}
	const onPublic = await room.join("public", "phone", true);
	const onLocal = await room.join("local", "mac", true);
	// Both relays issued peer id 1: the host keeps them apart.
	await waitFor(() => room.seen.participantCounts.at(-1) === 3, "host never counted both guests");

	room.announce("broadcast reaches both relays");
	await waitFor(
		() =>
			noticesSeenBy(onPublic).includes("broadcast reaches both relays") &&
			noticesSeenBy(onLocal).includes("broadcast reaches both relays"),
		"a guest missed the broadcast",
	);

	onPublic.prompt("from the phone");
	onLocal.prompt("from the mac");
	await waitFor(() => room.prompts.length === 2, "a prompt never reached the session");
	expect(room.prompts.map(p => `${p.from}: ${p.text}`).sort()).toEqual(["mac: from the mac", "phone: from the phone"]);
}, 15_000);

it("does not let a read-only guest on one relay borrow the identical peer id of a writer on the other", async () => {
	const room = await openRoom();
	const readOnly = await room.join("public", "viewer", false);
	const writer = await room.join("local", "writer", true);
	await waitFor(() => room.seen.participantCounts.at(-1) === 3, "host never counted both guests");

	readOnly.prompt("sneaky");
	await waitFor(() => readOnly.frames.some(frame => frame.t === "error"), "the read-only guest was not refused");
	writer.prompt("legit");
	await waitFor(() => room.prompts.length === 1, "the writer's prompt never arrived");
	expect(room.prompts).toEqual([{ text: "legit", from: "writer" }]);
}, 15_000);

it("leaves the public session untouched when the local relay is killed", async () => {
	const room = await openRoom();
	const onPublic = await room.join("public", "phone", true);
	await room.join("local", "mac", true);
	await waitFor(() => room.seen.participantCounts.at(-1) === 3, "host never counted both guests");

	room.localRelay.goOffline();
	await waitFor(() => room.seen.participantCounts.at(-1) === 2, "the host never dropped the local guest");

	expect(room.host.stopped).toBe(false);
	expect(room.host.relayConnected).toBe(true);
	room.announce("still here");
	await waitFor(() => noticesSeenBy(onPublic).includes("still here"), "the public guest stopped receiving frames");
	onPublic.prompt("after the outage");
	await waitFor(() => room.prompts.length === 1, "the public guest can no longer prompt");
}, 15_000);

it("starts and serves the public relay while the local relay is unreachable, and picks the local one up when it appears", async () => {
	const room = await openRoom({ localOffline: true });
	const onPublic = await room.join("public", "phone", true);
	// More broadcasts than a send backlog holds, paced so the public relay keeps up: none may queue for the dead one.
	for (let batch = 0; batch < 10; batch++) {
		const last = `tick ${batch * 50 + 49}`;
		for (let i = 0; i < 50; i++) room.announce(`tick ${batch * 50 + i}`);
		await waitFor(() => noticesSeenBy(onPublic).includes(last), "the public guest missed live traffic");
	}
	expect(room.host.stopped).toBe(false);

	// The host's local socket retries on its own backoff; once it holds the room, guests can join there.
	room.localRelay.offline = false;
	await waitFor(() => room.localRelay.hasHost, "the host never reached the local relay", 15_000);
	const onLocal = await room.join("local", "mac", true);
	room.announce("after the relay came up");
	await waitFor(
		() => noticesSeenBy(onLocal).includes("after the relay came up"),
		"the local guest saw no live traffic",
	);
}, 40_000);

it("keeps local guests when the public relay recreates its room", async () => {
	const room = await openRoom();
	await room.join("public", "phone", true);
	const onLocal = await room.join("local", "mac", true);
	await waitFor(() => room.seen.participantCounts.at(-1) === 3, "host never counted both guests");

	// The relay process restarts: everything drops, and the host's reconnect finds an empty room.
	// The public guest reconnects and says hello again, so look for the dip rather than the end state.
	const before = room.seen.participantCounts.length;
	room.publicRelay.goOffline();
	room.publicRelay.offline = false;
	await waitFor(
		() => room.seen.participantCounts.slice(before).includes(2),
		"the public guest was not released",
		15_000,
	);

	onLocal.prompt("still writable");
	await waitFor(
		() => room.prompts.length === 1,
		"the local guest lost its identity when the public room was recreated",
	);
	expect(room.prompts[0]?.from).toBe("mac");
}, 30_000);
