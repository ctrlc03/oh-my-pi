import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { answeredByOtherModel } from "../src/lib/prompt-model";

function reply(id: string, model: string): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "message",
		message: {
			role: "assistant",
			content: [],
			model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

function switched(id: string, model: string): SessionEntry {
	return { id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "model_change", model };
}

describe("answeredByOtherModel", () => {
	it("flags replies from another model after the session's last model change", () => {
		const entries = [
			reply("a", "haiku"),
			switched("m", "anthropic/sonnet"),
			reply("b", "sonnet"),
			reply("c", "opus"),
		];
		expect([...answeredByOtherModel(entries, "sonnet")]).toEqual([["c", "opus"]]);
	});

	it("treats answers from before the last model change as plain history", () => {
		const entries = [
			reply("a", "haiku"),
			reply("b", "haiku"),
			switched("m", "anthropic/sonnet"),
			reply("c", "sonnet"),
		];
		expect(answeredByOtherModel(entries, "sonnet").size).toBe(0);
	});

	it("notes a turn's last reply from the other model, once per prompt", () => {
		const prompt: SessionEntry = {
			id: "p",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "message",
			message: { role: "user", content: "again", timestamp: 0 },
		};
		const entries = [reply("a", "opus"), reply("b", "opus"), prompt, reply("c", "opus")];
		expect([...answeredByOtherModel(entries, "sonnet").keys()]).toEqual(["b", "c"]);
	});

	it("flags nothing until the session's model is known", () => {
		expect(answeredByOtherModel([reply("a", "opus")], undefined).size).toBe(0);
	});
});
