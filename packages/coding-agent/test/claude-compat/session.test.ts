import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgBashPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const MODEL = buildModel({
	id: "claude-compat-model",
	name: "Claude Compat Model",
	api: "claude-compat-api",
	provider: "claude-compat-provider",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;

const GUARD = `cat | grep -q 'rm -rf' && { echo 'rm -rf is blocked by policy' >&2; exit 2; }; exit 0`;

let savedConfigDir: string | undefined;
beforeEach(() => {
	savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

async function openSession(overrides: Record<string, unknown>) {
	const root = TempDir.createSync("@pi-claude-session-");
	const userClaude = root.join("claude-home");
	process.env.CLAUDE_CONFIG_DIR = userClaude;
	await Bun.write(
		path.join(root.path(), "repo/.claude/settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: GUARD }] }] },
			permissions: { deny: ["Bash(git push:*)"] },
		}),
	);
	const authStorage = await AuthStorage.create(root.join("auth.db"));
	authStorage.keys.setRuntime("claude-compat-provider", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false, ...overrides });
	const { session } = await createAgentSession({
		cwd: root.join("repo"),
		agentDir: root.join("agent"),
		sessionManager: SessionManager.inMemory(root.join("repo")),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, root.join("models.yml")),
		settings,
		model: MODEL,
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
		settings,
		async close() {
			await session.dispose();
			authStorage.close();
			root.removeSync();
		},
	};
}

const rmRf = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } } as const;

describe("Claude hooks in a real session", () => {
	it("blocks rm -rf through the project's PreToolUse hook when claude.hooks is enabled", async () => {
		const opened = await openSession({ "claude.hooks": "all" });
		try {
			const result = await opened.session.extensionRunner?.emitToolCall(rmRf);
			expect(result).toEqual({ block: true, reason: "rm -rf is blocked by policy" });
			const harmless = await opened.session.extensionRunner?.emitToolCall({
				...rmRf,
				input: { command: "ls" },
			});
			expect(harmless).toBeUndefined();
		} finally {
			await opened.close();
		}
	});

	it("leaves the same project inert by default", async () => {
		const opened = await openSession({});
		try {
			expect(await opened.session.extensionRunner?.emitToolCall(rmRf)).toBeUndefined();
			expect(cfgBashPatterns.get(opened.settings)).toEqual([]);
		} finally {
			await opened.close();
		}
	});

	it("does not run project hooks when claude.hooks is user-only", async () => {
		const opened = await openSession({ "claude.hooks": "user" });
		try {
			expect(await opened.session.extensionRunner?.emitToolCall(rmRf)).toBeUndefined();
		} finally {
			await opened.close();
		}
	});

	it("maps the project's permissions onto bash.patterns only when claude.permissions is enabled", async () => {
		const enabled = await openSession({ "claude.permissions": "all" });
		try {
			expect(cfgBashPatterns.get(enabled.settings) as readonly unknown[]).toEqual([
				{ match: "git push", approval: "deny" },
				{ match: "git push *", approval: "deny" },
			]);
			// Permissions alone must not arm the project's hooks.
			expect(await enabled.session.extensionRunner?.emitToolCall(rmRf)).toBeUndefined();
		} finally {
			await enabled.close();
		}
	});
});
