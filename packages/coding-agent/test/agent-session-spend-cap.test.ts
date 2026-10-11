import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SPEND_CAP_EXIT_CODE,
	SPEND_CAP_NOTICE_SOURCE,
	SpendCapExceededError,
} from "@oh-my-pi/pi-coding-agent/session/spend-cap";
import { TempDir } from "@oh-my-pi/pi-utils";

function usage(cost: number) {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("AgentSession spend cap", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-spend-cap-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-spend-cap-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/** Every model call costs `turnCost` and asks for the tool, until the script's last call, which just answers. */
	function createHarness(settings: Record<string, unknown>, turnCost: number, toolTurns: number) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const toolStarts: number[] = [];
		const toolEnds: number[] = [];
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => {
				toolStarts.push(modelCalls);
				await Promise.resolve();
				toolEnds.push(modelCalls);
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		let modelCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = modelCalls++;
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index < toolTurns;
				const message = {
					role: "assistant" as const,
					content: isToolTurn
						? [{ type: "toolCall" as const, id: `tc-${index}`, name: "bash", arguments: {} }]
						: [{ type: "text" as const, text: "done" }],
					api: "anthropic-messages" as const,
					provider: "anthropic" as const,
					model: "claude-sonnet-4-5",
					usage: usage(turnCost),
					stopReason: isToolTurn ? ("toolUse" as const) : ("stop" as const),
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
			settings: Settings.isolated({ "todo.enabled": false, "todo.reminders": false, ...settings }),
			modelRegistry,
			toolRegistry: new Map([[tool.name, tool]]),
		});
		cleanups.push(() => session.dispose());
		const notices: Array<{ level: string; source?: string }> = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "notice") notices.push({ level: event.level, source: event.source });
		});
		return { session, notices, toolStarts, toolEnds, modelCalls: () => modelCalls };
	}

	it("ends the run after the turn that crossed the cap, with that turn's tool finished", async () => {
		const { session, notices, toolStarts, toolEnds, modelCalls } = createHarness(
			{ "session.maxCostUsd": 0.01 },
			0.0085,
			5,
		);

		await session.prompt("work");

		// Turn 1 ($0.0085) is past the 80% warning but under the cap; turn 2 crosses it. No third model call.
		expect(modelCalls()).toBe(2);
		expect(toolStarts).toHaveLength(2);
		expect(toolEnds).toHaveLength(2);
		expect(session.getSpendCap().level).toBe("capped");
		expect(notices.filter(n => n.source === SPEND_CAP_NOTICE_SOURCE).map(n => n.level)).toEqual(["warning", "error"]);
	});

	it("refuses further prompts after the cap, and a raised cap lets them through", async () => {
		const { session, modelCalls } = createHarness({ "session.maxCostUsd": 0.01 }, 0.006, 5);
		await session.prompt("work");
		const callsAtCap = modelCalls();

		await expect(session.prompt("more")).rejects.toBeInstanceOf(SpendCapExceededError);
		expect(modelCalls()).toBe(callsAtCap);

		session.setSpendCap({ maxCostUsd: 1 });
		expect(session.getSpendCap().level).not.toBe("capped");
		await session.prompt("more");
		expect(modelCalls()).toBeGreaterThan(callsAtCap);
	});

	it("stays capped after the transcript is rewound past the spend", async () => {
		const { session, modelCalls } = createHarness({ "session.maxCostUsd": 0.01 }, 0.006, 5);
		await session.prompt("work");
		const spent = session.getSpendCap().costUsd;
		const callsAtCap = modelCalls();
		const firstPrompt = session.sessionManager.getEntries().find(entry => entry.type === "message");
		if (!firstPrompt) throw new Error("Expected the prompt entry");

		// What /undo does: the leaf moves back before the prompt and the live transcript empties.
		await session.navigateTree(firstPrompt.id, { summarize: false });
		expect(session.agent.state.messages).toHaveLength(0);

		expect(session.getSpendCap().costUsd).toBe(spent);
		expect(session.getSpendCap().level).toBe("capped");
		await expect(session.prompt("more")).rejects.toBeInstanceOf(SpendCapExceededError);
		expect(modelCalls()).toBe(callsAtCap);
	});

	it("caps on tokens as well as cost", async () => {
		const { session, modelCalls } = createHarness({ "session.maxTokens": 250 }, 0, 5);

		await session.prompt("work");

		// 150 tokens per turn: the second turn reaches 300.
		expect(modelCalls()).toBe(2);
		expect(session.getSpendCap().level).toBe("capped");
	});

	it("does nothing without a cap", async () => {
		const { session, notices, modelCalls } = createHarness({}, 5, 3);

		await session.prompt("work");

		expect(modelCalls()).toBe(4);
		expect(session.getSpendCap().level).toBe("off");
		expect(notices.filter(n => n.source === SPEND_CAP_NOTICE_SOURCE)).toEqual([]);
	});

	it("exits print mode with the spend-cap status", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
		const { session } = createHarness({ "session.maxCostUsd": 0.01 }, 0.006, 5);

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "work", messages: ["and more"] });

		expect(exitCode).toBe(SPEND_CAP_EXIT_CODE);
	});

	it("exits print mode normally when the cap is not reached", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
		const { session } = createHarness({ "session.maxCostUsd": 100 }, 0.006, 1);

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "work" });

		expect(exitCode).toBe(0);
	});
});
