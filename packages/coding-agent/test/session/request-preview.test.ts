/**
 * Contract: the request preview captures the provider body through `onPayload`, aborts, and never
 * lets the transport send it; transports not verified to call `onPayload` first are not run at
 * all and preview the provider-neutral context instead. Every string is redacted.
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { previewRequest } from "@oh-my-pi/pi-coding-agent/session/request-preview";

const SECRET = "sk-live-SECRET-VALUE";

function anthropicModel(): Model {
	return getBundledModel("anthropic", "claude-sonnet-4-5");
}

function context(): Context {
	return {
		systemPrompt: ["you are helpful"],
		messages: [{ role: "user", content: `my key is ${SECRET}`, timestamp: 1 }],
		tools: [],
	};
}

function errorMessage(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: 1,
	};
}

/** A transport that, like the real ones, builds its body, offers it to `onPayload`, and only then "sends". */
function fakeTransport(log: { sent: number; calls: number }, blob?: string): StreamFn {
	return (model, ctx, options) => {
		log.calls++;
		const stream = new AssistantMessageEventStream();
		void (async () => {
			try {
				await options?.onPayload?.(
					{ model: model.id, system: ctx.systemPrompt, messages: ctx.messages, ...(blob ? { image: blob } : {}) },
					model,
				);
				log.sent++;
				stream.end(errorMessage(model, "sent"));
			} catch (error) {
				const failed = errorMessage(model, error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", reason: "error", error: failed });
				stream.end(failed);
			}
		})();
		return stream;
	};
}

const countTokens = (text: string): number => Math.ceil(text.length / 4);
const redact = (text: string): string => text.replaceAll(SECRET, "[REDACTED]");

describe("previewRequest", () => {
	it("captures the provider body and stops the transport before it sends", async () => {
		const log = { sent: 0, calls: 0 };
		const preview = await previewRequest({
			model: anthropicModel(),
			context: context(),
			stream: fakeTransport(log),
			options: {},
			countTokens,
			redact,
		});
		expect(log.calls).toBe(1);
		expect(log.sent).toBe(0);
		expect(preview.source).toBe("request");
		expect(preview.messages).toBe(1);
		expect(preview.tokens).toBeGreaterThan(0);
		expect(preview.text).toContain("you are helpful");
		expect(preview.text).toContain("[REDACTED]");
		expect(preview.text).not.toContain("SECRET-VALUE");
		expect(preview.truncated).toBe(false);
	});

	it("elides inline binary blobs and truncates oversized bodies", async () => {
		const log = { sent: 0, calls: 0 };
		const preview = await previewRequest({
			model: anthropicModel(),
			context: context(),
			stream: fakeTransport(log, "A".repeat(50_000)),
			options: {},
			countTokens,
			maxChars: 200,
		});
		expect(preview.text.length).toBeLessThanOrEqual(200);
		expect(preview.truncated).toBe(true);
		expect(preview.tokens).toBeLessThan(2_000);
	});

	it("does not run a transport that is not known to hand over its body before sending", async () => {
		const log = { sent: 0, calls: 0 };
		const model: Model = { ...anthropicModel(), api: "cursor-agent" };
		const preview = await previewRequest({
			model,
			context: context(),
			stream: fakeTransport(log),
			options: {},
			countTokens,
			redact,
		});
		expect(log.calls).toBe(0);
		expect(preview.source).toBe("context");
		expect(preview.text).toContain("[REDACTED]");
		expect(preview.text).not.toContain("SECRET-VALUE");
		expect(preview.note).toContain("cursor-agent");
	});

	it("falls back to the context when the transport never offers its body", async () => {
		const log = { sent: 0, calls: 0 };
		const silent: StreamFn = model => {
			log.calls++;
			const stream = new AssistantMessageEventStream();
			const failed = errorMessage(model, "no key");
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end(failed);
			return stream;
		};
		const preview = await previewRequest({
			model: anthropicModel(),
			context: context(),
			stream: silent,
			options: {},
			countTokens,
		});
		expect(preview.source).toBe("context");
		expect(log.calls).toBe(1);
	});
});
