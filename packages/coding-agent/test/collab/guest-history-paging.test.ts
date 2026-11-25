/**
 * Contract: a TUI guest that joined a long session from its newest turns shows
 * that earlier history is missing, pages it in on demand ahead of what it
 * holds, and starts over from a fresh snapshot when the host's history moves
 * under the part it never loaded.
 *
 * The host side is a scripted `CollabSocket` on the in-memory relay; the guest
 * is the production `CollabGuestLink` over a real transcript shell, with the
 * replica file captured instead of written.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const HEADER = { type: "session" as const, id: "host-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" };

function userEntry(index: number): SessionEntry {
	return {
		type: "message",
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		timestamp: "2026-06-26T00:00:00Z",
		message: { role: "user", content: `prompt ${index}`, timestamp: index },
	};
}

const ALL = [0, 1, 2, 3, 4].map(userEntry);
/** The host's pages, keyed by the entry they precede: [e1, e2] before e3, then [e0] before e1. */
const PAGES: Record<string, { entries: SessionEntry[]; remaining: number }> = {
	e3: { entries: [ALL[1]!, ALL[2]!], remaining: 1 },
	e1: { entries: [ALL[0]!], remaining: 0 },
};

let restoreSpies: (() => void)[] = [];
/** Replica files the guest wrote, in order: the header line first, then its entries. */
let writes: string[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	installInMemoryRelay();
	writes = [];
	const write = spyOn(Bun, "write").mockImplementation(((_dest: unknown, data: unknown) => {
		writes.push(String(data));
		return Promise.resolve(0);
	}) as typeof Bun.write);
	const rename = spyOn(fsp, "rename").mockResolvedValue(undefined);
	restoreSpies = [() => write.mockRestore(), () => rename.mockRestore()];
});

afterEach(() => {
	for (const restore of restoreSpies) restore();
	uninstallInMemoryRelay();
	resetSettingsForTest();
});

/** Entry ids of the newest replica file the guest wrote. */
function replicaIds(): string[] {
	const lines = (writes.at(-1) ?? "").trim().split("\n");
	return lines.slice(1).map(line => (JSON.parse(line) as SessionEntry).id);
}

/** A context whose session manager reads the replica file the guest last wrote and activated. */
function guestContext(setCollabGuest: (guest: CollabGuestLink | undefined) => void): InteractiveModeContext {
	let held: SessionEntry[] = [];
	const load = (): void => {
		held = (writes.at(-1) ?? "")
			.trim()
			.split("\n")
			.slice(1)
			.map(line => JSON.parse(line) as SessionEntry);
	};
	const ctx = createInteractiveModeContext({
		session: {
			switchSession: () => {
				load();
				return Promise.resolve(true);
			},
			agent: { setModel: () => {}, setThinkingLevel: () => {}, setDisableReasoning: () => {} },
		},
		sessionManager: { getBranch: () => held.slice(), getEntries: () => held.slice() },
		syncRunningSubagentBadge: () => {},
		resetObserverRegistry: () => {},
		reloadTodos: () => Promise.resolve(),
		renderInitialMessages: () => Promise.resolve(),
		setCollabGuest,
	});
	Object.defineProperty(ctx, "eventController", { value: new EventController(ctx), configurable: true });
	return ctx;
}

interface ScriptedHost {
	link: string;
	/** Hellos received, oldest first. */
	hellos: Extract<CollabFrame, { t: "hello" }>[];
	/** `beforeEntryId` of every `fetch-history`, oldest first. */
	requests: string[];
	/** Settles once `count` hellos have arrived. */
	helloCount(count: number): Promise<void>;
	send(frame: CollabFrame): void;
	close(): void;
}

/** A host that welcomes every hello with the newest two entries of a five-entry session and serves {@link PAGES}. */
async function scriptedHost(roomId: string): Promise<ScriptedHost> {
	const roomKey = generateRoomKey();
	const socket = new CollabSocket({
		wsUrl: `ws://localhost:8788/r/${roomId}`,
		role: "host",
		key: await importRoomKey(roomKey),
	});
	const waiters: { count: number; resolve: () => void }[] = [];
	const scripted: ScriptedHost = {
		link: formatCollabLink("ws://localhost:8788", roomId, roomKey),
		hellos: [],
		requests: [],
		helloCount: count => {
			const waiter = Promise.withResolvers<void>();
			if (scripted.hellos.length >= count) waiter.resolve();
			else waiters.push({ count, resolve: waiter.resolve });
			return waiter.promise;
		},
		send: frame => socket.send(frame),
		close: () => socket.close(),
	};
	socket.onFrame = frame => {
		if (frame.t === "hello") {
			scripted.hellos.push(frame);
			for (const waiter of waiters) if (scripted.hellos.length >= waiter.count) waiter.resolve();
			socket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: HEADER,
				state: {
					isStreaming: false,
					queuedMessageCount: 0,
					sessionName: "long session",
					cwd: "/tmp",
					participants: [{ name: "Host", role: "host" }],
				},
				agents: [],
				entryCount: 2,
				truncated: { omitted: 3, firstOmittedId: "e0" },
				features: ["history-paging"],
			});
			socket.send({ t: "snapshot-chunk", entries: [ALL[3]!, ALL[4]!], final: true });
		}
		if (frame.t === "fetch-history") {
			scripted.requests.push(frame.beforeEntryId);
			const page = PAGES[frame.beforeEntryId];
			socket.send({
				t: "history",
				reqId: frame.reqId,
				entries: page?.entries ?? [],
				remaining: page?.remaining ?? 0,
			});
		}
	};
	const open = Promise.withResolvers<void>();
	socket.onOpen = () => open.resolve();
	socket.connect();
	await open.promise;
	return scripted;
}

describe("collab TUI guest history paging", () => {
	it("joins from the newest turns, then pages earlier entries in ahead of them", async () => {
		const ctx = guestContext(() => {});
		const host = await scriptedHost("guest-history-room");
		const guest = new CollabGuestLink(ctx);
		const emptyTranscript = ctx.shell.transcript.blocks().length;
		try {
			await guest.join(host.link);
			expect(host.hellos[0]?.pagedHistory).toBe(true);
			expect(replicaIds()).toEqual(["e3", "e4"]);
			expect(guest.earlierEntries).toBe(3);
			// One row at the top says that history is missing.
			expect(ctx.shell.transcript.blocks().length).toBe(emptyTranscript + 1);

			const loaded = await guest.loadEarlier();

			expect(loaded).toBe(3);
			expect(host.requests).toEqual(["e3", "e1"]);
			// Pages land in session order ahead of what the guest already held.
			expect(replicaIds()).toEqual(["e0", "e1", "e2", "e3", "e4"]);
			expect(guest.earlierEntries).toBe(0);
			expect(ctx.shell.transcript.blocks().length).toBe(emptyTranscript);
		} finally {
			host.close();
			await guest.leave("test cleanup").catch(() => {});
		}
	});

	it("says hello again, instead of leaving, when the host's history moves under the unloaded part", async () => {
		const setCollabGuest = vi.fn();
		const ctx = guestContext(setCollabGuest);
		const host = await scriptedHost("guest-branch-room");
		const guest = new CollabGuestLink(ctx);
		try {
			await guest.join(host.link);
			expect(host.hellos).toHaveLength(1);

			// The host rewound to an entry from the part this guest never received.
			host.send({ t: "branch", keep: "e1", entries: [] });

			await host.helloCount(2);
			expect(setCollabGuest).not.toHaveBeenCalledWith(undefined);
		} finally {
			host.close();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
