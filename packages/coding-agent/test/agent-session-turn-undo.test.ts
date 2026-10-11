/**
 * Contract: `session.turnUndo` undoes the last turn - conversation and files together - and redoes it
 * back to exactly the tip and file state the undo left. Undos stack, redo is good only until the
 * conversation moves on, and both are refused while a turn runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnUndoError } from "@oh-my-pi/pi-coding-agent/session/turn-undo";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function git(cwd: string, ...args: string[]): void {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	const result = Bun.spawnSync(["git", ...args], { cwd, env });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("AgentSession turn undo", () => {
	let tempDir: TempDir;
	let repo: string;
	let file: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let originalAgentDir: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-turn-undo-");
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(fs.realpathSync(tempDir.path()), "agent"));
		repo = path.join(fs.realpathSync(tempDir.path()), "repo");
		fs.mkdirSync(repo);
		git(repo, "init", "-q");
		file = path.join(repo, "work.txt");
		fs.writeFileSync(file, "v0\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		setAgentDir(originalAgentDir);
		tempDir.removeSync();
	});

	/** A session whose n-th turn writes `edits[n]` to the file, like an agent editing while it works. */
	function createSession(options: { snapshotFiles: boolean; whileStreaming?: () => Promise<void> }) {
		const edits = ["v1\n", "v2\n", "v3\n", "v4\n"];
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		let turn = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = turn++;
				fs.writeFileSync(file, edits[index]);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: `done ${index}` }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				void (async () => {
					await options.whileStreaming?.();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				})();
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"rewind.snapshotFiles": options.snapshotFiles,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory(repo);
		const created = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
		});
		session = created;
		return { created, sessionManager };
	}

	function text(): string {
		return fs.readFileSync(file, "utf8");
	}

	it("unwinds turns one at a time and redoes them to exactly the tip and files they left", async () => {
		const { created, sessionManager } = createSession({ snapshotFiles: true });
		await created.prompt("first");
		await created.prompt("second");
		await created.prompt("third");
		await created.waitForIdle();
		const tipIds = sessionManager.getBranch().map(entry => entry.id);
		const tip = sessionManager.getLeafId();
		const messageCount = created.agent.state.messages.length;
		expect(text()).toBe("v3\n");

		const third = await created.turnUndo.undo();
		expect(third.editorText).toBe("third");
		expect(third.files?.plan).toEqual({ revert: 1, remove: 0, recreate: 0 });
		expect(text()).toBe("v2\n");
		expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(tipIds.slice(0, tipIds.length - 2));

		const second = await created.turnUndo.undo();
		expect(second.editorText).toBe("second");
		expect(text()).toBe("v1\n");
		expect(created.turnUndo.redoDepth).toBe(2);

		const first = await created.turnUndo.undo();
		expect(first.editorText).toBe("first");
		expect(text()).toBe("v0\n");
		expect(sessionManager.getLeafId()).toBeNull();
		expect(created.agent.state.messages).toHaveLength(0);
		await expect(created.turnUndo.undo()).rejects.toThrow("nothing to undo");

		const redoneFirst = await created.turnUndo.redo();
		expect(redoneFirst.staleDraft).toBe("first");
		expect(text()).toBe("v1\n");
		await created.turnUndo.redo();
		expect(text()).toBe("v2\n");
		const last = await created.turnUndo.redo();
		expect(last.redoDepth).toBe(0);
		expect(text()).toBe("v3\n");
		expect(sessionManager.getLeafId()).toBe(tip);
		expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(tipIds);
		expect(created.agent.state.messages).toHaveLength(messageCount);
		await expect(created.turnUndo.redo()).rejects.toThrow("nothing to redo");
	});

	it("drops the redo steps once a new prompt is sent", async () => {
		const { created, sessionManager } = createSession({ snapshotFiles: true });
		await created.prompt("first");
		await created.prompt("second");
		await created.waitForIdle();

		await created.turnUndo.undo();
		expect(created.turnUndo.redoDepth).toBe(1);
		await created.prompt("replacement");
		await created.waitForIdle();
		expect(created.turnUndo.redoDepth).toBe(0);
		const leaf = sessionManager.getLeafId();
		await expect(created.turnUndo.redo()).rejects.toThrow("nothing to redo");
		expect(sessionManager.getLeafId()).toBe(leaf);

		// The new prompt is now the last turn, so a later undo walks back over it and redoes it alone.
		const undone = await created.turnUndo.undo();
		expect(undone.editorText).toBe("replacement");
		expect(created.turnUndo.redoDepth).toBe(1);
		await created.turnUndo.redo();
		expect(sessionManager.getLeafId()).toBe(leaf);
	});

	it("refuses a redo over files changed since the undo and leaves the conversation alone", async () => {
		const { created, sessionManager } = createSession({ snapshotFiles: true });
		await created.prompt("first");
		await created.waitForIdle();
		const tip = sessionManager.getLeafId();

		await created.turnUndo.undo();
		fs.writeFileSync(file, "edited since\n");
		await expect(created.turnUndo.redo()).rejects.toThrow("files changed since the restore");
		expect(text()).toBe("edited since\n");
		expect(sessionManager.getLeafId()).toBeNull();
		expect(created.turnUndo.redoDepth).toBe(1);

		fs.writeFileSync(file, "v0\n");
		await created.turnUndo.redo();
		expect(sessionManager.getLeafId()).toBe(tip);
		expect(text()).toBe("v1\n");
	});

	it("undoes and redoes only the conversation when file snapshots are off", async () => {
		const { created, sessionManager } = createSession({ snapshotFiles: false });
		await created.prompt("first");
		await created.waitForIdle();
		const tip = sessionManager.getLeafId();

		const undone = await created.turnUndo.undo();
		expect(undone.editorText).toBe("first");
		expect(undone.files).toBeUndefined();
		expect(undone.filesUnavailable).toBeUndefined();
		expect(text()).toBe("v1\n");
		expect(sessionManager.getLeafId()).toBeNull();

		await created.turnUndo.redo();
		expect(sessionManager.getLeafId()).toBe(tip);
		expect(text()).toBe("v1\n");
	});

	it("is refused while a turn runs, without moving anything", async () => {
		let refusal: unknown;
		let fileDuring: string | undefined;
		const { created, sessionManager } = createSession({
			snapshotFiles: true,
			whileStreaming: async () => {
				refusal = await session?.turnUndo.undo().catch((error: unknown) => error);
				fileDuring = text();
			},
		});
		await created.prompt("first");
		await created.waitForIdle();

		expect(refusal).toBeInstanceOf(TurnUndoError);
		expect((refusal as TurnUndoError).message).toContain("wait for the current response");
		expect(fileDuring).toBe("v1\n");
		expect(created.turnUndo.redoDepth).toBe(0);
		const roles = sessionManager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message.role] : []));
		expect(roles).toEqual(["user", "assistant"]);
	});
});
