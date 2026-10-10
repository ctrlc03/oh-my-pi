/**
 * Contract: every user prompt - typed, or delivered as a queued follow-up - is bound to a snapshot of
 * the working tree taken before the agent acted on it, so the files can be put back to how they were
 * before that prompt; restoring is refused while a turn runs.
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
import { FileSnapshotError } from "@oh-my-pi/pi-coding-agent/session/file-snapshots";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

describe("AgentSession file snapshots", () => {
	let tempDir: TempDir;
	let repo: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let originalAgentDir: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-file-snapshots-session-");
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(fs.realpathSync(tempDir.path()), "agent"));
		repo = path.join(fs.realpathSync(tempDir.path()), "repo");
		fs.mkdirSync(repo);
		git(repo, "init", "-q");
		fs.writeFileSync(path.join(repo, "work.txt"), "v0\n");
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

	it("restores the files to before each prompt, including a follow-up, and refuses while a turn runs", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const file = path.join(repo, "work.txt");
		const turnEdits = ["v1\n", "v2\n", "v3\n"];
		const duringTurn: { refusal?: unknown; queueFollowUp?: () => Promise<boolean> }[] = [{}, {}, {}];
		let turn = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const index = turn++;
				// The "agent" edits the file while it works on the prompt.
				fs.writeFileSync(file, turnEdits[index]);
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
				const finish = async () => {
					await duringTurn[index].queueFollowUp?.();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				};
				void finish();
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"rewind.snapshotFiles": true,
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
		expect(created.canRestoreFiles).toBe(true);

		// Turn 1 edits the file; turn 2 edits it again and, mid-turn, queues a follow-up that becomes turn 3.
		await created.prompt("first");
		duringTurn[1].queueFollowUp = async () => {
			duringTurn[1].queueFollowUp = undefined;
			try {
				const firstPrompt = sessionManager
					.getBranch()
					.find(entry => entry.type === "message" && entry.message.role === "user");
				await created.restoreFiles(firstPrompt?.id ?? "");
			} catch (error) {
				duringTurn[1].refusal = error;
			}
			return created.prompt("third", { streamingBehavior: "followUp" });
		};
		await created.prompt("second");
		await created.waitForIdle();
		expect(fs.readFileSync(file, "utf8")).toBe("v3\n");
		expect(duringTurn[1].refusal).toBeInstanceOf(FileSnapshotError);

		const userIds = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => entry.id);
		expect(userIds).toHaveLength(3);

		// Each prompt's snapshot holds the file as the prompt before it left it.
		expect(await created.previewFileRestore(userIds[2])).toEqual({ revert: 1, remove: 0, recreate: 0 });
		await created.restoreFiles(userIds[2]);
		expect(fs.readFileSync(file, "utf8")).toBe("v2\n");
		await created.restoreFiles(userIds[1]);
		expect(fs.readFileSync(file, "utf8")).toBe("v1\n");
		await created.restoreFiles(userIds[0]);
		expect(fs.readFileSync(file, "utf8")).toBe("v0\n");

		expect(created.canRedoFileRestore).toBe(true);
		await created.redoFileRestore();
		expect(fs.readFileSync(file, "utf8")).toBe("v1\n");
	});

	it("takes no snapshot when the setting is off", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"rewind.snapshotFiles": false,
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

		await created.prompt("hello");
		expect(created.canRestoreFiles).toBe(false);
		const prompt = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		expect(await created.previewFileRestore(prompt?.id ?? "")).toBeUndefined();
		expect(fs.existsSync(path.join(getAgentDir(), "snapshots"))).toBe(false);
	});
});
