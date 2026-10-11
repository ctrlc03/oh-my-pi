/**
 * Contract: a writer can ask the host what fills its context window (`session-cmd` `context-items`)
 * and prune one listed item (`context-prune`); both are answered with a targeted `context-items`
 * frame and advertised as the `context-items` feature. Read-only peers are refused. Runs over the
 * in-memory relay with the real CollabHost; the agent session is a double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ContextItem } from "@oh-my-pi/pi-coding-agent/session/context-items";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function item(id: string, tokens: number, prunable: boolean): ContextItem {
	return {
		id,
		kind: prunable ? "toolResult" : "systemPrompt",
		label: id,
		tokens,
		share: tokens / 1_000,
		count: 1,
		targets: prunable ? [{ kind: "toolResult", entryId: id }] : [],
	};
}

interface HostHarness {
	ctx: InteractiveModeContext;
	state: { items: ContextItem[]; used: number; compacting: boolean; streaming: boolean };
	pruned: string[];
	rebuilt: number;
}

function makeHost(): HostHarness {
	const state = {
		items: [item("tr:big", 600, true), item("sys:0", 300, false)],
		used: 1_000,
		compacting: false,
		streaming: false,
	};
	const harness = { pruned: [] as string[], rebuilt: 0 };
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			getEntries: () => [],
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			getSessionName: () => "ctx",
		},
		session: {
			get isStreaming() {
				return state.streaming;
			},
			get isCompacting() {
				return state.compacting;
			},
			get isBusyForSnapshot() {
				return state.streaming || state.compacting;
			},
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			sessionName: "ctx",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			getContextItems: () => [...state.items].sort((a, b) => b.tokens - a.tokens),
			pruneContextItems: (items: ContextItem[]) => {
				for (const pruned of items) {
					harness.pruned.push(pruned.id);
					state.items = state.items.filter(candidate => candidate.id !== pruned.id);
					state.used -= pruned.tokens;
				}
				return Promise.resolve({ entriesRewritten: items.length, tokensFreed: items[0]!.tokens });
			},
			getSpendCap: () => ({ level: "off" }),
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: state.used, contextWindow: 10_000 }),
		},
		ui: { requestRender: () => {} },
		rebuildChatFromMessages: () => {
			harness.rebuilt++;
		},
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		state,
		pruned: harness.pruned,
		get rebuilt() {
			return harness.rebuilt;
		},
	};
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	next<T extends CollabFrame["t"]>(
		type: T,
		match?: (frame: Extract<CollabFrame, { t: T }>) => boolean,
		from?: number,
	): Promise<Extract<CollabFrame, { t: T }>>;
}

async function joinAsGuest(link: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const frames: CollabFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
		for (const wake of waiters.splice(0)) wake();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	const next: TestGuest["next"] = async (type, match, from = 0) => {
		for (;;) {
			const found = frames.slice(from).find(frame => frame.t === type && (!match || match(frame as never)));
			if (found) return found as never;
			const woken = Promise.withResolvers<void>();
			waiters.push(woken.resolve);
			await woken.promise;
		}
	};
	return { socket, frames, next };
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function startHost(): Promise<void> {
	harness = makeHost();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8789");
}

async function join(link: () => string = () => host.link): Promise<TestGuest> {
	const guest = await joinAsGuest(link());
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

describe("collab context items", () => {
	it("advertises the feature and answers context-items with the ranking and the host's meter", async () => {
		await startHost();
		const guest = await join();
		expect((await guest.next("welcome")).features).toContain("context-items");

		guest.socket.send({ t: "session-cmd", cmd: "context-items" });
		const frame = await guest.next("context-items");

		expect(frame.items.map(row => [row.id, row.prunable])).toEqual([
			["tr:big", true],
			["sys:0", false],
		]);
		expect(frame.usedTokens).toBe(1_000);
		expect(frame.contextWindow).toBe(10_000);
		expect(frame.pruned).toBeUndefined();
	});

	it("prunes the picked item and replies with the refreshed ranking and what it freed", async () => {
		await startHost();
		const guest = await join();

		guest.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "tr:big" });
		const frame = await guest.next("context-items");

		expect(harness.pruned).toEqual(["tr:big"]);
		expect(harness.rebuilt).toBe(1);
		expect(frame.items.map(row => row.id)).toEqual(["sys:0"]);
		expect(frame.usedTokens).toBe(400);
		expect(frame.pruned).toEqual({ entries: 1, tokensFreed: 600 });
	});

	it("refuses fixed items, stale ids, and a busy session without touching the session", async () => {
		await startHost();
		const guest = await join();

		guest.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "sys:0" });
		expect((await guest.next("error")).message).toContain("cannot be pruned");
		let seen = guest.frames.length;
		guest.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "tr:gone" });
		expect((await guest.next("error", undefined, seen)).message).toContain("no longer in the context");
		seen = guest.frames.length;
		harness.state.compacting = true;
		guest.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "tr:big" });
		expect((await guest.next("error", undefined, seen)).message).toContain("wait for");
		harness.state.compacting = false;
		seen = guest.frames.length;
		// A turn mid-stream owns the in-flight messages a prune would rewrite.
		harness.state.streaming = true;
		guest.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "tr:big" });
		expect((await guest.next("error", undefined, seen)).message).toContain("wait for");
		expect(harness.pruned).toEqual([]);
	});

	it("refuses read-only peers", async () => {
		await startHost();
		const viewer = await join(() => host.viewLink);
		viewer.socket.send({ t: "session-cmd", cmd: "context-prune", arg: "tr:big" });
		expect((await viewer.next("error")).message).toContain("read-only");
		expect(harness.pruned).toEqual([]);
	});
});
