/**
 * Guest session controls: a writer's `session-cmd` switches the host's model,
 * thinking level, or compacts it through the session APIs the host TUI uses;
 * read-only peers are refused; and only writers learn the model catalog from
 * `welcome`. Runs over the in-memory relay with the real CollabHost/CollabSocket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function fakeModel(provider: string, id: string, contextWindow: number): Model {
	return { provider, id, name: id.toUpperCase(), contextWindow, api: "openai-completions" } as unknown as Model;
}

const CURRENT = fakeModel("acme", "small", 100_000);
const TARGET = fakeModel("acme", "big", 1_000_000);
const CATALOG = [CURRENT, TARGET];

interface SessionCalls {
	models: Model[];
	thinking: string[];
	compactions: { instructions?: string }[];
	notices: string[];
	noticeWaiters: ((message: string) => void)[];
}

interface HostHarness {
	ctx: InteractiveModeContext;
	calls: SessionCalls;
	state: { isCompacting: boolean; selectors: string[]; contextTokens: number };
	nextNotice(): Promise<string>;
}

function makeHost(): HostHarness {
	const calls: SessionCalls = { models: [], thinking: [], compactions: [], notices: [], noticeWaiters: [] };
	const state = { isCompacting: false, selectors: ["off", "auto", "low", "high"], contextTokens: 10 };
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			getEntries: () => [{ type: "message" }, { type: "message" }],
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			get isCompacting() {
				return state.isCompacting;
			},
			queuedMessageCount: 0,
			sessionName: "test",
			model: CURRENT,
			thinkingLevel: undefined,
			scopedModels: [],
			modelRegistry: { getError: () => undefined, getAvailable: () => CATALOG, getAll: () => CATALOG },
			getAvailableEffortSelectors: () => state.selectors,
			getContextUsage: () => ({ tokens: state.contextTokens }),
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: (model: Model) => {
				calls.models.push(model);
				return Promise.resolve();
			},
			setThinkingLevel: (level: string) => {
				calls.thinking.push(level);
			},
			subscribe: () => () => {},
			emitNotice: (_level: string, message: string) => {
				calls.notices.push(message);
				for (const waiter of calls.noticeWaiters.splice(0)) waiter(message);
			},
		},
		handleCompactCommand: (instructions?: string) => {
			calls.compactions.push({ instructions });
			return Promise.resolve("ok");
		},
		updateEditorBorderColor: () => {},
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
	const nextNotice = (): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		calls.noticeWaiters.push(resolve);
		return promise;
	};
	return { ctx, calls, state, nextNotice };
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Broadcast and snapshot traffic interleaves nondeterministically with the directed welcome/error frames asserted on. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

async function expectWelcome(guest: TestGuest): Promise<Extract<CollabFrame, { t: "welcome" }>> {
	const frame = await guest.nextFrame();
	if (frame.t !== "welcome") throw new Error(`expected welcome, got ${frame.t}`);
	return frame;
}

async function expectError(guest: TestGuest): Promise<string> {
	const frame = await guest.nextFrame();
	if (frame.t !== "error") throw new Error(`expected error, got ${frame.t}`);
	return frame.message;
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	harness = makeHost();
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	harness.calls.models.length = 0;
	harness.calls.thinking.length = 0;
	harness.calls.compactions.length = 0;
	harness.calls.notices.length = 0;
	harness.state.isCompacting = false;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

async function joinWriter(name: string): Promise<TestGuest> {
	const guest = await joinAsGuest(host.link, name);
	guestCleanups.push(() => guest.socket.close());
	await expectWelcome(guest);
	return guest;
}

describe("collab guest session controls", () => {
	it("sends the model catalog and thinking levels to writers only", async () => {
		const writer = await joinAsGuest(host.link, "writer");
		guestCleanups.push(() => writer.socket.close());
		const writerWelcome = await expectWelcome(writer);
		expect(writerWelcome.models?.map(model => `${model.provider}/${model.id}`).sort()).toEqual([
			"acme/big",
			"acme/small",
		]);
		expect(writerWelcome.models?.find(model => model.id === "big")).toEqual({
			id: "big",
			name: "BIG",
			provider: "acme",
			contextWindow: 1_000_000,
		});
		expect(writerWelcome.state.thinkingLevels).toEqual(["off", "auto", "low", "high"]);

		const viewer = await joinAsGuest(host.viewLink, "viewer");
		guestCleanups.push(() => viewer.socket.close());
		const viewerWelcome = await expectWelcome(viewer);
		expect(viewerWelcome.readOnly).toBe(true);
		expect(viewerWelcome.models).toBeUndefined();
	});

	it("refuses session-cmd from a read-only peer without touching the session", async () => {
		const viewer = await joinAsGuest(host.viewLink, "viewer-cmd");
		guestCleanups.push(() => viewer.socket.close());
		await expectWelcome(viewer);
		for (const [cmd, arg] of [
			["model", "acme/big"],
			["thinking", "high"],
			["compact", undefined],
		] as const) {
			viewer.socket.send({ t: "session-cmd", cmd, arg });
			expect(await expectError(viewer)).toContain("read-only");
		}
		const { calls } = harness;
		expect(calls.models).toHaveLength(0);
		expect(calls.thinking).toHaveLength(0);
		expect(calls.compactions).toHaveLength(0);
	});

	it("rejects a model outside the picker's set", async () => {
		const writer = await joinWriter("writer-unknown");
		writer.socket.send({ t: "session-cmd", cmd: "model", arg: "acme/missing" });
		expect(await expectError(writer)).toContain("unknown model");
		expect(harness.calls.models).toHaveLength(0);
	});

	it("switches to a listed model for the session and announces it", async () => {
		const writer = await joinWriter("writer-model");
		const notice = harness.nextNotice();
		writer.socket.send({ t: "session-cmd", cmd: "model", arg: "acme/big" });
		expect(await notice).toBe("writer-model switched model to acme/big");
		expect(harness.calls.models).toEqual([TARGET]);
	});

	it("refuses a model whose context window cannot hold the conversation", async () => {
		const writer = await joinWriter("writer-overflow");
		harness.state.contextTokens = 2_000_000;
		try {
			writer.socket.send({ t: "session-cmd", cmd: "model", arg: "acme/big" });
			expect(await expectError(writer)).toContain("compact first");
			expect(harness.calls.models).toHaveLength(0);
		} finally {
			harness.state.contextTokens = 10;
		}
	});

	it("applies a thinking level the model accepts and rejects one it does not", async () => {
		const writer = await joinWriter("writer-thinking");
		const notice = harness.nextNotice();
		writer.socket.send({ t: "session-cmd", cmd: "thinking", arg: "high" });
		expect(await notice).toBe("writer-thinking set thinking to high");
		expect(harness.calls.thinking).toEqual(["high"]);

		writer.socket.send({ t: "session-cmd", cmd: "thinking", arg: "ultra" });
		expect(await expectError(writer)).toContain("does not accept thinking level");
		expect(harness.calls.thinking).toEqual(["high"]);
	});

	it("runs the host's /compact with the guest's instructions and refuses while compacting", async () => {
		const writer = await joinWriter("writer-compact");
		const notice = harness.nextNotice();
		writer.socket.send({ t: "session-cmd", cmd: "compact", arg: "keep the API design" });
		expect(await notice).toBe("writer-compact started compaction");
		expect(harness.calls.compactions).toEqual([{ instructions: "keep the API design" }]);

		harness.state.isCompacting = true;
		writer.socket.send({ t: "session-cmd", cmd: "compact" });
		expect(await expectError(writer)).toContain("already in progress");
		expect(harness.calls.compactions).toHaveLength(1);
	});
});
