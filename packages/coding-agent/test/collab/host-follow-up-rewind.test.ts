/**
 * Contract: a writer's prompt can ask to be delivered as a follow-up (after the
 * running turn) instead of a steer, the host's queued follow-ups reach guests
 * in `state.followUps` and can be withdrawn with `session-cmd unqueue`, and a
 * writer can rewind the conversation to before one of its prompts. Rewinds —
 * a guest's or the host user's own tree navigation — reach every guest as a
 * `branch` frame, and a guest that joins afterwards replicates the active
 * path only. Runs over the in-memory relay with the real CollabHost and a real
 * SessionManager; only the agent session is a double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface PromptCall {
	streamingBehavior: unknown;
	queueChipText: unknown;
}

interface HostHarness {
	ctx: InteractiveModeContext;
	manager: SessionManager;
	/** Ids in conversation order: u1, a1, u2, a2. */
	ids: { u1: string; a1: string; u2: string; a2: string };
	state: { busy: boolean; transitioning: boolean; navigationMoves: boolean; followUps: string[] };
	prompts: PromptCall[];
	promptWaiters: (() => void)[];
	navigations: string[];
	notices: string[];
	/** Fires the session's `queue_update` event, as the real session does when its queues change. */
	emitQueueUpdate(): void;
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: USAGE,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function makeHost(): HostHarness {
	const manager = SessionManager.inMemory();
	const ids = {
		u1: manager.appendMessage(user("first")),
		a1: manager.appendMessage(assistant("one")),
		u2: manager.appendMessage(user("second")),
		a2: manager.appendMessage(assistant("two")),
	};
	const state = { busy: false, transitioning: false, navigationMoves: true, followUps: [] as string[] };
	const prompts: PromptCall[] = [];
	const promptWaiters: (() => void)[] = [];
	const navigations: string[] = [];
	const notices: string[] = [];
	const listeners: ((event: { type: string }) => void)[] = [];
	const emitQueueUpdate = () => {
		for (const listener of listeners) listener({ type: "queue_update" });
	};
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			get isStreaming() {
				return state.busy;
			},
			get isBusyForSnapshot() {
				return state.busy;
			},
			get isSessionTransitioning() {
				return state.transitioning;
			},
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "rewind",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [...state.followUps] }),
			removeQueuedMessage: (text: string) => {
				const index = state.followUps.indexOf(text);
				if (index < 0) return false;
				state.followUps.splice(index, 1);
				emitQueueUpdate();
				return true;
			},
			promptCustomMessage: (_message: unknown, options: PromptCall) => {
				prompts.push({ streamingBehavior: options.streamingBehavior, queueChipText: options.queueChipText });
				for (const wake of promptWaiters.splice(0)) wake();
				return Promise.resolve(true);
			},
			// The real navigateTree lands the leaf on the prompt's parent (null for a root prompt).
			navigateTree: (targetId: string) => {
				navigations.push(targetId);
				if (!state.navigationMoves) return Promise.resolve({ cancelled: false });
				const parentId = manager.getEntry(targetId)?.parentId ?? null;
				if (parentId === null) manager.resetLeaf();
				else manager.branch(parentId);
				return Promise.resolve({ cancelled: false });
			},
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			emitNotice: (_level: string, message: string) => {
				notices.push(message);
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, manager, ids, state, prompts, promptWaiters, navigations, notices, emitQueueUpdate };
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	/** The first frame at or after index `from` matching `match`; waits for it when it has not arrived. */
	next<T extends CollabFrame["t"]>(
		type: T,
		match?: (frame: Extract<CollabFrame, { t: T }>) => boolean,
		from?: number,
	): Promise<Extract<CollabFrame, { t: T }>>;
}

async function joinAsGuest(
	link: string,
	options: { resume?: { sessionId: string; entryId: string }; readOnly?: boolean } = {},
): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken =
		parsed.writeToken && !options.readOnly ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const frames: CollabFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
		for (const wake of waiters.splice(0)) wake();
	};
	socket.onOpen = () =>
		socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken, resume: options.resume });
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

/** Entry ids a guest would hold after the welcome train: every chunk's entries, in order. */
async function snapshotIds(guest: TestGuest): Promise<string[]> {
	await guest.next("snapshot-chunk", chunk => chunk.final);
	return guest.frames.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries.map(entry => entry.id) : []));
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
	await host.start("ws://localhost:8788");
}

async function join(options?: Parameters<typeof joinAsGuest>[1]): Promise<TestGuest> {
	const guest = await joinAsGuest(host.link, options);
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

describe("collab follow-up delivery", () => {
	it("advertises the follow-up, rewind and commands features in welcome", async () => {
		await startHost();
		const guest = await join();
		const welcome = await guest.next("welcome");
		expect(welcome.features).toEqual(["follow-up", "rewind", "commands"]);
	});

	it("queues a follow-up prompt behind the turn, and steers by default", async () => {
		await startHost();
		const guest = await join();
		guest.socket.send({ t: "prompt", text: "after this", deliver: "follow-up" });
		guest.socket.send({ t: "prompt", text: "right now" });
		// Only the literal "follow-up" opts out of steering.
		guest.socket.send({ t: "prompt", text: "bogus", deliver: "later" } as unknown as CollabFrame);
		while (harness.prompts.length < 3) await new Promise<void>(resolve => harness.promptWaiters.push(resolve));
		expect(harness.prompts).toEqual([
			{ streamingBehavior: "followUp", queueChipText: "after this" },
			{ streamingBehavior: "steer", queueChipText: "right now" },
			{ streamingBehavior: "steer", queueChipText: "bogus" },
		]);
	});
});

describe("collab queued follow-ups", () => {
	it("reports queued follow-ups in state, oldest first, and drops them when the queue drains", async () => {
		await startHost();
		harness.state.followUps.push("first up", "second up");
		const guest = await join();
		const welcome = await guest.next("welcome");
		expect(welcome.state.followUps).toEqual(["first up", "second up"]);

		harness.state.followUps.shift();
		harness.emitQueueUpdate();
		const shrunk = await guest.next("state", state => state.state.followUps?.length === 1);
		expect(shrunk.state.followUps).toEqual(["second up"]);

		harness.state.followUps.length = 0;
		harness.emitQueueUpdate();
		const drained = await guest.next("state", state => state.state.followUps?.length === 0);
		expect(drained.state.followUps).toEqual([]);
	});

	it("removes the first queued follow-up with the given text on unqueue, and says so when none matches", async () => {
		await startHost();
		harness.state.followUps.push("keep", "drop", "drop");
		const guest = await join();

		guest.socket.send({ t: "session-cmd", cmd: "unqueue", arg: "drop" });
		const state = await guest.next("state", s => s.state.followUps?.length === 2);
		expect(state.state.followUps).toEqual(["keep", "drop"]);
		expect(harness.notices).toContain("guest removed a queued follow-up");

		guest.socket.send({ t: "session-cmd", cmd: "unqueue", arg: "never queued" });
		const error = await guest.next("error");
		expect(error.message).toBe("unqueue: that follow-up is no longer queued");
		expect(harness.state.followUps).toEqual(["keep", "drop"]);
	});

	it("refuses unqueue on a read-only link", async () => {
		await startHost();
		harness.state.followUps.push("mine");
		const guest = await join({ readOnly: true });
		guest.socket.send({ t: "session-cmd", cmd: "unqueue", arg: "mine" });
		await guest.next("error");
		expect(harness.state.followUps).toEqual(["mine"]);
	});
});

describe("collab rewind", () => {
	it("refuses while the agent is working and leaves the conversation alone", async () => {
		await startHost();
		const guest = await join();
		harness.state.busy = true;
		guest.socket.send({ t: "session-cmd", cmd: "rewind", arg: harness.ids.u2 });
		const error = await guest.next("error");
		expect(error.message).toStartWith("rewind: wait for the current response");
		expect(harness.navigations).toEqual([]);
		expect(harness.manager.getLeafId()).toBe(harness.ids.a2);
	});

	it("refuses entries that are not prompts on the active path", async () => {
		await startHost();
		const guest = await join();
		for (const arg of [harness.ids.a1, "no-such-entry"]) {
			const from = guest.frames.length;
			guest.socket.send({ t: "session-cmd", cmd: "rewind", arg });
			const error = await guest.next("error", undefined, from);
			expect(error.message).toBe("rewind: not a prompt on the active conversation");
		}
		expect(harness.navigations).toEqual([]);
	});

	it("moves the leaf before the prompt and tells guests which entries to keep", async () => {
		await startHost();
		const guest = await join();
		const { u1, a1, u2 } = harness.ids;

		guest.socket.send({ t: "session-cmd", cmd: "rewind", arg: u2 });
		const branch = await guest.next("branch");
		expect(branch).toEqual({ t: "branch", keep: a1, entries: [] });
		expect(harness.manager.getLeafId()).toBe(a1);
		expect(harness.notices).toContain("guest rewound the conversation");

		// The next prompt starts a sibling branch; guests receive it as an ordinary append.
		const retried = harness.manager.appendMessage(user("second, reworded"));
		const entry = await guest.next("entry", frame => frame.entry.id === retried);
		expect(entry.entry.parentId).toBe(a1);

		// A prompt at the root rewinds to nothing.
		const from = guest.frames.length;
		guest.socket.send({ t: "session-cmd", cmd: "rewind", arg: u1 });
		const toRoot = await guest.next("branch", undefined, from);
		expect(toRoot).toEqual({ t: "branch", keep: null, entries: [] });
		expect(harness.manager.getLeafId()).toBeNull();
	});

	it("keeps guests on the active path when work finishes on an abandoned branch", async () => {
		await startHost();
		const guest = await join();
		const { u1, a2 } = harness.ids;

		// E.g. a `!bash` result recorded against the branch the user navigated away from.
		const stray = harness.manager.appendMessageToBranch(assistant("late"), u1);
		expect(harness.manager.getLeafId()).toBe(a2);
		const next = harness.manager.appendMessage(user("still here"));
		const entry = await guest.next("entry", frame => frame.entry.id === next);

		expect(entry.entry.parentId).toBe(a2);
		expect(guest.frames.some(frame => frame.t === "branch")).toBe(false);
		expect(guest.frames.some(frame => frame.t === "entry" && frame.entry.id === stray)).toBe(false);
	});

	it("refuses while a session transition is in flight", async () => {
		await startHost();
		const guest = await join();
		harness.state.transitioning = true;
		guest.socket.send({ t: "session-cmd", cmd: "rewind", arg: harness.ids.u2 });
		const error = await guest.next("error");
		expect(error.message).toStartWith("rewind: wait for the current response");
		expect(harness.navigations).toEqual([]);
	});

	it("does not announce a rewind that left the conversation where it was", async () => {
		await startHost();
		const guest = await join();
		harness.state.navigationMoves = false;
		guest.socket.send({ t: "session-cmd", cmd: "rewind", arg: harness.ids.u2 });
		const error = await guest.next("error");
		expect(error.message).toBe("rewind: the conversation did not move");
		expect(harness.notices.some(notice => notice.includes("rewound"))).toBe(false);
	});

	it("sends the host user's own navigation onto another branch as keep plus the new path", async () => {
		await startHost();
		const guest = await join();
		const { a1, u2, a2 } = harness.ids;
		harness.manager.branch(a1);
		const reworded = harness.manager.appendMessage(user("second, reworded"));
		await guest.next("branch");
		await guest.next("entry", frame => frame.entry.id === reworded);

		// Tree navigation back to the abandoned reply: the guest keeps through a1 and replays u2, a2.
		const from = guest.frames.length;
		harness.manager.branch(a2);
		const back = await guest.next("branch", undefined, from);
		expect(back.keep).toBe(a1);
		expect(back.entries.map(entry => entry.id)).toEqual([u2, a2]);
	});

	it("welcomes later guests with the active path only, and resumes only along it", async () => {
		await startHost();
		const { u1, a1, a2 } = harness.ids;
		harness.manager.branch(a1);
		const reworded = harness.manager.appendMessage(user("second, reworded"));

		const fresh = await join();
		expect(await snapshotIds(fresh)).toEqual([u1, a1, reworded]);

		// A guest whose replica ends on the abandoned branch cannot be resumed from it.
		const sessionId = harness.manager.getSessionId();
		const stale = await join({ resume: { sessionId, entryId: a2 } });
		const staleWelcome = await stale.next("welcome");
		expect(staleWelcome.resumed).toBeUndefined();
		expect(await snapshotIds(stale)).toEqual([u1, a1, reworded]);

		// One whose replica ends on a shared entry gets just the tail.
		const current = await join({ resume: { sessionId, entryId: a1 } });
		const currentWelcome = await current.next("welcome");
		expect(currentWelcome.resumed).toBe(true);
		expect(await snapshotIds(current)).toEqual([reworded]);
	});
});
