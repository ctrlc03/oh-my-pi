/**
 * Contract: on a real AgentSession, `getInspectRows` lists the requests the session made with
 * the usage and timing they recorded and redacts excerpts through the session's obfuscator on
 * request, and `previewNextRequest` builds the next request through the session's own provider
 * path (secrets obfuscated, tools and system prompt included) while the transport never sends.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SECRET = "hunter2-very-secret-value";

describe("AgentSession inspector and preview", () => {
	let modelRegistry: ModelRegistry;
	let model: Model;
	let session: AgentSession | undefined;

	beforeAll(() => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("lists the session's requests, redacts on request, and previews the next one without sending", async () => {
		const mock = createMockModel({ handler: { content: [`noted ${SECRET}`] } });
		let sent = 0;
		let previews = 0;
		const streamFn: Agent["streamFn"] = (streamModel, context, options) => {
			if (mock.calls.length === 0) return mock.stream(streamModel, context, options);
			previews++;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const failed: AssistantMessage = {
					role: "assistant",
					content: [],
					api: streamModel.api,
					provider: streamModel.provider,
					model: streamModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: "stopped",
					timestamp: 1,
				};
				try {
					await options?.onPayload?.({ system: context.systemPrompt, messages: context.messages }, streamModel);
					sent++;
					stream.end(failed);
				} catch {
					stream.push({ type: "error", reason: "error", error: failed });
					stream.end(failed);
				}
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: ["You are a test agent"], tools: [], messages: [] },
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setObfuscator(new SecretObfuscator([{ type: "plain", content: SECRET }]));

		await agent.prompt(`remember ${SECRET}`);

		const plain = session.getInspectRows();
		expect(plain.total).toBe(1);
		expect(plain.rows[0]).toMatchObject({ seq: 1, model: "mock/mock-model", stopReason: "stop" });
		expect(plain.rows[0]!.injected[0]).toMatchObject({ kind: "prompt", text: `remember ${SECRET}` });

		const redacted = session.getInspectRows({ redact: true });
		expect(JSON.stringify(redacted)).not.toContain(SECRET);
		expect(redacted.rows[0]!.injected[0]!.text).toContain("remember ");

		const preview = await session.previewNextRequest({ redact: true });
		expect(previews).toBe(1);
		expect(sent).toBe(0);
		expect(preview.source).toBe("request");
		expect(preview.model).toBe(`${model.provider}/${model.id}`);
		expect(preview.text).toContain("You are a test agent");
		expect(preview.text).not.toContain(SECRET);
		// Previewing is read-only: it adds nothing to the transcript or the request list.
		expect(session.getInspectRows().total).toBe(1);
	});
});
