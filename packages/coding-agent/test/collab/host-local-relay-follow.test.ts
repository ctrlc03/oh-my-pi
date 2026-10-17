/**
 * Contract: when `collab.localRelayEndpointFile` names a live companion on another loopback port
 * and the host's local relay stays unreachable, the host serves its room on the new port: guests
 * joining there get live frames and the link handed to local tools names the new port. A file
 * naming a dead process, or an empty setting, leaves the host retrying the configured relay.
 *
 * Drives the production `CollabHost` over in-memory relays with the retry clock under test control.
 */
import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
import { makeHostContext, makeSnapshot, waitFor } from "./helpers/throttled-host";

const PUBLIC_RELAY = "ws://localhost:8788";
const OLD_RELAY = "ws://127.0.0.1:8789";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

interface Room {
	host: CollabHost;
	oldRelay: InMemoryRelay;
	newRelay: InMemoryRelay;
	endpointFile: string;
	announce(message: string): void;
}

async function openRoom(setting: "file" | "empty"): Promise<Room> {
	installInMemoryRelay();
	const oldRelay = addInMemoryRelay("127.0.0.1:8789");
	const newRelay = addInMemoryRelay("127.0.0.1:8790");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-endpoint-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const endpointFile = path.join(dir, "collab-companion-local.json");
	const ctx = makeHostContext(makeSnapshot(), { notices: [], participantCounts: [] });
	Object.assign(ctx, {
		settings: Settings.isolated({ "collab.localRelayEndpointFile": setting === "file" ? endpointFile : "" }),
	});
	const session = ctx.session as unknown as {
		emitNotice(level: string, message: string, source?: string): void;
	};
	const host = new CollabHost(ctx as InteractiveModeContext);
	cleanups.push(() => void host.stop("test done"));
	await host.start(PUBLIC_RELAY, "", OLD_RELAY);
	return {
		host,
		oldRelay,
		newRelay,
		endpointFile,
		announce: message => session.emitNotice("info", message, "collab"),
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Runs the host's retry timers; with `Math.random` pinned its local socket fails at 0, 1, 3, 7 s. */
async function advance(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += 500) {
		vi.advanceTimersByTime(500);
		await settle();
	}
}

function localPort(host: CollabHost): string {
	const parsed = parseCollabLink(host.registryLink("control"));
	if ("error" in parsed) throw new Error(parsed.error);
	return new URL(parsed.localWsUrl ?? "ws://missing").port;
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", ""]);
	await child.exited;
	return child.pid;
}

it("moves its local relay to the port in the endpoint file, so a guest there gets frames and the link names it", async () => {
	const room = await openRoom("file");
	expect(localPort(room.host)).toBe("8789");
	fs.writeFileSync(room.endpointFile, JSON.stringify({ pid: process.pid, port: 8790, app: false }));
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);

	room.oldRelay.goOffline();
	await settle();
	await advance(4_000);
	expect(room.newRelay.hasHost).toBe(true);
	expect(localPort(room.host)).toBe("8790");
	// What /collab prints stays shareable beyond this machine.
	expect(room.host.webLink).not.toContain("127.0.0.1");

	const parsed = parseCollabLink(room.host.registryLink("control"));
	if ("error" in parsed || !parsed.localWsUrl) throw new Error("registry link lacks the local relay");
	// The host has already moved; the guest handshake below needs real timers.
	vi.useRealTimers();
	const key = await importRoomKey(parsed.key);
	const guest = new CollabSocket({ wsUrl: parsed.localWsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "mac" });
	guest.connect();
	await waitFor(
		() => frames.some(f => f.t === "snapshot-chunk" && f.final),
		"the guest on the new local relay never got its snapshot",
	);
	room.announce("after the move");
	await waitFor(
		() =>
			frames.some(f => {
				if (f.t !== "event" || f.event.type !== "notice") return false;
				return "message" in f.event && f.event.message === "after the move";
			}),
		"the guest on the new local relay saw no live traffic",
	);
});

it("stays on the configured port when the endpoint file names a dead process", async () => {
	const room = await openRoom("file");
	fs.writeFileSync(room.endpointFile, JSON.stringify({ pid: await deadPid(), port: 8790, app: false }));
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);

	room.oldRelay.goOffline();
	await settle();
	await advance(10_000);
	expect(room.newRelay.hasHost).toBe(false);
	expect(localPort(room.host)).toBe("8789");
});

it("ignores the endpoint file when the setting is empty", async () => {
	const room = await openRoom("empty");
	fs.writeFileSync(room.endpointFile, JSON.stringify({ pid: process.pid, port: 8790, app: false }));
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);

	room.oldRelay.goOffline();
	await settle();
	await advance(10_000);
	expect(room.newRelay.hasHost).toBe(false);
	expect(localPort(room.host)).toBe("8789");
});
