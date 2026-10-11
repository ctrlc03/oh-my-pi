import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession request ledger", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-request-ledger-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-request-ledger-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		tempDir.removeSync();
	});

	/** Every model call answers with a warm cache read, so the second call onward reads the prefix. */
	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "done" }],
					api: "anthropic-messages" as const,
					provider: "anthropic" as const,
					model: "claude-sonnet-4-5",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 30_000,
						cacheWrite: 100,
						totalTokens: 30_115,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "todo.enabled": false, "todo.reminders": false }),
			modelRegistry,
			toolRegistry: new Map(),
		});
		cleanups.push(() => session.dispose());
		return session;
	}

	it("records each settled request, then starts empty in a new session", async () => {
		const session = createSession();
		await session.prompt("one");
		await session.prompt("two");
		expect(session.requestLedger.records()).toHaveLength(2);
		expect(session.requestLedger.snapshot()?.requests).toBe(2);

		await session.newSession();

		expect(session.requestLedger.records()).toHaveLength(0);
		expect(session.requestLedger.snapshot()).toBeUndefined();
		expect(session.requestLedger.hitPct).toBeUndefined();

		await session.prompt("fresh");
		expect(session.requestLedger.records()).toHaveLength(1);
		expect(session.requestLedger.snapshot()?.requests).toBe(1);
	});
});
