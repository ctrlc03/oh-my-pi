/**
 * Contract: a compaction call becomes one provider request whose first user message is the view (its blocks, the
 * last whole block marked for the cache, then the tail of the view) followed by the task; the model's replies and the
 * "Too long" follow-ups come after it, alternating assistant and user. The transport hands that request to the host
 * and returns the text the host answers, passing the abort signal and the response-start hook along.
 */
import { describe, expect, it } from "bun:test";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import type { CompactionCall } from "../../../src/personal/chat-tree/compactor";
import {
	compactionMessages,
	createCompactionTransport,
	type SideRequestHost,
} from "../../../src/personal/chat-tree/transport";

/** A model with only the fields the transport reads. */
function modelOf(id = "claude-haiku-4-5"): Model {
	return { id, provider: "anthropic", api: "anthropic-messages" } as unknown as Model;
}

function callOf(overrides: Partial<CompactionCall> = {}): CompactionCall {
	return {
		view: {
			blocks: ["<chat>\n0+1|user: a\n1+1|unii: b\n2+1|user: c\n3+1|tool: d\n", "4+1|echo: e\n"],
			tail: "5+1|user: f\n</chat>",
		},
		prefixKey: "pk",
		turns: ["Compaction: compress message 6 ..."],
		replies: [],
		...overrides,
	};
}

/** The content of a message that has content blocks. */
function blocksOf(message: Message | undefined) {
	if (!message || typeof message.content === "string") throw new Error("message has no content blocks");
	return message.content as { type: string; text?: string; cacheBoundary?: boolean }[];
}

describe("compactionMessages", () => {
	it("makes one user message of the view blocks, the tail and the task", () => {
		const call = callOf();
		const messages = compactionMessages(call, modelOf());
		expect(messages.length).toBe(1);
		const [first] = messages;
		expect(first?.role).toBe("user");
		expect(blocksOf(first).map(block => block.text)).toEqual([...call.view.blocks, call.view.tail, call.turns[0]]);
		expect(blocksOf(first).every(block => block.type === "text")).toBe(true);
	});

	it("marks the last whole block, and only that one, as the cache boundary", () => {
		const content = blocksOf(compactionMessages(callOf(), modelOf())[0]);
		expect(content.map(block => block.cacheBoundary === true)).toEqual([false, true, false, false]);
	});

	it("marks nothing when the view has no whole block yet", () => {
		const call = callOf({ view: { blocks: [], tail: "<chat>\n0+1|user: a\n</chat>" } });
		const content = blocksOf(compactionMessages(call, modelOf())[0]);
		expect(content.map(block => block.text)).toEqual(["<chat>\n0+1|user: a\n</chat>", call.turns[0]]);
		expect(content.some(block => block.cacheBoundary)).toBe(false);
	});

	it("does not touch the strings of the call", () => {
		const call = callOf();
		const before = JSON.stringify(call);
		compactionMessages(call, modelOf());
		compactionMessages(call, modelOf());
		expect(JSON.stringify(call)).toBe(before);
	});

	it("alternates the replies as assistant messages and the follow-ups as user messages", () => {
		const call = callOf({
			turns: ["the task", "Too long 1", "Too long 2"],
			replies: ["first reply", "second reply"],
		});
		const model = modelOf("claude-haiku-4-5-x");
		const messages = compactionMessages(call, model);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		const assistants = messages.filter(message => message.role === "assistant");
		expect(assistants.map(message => blocksOf(message))).toEqual([
			[{ type: "text", text: "first reply" }],
			[{ type: "text", text: "second reply" }],
		]);
		for (const message of assistants) {
			if (message.role !== "assistant") continue;
			expect(message.model).toBe("claude-haiku-4-5-x");
			expect(message.provider).toBe("anthropic");
			expect(message.api).toBe("anthropic-messages");
			expect(message.stopReason).toBe("stop");
		}
		expect(blocksOf(messages[2])).toEqual([{ type: "text", text: "Too long 1" }]);
		expect(blocksOf(messages[4])).toEqual([{ type: "text", text: "Too long 2" }]);
		// The view and the task stay in the first message only.
		expect(blocksOf(messages[0]).map(block => block.text)).toContain("the task");
		expect(blocksOf(messages[0]).map(block => block.text)).not.toContain("Too long 1");
	});

	it("marks every message as the agent's own (no user attribution)", () => {
		const call = callOf({ turns: ["task", "Too long"], replies: ["reply"] });
		const messages = compactionMessages(call, modelOf());
		for (const message of messages) {
			if (message.role === "user") expect(message.attribution).toBe("agent");
		}
	});
});

describe("createCompactionTransport", () => {
	it("builds the context from the messages, sends it and returns the host's text", async () => {
		const sent: { context: Context; signal: AbortSignal | undefined }[] = [];
		let started = 0;
		const model = modelOf();
		const built: Message[][] = [];
		const host: SideRequestHost = {
			buildContext: async messages => {
				built.push(messages);
				return { systemPrompt: "SYSTEM", messages, tools: [] } as unknown as Context;
			},
			send: async (context, signal, onStart) => {
				onStart();
				sent.push({ context, signal });
				return "the line";
			},
			model: () => model,
		};
		const controller = new AbortController();
		const transport = createCompactionTransport(host);
		const call = callOf();
		const out = await transport(call, {
			signal: controller.signal,
			onResponseStart: () => {
				started++;
			},
		});
		expect(out).toBe("the line");
		expect(started).toBe(1);
		expect(built.length).toBe(1);
		expect(built[0]?.length).toBe(1);
		expect(sent[0]?.context.messages).toBe(built[0]);
		expect(sent[0]?.signal).toBe(controller.signal);
	});

	it("replays the replies it is given", async () => {
		let messages: Message[] = [];
		const host: SideRequestHost = {
			buildContext: async built => {
				messages = built;
				return { messages: built } as unknown as Context;
			},
			send: async () => "x",
			model: () => modelOf(),
		};
		await createCompactionTransport(host)(callOf({ turns: ["t", "again"], replies: ["r"] }), {
			onResponseStart: () => {},
		});
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	});
});
