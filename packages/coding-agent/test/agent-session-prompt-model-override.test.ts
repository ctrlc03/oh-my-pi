import { afterEach, describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildTestModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

const BASE = buildTestModel("base");
const ALT = buildTestModel("alt");

const prompt = (content: string) => ({
	customType: "collab-prompt",
	content,
	display: true,
	attribution: "user" as const,
});

describe("per-prompt model override", () => {
	let session: AgentSession;

	afterEach(async () => {
		await session?.dispose();
	});

	function setup(responses: MockResponseSource) {
		const mock = createMockModel({ responses });
		const served: string[] = [];
		const manager = SessionManager.inMemory();
		const registry = {
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (model: Model) => model,
			clearSuppressedSelector: () => {},
		} as unknown as ModelRegistry;
		const agent = new Agent({
			initialState: { model: BASE, systemPrompt: ["base"], tools: [], messages: [] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (model, context, options) => {
				served.push(model.id);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
			toolRegistry: new Map(),
		});
		return { served, manager };
	}

	/** The session model is put back by the settle step, which runs after the prompt promise resolves. */
	async function settled(): Promise<void> {
		while (session.isStreaming) await setImmediate();
	}

	const modelChanges = (manager: SessionManager) =>
		manager.getEntries().filter(entry => entry.type === "model_change");

	it("runs one turn on the override and restores the session model without a transcript entry", async () => {
		const { served, manager } = setup([{ content: ["one"] }, { content: ["two"] }]);
		await session.promptCustomMessage(prompt("first"), { modelOverride: { model: ALT } });
		await settled();
		expect(served).toEqual(["alt"]);
		expect(session.model?.id).toBe("base");
		expect(modelChanges(manager)).toEqual([]);

		await session.promptCustomMessage(prompt("second"));
		await settled();
		expect(served).toEqual(["alt", "base"]);
	});

	it("restores the session model when the turn errors", async () => {
		const { served } = setup([{ stopReason: "error", errorMessage: "provider exploded" }]);
		await session.promptCustomMessage(prompt("boom"), { modelOverride: { model: ALT } });
		await settled();
		expect(served).toEqual(["alt"]);
		expect(session.model?.id).toBe("base");
	});

	it("restores the session model when the turn is aborted", async () => {
		const started = Promise.withResolvers<void>();
		setup([
			() => {
				started.resolve();
				return { content: ["never"], delayMs: 60_000 };
			},
		]);
		const running = session.promptCustomMessage(prompt("slow"), { modelOverride: { model: ALT } });
		await started.promise;
		expect(session.model?.id).toBe("alt");
		await session.abort();
		await running;
		await settled();
		expect(session.model?.id).toBe("base");
	});

	it("runs a queued follow-up on its own override and returns to the session model for the next one", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { served, manager } = setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first"] };
			},
			{ content: ["second"] },
			{ content: ["third"] },
		]);
		const first = session.promptCustomMessage(prompt("first"));
		await started.promise;
		await session.promptCustomMessage(prompt("second"), {
			streamingBehavior: "followUp",
			modelOverride: { model: ALT },
		});
		await session.promptCustomMessage(prompt("third"), { streamingBehavior: "followUp" });
		release.resolve();
		await first;
		await settled();
		expect(served).toEqual(["base", "alt", "base"]);
		expect(session.model?.id).toBe("base");
		expect(modelChanges(manager)).toEqual([]);
	});

	it("keeps a steer that arrives mid-turn on the running turn's model and restores afterwards", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { served } = setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first"] };
			},
			{ content: ["second"] },
		]);
		const running = session.promptCustomMessage(prompt("first"), { modelOverride: { model: ALT } });
		await started.promise;
		await session.promptCustomMessage(prompt("steer"), { streamingBehavior: "steer" });
		release.resolve();
		await running;
		await settled();
		expect(served).toEqual(["alt", "alt"]);
		expect(session.model?.id).toBe("base");
	});

	it("runs the host's own follow-up on the session model while a guest's override is running", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { served } = setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["first"] };
			},
			{ content: ["second"] },
		]);
		const running = session.promptCustomMessage(prompt("guest"), { modelOverride: { model: ALT } });
		await started.promise;
		await session.followUp("host follow-up");
		release.resolve();
		await running;
		await settled();
		expect(served).toEqual(["alt", "base"]);
		expect(session.model?.id).toBe("base");
	});
});
