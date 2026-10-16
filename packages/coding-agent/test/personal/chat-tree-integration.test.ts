/**
 * Contract: a Personal session in `chat-tree` mode answers every owner message with a fresh model call made of
 * [tools][system prompt][view][state][message] and nothing else; `zoom` opens the view's lines and gives a message
 * whole; the compaction calls carry the turns' system prompt and tools; a restarted session continues the same chat;
 * and without the mode nothing of it exists. The models are scripted; every run uses a temporary home.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatLog } from "@oh-my-pi/pi-coding-agent/personal/chat-tree/log";
import { CHAT_TREE_SYSTEM_PROMPT } from "@oh-my-pi/pi-coding-agent/personal/chat-tree/prompt";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { DateTool, ZoomTool } from "@oh-my-pi/pi-coding-agent/tools/chat-tree-tools";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const CHAT_SETTINGS = {
	"personal.enabled": true,
	"personal.runKind": "live",
	"personal.memoryMode": "chat-tree",
	"todo.enabled": false,
	"todo.reminders": false,
};

const LONG_MESSAGE = "The quick brown fox jumps over the lazy dog. ".repeat(40);

type Reply = (context: Context) => AssistantMessage["content"];

function assistant(content: AssistantMessage["content"], model: Model): AssistantMessage {
	const toolUse = content.some(block => block.type === "toolCall");
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolUse ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	});
	return stream;
}

/** The request as the wire would carry it: tools hold functions, so a deep copy goes through JSON. */
function snapshot(context: Context): Context {
	return JSON.parse(JSON.stringify(context)) as Context;
}

function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap(block => (block.type === "text" ? [block.text as string] : []));
}

describe("AgentSession in the chat-tree memory mode", () => {
	let tempDir: TempDir;
	let homeDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let previousAgentDir: string;
	let previousHome: string | undefined;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-chat-tree-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-chat-tree-session-");
		homeDir = TempDir.createSync("@pi-chat-tree-home-");
		previousHome = process.env.HOME;
		process.env.HOME = homeDir.path();
		vi.spyOn(os, "homedir").mockReturnValue(homeDir.path());
		previousAgentDir = getAgentDir();
		setAgentDir(path.join(homeDir.path(), "agent"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		setAgentDir(previousAgentDir);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		vi.restoreAllMocks();
		tempDir.removeSync();
		homeDir.removeSync();
	});

	/**
	 * A session whose turns answer from `replies`, in order, and whose compactions answer `summary N`: at once and
	 * for `sideCostUsd` each, or from the stream `sideStream` makes for the compaction request number `n`.
	 */
	function createHarness(
		settings: Record<string, unknown>,
		replies: Reply[],
		side: { sideCostUsd?: number; sideStream?: (model: Model, n: number) => AssistantMessageEventStream } = {},
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const turnRequests: Context[] = [];
		const sideRequests: Context[] = [];
		const holder: { session?: AgentSession } = {};
		const toolSession = {
			settings: Settings.isolated(settings),
			taskDepth: 0,
			getChatTree: () => holder.session?.chatTree,
		} as unknown as ToolSession;
		// The tools' parameter types are narrower than the agent's general tool type; the agent only calls `execute`.
		const tools = [new ZoomTool(toolSession), new DateTool(toolSession)] as unknown as AgentTool[];
		let turnCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: [CHAT_TREE_SYSTEM_PROMPT], tools, messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				turnRequests.push(snapshot(context));
				const reply = replies[turnCalls++];
				if (!reply) throw new Error(`No scripted reply for model call ${turnCalls}`);
				return streamOf(assistant(reply(context), model));
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ ...settings }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			sideStreamFn: (sideModel, context) => {
				sideRequests.push(snapshot(context));
				if (side.sideStream) return side.sideStream(sideModel, sideRequests.length);
				const message = assistant([{ type: "text", text: `summary ${sideRequests.length}` }], sideModel);
				message.usage.cost.total = side.sideCostUsd ?? 0;
				return streamOf(message);
			},
		});
		holder.session = session;
		cleanups.push(() => session.dispose());
		return {
			session,
			turnRequests,
			sideRequests,
			chatDir: path.join(session.settings.getAgentDir(), "personal-chat"),
		};
	}

	const say =
		(text: string): Reply =>
		() => [{ type: "text", text }];
	const zoomCall =
		(id: string, args: Record<string, unknown>): Reply =>
		() => [{ type: "toolCall", id, name: "zoom", arguments: args }];

	it("answers each owner message with a fresh call of tools, system prompt, view, state and message", async () => {
		const { session, turnRequests, sideRequests, chatDir } = createHarness(CHAT_SETTINGS, [
			say("Hello, I am Personal."),
			say("Noted."),
			zoomCall("z1", { id: 0, n: 2 }),
			zoomCall("z2", { id: 2, n: 1 }),
			say("You said hello one."),
		]);
		await session.prompt("hello one");
		await session.prompt(LONG_MESSAGE);
		await session.prompt("what was the first thing I said?");

		expect(turnRequests).toHaveLength(5);
		const toolNames = turnRequests[0]?.tools?.map(tool => tool.name);
		expect(toolNames).toEqual(["zoom", "date"]);
		for (const request of [...turnRequests, ...sideRequests]) {
			expect(request.systemPrompt).toEqual([CHAT_TREE_SYSTEM_PROMPT]);
			expect(request.tools?.map(tool => tool.name)).toEqual(toolNames);
		}

		// Turn 1: an empty view, the state, the message; nothing else.
		const first = turnRequests[0]?.messages;
		expect(first).toHaveLength(1);
		expect(first?.[0]?.role).toBe("user");
		const firstBlocks = textBlocks(first?.[0]?.content);
		expect(firstBlocks[0]).toBe("<chat>\n</chat>");
		expect(firstBlocks[1]).toStartWith("<state>");
		expect(firstBlocks.at(-1)).toBe("hello one");
		expect(firstBlocks).toHaveLength(3);

		// Turn 2: still one message; the first exchange is in the view, not in the messages.
		expect(turnRequests[1]?.messages).toHaveLength(1);
		const secondBlocks = textBlocks(turnRequests[1]?.messages[0]?.content);
		expect(secondBlocks[0]).toContain("0+1|user: hello one\n1+1|unii: Hello, I am Personal.\n");
		expect(secondBlocks.at(-1)).toBe(LONG_MESSAGE);
		expect(JSON.stringify(turnRequests[1]?.messages)).not.toContain("Hello, I am Personal.</");

		// Turn 3: the view holds the long message as a line the model wrote, never the message itself.
		const thirdContent = turnRequests[2]?.messages[0]?.content;
		const thirdBlocks = textBlocks(thirdContent);
		expect(thirdBlocks[0]).toContain("2+1|summary ");
		expect(thirdBlocks.join("")).not.toContain(LONG_MESSAGE);
		expect(thirdBlocks.at(-1)).toBe("what was the first thing I said?");
		// The four lines make one whole block: it carries the cache mark.
		const marked = Array.isArray(thirdContent)
			? thirdContent.flatMap(block => (block.type === "text" && block.cacheBoundary === true ? [block] : []))
			: [];
		expect(marked).toHaveLength(1);
		expect(marked[0]?.text).toStartWith("<chat>\n0+1|");

		// Within the turn the calls go on from the same first message.
		expect(turnRequests[3]?.messages).toHaveLength(3);
		expect(turnRequests[3]?.messages[0]).toEqual(turnRequests[2]?.messages[0]);
		expect(turnRequests[4]?.messages).toHaveLength(5);
		expect(turnRequests[4]?.messages[0]).toEqual(turnRequests[2]?.messages[0]);

		// zoom: the two lines under `0+2`, and the whole message at n = 1.
		const results = session.agent.state.messages.flatMap(message =>
			message.role === "toolResult" ? [textBlocks(message.content).join("")] : [],
		);
		expect(results[0]).toBe("0+1|user: hello one\n1+1|unii: Hello, I am Personal.");
		expect(results[1]).toBe(`message 2, user, ${Buffer.byteLength(LONG_MESSAGE)} bytes\n${LONG_MESSAGE}`);

		// The compaction of the long message ran on the side, with the task and the ruler, and called no tool.
		expect(sideRequests.length).toBeGreaterThan(0);
		const side = sideRequests[0];
		expect(side?.messages).toHaveLength(1);
		const sideBlocks = textBlocks(side?.messages[0]?.content);
		expect(sideBlocks.at(-1)).toContain("Compaction: compress message 2");
		expect(sideBlocks.at(-1)).toContain("-".repeat(512));

		const chat = await session.chatTree?.ready;
		await chat?.tree.idle();
		await session.dispose();
		const lines = (await Bun.file(path.join(chatDir, "status.json")).json()) as Record<string, number | string>;
		expect(lines.messages).toBe(10);
		expect(lines.compactionsFailed).toBe(0);
	});

	it("logs what the model does as unii, tool and echo, and the owner's messages as user", async () => {
		const { session, chatDir } = createHarness(CHAT_SETTINGS, [zoomCall("z1", { id: 0, n: 1 }), say("ok")]);
		await session.prompt("ping");
		await (await session.chatTree?.ready)?.tree.idle();
		await session.dispose();
		const rows = (await fs.readdir(path.join(chatDir, "main"))).sort();
		expect(rows).toHaveLength(1);
		const parsed = (await Bun.file(path.join(chatDir, "main", rows[0] as string)).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { i: number; kind: string; text: string });
		expect(parsed.map(row => row.kind)).toEqual(["user", "tool", "echo", "unii"]);
		expect(parsed[1]?.text).toBe('zoom {"id":0,"n":1}');
		expect(parsed[2]?.text).toBe("message 0, user, 4 bytes\nping");
	});

	it("continues the same chat in a restarted session", async () => {
		const first = createHarness(CHAT_SETTINGS, [say("one")]);
		await first.session.prompt("first message");
		await (await first.session.chatTree?.ready)?.tree.idle();
		await first.session.dispose();

		const second = createHarness(CHAT_SETTINGS, [say("two")]);
		await second.session.prompt("second message");
		const request = second.turnRequests[0];
		expect(request?.messages).toHaveLength(1);
		const blocks = textBlocks(request?.messages[0]?.content);
		expect(blocks.join("")).toContain("0+1|user: first message");
		expect(blocks.join("")).toContain("1+1|unii: one");
		expect(blocks.at(-1)).toBe("second message");
		await second.session.dispose();

		const log = await ChatLog.open(second.chatDir);
		try {
			expect(log.messageCount).toBe(4);
			expect((await log.readMessage(2))?.text).toBe("second message");
		} finally {
			await log.close();
		}
	});

	it("takes a note as one note message without starting a turn", async () => {
		const { session, turnRequests, chatDir } = createHarness(CHAT_SETTINGS, []);
		await session.chatTree?.logNote("Handoff: the owner likes tea.");
		expect(turnRequests).toHaveLength(0);
		await session.dispose();
		const files = await fs.readdir(path.join(chatDir, "main"));
		const row = JSON.parse((await Bun.file(path.join(chatDir, "main", files[0] as string)).text()).trim());
		expect(row).toMatchObject({ i: 0, kind: "note", text: "Handoff: the owner likes tea." });
	});

	it("keeps recall mode as it was: no chat, the history goes to the provider", async () => {
		const { session, turnRequests, chatDir } = createHarness({ ...CHAT_SETTINGS, "personal.memoryMode": "recall" }, [
			say("one"),
			say("two"),
		]);
		expect(session.chatTree).toBeUndefined();
		await session.prompt("first");
		await session.prompt("second");
		expect(turnRequests[1]?.messages.length).toBe(3);
		expect(await Bun.file(path.join(chatDir, "status.json")).exists()).toBe(false);
		await expect(fs.stat(chatDir)).rejects.toThrow();
	});

	it("counts the cost of the compactions as usage of the session, against its spend", async () => {
		const { session, sideRequests } = createHarness(CHAT_SETTINGS, [say("Noted.")], { sideCostUsd: 0.125 });
		await session.prompt(LONG_MESSAGE);
		await (await session.chatTree?.ready)?.tree.idle();
		expect(sideRequests.length).toBeGreaterThan(0);
		const usage = session.sessionManager.getEntries().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(sideRequests.length);
		for (const entry of usage)
			expect(entry).toMatchObject({ purpose: "chat-tree-compaction", provider: "anthropic" });
		// The turn itself cost nothing here: every cent of the session's spend is a compaction's.
		expect(session.sessionManager.getUsageStatistics().cost).toBeCloseTo(0.125 * sideRequests.length);
		// The session spend cap reads the same journal.
		session.setSpendCap({ maxCostUsd: 100 });
		expect(session.getSpendCap().costUsd).toBeCloseTo(0.125 * sideRequests.length);
	});

	it("lets a second compaction on the same prefix go only when the first one's response has content, not at its start", async () => {
		const responses: { stream: AssistantMessageEventStream; message: AssistantMessage }[] = [];
		const { session, sideRequests } = createHarness(CHAT_SETTINGS, [], {
			sideStream: (sideModel, n) => {
				const message = assistant([{ type: "text", text: `summary ${n}` }], sideModel);
				if (n > 2) return streamOf(message);
				const stream = new AssistantMessageEventStream();
				// As the Anthropic provider does: `start` before the request has even been sent.
				stream.push({ type: "start", partial: message });
				responses.push({ stream, message });
				return stream;
			},
		});
		// Turns of the event loop, not a stretch of time: the file reads that start a compaction finish within a few.
		const turnsUntil = async (condition: () => boolean, turns: number) => {
			for (let turn = 0; turn < turns && !condition(); turn++)
				await new Promise<void>(resolve => setImmediate(resolve));
		};
		const chat = await session.chatTree?.ready;
		await chat?.logMessage("user", LONG_MESSAGE);
		await chat?.logMessage("user", LONG_MESSAGE);
		await turnsUntil(() => sideRequests.length > 0, 5000);
		expect(sideRequests).toHaveLength(1);
		// Room for the second compaction to start were the provider's `start` enough to release the gate.
		await turnsUntil(() => sideRequests.length > 1, 500);
		expect(sideRequests).toHaveLength(1);
		const first = responses[0];
		first?.stream.push({ type: "text_start", contentIndex: 0, partial: first.message });
		await turnsUntil(() => sideRequests.length > 1, 5000);
		expect(sideRequests).toHaveLength(2);
		for (const response of responses) {
			response.stream.push({ type: "done", reason: "stop", message: response.message });
		}
		await chat?.tree.idle();
	});
});
