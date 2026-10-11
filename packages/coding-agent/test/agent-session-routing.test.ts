import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_ROUTING_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-routing";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const HAIKU = getBundledModel("anthropic", "claude-haiku-4-5");
const SONNET = getBundledModel("anthropic", "claude-sonnet-4-5");
const OPUS = getBundledModel("anthropic", "claude-opus-4-6");
const JUDGE = getBundledModel("local", "qwen3-1.7b");
if (!HAIKU || !SONNET || !OPUS || !JUDGE) throw new Error("Expected bundled routing test models");

function usage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession model routing", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-routing-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createHarness(settings: Record<string, unknown>) {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/routing-session-models.yml");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([HAIKU!, SONNET!, OPUS!, JUDGE!]);
		const ranOn: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: SONNET!, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: model => {
				ranOn.push(model.id);
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "done" }],
					api: "anthropic-messages" as const,
					provider: "anthropic" as const,
					model: model.id,
					usage: usage(),
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({
				"todo.enabled": false,
				"todo.reminders": false,
				modelRoles: { judge: `local/${JUDGE!.id}`, smol: `anthropic/${HAIKU!.id}`, slow: `anthropic/${OPUS!.id}` },
				...settings,
			}),
			modelRegistry,
			toolRegistry: new Map(),
		});
		cleanups.push(() => session.dispose());
		const notices: Array<{ message: string; source?: string }> = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "notice") notices.push({ message: event.message, source: event.source });
		});
		return { session, ranOn, notices };
	}

	function scriptJudge(...answers: Array<[string, string]>) {
		return vi.spyOn(tinyModelClient, "complete").mockImplementation(async () => {
			const answer = answers.shift();
			if (!answer) throw new Error("judge script exhausted");
			return `tier: ${answer[0]}\nbucket: ${answer[1]}`;
		});
	}

	it("runs each prompt on its routed model, announces it, and puts the session's model back", async () => {
		scriptJudge(["smol", "trivial"], ["slow", "hard"]);
		const { session, ranOn, notices } = createHarness({ "routing.mode": "auto", "routing.stickiness": 0 });

		await session.prompt("what does Array.prototype.at return?");
		await session.waitForIdle();
		await session.prompt("redesign the scheduler as per-queue workers across the whole repo");
		await session.waitForIdle();

		expect(ranOn).toEqual([HAIKU!.id, OPUS!.id]);
		expect(session.model?.id).toBe(SONNET!.id);
		expect(notices.filter(notice => notice.source === "routing")).toHaveLength(2);
		expect(session.routing.decisions.map(decision => decision.tier)).toEqual(["smol", "slow"]);
	});

	it("lets a model chosen for the message win over routing", async () => {
		const complete = scriptJudge(["smol", "trivial"]);
		const { session, ranOn } = createHarness({ "routing.mode": "auto" });

		await session.promptCustomMessage(
			{ customType: "test-prompt", content: "what is a monad?", display: true, attribution: "user" },
			{ modelOverride: { model: OPUS! } },
		);
		await session.waitForIdle();

		expect(ranOn).toEqual([OPUS!.id]);
		expect(complete).not.toHaveBeenCalled();
		expect(session.routing.decisions).toEqual([expect.objectContaining({ status: "skipped" })]);
	});

	it("does nothing unless routing is on", async () => {
		const complete = scriptJudge(["smol", "trivial"]);
		const { session, ranOn, notices } = createHarness({});

		await session.prompt("what is a monad?");
		await session.waitForIdle();

		expect(ranOn).toEqual([SONNET!.id]);
		expect(complete).not.toHaveBeenCalled();
		expect(notices.filter(notice => notice.source === "routing")).toEqual([]);
	});

	it("/route toggles routing for the session and reports the tiers", async () => {
		const complete = scriptJudge(["smol", "trivial"]);
		const { session, ranOn } = createHarness({});
		const output: string[] = [];
		const route = async (args: string) => {
			const [command] = BUILTIN_ROUTING_SLASH_COMMANDS;
			const runtime = { session, output: (text: string) => output.push(text) } as unknown as SlashCommandRuntime;
			await command?.handle?.({ name: "route", args, text: `/route ${args}` }, runtime);
		};

		await route("on");
		expect(session.routing.enabled).toBe(true);
		await session.prompt("what is a monad?");
		await session.waitForIdle();
		expect(ranOn).toEqual([HAIKU!.id]);

		await route("");
		expect(output.at(-1)).toContain(HAIKU!.id);
		await route("off");
		expect(session.routing.enabled).toBe(false);
		await route("bogus");
		expect(session.routing.enabled).toBe(false);
		expect(complete).toHaveBeenCalledTimes(1);
	});
});
