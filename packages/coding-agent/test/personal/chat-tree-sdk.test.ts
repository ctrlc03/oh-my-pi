/**
 * Contract: `createAgentSession` in the Personal `chat-tree` memory mode replaces omp's system prompt with the
 * mode's own (the owner's instructions follow it), offers `zoom` and `date` and no `recall`, and stands omp's
 * compaction and Mnemopi recall down; without the mode none of that happens.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMnemopiAutoRecall } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";
import { CHAT_TREE_SYSTEM_PROMPT } from "@oh-my-pi/pi-coding-agent/personal/chat-tree/prompt";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	cfgCompactionEnabled,
	cfgCompactionExperimentalContextManagement,
	cfgCompactionIdleEnabled,
	cfgCompactionMidTurnEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

async function openSession(settings: Record<string, unknown>) {
	const tempDir = TempDir.createSync("@pi-chat-tree-sdk-");
	await fs.writeFile(path.join(tempDir.path(), "AGENTS.md"), "ABOUT_YOU_MARKER: prefers tea");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "mnemopi.autoRecall": true, "memory.backend": "mnemopi", ...settings }),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return {
		session,
		async close() {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

describe("createAgentSession in the chat-tree memory mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("brings its own system prompt, zoom and date, and no recall", async () => {
		const { session, close } = await openSession({
			"personal.enabled": true,
			"personal.runKind": "live",
			"personal.memoryMode": "chat-tree",
		});
		try {
			expect(session.systemPrompt).toHaveLength(1);
			const prompt = session.systemPrompt[0] as string;
			expect(prompt.startsWith(CHAT_TREE_SYSTEM_PROMPT.slice(0, 200))).toBe(true);
			expect(prompt).toContain("# The user's instructions");
			expect(prompt.indexOf("ABOUT_YOU_MARKER")).toBeGreaterThan(prompt.indexOf("# The user's instructions"));
			expect(prompt).not.toContain("recall");
			const tools = session.agent.state.tools.map(tool => tool.name);
			expect(tools).toContain("zoom");
			expect(tools).toContain("date");
			expect(tools).not.toContain("recall");
			expect(tools).not.toContain("reflect");
			expect(cfgCompactionEnabled.get(session.settings)).toBe(false);
			expect(cfgMnemopiAutoRecall.get(session.settings)).toBe(false);
			expect(session.chatTree).toBeDefined();
		} finally {
			await close();
		}
	});

	it("keeps omp's compaction for the subagents of the session whose own compaction it switched off", async () => {
		const { session, close } = await openSession({
			"personal.enabled": true,
			"personal.runKind": "live",
			"personal.memoryMode": "chat-tree",
			"compaction.idleEnabled": true,
			"compaction.experimentalContextManagement": true,
		});
		try {
			for (const setting of [
				cfgCompactionEnabled,
				cfgCompactionIdleEnabled,
				cfgCompactionMidTurnEnabled,
				cfgCompactionExperimentalContextManagement,
			]) {
				expect(setting.get(session.settings)).toBe(false);
			}
			const subagent = createSubagentSettings(session.settings);
			expect(cfgCompactionEnabled.get(subagent)).toBe(true);
			expect(cfgCompactionIdleEnabled.get(subagent)).toBe(true);
			expect(cfgCompactionMidTurnEnabled.get(subagent)).toBe(true);
			expect(cfgCompactionExperimentalContextManagement.get(subagent)).toBe(true);
			// A subagent of a subagent reads through its parent, which holds the restored values.
			expect(cfgCompactionEnabled.get(createSubagentSettings(subagent))).toBe(true);
			// The main session keeps the mode's switch-off.
			expect(cfgCompactionEnabled.get(session.settings)).toBe(false);
		} finally {
			await close();
		}
	});

	it("gives a subagent the compaction setting the profile chose, not a fixed one", async () => {
		const { session, close } = await openSession({
			"personal.enabled": true,
			"personal.runKind": "live",
			"personal.memoryMode": "chat-tree",
			"compaction.enabled": false,
		});
		try {
			expect(cfgCompactionEnabled.get(createSubagentSettings(session.settings))).toBe(false);
		} finally {
			await close();
		}
	});

	it("leaves the settings of a subagent of a recall-mode session as they were", async () => {
		const { session, close } = await openSession({ "personal.enabled": true, "personal.runKind": "live" });
		try {
			expect(cfgCompactionEnabled.get(createSubagentSettings(session.settings))).toBe(true);
		} finally {
			await close();
		}
	});

	it("leaves a session in the default recall mode as it was", async () => {
		const { session, close } = await openSession({ "personal.enabled": true, "personal.runKind": "live" });
		try {
			expect(session.systemPrompt.join("\n")).not.toContain("# The user's instructions");
			const tools = session.agent.state.tools.map(tool => tool.name);
			expect(tools).not.toContain("zoom");
			expect(tools).not.toContain("date");
			expect(session.chatTree).toBeUndefined();
		} finally {
			await close();
		}
	});
});
