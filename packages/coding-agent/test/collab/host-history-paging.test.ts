/**
 * Contract: a session too long to send whole joins a guest that pages history
 * (`hello.pagedHistory`) with only its newest turns, and the rest is served on
 * request. Without it, a 60-120 MB transcript sent every entry and the guest's
 * join sat at "0%" past its own timeouts.
 *
 * - The welcome carries the newest entries inside `WELCOME_TAIL_BYTES`, starting
 *   at a turn boundary, flagged `truncated` with what it left out.
 * - A guest that did not ask (an older client) still receives every entry.
 * - `fetch-history` returns the entries before the one named, oldest first,
 *   bounded in bytes and cut at turn boundaries, ending in a `remaining: 0`
 *   terminator; the pages plus the welcome tail reproduce the active path.
 * - A delta resume bigger than the budget is cut like a full snapshot; a small
 *   one is still a plain delta.
 *
 * Drives the production `CollabHost` over the in-memory relay.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost, WELCOME_TAIL_BYTES } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const SESSION_ID = "sess-history";
const TURNS = 160;
const PROMPT = "q".repeat(2 * 1024);
const REPLY = "a".repeat(8 * 1024);

/** 160 turns of a 2 KiB prompt and an 8 KiB reply: ~1.6 MiB, past the welcome budget, several turns per history page. */
const entries: SessionEntry[] = [];
for (let turn = 0; turn < TURNS; turn++) {
	entries.push({
		type: "message",
		id: `u${turn}`,
		parentId: turn === 0 ? null : `a${turn - 1}`,
		timestamp: "2026-06-20T00:00:00Z",
		message: { role: "user", content: `${turn}: ${PROMPT}`, timestamp: 0 },
	});
	entries.push({
		type: "message",
		id: `a${turn}`,
		parentId: `u${turn}`,
		timestamp: "2026-06-20T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: REPLY }],
			api: "openai-responses",
			provider: "test",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	});
}
const ALL_IDS = entries.map(entry => entry.id);
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
			sessionName: "history",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			refresh: () => {},
			facts: () => ({ context: { tokens: 0, window: 0, percent: null } }),
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
type Welcome = Extract<CollabFrame, { t: "welcome" }>;
type History = Extract<CollabFrame, { t: "history" }>;

interface Joined {
	welcome: Welcome;
	ids: string[];
	/** `fetch-history` for the entries before `beforeEntryId`, on the joined connection. */
	fetchHistory(beforeEntryId: string): Promise<{ frame: History; bytes: number }>;
}

/** Join with the given hello extras; resolves once the snapshot's final chunk arrived. */
async function join(extra: Partial<Hello>): Promise<Joined> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	sockets.push(socket);
	let welcome: Welcome | undefined;
	const ids: string[] = [];
	const done = Promise.withResolvers<void>();
	const replies = new Map<number, (frame: History) => void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcome = frame;
		if (frame.t === "snapshot-chunk") {
			for (const entry of frame.entries) ids.push(entry.id);
			if (frame.final) done.resolve();
		}
		if (frame.t === "history") replies.get(frame.reqId)?.(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "history test", ...extra });
	socket.connect();
	await done.promise;
	if (!welcome) throw new Error("no welcome");
	let nextReq = 1;
	return {
		welcome,
		ids,
		async fetchHistory(beforeEntryId) {
			const reqId = nextReq++;
			const reply = Promise.withResolvers<History>();
			replies.set(reqId, reply.resolve);
			socket.send({ t: "fetch-history", reqId, beforeEntryId });
			const frame = await reply.promise;
			return { frame, bytes: JSON.stringify(frame.entries).length };
		},
	};
}

const byId = new Map(entries.map(entry => [entry.id, entry]));
const bytesOf = (ids: readonly string[]): number =>
	ids.reduce((sum, id) => sum + JSON.stringify(byId.get(id)).length, 0);

describe("collab history paging", () => {
	it("welcomes a paging guest with the newest turns inside the budget, flagged truncated", async () => {
		const { welcome, ids } = await join({ pagedHistory: true });
		expect(welcome.features).toContain("history-paging");
		expect(welcome.truncated).toBeDefined();
		const omitted = ALL_IDS.length - ids.length;
		expect(welcome.truncated).toEqual({ omitted, firstOmittedId: "u0" });
		expect(welcome.entryCount).toBe(ids.length);
		expect(ids).toEqual(ALL_IDS.slice(omitted));
		// A tail that does not start at a prompt would open on an orphaned reply.
		expect(ids[0]).toMatch(/^u\d+$/);
		expect(ids.at(-1)).toBe(`a${TURNS - 1}`);
		expect(bytesOf(ids)).toBeLessThanOrEqual(WELCOME_TAIL_BYTES);
		expect(bytesOf(ids)).toBeGreaterThan(WELCOME_TAIL_BYTES / 2);
	});

	it("still sends every entry to a guest that did not ask for paging", async () => {
		const { welcome, ids } = await join({});
		expect(welcome.truncated).toBeUndefined();
		expect(welcome.entryCount).toBe(ALL_IDS.length);
		expect(ids).toEqual(ALL_IDS);
	});

	it("pages earlier entries in order, bounded, to a remaining-0 terminator", async () => {
		const joined = await join({ pagedHistory: true });
		let before = joined.ids[0]!;
		const pages: string[][] = [];
		let last: History | undefined;
		for (let guard = 0; guard < 200; guard++) {
			const { frame, bytes } = await joined.fetchHistory(before);
			expect(frame.error).toBeUndefined();
			const pageIds = frame.entries.map(entry => entry.id);
			expect(pageIds.length).toBeGreaterThan(0);
			// A soft cap: the page fits one snapshot chunk, give or take the entry that crossed it.
			expect(bytes).toBeLessThanOrEqual(64 * 1024 + 12 * 1024);
			// Pages end where the previous request began and open at a prompt.
			expect(pageIds[0]).toMatch(/^u\d+$/);
			// `remaining` counts what still precedes the page.
			expect(frame.remaining).toBe(ALL_IDS.indexOf(pageIds[0]!));
			pages.unshift(pageIds);
			last = frame;
			if (frame.remaining === 0) break;
			before = pageIds[0]!;
		}
		expect(last?.remaining).toBe(0);
		expect([...pages.flat(), ...joined.ids]).toEqual(ALL_IDS);
	});

	it("answers a request before an entry that is not on the active path with an error", async () => {
		const joined = await join({ pagedHistory: true });
		const { frame } = await joined.fetchHistory("not-an-entry");
		expect(frame.error).toBeDefined();
		expect(frame.entries).toEqual([]);
	});

	it("cuts a delta larger than the budget like a snapshot, and sends a small one whole", async () => {
		const stale = await join({ pagedHistory: true, resume: { sessionId: SESSION_ID, entryId: "u1" } });
		expect(stale.welcome.resumed).toBeUndefined();
		expect(stale.welcome.truncated).toBeDefined();
		expect(stale.ids[0]).toMatch(/^u\d+$/);
		expect(stale.ids.at(-1)).toBe(`a${TURNS - 1}`);

		const current = await join({ pagedHistory: true, resume: { sessionId: SESSION_ID, entryId: `a${TURNS - 3}` } });
		expect(current.welcome.resumed).toBe(true);
		expect(current.welcome.truncated).toBeUndefined();
		expect(current.ids).toEqual([`u${TURNS - 2}`, `a${TURNS - 2}`, `u${TURNS - 1}`, `a${TURNS - 1}`]);
	});
});
