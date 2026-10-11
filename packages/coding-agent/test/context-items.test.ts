import { describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	type ContextItem,
	rankContextItems,
	selectContextItems,
} from "@oh-my-pi/pi-coding-agent/session/context-items";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseContextArgs } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/context-report";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let nextId = 0;
function entry(message: AgentMessage): SessionEntry {
	const id = `e${++nextId}`;
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message };
}

function toolTurn(
	name: string,
	args: Record<string, unknown>,
	output: string,
	images: ImageContent[] = [],
): SessionEntry[] {
	const toolCallId = `call_${++nextId}`;
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: 1,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: name,
		content: [{ type: "text", text: output }, ...images],
		isError: false,
		timestamp: 2,
	};
	return [entry(assistant), entry(result)];
}

const tokenizer = new Tokenizer();
const baseInput = { tokenizer, systemPrompt: [], tools: [], cwd: "/repo" };

function rank(
	entries: SessionEntry[],
	prunable: "all" | "none" = "all",
	extra: Partial<typeof baseInput> & { totalTokens?: number } = {},
) {
	const ids = new Set<string>();
	if (prunable === "all") {
		for (const e of entries) if (e.type === "message" && e.message.role === "toolResult") ids.add(e.id);
	}
	return rankContextItems({ ...baseInput, ...extra, entries, prunableToolResultIds: ids });
}

describe("rankContextItems", () => {
	it("ranks individual tool results largest first and labels them with the main argument", () => {
		const entries = [
			...toolTurn("bash", { command: "ls" }, "a ".repeat(50)),
			...toolTurn("bash", { command: "bun test" }, "b ".repeat(4_000)),
			...toolTurn("grep", { pattern: "TODO" }, "c ".repeat(500)),
		];
		const items = rank(entries);
		expect(items.map(item => item.label)).toEqual(["bash bun test", "grep TODO", "bash ls"]);
		expect(items[0]!.tokens).toBeGreaterThan(items[1]!.tokens);
		expect(items.every(item => item.kind === "toolResult" && item.targets.length === 1)).toBe(true);
	});

	it("shares are fractions of the supplied total", () => {
		const items = rank(toolTurn("bash", { command: "x" }, "w ".repeat(1_000)), "all", { totalTokens: 10_000 });
		expect(items[0]!.share).toBeCloseTo(items[0]!.tokens / 10_000, 6);
	});

	it("aggregates every read of one file, whatever selector or path spelling it used", () => {
		const entries = [
			...toolTurn("read", { path: "src/x.ts" }, "line ".repeat(800)),
			...toolTurn("read", { path: "src/x.ts:100-200" }, "line ".repeat(300)),
			...toolTurn("read", { path: "/repo/src/x.ts:raw" }, "line ".repeat(100)),
			...toolTurn("read", { path: "src/y.ts" }, "line ".repeat(50)),
		];
		const items = rank(entries);
		const files = items.filter(item => item.kind === "file");
		expect(files).toHaveLength(2);
		const x = files.find(item => item.label.startsWith("src/x.ts"))!;
		expect(x.count).toBe(3);
		expect(x.label).toBe("src/x.ts (3 reads)");
		expect(x.targets).toHaveLength(3);
		expect(x.tokens).toBeGreaterThan(files.find(item => item.label.includes("y.ts"))!.tokens);
		// A single read keeps the plain tool-call label.
		expect(files.find(item => item.label.includes("y.ts"))!.label).toBe("read src/y.ts");
	});

	it("counts @file mentions toward the same per-file row", () => {
		const entries = [
			...toolTurn("read", { path: "src/x.ts" }, "line ".repeat(400)),
			entry({
				role: "fileMention",
				files: [{ path: "src/x.ts", content: "line ".repeat(400) }],
				timestamp: 3,
			} as AgentMessage),
		];
		const [file] = rank(entries);
		expect(file!.kind).toBe("file");
		expect(file!.count).toBe(2);
		expect(file!.targets.map(target => target.kind).sort()).toEqual(["fileMention", "toolResult"]);
	});

	it("leaves results the elision cannot touch listed but not prunable", () => {
		const items = rank(toolTurn("bash", { command: "x" }, "w ".repeat(1_000)), "none");
		expect(items).toHaveLength(1);
		expect(items[0]!.targets).toEqual([]);
	});

	it("groups images per carrying entry as attachments without double counting the result text", () => {
		const image: ImageContent = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };
		const entries = [
			...toolTurn("read", { path: "shot.png" }, "ok", [image]),
			entry({ role: "user", content: [{ type: "text", text: "see" }, image, image], timestamp: 5 }),
		];
		const items = rank(entries);
		const attachments = items.filter(item => item.kind === "attachment");
		expect(attachments).toHaveLength(2);
		expect(attachments.map(item => item.count).sort()).toEqual([1, 2]);
		expect(attachments.every(item => item.targets[0]?.kind === "images")).toBe(true);
		expect(attachments.every(item => item.tokens > 0)).toBe(true);
	});

	it("lists system prompt parts and tool schemas as fixed rows", () => {
		const items = rankContextItems({
			...baseInput,
			entries: [],
			prunableToolResultIds: new Set(),
			systemPrompt: ["You are a helpful agent. ".repeat(200), "Project context: ".repeat(40)],
			tools: [
				{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } as never },
			],
		});
		expect(items.map(item => item.kind).sort()).toEqual(["systemPrompt", "systemPrompt", "toolSchema"]);
		expect(items.every(item => item.targets.length === 0)).toBe(true);
		expect(items.find(item => item.id === "sys:0")!.label).toBe("System prompt");
		expect(items.find(item => item.id === "tool:bash")!.label).toBe("tool schema: bash");
	});
});

describe("selectContextItems", () => {
	const items = rank([
		...toolTurn("bash", { command: "big" }, "a ".repeat(2_000)),
		...toolTurn("bash", { command: "small" }, "a ".repeat(10)),
	]);

	it("resolves 1-based ranks and ids, de-duplicating", () => {
		const { selected, missing } = selectContextItems(items, ["1", items[0]!.id, items[1]!.id]);
		expect(selected.map((item: ContextItem) => item.label)).toEqual(["bash big", "bash small"]);
		expect(missing).toEqual([]);
	});

	it("reports selectors that match nothing, including rank 0", () => {
		const { selected, missing } = selectContextItems(items, ["0", "9", "tr:nope"]);
		expect(selected).toEqual([]);
		expect(missing).toEqual(["0", "9", "tr:nope"]);
	});
});

describe("parseContextArgs", () => {
	it("parses show, interactive prune, and rank lists", () => {
		expect(parseContextArgs("")).toEqual({ action: "show" });
		expect(parseContextArgs("prune")).toEqual({ action: "prune", selectors: [] });
		expect(parseContextArgs("prune 1, 3 5")).toEqual({ action: "prune", selectors: ["1", "3", "5"] });
		expect(parseContextArgs("prune tr:abc")).toEqual({ action: "prune", selectors: ["tr:abc"] });
	});

	it("rejects anything else", () => {
		expect("error" in parseContextArgs("prune banana")).toBe(true);
		expect("error" in parseContextArgs("everything")).toBe(true);
	});
});
