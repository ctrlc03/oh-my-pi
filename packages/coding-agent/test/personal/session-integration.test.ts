/**
 * Contract: `AgentSession` builds the Personal runtime only for a top-level session with `personal.enabled`,
 * forwards its events to it, refuses what an outside-started turn may not do, and counts spend in the profile
 * ledger. With Personal off nothing exists, nothing is written and the spend path is as before. Every run uses a
 * temporary home and agent directory, and the `review` run kind (no inbox polling, no heartbeat).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SPEND_LEDGER_FILE } from "@oh-my-pi/pi-coding-agent/session/rolling-spend";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SpendCapExceededError } from "@oh-my-pi/pi-coding-agent/session/spend-cap";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

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

describe("AgentSession with the Personal agent", () => {
	let tempDir: TempDir;
	let homeDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let previousAgentDir: string;
	let previousHome: string | undefined;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-personal-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-personal-session-");
		homeDir = TempDir.createSync("@pi-personal-home-");
		previousHome = process.env.HOME;
		process.env.HOME = homeDir.path();
		vi.spyOn(os, "homedir").mockReturnValue(homeDir.path());
		previousAgentDir = getAgentDir();
		setAgentDir(path.join(homeDir.path(), "agent"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		setAgentDir(previousAgentDir);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		vi.restoreAllMocks();
		tempDir.removeSync();
		homeDir.removeSync();
	});

	/** Every model call costs `turnCost` and asks for the tool, until the script's last call, which just answers. */
	function createHarness(settings: Record<string, unknown>, turnCost: number, toolTurns: number) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		let modelCalls = 0;
		let toolRuns = 0;
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => {
				toolRuns += 1;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = modelCalls++;
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index % (toolTurns + 1) < toolTurns;
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
		return { session, toolRuns: () => toolRuns };
	}

	const personalEvent = (trust: "owner" | "external") => ({
		customType: "personal-event",
		content: "[personal-event] email, event: something",
		display: false as const,
		attribution: "agent" as const,
		details: { id: `e-${trust}`, source: "email", kind: "event", trust },
	});

	const ledgerFile = () => path.join(getAgentDir(), SPEND_LEDGER_FILE);

	describe("off", () => {
		it("has no runtime, writes nothing, and counts no rolling spend", async () => {
			const { session, toolRuns } = createHarness({}, 5, 1);
			expect(session.personal).toBeUndefined();
			await session.prompt("work");
			expect(toolRuns()).toBe(1);
			expect(await Bun.file(ledgerFile()).exists()).toBe(false);
			expect(await Bun.file(path.join(homeDir.path(), ".omp", "run", "personal", "beat.json")).exists()).toBe(false);
		});

		it("does not enforce a rolling limit that is not configured", async () => {
			const { session } = createHarness({}, 50, 1);
			await session.prompt("work");
			await session.prompt("again");
		});
	});

	describe("on", () => {
		const on = {
			"personal.enabled": true,
			"personal.runKind": "review",
			"personal.externalTurns.policy": "read-only",
		};

		it("builds a runtime for the session, and its guard follows the turn", async () => {
			const { session } = createHarness(on, 0.001, 0);
			expect(session.personal?.runKind).toBe("review");
			expect(session.personal?.currentOrigin()).toBe("agent");
			await session.prompt("hello");
			// The turn is over: nothing is tainted and the origin is back to the default.
			expect(session.personal?.guard.tainted).toBe(false);
		});

		it("refuses tool calls above read in a turn an external event started, and not in an owner turn", async () => {
			const { session, toolRuns } = createHarness(on, 0.001, 1);
			await session.sendCustomMessage(personalEvent("external"), { triggerTurn: true });
			await session.waitForIdle();
			expect(toolRuns()).toBe(0);
			await session.prompt("owner asks");
			expect(toolRuns()).toBe(1);
		});

		it("runs the tool in an external turn when the policy is none", async () => {
			const { session, toolRuns } = createHarness({ ...on, "personal.externalTurns.policy": "none" }, 0.001, 1);
			await session.sendCustomMessage(personalEvent("external"), { triggerTurn: true });
			await session.waitForIdle();
			expect(toolRuns()).toBe(1);
		});

		it("an owner-trust event is an owner turn", async () => {
			const { session, toolRuns } = createHarness(on, 0.001, 1);
			await session.sendCustomMessage(personalEvent("owner"), { triggerTurn: true });
			await session.waitForIdle();
			expect(toolRuns()).toBe(1);
		});

		it("records spend in the profile ledger and refuses prompts once the day limit is reached", async () => {
			const { session } = createHarness({ ...on, "session.spendLimits.dayUsd": 0.01 }, 0.02, 0);
			await session.prompt("one");
			const lines = (await Bun.file(ledgerFile()).text()).trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toMatchObject({ sessionId: session.sessionId, costUsd: 0.02 });
			await expect(session.prompt("two")).rejects.toBeInstanceOf(SpendCapExceededError);
		});

		it("a subagent session gets no runtime", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("model missing");
			const session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "k",
					initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
					convertToLlm,
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: Settings.isolated(on),
				modelRegistry,
				toolRegistry: new Map(),
				agentKind: "sub",
			});
			cleanups.push(() => session.dispose());
			expect(session.personal).toBeUndefined();
		});
	});
});
