/**
 * Contract: a writer can edit, reorder and promote the host's queued follow-ups by id (`session-cmd`
 * `queue-edit` / `queue-move` / `queue-steer`, feature `queue-edit`), the ids reach guests in
 * `state.followUpIds`, a read-only link cannot, and a prompt's `mentions` arrive in the session as a context
 * block after the typed text. Runs over the in-memory relay with the real CollabHost; the agent session is a
 * double that keeps a follow-up queue.
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

interface QueuedDouble {
	id: string;
	message: { role: "custom"; customType: string; content: string; details: { __queueChipText: string } };
}

const queue: QueuedDouble[] = [];
const steering: string[] = [];
const submitted: { content: unknown; queueChipText: unknown }[] = [];
const submitWaiters: (() => void)[] = [];
const listeners: ((event: { type: string }) => void)[] = [];

function queued(id: string, text: string, customType = "collab-prompt"): QueuedDouble {
	return { id, message: { role: "custom", customType, content: text, details: { __queueChipText: text } } };
}

const emitQueueUpdate = (): void => {
	for (const listener of listeners) listener({ type: "queue_update" });
};

function makeCtx(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: true,
			isBusyForSnapshot: true,
			isSessionTransitioning: false,
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "queue",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({
				steering: [...steering],
				followUp: queue.map(item => item.message.details.__queueChipText),
			}),
			listQueuedFollowUps: () => queue.map(item => ({ id: item.id, text: item.message.details.__queueChipText })),
			editQueuedFollowUp: (id: string, rewrite: (message: QueuedDouble["message"]) => unknown) => {
				const at = queue.findIndex(item => item.id === id);
				if (at < 0) return "missing";
				const edited = rewrite(queue[at].message) as QueuedDouble["message"] | undefined;
				if (edited === undefined) return "refused";
				queue[at] = { id, message: edited };
				emitQueueUpdate();
				return "edited";
			},
			moveQueuedFollowUp: (id: string, position: number) => {
				const at = queue.findIndex(item => item.id === id);
				if (at < 0) return false;
				const [item] = queue.splice(at, 1);
				queue.splice(Math.min(position, queue.length), 0, item);
				emitQueueUpdate();
				return true;
			},
			promoteQueuedFollowUp: (id: string) => {
				const at = queue.findIndex(item => item.id === id);
				if (at < 0) return false;
				const [item] = queue.splice(at, 1);
				steering.push(item.message.details.__queueChipText);
				emitQueueUpdate();
				return true;
			},
			promptCustomMessage: (message: { content: unknown }, options: { queueChipText: unknown }) => {
				submitted.push({ content: message.content, queueChipText: options.queueChipText });
				for (const wake of submitWaiters.splice(0)) wake();
				return Promise.resolve(true);
			},
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			emitNotice: () => {},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		skillCommands: new Map(),
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
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

async function joinAsGuest(link: string, readOnly: boolean): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken && !readOnly ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
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
let host: CollabHost;

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

afterEach(async () => {
	queue.length = 0;
	steering.length = 0;
	submitted.length = 0;
	listeners.length = 0;
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function join(readOnly = false): Promise<TestGuest> {
	host = new CollabHost(makeCtx());
	await host.start("ws://localhost:8788");
	const guest = await joinAsGuest(host.link, readOnly);
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

const idsOf = (): string[] => queue.map(item => item.id);
const textsOf = (): string[] => queue.map(item => item.message.details.__queueChipText);

describe("collab queue editing", () => {
	it("advertises the features and reports follow-up ids beside their texts", async () => {
		queue.push(queued("q1", "one"), queued("q2", "two"));
		const guest = await join();
		const welcome = await guest.next("welcome");
		expect(welcome.features).toEqual(expect.arrayContaining(["queue-edit", "mentions"]));
		expect(welcome.state.followUps).toEqual(["one", "two"]);
		expect(welcome.state.followUpIds).toEqual(["q1", "q2"]);
	});

	it("edits a queued follow-up's text in place and reflects it in state", async () => {
		queue.push(queued("q1", "one"), queued("q2", "two"));
		const guest = await join();
		guest.socket.send({ t: "session-cmd", cmd: "queue-edit", id: "q2", arg: "two, revised" });
		const state = await guest.next("state", s => s.state.followUps?.[1] === "two, revised");
		expect(state.state.followUpIds).toEqual(["q1", "q2"]);
		expect(textsOf()).toEqual(["one", "two, revised"]);
	});

	it("refuses an empty edit, a slash command, and a follow-up that is no longer queued", async () => {
		queue.push(queued("q1", "one"), queued("q2", "/skill:x y"), queued("q3", "host typed", "other"));
		const guest = await join();
		const refused = async (frame: CollabFrame): Promise<string> => {
			const from = guest.frames.length;
			guest.socket.send(frame);
			return (await guest.next("error", undefined, from)).message;
		};
		expect(await refused({ t: "session-cmd", cmd: "queue-edit", id: "q1", arg: "  " })).toContain("cannot be empty");
		expect(await refused({ t: "session-cmd", cmd: "queue-edit", id: "q1", arg: "/new" })).toContain("slash command");
		expect(await refused({ t: "session-cmd", cmd: "queue-edit", id: "q2", arg: "plain" })).toContain("slash command");
		expect(await refused({ t: "session-cmd", cmd: "queue-edit", id: "q3", arg: "plain" })).toContain(
			"only prompts sent",
		);
		expect(await refused({ t: "session-cmd", cmd: "queue-edit", id: "gone", arg: "plain" })).toBe(
			"queue-edit: that follow-up is no longer queued",
		);
		expect(await refused({ t: "session-cmd", cmd: "queue-move", id: "q1", index: -1 })).toContain("no position");
		expect(await refused({ t: "session-cmd", cmd: "queue-move", id: "gone", index: 0 })).toContain(
			"no longer queued",
		);
		expect(await refused({ t: "session-cmd", cmd: "queue-steer", arg: "q1" })).toContain("no queued follow-up given");
		expect(textsOf()).toEqual(["one", "/skill:x y", "host typed"]);
	});

	it("moves a follow-up to a position and promotes one to steer", async () => {
		queue.push(queued("q1", "one"), queued("q2", "two"), queued("q3", "three"));
		const guest = await join();
		guest.socket.send({ t: "session-cmd", cmd: "queue-move", id: "q3", index: 0 });
		await guest.next("state", s => s.state.followUpIds?.[0] === "q3");
		expect(idsOf()).toEqual(["q3", "q1", "q2"]);

		guest.socket.send({ t: "session-cmd", cmd: "queue-steer", id: "q1" });
		const state = await guest.next("state", s => s.state.followUps?.length === 2);
		expect(state.state.followUpIds).toEqual(["q3", "q2"]);
		expect(steering).toEqual(["one"]);
	});

	it("refuses every queue command on a read-only link", async () => {
		queue.push(queued("q1", "one"));
		const guest = await join(true);
		for (const cmd of ["queue-edit", "queue-move", "queue-steer"] as const) {
			const from = guest.frames.length;
			guest.socket.send({ t: "session-cmd", cmd, id: "q1", arg: "x", index: 0 });
			await guest.next("error", undefined, from);
		}
		expect(textsOf()).toEqual(["one"]);
		expect(steering).toEqual([]);
	});
});

describe("collab prompt mentions", () => {
	it("hands the session the typed text plus a context block, keeping the chip text as typed", async () => {
		const guest = await join();
		guest.socket.send({
			t: "prompt",
			text: "review #12",
			mentions: [{ kind: "pr", number: 12, title: "Add cache", url: "https://github.com/o/r/pull/12" }],
		});
		guest.socket.send({ t: "prompt", text: "plain" });
		while (submitted.length < 2) await new Promise<void>(resolve => submitWaiters.push(resolve));
		expect(submitted[0].queueChipText).toBe("review #12");
		expect(String(submitted[0].content).startsWith("review #12\n\n<referenced-context>")).toBe(true);
		expect(String(submitted[0].content)).toContain("https://github.com/o/r/pull/12");
		expect(submitted[1].content).toBe("plain");
	});

	it("drops a mention it cannot verify, leaving the prompt untouched", async () => {
		const guest = await join();
		guest.socket.send({
			t: "prompt",
			text: "look at #1",
			mentions: [{ kind: "pr", number: 1, title: "x", url: "javascript:alert(1)" }],
		});
		while (submitted.length < 1) await new Promise<void>(resolve => submitWaiters.push(resolve));
		expect(submitted[0].content).toBe("look at #1");
	});
});
