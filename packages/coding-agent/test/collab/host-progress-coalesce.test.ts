import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// Many subagents tick progress far faster than a relay link drains. Forwarded
// one frame per tick, a burst overflowed the socket's send backlog and ended
// the room for every guest. Progress is state, so only the latest tick per
// subagent needs to reach guests — and a lifecycle frame must still follow it.

function makeHostContext(eventBus: EventBus): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus,
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

function tick(id: string, n: number) {
	return {
		index: 0,
		agent: "task",
		task: "work",
		parentToolCallId: "call-burst",
		progress: { id, index: 0, agent: "task", status: "running", task: "work", toolCount: n },
	};
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab host subagent progress", () => {
	it("survives a progress burst and delivers each subagent's latest tick before its lifecycle", async () => {
		const bus = new EventBus();
		const host = new CollabHost(makeHostContext(bus));
		await host.start("ws://localhost:8788");

		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guestSocket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });

		const welcomed = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const seen: string[] = [];
		const latest: Record<string, number> = {};
		guestSocket.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve();
			if (frame.t !== "bus") return;
			if (frame.channel === TASK_SUBAGENT_PROGRESS_CHANNEL) {
				const { progress } = frame.data as ReturnType<typeof tick>;
				latest[progress.id] = progress.toolCount;
				seen.push(`progress:${progress.id}:${progress.toolCount}`);
			}
			if (frame.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
				const { id, status } = frame.data as { id: string; status: string };
				seen.push(`lifecycle:${id}:${status}`);
				if (id === "Agent11") done.resolve();
			}
		};
		guestSocket.onOpen = () => {
			guestSocket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "probe-guest",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		};
		guestSocket.connect();

		try {
			await welcomed.promise;
			const agents = Array.from({ length: 12 }, (_, i) => `Agent${i}`);
			// Far more ticks than the socket's 256-entry backlog, all in one burst.
			for (let n = 1; n <= 100; n++) {
				for (const id of agents) bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, tick(id, n));
			}
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "Agent0", agent: "task", status: "completed", index: 0 });
			for (const id of agents.slice(1)) {
				bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id, agent: "task", status: "completed", index: 0 });
			}

			await Promise.race([done.promise, Bun.sleep(5000)]);
			expect(host.ending).toBe(false);
			for (const id of agents) {
				expect(latest[id]).toBe(100);
				expect(seen.indexOf(`progress:${id}:100`)).toBeLessThan(seen.indexOf(`lifecycle:${id}:completed`));
			}
			expect(seen.filter(entry => entry.startsWith("progress:")).length).toBeLessThan(100);
		} finally {
			guestSocket.close();
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20000);
});
