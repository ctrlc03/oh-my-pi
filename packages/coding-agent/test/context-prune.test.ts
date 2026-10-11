import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, SessionBusyError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { FileMentionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { pruneContextSelectors } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/context-report";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession context items and pruning", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-prune-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	/** user → assistant(toolCall) → toolResult, with the result as the newest message when `recent`. */
	function seedToolTurn(
		name: string,
		args: Record<string, unknown>,
		output: string,
		extra: ImageContent[] = [],
	): string {
		const toolCallId = `call_${name}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "go" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: name,
			content: [{ type: "text", text: output }, ...extra],
			isError: false,
			timestamp: Date.now() - 1,
		});
		return toolCallId;
	}

	function syncAgent(): void {
		session.agent.replaceMessages(
			sessionManager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message as AgentMessage),
		);
	}

	/** The provider-validity invariant: every tool call is answered by exactly one result, after it. */
	function expectPairedTranscript(): void {
		const calls = new Map<string, number>();
		const results = new Map<string, number>();
		for (const [index, message] of session.messages.entries()) {
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, index);
			} else if (message.role === "toolResult") {
				expect(calls.get(message.toolCallId)).toBeLessThan(index);
				results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
			}
		}
		expect([...calls.keys()].sort()).toEqual([...results.keys()].sort());
		for (const count of results.values()) expect(count).toBe(1);
	}

	it("prunes one tool result, keeps the call/result pair, persists it, and lowers reported usage", async () => {
		const bigId = seedToolTurn("bash", { command: "bun test" }, "failure ".repeat(3_000));
		seedToolTurn("bash", { command: "ls" }, "file ".repeat(20));
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			...apiInfo,
			stopReason: "stop",
			usage: { ...usage, input: 20_000, totalTokens: 20_008 },
			timestamp: Date.now(),
		});
		syncAgent();
		expect(session.getContextUsage()?.tokens).toBe(20_000);

		const items = session.getContextItems();
		const target = items[0]!;
		expect(target.label).toBe("bash bun test");
		expect(target.targets).toHaveLength(1);

		const result = await session.pruneContextItems([target]);

		expect(result.entriesRewritten).toBe(1);
		expect(result.tokensFreed).toBeGreaterThan(0);
		expect(result.artifactId).toBeDefined();
		expect(session.getContextUsage()?.tokens).toBe(20_000 - result.tokensFreed);
		expectPairedTranscript();

		const pruned = session.messages.find(message => message.role === "toolResult" && message.toolCallId === bigId);
		if (pruned?.role !== "toolResult") throw new Error("Expected the pruned tool result to stay in context");
		expect(pruned.prunedAt).toBeGreaterThan(0);
		expect(pruned.content.map(block => (block.type === "text" ? block.text : "")).join("")).toContain(
			`artifact://${result.artifactId}`,
		);

		// The ranking now sees the placeholder, and it is not offered for pruning again.
		const after = session.getContextItems().find(item => item.id === target.id);
		expect(after?.tokens ?? 0).toBeLessThan(target.tokens);
		expect(after?.targets ?? []).toEqual([]);

		// The rewrite is in the session file, like any other elision.
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const persisted = reopened
				.getBranch()
				.find(
					entry =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === bigId,
				);
			expect(
				persisted?.type === "message" && persisted.message.role === "toolResult"
					? persisted.message.prunedAt
					: undefined,
			).toBeGreaterThan(0);
		} finally {
			await reopened.close();
		}
	});

	it("prunes every read of a file in one go, and the recent tail is not exempt", async () => {
		seedToolTurn("read", { path: "src/a.ts" }, "alpha ".repeat(2_000));
		seedToolTurn("read", { path: "src/a.ts:1-50" }, "alpha ".repeat(1_000));
		syncAgent();
		const file = session.getContextItems().find(item => item.kind === "file");
		expect(file?.count).toBe(2);

		const outcome = await pruneContextSelectors(session, [file!.id]);

		expect(outcome.ok).toBe(true);
		expect(session.getContextItems().find(item => item.id === file!.id)?.targets ?? []).toEqual([]);
		expectPairedTranscript();
		const results = session.messages.filter(message => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every(message => message.prunedAt !== undefined)).toBe(true);
	});

	it("elides @file mention contents and strips images without dropping the messages", async () => {
		const image: ImageContent = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };
		const mentionMessage: FileMentionMessage = {
			role: "fileMention",
			files: [{ path: "notes.md", content: "note ".repeat(3_000) }],
			timestamp: Date.now() - 2,
		};
		sessionManager.appendMessage(mentionMessage);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "look" }, image],
			timestamp: Date.now() - 1,
		});
		syncAgent();
		const items = session.getContextItems();
		const mention = items.find(item => item.kind === "file")!;
		const attachment = items.find(item => item.kind === "attachment")!;

		const result = await session.pruneContextItems([mention, attachment]);

		expect(result.entriesRewritten).toBe(2);
		const mentionEntry = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "fileMention");
		const files =
			mentionEntry?.type === "message" && mentionEntry.message.role === "fileMention"
				? mentionEntry.message.files
				: [];
		expect(files[0]?.content).toContain(`artifact://${result.artifactId}`);
		const userEntry = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		const content =
			userEntry?.type === "message" && userEntry.message.role === "user" ? userEntry.message.content : [];
		expect(Array.isArray(content) && content.some(block => block.type === "image")).toBe(false);
		expect(session.getContextItems().filter(item => item.targets.length > 0)).toEqual([]);
	});

	it("refuses fixed items and unknown ranks without touching the session", async () => {
		seedToolTurn("bash", { command: "ls" }, "file ".repeat(500));
		syncAgent();
		const before = session.getContextItems();
		const missing = await pruneContextSelectors(session, ["99"]);
		expect(missing.ok).toBe(false);
		const fixed = before.find(item => item.targets.length === 0);
		expect(fixed?.kind).toBe("systemPrompt");
		expect((await pruneContextSelectors(session, [fixed!.id])).ok).toBe(false);
		expect(session.getContextItems()).toEqual(before);
	});

	it("refuses to prune while a turn is streaming, leaving in-flight messages alone", async () => {
		seedToolTurn("bash", { command: "bun test" }, "failure ".repeat(3_000));
		syncAgent();
		const target = session.getContextItems().find(item => item.targets.length > 0)!;
		Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
		const before = session.messages.slice();
		try {
			await expect(session.pruneContextItems([target])).rejects.toBeInstanceOf(SessionBusyError);
			expect((await pruneContextSelectors(session, [target.id])).ok).toBe(false);

			expect(session.messages).toEqual(before);
			expect(session.getContextItems().find(item => item.id === target.id)?.targets).toHaveLength(1);
		} finally {
			Reflect.deleteProperty(session, "isStreaming");
		}
		expect((await session.pruneContextItems([target])).entriesRewritten).toBe(1);
	});
});
