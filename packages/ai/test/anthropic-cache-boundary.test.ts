/**
 * Unit test: a text block that asks for a cache mark (`TextContent.cacheBoundary`) gets an Anthropic
 * `cache_control` breakpoint right after it, counted in the request's four. With the tools and the system prompt
 * marked, one block mark and the request end make the four breakpoints of the chat-tree layout; other blocks and
 * messages carry none. No network: a capturing `fetch` records the wire body and answers 400.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

const TOOLS: Context["tools"] = [
	{ name: "zoom", description: "Zoom", parameters: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "date", description: "Date", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

async function wireBody(context: Context): Promise<MessageCreateParams> {
	let body: MessageCreateParams | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body ?? "{}")) as MessageCreateParams;
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;
	await streamAnthropic(MODEL, context, { apiKey: "sk-ant-api-test", fetch: fetchMock })
		.result()
		.catch(() => undefined);
	if (!body) throw new Error("wire body was not captured");
	return body;
}

function markedBlocks(body: MessageCreateParams): string[] {
	const marked: string[] = [];
	for (const message of body.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "text" && (block as { cache_control?: unknown }).cache_control != null)
				marked.push(block.text);
		}
	}
	return marked;
}

describe("anthropic cache boundary blocks", () => {
	it("marks the flagged block and the request end, with the tools and system prompt: four breakpoints", async () => {
		const body = await wireBody({
			systemPrompt: ["You are Personal."],
			tools: TOOLS,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "<chat>\n0+1|a\n1+1|b\n2+1|c\n3+1|d\n" },
						{ type: "text", text: "4+1|e\n</chat>" },
						{ type: "text", text: "<state>now</state>" },
						{ type: "text", text: "the message" },
					].map((block, index) => (index === 0 ? { ...block, cacheBoundary: true } : block)) as never,
					timestamp: 1,
				},
			],
		});
		expect(markedBlocks(body)).toEqual(["<chat>\n0+1|a\n1+1|b\n2+1|c\n3+1|d\n", "the message"]);
		const system = body.system;
		if (!Array.isArray(system)) throw new Error("expected system blocks");
		expect(system.filter(block => typeof block !== "string" && block.cache_control != null)).toHaveLength(1);
		const tools = (body.tools ?? []) as { cache_control?: unknown }[];
		expect(tools.filter(tool => tool.cache_control != null)).toHaveLength(1);
		const total = markedBlocks(body).length + 1 + 1;
		expect(total).toBe(4);
	});

	it("never sends the marker itself, and marks nothing when no block asks", async () => {
		const flagged = await wireBody({
			systemPrompt: ["s"],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a", cacheBoundary: true },
						{ type: "text", text: "b" },
					],
					timestamp: 1,
				},
			],
		});
		expect(JSON.stringify(flagged)).not.toContain("cacheBoundary");
		const plain = await wireBody({
			systemPrompt: ["s"],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
					timestamp: 1,
				},
			],
		});
		expect(markedBlocks(plain)).toEqual(["b"]);
	});

	it("holds to four breakpoints when more blocks ask than there is room for", async () => {
		const blocks = Array.from({ length: 6 }, (_, index) => ({
			type: "text" as const,
			text: `block ${index}`,
			cacheBoundary: true,
		}));
		const body = await wireBody({
			systemPrompt: ["s"],
			tools: TOOLS,
			messages: [{ role: "user", content: blocks, timestamp: 1 }],
		});
		const head = 2;
		expect(markedBlocks(body).length + head).toBeLessThanOrEqual(4);
	});
});
