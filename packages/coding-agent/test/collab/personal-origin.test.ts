/**
 * Contract: a Personal session (`personal.enabled`) stamps `origin: "owner"` on the collab prompts it injects
 * (only the owner's paired devices hold a write link), refuses to hand out view links through the registry and
 * `/collab` creates no share links. A session without Personal changes nothing: its prompt details carry no
 * `origin` and its links are the same as ever.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface PromptCall {
	message: { customType: string; details?: unknown };
}

const prompts: PromptCall[] = [];
const promptWaiters: (() => void)[] = [];

function makeCtx(settings: Settings): InteractiveModeContext {
	return {
		settings,
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isBusyForSnapshot: false,
			isSessionTransitioning: false,
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "personal-origin",
			model: undefined,
			thinkingLevel: undefined,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [] },
			slashCommands: [],
			promptTemplates: [],
			customCommands: [],
			extensionRunner: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			promptCustomMessage: (message: PromptCall["message"]) => {
				prompts.push({ message });
				for (const wake of promptWaiters.splice(0)) wake();
				return Promise.resolve(true);
			},
			subscribe: () => () => {},
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

async function writerSocket(link: string): Promise<CollabSocket> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	if (!parsed.writeToken) throw new Error("the control link has no write token");
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const welcomed = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		if (frame.t === "welcome") welcomed.resolve();
	};
	socket.onOpen = () =>
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "phone",
			writeToken: Buffer.from(parsed.writeToken as Uint8Array).toString("base64url"),
		});
	socket.connect();
	await welcomed.promise;
	return socket;
}

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

let host: CollabHost | undefined;
let socket: CollabSocket | undefined;

afterEach(async () => {
	prompts.length = 0;
	socket?.close();
	socket = undefined;
	await host?.stop("test done");
	host = undefined;
});

async function promptsReceived(count: number): Promise<void> {
	while (prompts.length < count) await new Promise<void>(resolve => promptWaiters.push(resolve));
}

describe("collab prompt origin", () => {
	it("a Personal session stamps origin owner on a writer's prompt", async () => {
		host = new CollabHost(makeCtx(Settings.isolated({ "personal.enabled": true })));
		await host.start("ws://localhost:8788");
		socket = await writerSocket(host.link);
		socket.send({ t: "prompt", text: "from my phone" });
		await promptsReceived(1);
		expect(prompts[0].message.customType).toBe("collab-prompt");
		expect(prompts[0].message.details).toEqual({ from: "phone", origin: "owner" });
	});

	it("a session without Personal stamps nothing", async () => {
		host = new CollabHost(makeCtx(Settings.isolated()));
		await host.start("ws://localhost:8788");
		socket = await writerSocket(host.link);
		socket.send({ t: "prompt", text: "hello" });
		await promptsReceived(1);
		expect(prompts[0].message.details).toEqual({ from: "phone" });
	});
});

describe("registry links", () => {
	it("a Personal session publishes no view link, only the control link", async () => {
		host = new CollabHost(makeCtx(Settings.isolated({ "personal.enabled": true })));
		await host.start("ws://localhost:8788");
		expect(host.registryLink("view")).toBe("");
		expect(host.registryLink("control")).not.toBe("");
	});

	it("allowShareLinks puts the view link back", async () => {
		host = new CollabHost(makeCtx(Settings.isolated({ "personal.enabled": true, "personal.allowShareLinks": true })));
		await host.start("ws://localhost:8788");
		expect(host.registryLink("view")).not.toBe("");
	});

	it("a session without Personal keeps its view link", async () => {
		host = new CollabHost(makeCtx(Settings.isolated()));
		await host.start("ws://localhost:8788");
		expect(host.registryLink("view")).not.toBe("");
	});
});

describe("/collab in a Personal session", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function harness(overrides: Record<string, unknown>) {
		const showStatus = vi.fn();
		const showError = vi.fn();
		const present = vi.fn();
		const ctx = {
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			present,
			settings: Settings.isolated({ "collab.relayUrl": "wss://relay.example.com", ...overrides }),
			session: { registerSessionChangeCallback: () => () => {} },
			sessionManager: { getSessionId: () => "sess-personal" },
			statusLine: { setCollabStatus: () => {}, invalidate: () => {} },
			ui: { requestRender: () => {} },
			collabHost: undefined,
		} as unknown as InteractiveModeContext;
		ctx.collabController = new CollabController(ctx);
		return { ctx, showStatus, showError, present, runtime: { ctx } as BuiltinSlashCommandRuntime };
	}

	it("refuses to start or view a room, and creates no link", async () => {
		const start = vi.spyOn(CollabHost.prototype, "start");
		const h = harness({ "personal.enabled": true });
		for (const command of ["/collab", "/collab start", "/collab view", "/collab wss://elsewhere.example.com"]) {
			expect(await executeBuiltinSlashCommand(command, h.runtime)).toBe(true);
		}
		expect(h.showError).toHaveBeenCalledTimes(4);
		expect(h.showError.mock.calls[0]?.[0]).toContain("Personal session");
		expect(h.present).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("still lets the owner stop and ask for the status", async () => {
		const h = harness({ "personal.enabled": true });
		await executeBuiltinSlashCommand("/collab status", h.runtime);
		expect(h.showStatus.mock.calls[0]?.[0]).toBe("Not in a collab session");
		await executeBuiltinSlashCommand("/collab stop", h.runtime);
		expect(h.showStatus.mock.calls[1]?.[0]).toBe("Collab stopped");
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("starts a room as before when allowShareLinks is on, or Personal is off", async () => {
		for (const overrides of [{ "personal.enabled": true, "personal.allowShareLinks": true }, {}]) {
			const start = vi.spyOn(CollabHost.prototype, "start").mockResolvedValue(undefined);
			const h = harness(overrides);
			await executeBuiltinSlashCommand("/collab", h.runtime);
			expect(start).toHaveBeenCalledTimes(1);
			expect(h.showError.mock.calls.every(call => !String(call[0]).includes("Personal session"))).toBe(true);
			vi.restoreAllMocks();
		}
	});
});
