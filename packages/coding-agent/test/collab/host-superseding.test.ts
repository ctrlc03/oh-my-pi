import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// Streaming replies and subagent progress update far faster than a relay link
// drains. Forwarded one frame per token or tick, a burst overflowed the
// socket's send backlog and ended the room for every guest. Each update carries
// a whole current view, so only the latest needs to reach guests — and the
// frame that settles it (message_end, lifecycle) must still follow it.

type SessionListener = (event: AgentSessionEvent) => void;

function makeHostContext(eventBus: EventBus, listeners: SessionListener[] = []): InteractiveModeContext {
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
			subscribe: (listener: SessionListener) => {
				listeners.push(listener);
				return () => {};
			},
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

async function joinGuest(host: CollabHost, onFrame: (frame: CollabFrame) => void) {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const guestSocket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const welcomed = Promise.withResolvers<void>();
	guestSocket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
		onFrame(frame);
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
	await welcomed.promise;
	return guestSocket;
}

function reply(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "probe",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("collab host superseding broadcasts", () => {
	it("survives a progress burst and delivers each subagent's latest tick before its lifecycle", async () => {
		const bus = new EventBus();
		const host = new CollabHost(makeHostContext(bus));
		await host.start("ws://localhost:8788");

		const done = Promise.withResolvers<void>();
		const seen: string[] = [];
		const latest: Record<string, number> = {};
		const guestSocket = await joinGuest(host, frame => {
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
		});

		try {
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

	it("survives a long streamed reply and delivers its final text before message_end", async () => {
		const listeners: SessionListener[] = [];
		const host = new CollabHost(makeHostContext(new EventBus(), listeners));
		await host.start("ws://localhost:8788");

		const ended = Promise.withResolvers<void>();
		const seen: string[] = [];
		let lastText = "";
		const guestSocket = await joinGuest(host, frame => {
			if (frame.t !== "event") return;
			if (frame.event.type === "message_update") {
				const part = (frame.event.message as ReturnType<typeof reply>).content[0];
				lastText = part?.text ?? "";
				seen.push("update");
			}
			if (frame.event.type === "message_end") {
				seen.push(`end:${lastText.length}`);
				ended.resolve();
			}
		});

		try {
			const emit = (event: unknown) => {
				for (const listener of listeners) listener(event as AgentSessionEvent);
			};
			// Every token resends the whole reply so far, as a real stream does.
			let text = "";
			emit({ type: "message_start", message: reply("") });
			for (let n = 0; n < 2000; n++) {
				text += "token ";
				emit({
					type: "message_update",
					message: reply(text),
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token ", partial: reply(text) },
				});
			}
			emit({ type: "message_end", message: reply(text) });

			await Promise.race([ended.promise, Bun.sleep(5000)]);
			expect(host.ending).toBe(false);
			expect(seen.at(-1)).toBe(`end:${text.length}`);
			expect(seen.filter(entry => entry === "update").length).toBeLessThan(2000);
		} finally {
			guestSocket.close();
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20000);
});
