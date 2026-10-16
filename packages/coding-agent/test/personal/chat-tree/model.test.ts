/**
 * Contract: pickHaiku chooses the cheapest Anthropic Haiku (input price, then output price), the newest id (the
 * highest) among equals, and nothing when the list holds no Anthropic Haiku. resolveChatTreeModel falls back from the
 * Haiku to the session model.
 */
import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../../../src/config/settings";
import { pickHaiku, resolveChatTreeModel } from "../../../src/personal/chat-tree/model";

/** A model with only the fields pickHaiku reads. */
function model(provider: string, id: string, input = 1, output = 5): Model<Api> {
	return {
		provider,
		id,
		api: "anthropic-messages",
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<Api>;
}

describe("pickHaiku", () => {
	it("returns undefined for an empty list", () => {
		expect(pickHaiku([])).toBeUndefined();
	});

	it("returns undefined when there is no Anthropic Haiku", () => {
		const models = [
			model("anthropic", "claude-sonnet-4-5", 3, 15),
			model("anthropic", "claude-opus-4-1", 15, 75),
			model("openai", "haiku-clone", 0.1, 0.1),
			model("bedrock", "anthropic.claude-haiku-4-5", 0.5, 2),
		];
		expect(pickHaiku(models)).toBeUndefined();
	});

	it("picks the only Anthropic Haiku among other models", () => {
		const haiku = model("anthropic", "claude-haiku-4-5", 1, 5);
		expect(
			pickHaiku([model("anthropic", "claude-sonnet-4-5", 0.1, 0.1), haiku, model("openai", "gpt-5", 0.1, 0.1)]),
		).toBe(haiku);
	});

	it("picks the cheapest by input price", () => {
		const cheap = model("anthropic", "claude-3-haiku", 0.25, 1.25);
		const dear = model("anthropic", "claude-haiku-4-5", 1, 5);
		expect(pickHaiku([dear, cheap])).toBe(cheap);
		expect(pickHaiku([cheap, dear])).toBe(cheap);
	});

	it("breaks an input-price tie by output price", () => {
		const low = model("anthropic", "claude-haiku-a", 1, 4);
		const high = model("anthropic", "claude-haiku-b", 1, 5);
		expect(pickHaiku([high, low])).toBe(low);
		expect(pickHaiku([low, high])).toBe(low);
	});

	it("takes the highest id, the newest, when the prices are equal", () => {
		const older = model("anthropic", "claude-haiku-4-5-20250101", 1, 5);
		const newer = model("anthropic", "claude-haiku-4-5-20251001", 1, 5);
		expect(pickHaiku([older, newer])).toBe(newer);
		expect(pickHaiku([newer, older])).toBe(newer);
	});

	it("matches haiku in any case", () => {
		const haiku = model("anthropic", "Claude-HAIKU-4", 1, 5);
		expect(pickHaiku([haiku])).toBe(haiku);
	});
});

describe("resolveChatTreeModel", () => {
	it("chooses the Haiku when the setting is empty", () => {
		const haiku = model("anthropic", "claude-haiku-4-5", 1, 5);
		const resolved = resolveChatTreeModel(
			Settings.isolated({}),
			[model("anthropic", "claude-sonnet-4-5", 3, 15), haiku],
			undefined,
		);
		expect(resolved.source).toBe("haiku");
		expect(resolved.model).toBe(haiku);
	});

	it("throws when there is no model at all", () => {
		expect(() => resolveChatTreeModel(Settings.isolated({}), [], undefined)).toThrow("no model");
	});

	it("falls back to the session model when nothing else is available", () => {
		const session = model("openai", "gpt-5", 1, 5);
		const resolved = resolveChatTreeModel(Settings.isolated({}), [], session);
		expect(resolved.source).toBe("session");
		expect(resolved.model).toBe(session);
	});

	it("throws when the setting names a model that is not available", () => {
		const settings = Settings.isolated({ "personal.chatTree.model": "no-such-model-anywhere" });
		expect(() => resolveChatTreeModel(settings, [model("anthropic", "claude-haiku-4-5")], undefined)).toThrow(
			'personal.chatTree.model "no-such-model-anywhere" is not an available model',
		);
	});
});
