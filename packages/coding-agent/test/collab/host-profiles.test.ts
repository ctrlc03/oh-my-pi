/**
 * Guest agent-profile switching: a writer's `session-cmd` `profile` switches the host session's
 * profile and a read-only peer is refused without the session being touched. Runs over the
 * in-memory relay with the real CollabHost/CollabSocket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const PROFILES = [{ name: "build" }, { name: "review", description: "Read-only" }, { name: "wide" }];

const switches: string[] = [];
let active = "build";
let blocker: string | undefined;
let onSwitch: ((name: string) => void) | undefined;

function makeCtx(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-profiles",
			getCwd: () => "/tmp",
			getEntries: () => [],
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-profiles", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			getSessionName: () => "test",
		},
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			sessionName: "test",
			scopedModels: [],
			modelRegistry: { getError: () => undefined, getAvailable: () => [], getAll: () => [] },
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			getContextUsage: () => ({ tokens: 0 }),
			getSpendCap: () => ({ level: "off" }),
			subscribe: () => () => {},
			emitNotice: () => {},
			profiles: {
				get active() {
					return { name: active };
				},
				catalog: () => ({ profiles: PROFILES, warnings: [] }),
				onChange: () => () => {},
				looseningOf: (name: string) =>
					name === "wide" ? "enables the bash tool the active profile does not" : undefined,
				switch: (name: string) => {
					if (blocker) return Promise.resolve({ ok: false, reason: blocker });
					const profile = PROFILES.find(candidate => candidate.name === name);
					if (!profile) return Promise.resolve({ ok: false, reason: `unknown profile ${JSON.stringify(name)}` });
					switches.push(name);
					onSwitch?.(name);
					active = name;
					return Promise.resolve({ ok: true, status: "applied", profile });
				},
			},
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
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

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

async function welcomeOf(guest: TestGuest): Promise<Extract<CollabFrame, { t: "welcome" }>> {
	const frame = await guest.nextFrame();
	if (frame.t !== "welcome") throw new Error(`expected welcome, got ${frame.t}`);
	return frame;
}

async function errorOf(guest: TestGuest): Promise<string> {
	const frame = await guest.nextFrame();
	if (frame.t !== "error") throw new Error(`expected error, got ${frame.t}`);
	return frame.message;
}

const cleanups: (() => void)[] = [];
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeCtx());
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	switches.length = 0;
	active = "build";
	blocker = undefined;
	onSwitch = undefined;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

async function join(link: string, name: string) {
	const guest = await joinAsGuest(link, name);
	cleanups.push(() => guest.socket.close());
	return { guest, welcome: await welcomeOf(guest) };
}

describe("collab guest profile switching", () => {
	it("lists the profiles to writers only and advertises the feature to everyone", async () => {
		const writer = await join(host.link, "writer");
		expect(writer.welcome.features).toContain("profiles");
		expect(writer.welcome.profiles).toEqual(PROFILES);
		expect(writer.welcome.state.profile).toBe("build");
		const viewer = await join(host.viewLink, "viewer");
		expect(viewer.welcome.profiles).toBeUndefined();
	});

	it("switches the host session for a writer", async () => {
		const { guest } = await join(host.link, "writer-switch");
		const switched = new Promise<string>(resolve => {
			onSwitch = resolve;
		});
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "review" });
		expect(await switched).toBe("review");
		expect(switches).toEqual(["review"]);
	});

	it("refuses an unknown profile and a switch the session blocks", async () => {
		const { guest } = await join(host.link, "writer-bad");
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "missing" });
		expect(await errorOf(guest)).toContain("unknown profile");
		blocker = "exit plan mode first";
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "review" });
		expect(await errorOf(guest)).toContain("plan mode");
		expect(switches).toEqual([]);
	});

	it("refuses a guest switch to a looser profile but allows a tightening one", async () => {
		const { guest } = await join(host.link, "writer-loosen");
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "wide" });
		const message = await errorOf(guest);
		expect(message).toContain("refused");
		expect(message).toContain("bash tool");
		expect(switches).toEqual([]);
		expect(active).toBe("build");
		const switched = new Promise<string>(resolve => {
			onSwitch = resolve;
		});
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "review" });
		expect(await switched).toBe("review");
		expect(switches).toEqual(["review"]);
	});

	it("refuses a read-only peer without touching the session", async () => {
		const { guest } = await join(host.viewLink, "viewer-switch");
		guest.socket.send({ t: "session-cmd", cmd: "profile", arg: "review" });
		expect(await errorOf(guest)).toContain("read-only");
		expect(switches).toEqual([]);
		expect(active).toBe("build");
	});
});
