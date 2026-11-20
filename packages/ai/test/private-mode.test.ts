import { afterEach, describe, expect, test, vi } from "bun:test";
import { complete, completeSimple, PrivateModeError, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { enterPrivateMode, resetPrivateModeForTesting } from "@oh-my-pi/pi-ai/private-mode";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { generateImage } from "@oh-my-pi/pi-ai/images";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";

const remote = getBundledModel("anthropic", "claude-haiku-4-5");
const local: Model<Api> = {
	...getBundledModel("openai", "gpt-4o-mini"),
	provider: "studio-glm",
	baseUrl: "http://127.0.0.1:9/v1",
};
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

afterEach(() => {
	resetPrivateModeForTesting();
	vi.restoreAllMocks();
});

describe("private mode egress guard", () => {
	test("a disallowed provider is refused before any fetch, on every entry that dispatches a model request", async () => {
		enterPrivateMode(["studio-glm"]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const perCallFetch = vi.fn(async () => new Response("{}"));

		await expect(complete(remote, context, { apiKey: "sk-x", fetch: perCallFetch })).rejects.toBeInstanceOf(
			PrivateModeError,
		);
		await expect(completeSimple(remote, context, { apiKey: "sk-x", fetch: perCallFetch })).rejects.toBeInstanceOf(
			PrivateModeError,
		);
		expect(() => streamSimple(remote, context, { apiKey: "sk-x", fetch: perCallFetch })).toThrow(PrivateModeError);
		expect(() =>
			synthesizeSpeech(
				{ ...remote, api: "openai-speech" },
				{ text: "hi" } as never,
				{ apiKey: "sk-x", fetch: perCallFetch } as never,
			),
		).toThrow(PrivateModeError);
		await expect(
			generateImage(
				{ ...remote, api: "openai-images" },
				{ prompt: "x" } as never,
				{
					apiKey: "sk-x",
					fetch: perCallFetch,
				} as never,
			),
		).rejects.toBeInstanceOf(PrivateModeError);

		expect(perCallFetch).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("an allowed provider reaches the transport", async () => {
		enterPrivateMode(["studio-glm"]);
		const perCallFetch = vi.fn(async () => new Response("nope", { status: 400 }));
		const message = await complete(local, context, { apiKey: "local", fetch: perCallFetch });
		expect(perCallFetch).toHaveBeenCalled();
		expect(message.stopReason).toBe("error");
	});

	test("outside private mode a remote provider is not blocked", async () => {
		const perCallFetch = vi.fn(async () => new Response("nope", { status: 400 }));
		await complete(remote, context, { apiKey: "sk-x", fetch: perCallFetch });
		expect(perCallFetch).toHaveBeenCalled();
	});

	test("re-entering private mode can narrow the allowlist but never widen it", async () => {
		enterPrivateMode(["studio-glm"]);
		enterPrivateMode(["studio-glm", "anthropic"]);
		await expect(complete(remote, context, { apiKey: "sk-x" })).rejects.toBeInstanceOf(PrivateModeError);
	});

	test("a refusal names the provider and the allowlist, and is never retried", async () => {
		enterPrivateMode(["studio-glm"]);
		const failure = await complete(remote, context, { apiKey: "sk-x" }).then(
			() => undefined,
			error => error,
		);
		expect(failure).toBeInstanceOf(PrivateModeError);
		expect(failure.message).toBe("anthropic is not allowed in a private session (private.providers: studio-glm).");
		// The retry layer classifies by error object and by message text; neither may be retriable.
		expect(AIError.retriable(AIError.classify(failure))).toBe(false);
		expect(AIError.retriable(AIError.classifyMessage({ errorMessage: failure.message }))).toBe(false);
	});
});
