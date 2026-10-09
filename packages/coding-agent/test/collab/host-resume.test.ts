/**
 * Contract: a guest that still holds a session replica can ask the host for
 * only the entries after its last one (`hello.resume`), and a guest that says
 * `zip` receives its targeted frames compressed. Anything the host cannot
 * resume from (unknown entry, other session) gets the full snapshot, exactly
 * as without the field.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const SESSION_ID = "sess-resume";
const BODY = "const answer = compute(input); // a line of ordinary source text\n".repeat(60);

const entries: SessionEntry[] = [];
for (let i = 0; i < 12; i++) {
	entries.push({
		type: "message",
		id: `e${i}`,
		parentId: i === 0 ? null : `e${i - 1}`,
		timestamp: "2026-06-20T00:00:00Z",
		message: { role: "user", content: `${i}: ${BODY}`, timestamp: 0 },
	});
}
const snapshot = {
	header: { type: "session" as const, id: SESSION_ID, timestamp: "2026-06-20T00:00:00Z", cwd: "/tmp" },
	entries,
};

function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "resume",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext());
	await host.start("ws://localhost:8788");
});

afterAll(async () => {
	await host.stop("test done");
	uninstallInMemoryRelay();
});

const sockets: CollabSocket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
});

type Hello = Extract<CollabFrame, { t: "hello" }>;

/** Join with the given hello extras; resolves with the welcome and every snapshot chunk's entries. */
async function join(extra: Partial<Hello>): Promise<{
	welcome: Extract<CollabFrame, { t: "welcome" }>;
	ids: string[];
	chunks: number;
}> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	sockets.push(socket);
	let welcome: Extract<CollabFrame, { t: "welcome" }> | undefined;
	const ids: string[] = [];
	let chunks = 0;
	const done = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcome = frame;
		if (frame.t === "snapshot-chunk") {
			chunks++;
			for (const entry of frame.entries) ids.push(entry.id);
			if (frame.final) done.resolve();
		}
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "resume test", ...extra });
	socket.connect();
	await done.promise;
	if (!welcome) throw new Error("no welcome");
	return { welcome, ids, chunks };
}

const ALL_IDS = entries.map(entry => entry.id);

describe("collab delta resume", () => {
	it("sends only the entries after the guest's last entry", async () => {
		const { welcome, ids } = await join({ resume: { sessionId: SESSION_ID, entryId: "e7" } });
		expect(welcome.resumed).toBe(true);
		expect(welcome.entryCount).toBe(4);
		expect(ids).toEqual(["e8", "e9", "e10", "e11"]);
	});

	it("resumes a guest that is already current with an empty final chunk", async () => {
		const { welcome, ids, chunks } = await join({ resume: { sessionId: SESSION_ID, entryId: "e11" } });
		expect(welcome.resumed).toBe(true);
		expect(welcome.entryCount).toBe(0);
		expect(ids).toEqual([]);
		expect(chunks).toBe(1);
	});

	it("falls back to the full snapshot for an entry the host does not have", async () => {
		const { welcome, ids } = await join({ resume: { sessionId: SESSION_ID, entryId: "gone" } });
		expect(welcome.resumed).toBeUndefined();
		expect(welcome.entryCount).toBe(ALL_IDS.length);
		expect(ids).toEqual(ALL_IDS);
	});

	it("falls back to the full snapshot for a different session", async () => {
		const { welcome, ids } = await join({ resume: { sessionId: "other-session", entryId: "e7" } });
		expect(welcome.resumed).toBeUndefined();
		expect(ids).toEqual(ALL_IDS);
	});

	it("sends the full snapshot when the hello carries no resume", async () => {
		const { welcome, ids } = await join({});
		expect(welcome.resumed).toBeUndefined();
		expect(ids).toEqual(ALL_IDS);
	});
});

describe("collab compressed frames", () => {
	it("compresses targeted frames only toward a guest that sent zip, with identical content", async () => {
		let bytesToGuest = 0;
		const original = FakeWebSocket.prototype.deliver;
		const spy = spyOn(FakeWebSocket.prototype, "deliver").mockImplementation(function (
			this: FakeWebSocket,
			bytes: Uint8Array,
		) {
			if (this.role === "guest") bytesToGuest += bytes.byteLength;
			original.call(this, bytes);
		});
		try {
			const plain = await join({});
			const plainBytes = bytesToGuest;
			bytesToGuest = 0;
			const zipped = await join({ zip: true });
			expect(zipped.ids).toEqual(plain.ids);
			expect(zipped.welcome.entryCount).toBe(plain.welcome.entryCount);
			// Source-like text deflates by far more than 4x; the plain guest pays full price.
			expect(bytesToGuest).toBeLessThan(plainBytes / 4);
		} finally {
			spy.mockRestore();
		}
	});
});
