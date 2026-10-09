import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { buildChatItems, type ChatItem } from "../src/components/transcript/chat-items";

const AT = "2026-07-09T00:00:00Z";

function assistant(id: string, content: AssistantMessage["content"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: AT,
		message: {
			role: "assistant",
			content,
			model: "test/model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });
const result = (id: string): SessionEntry => ({
	type: "message",
	id: `r-${id}`,
	parentId: null,
	timestamp: AT,
	message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false, timestamp: 1 },
});
const prompt = (id: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: AT,
	message: { role: "user", content: "go", timestamp: 1 },
});

function shape(items: ChatItem[]): string[] {
	return items.map(item => {
		if (item.kind === "tools") return `tools(${item.calls.map(c => c.id).join(",")})${item.lead ? "*" : ""}`;
		if (item.kind === "text") return `text${item.lead ? "*" : ""}`;
		return item.kind === "entry" ? item.entry.id : item.kind;
	});
}

describe("buildChatItems", () => {
	it("folds tool calls across messages until reply text, and drops thinking and markers", () => {
		const entries: SessionEntry[] = [
			prompt("p1"),
			assistant("a1", [{ type: "thinking", thinking: "hmm" }, call("c1"), call("c2")]),
			result("c1"),
			result("c2"),
			{ type: "model_change", id: "m", parentId: null, timestamp: AT, model: "x" },
			assistant("a2", [call("c3")]),
			result("c3"),
			assistant("a3", [{ type: "text", text: "done" }, call("c4")]),
			prompt("p2"),
			assistant("a4", [{ type: "text", text: "hi" }]),
		];
		// `*`: the first agent item after a prompt, which carries the gutter label.
		expect(shape(buildChatItems(entries, null, true, []))).toEqual([
			"p1",
			"tools(c1,c2,c3)*",
			"text",
			"tools(c4)",
			"p2",
			"text*",
		]);
	});

	it("extends the open run with the streaming message and live tools", () => {
		const entries = [prompt("p1"), assistant("a1", [call("c1")]), result("c1")];
		const streaming = assistant("s", [call("c2")]);
		const stream = streaming.type === "message" ? (streaming.message as AssistantMessage) : null;
		const items = buildChatItems(entries, stream, false, [
			{ toolCallId: "c3", toolName: "bash", args: {}, startedAt: 1 },
		]);
		expect(shape(items)).toEqual(["p1", "tools(c1,c2,c3)*"]);
		const run = items[1];
		expect(run?.kind === "tools" && run.calls.map(c => c.pending)).toEqual([false, true, true]);
	});
});
