/**
 * Contract: a private session limits every model request to `private.providers`.
 *
 * - The session header carries `private: true`; forks and branches copy it; the header, not the
 *   flag, decides what a process may open.
 * - `--private` is for new sessions only; a private process refuses non-private transcripts, and a
 *   normal process refuses a private one at runtime but adopts it at startup.
 * - Empty `private.providers` fails startup naming the setting; `private.modelRoles` replaces
 *   `modelRoles` per role.
 * - Disallowed providers vanish from the model catalog, so fallback chains cannot select them.
 * - The advisor, `/share` and `web_search` are unavailable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	assertProviderAllowedInPrivateMode,
	enterPrivateMode,
	PrivateModeError,
	resetPrivateModeForTesting,
} from "@oh-my-pi/pi-ai/private-mode";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { activatePrivateMode } from "@oh-my-pi/pi-coding-agent/config/private-mode";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { shareSession } from "@oh-my-pi/pi-coding-agent/export/share";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { archiveSession } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import { collectThreads } from "@oh-my-pi/pi-coding-agent/memories";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveMethodSettings, canUseRemoteCompaction } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { listRecentSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { PrivateSessionError, withPrivateSessionAdoption } from "@oh-my-pi/pi-coding-agent/session/private-session";
import { findRetryFallbackCandidates } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { privateModeThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/private-mode";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** A persisted session with one user and one assistant message; returns its manager and file path. */
async function persistedSession(cwd: string, sessionDir: string): Promise<{ manager: SessionManager; file: string }> {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	manager.appendMessage(assistantMessage("hi"));
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return { manager, file };
}

function headerOf(file: string): Record<string, unknown> {
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.type === "session") return entry;
	}
	throw new Error(`No session header in ${file}`);
}

/** Settings read from a config.yml in a scratch agent dir, so the values sit in the global layer. */
async function loadConfiguredSettings(config: Record<string, unknown>): Promise<Settings> {
	const root = makeTempDir("@pi-private-settings-");
	const agentDir = path.join(root, "agent");
	await Bun.write(path.join(agentDir, "config.yml"), Bun.YAML.stringify(config));
	return Settings.loadReadOnly({ cwd: root, agentDir });
}

function privateSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ "private.providers": ["studio-glm", "studio-nanbeige"], ...overrides });
}

beforeEach(() => {
	resetPrivateModeForTesting();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetPrivateModeForTesting();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("private session header", () => {
	it("persists `private: true`, survives reopen, and is copied by forks and branches", async () => {
		enterPrivateMode(["studio-glm"]);
		const cwd = makeTempDir("@pi-private-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { manager, file } = await persistedSession(cwd, sessionDir);

		expect(manager.isPrivate()).toBe(true);
		expect(headerOf(file).private).toBe(true);

		const reopened = await SessionManager.open(file, sessionDir);
		expect(reopened.isPrivate()).toBe(true);

		const forked = await SessionManager.forkFrom(file, cwd, sessionDir);
		expect(forked.isPrivate()).toBe(true);

		const leaf = manager.getLeafId();
		if (!leaf) throw new Error("Expected a leaf entry");
		const branchFile = manager.createBranchedSession(leaf);
		if (!branchFile) throw new Error("Expected a branched session file");
		expect(headerOf(branchFile).private).toBe(true);
	});

	it("leaves the field absent in a normal process", async () => {
		const cwd = makeTempDir("@pi-normal-cwd-");
		const { manager, file } = await persistedSession(cwd, path.join(cwd, "sessions"));
		expect(manager.isPrivate()).toBe(false);
		expect(headerOf(file)).not.toHaveProperty("private");
	});

	it("keeps a private source private when forked and refuses to write a fork of a normal source", async () => {
		const cwd = makeTempDir("@pi-fork-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { file: normalFile } = await persistedSession(cwd, sessionDir);
		enterPrivateMode(["studio-glm"]);
		const before = fs.readdirSync(sessionDir, { recursive: true }).length;

		await expect(SessionManager.forkFrom(normalFile, cwd, sessionDir)).rejects.toThrow(PrivateSessionError);
		expect(fs.readdirSync(sessionDir, { recursive: true }).length).toBe(before);
	});
});

describe("private session adoption", () => {
	it("a private process refuses to open a normal session, saying only a new session can be made private", async () => {
		const cwd = makeTempDir("@pi-adopt-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { file } = await persistedSession(cwd, sessionDir);
		enterPrivateMode(["studio-glm"]);

		const failure = await SessionManager.open(file, sessionDir).then(
			() => undefined,
			error => error,
		);
		expect(failure).toBeInstanceOf(PrivateSessionError);
		expect(String(failure.message)).toContain("only a new session can be made private");
	});

	it("`--private --resume <normal session>` fails at startup with that error", async () => {
		const cwd = makeTempDir("@pi-resume-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { file } = await persistedSession(cwd, sessionDir);
		const settings = privateSettings();
		activatePrivateMode(settings);

		const parsed = parseArgs(["--private", "--resume", file, "--session-dir", sessionDir]);
		expect(parsed.private).toBe(true);
		await expect(createSessionManager(parsed, cwd, settings)).rejects.toThrow(
			/only a new session can be made private/,
		);
		const forkParsed = parseArgs(["--private", "--fork", file, "--session-dir", sessionDir]);
		await expect(createSessionManager(forkParsed, cwd, settings)).rejects.toThrow(
			/only a new session can be made private/,
		);
	});

	it("a normal process refuses a private session at runtime but adopts it at startup", async () => {
		enterPrivateMode(["studio-glm"]);
		const cwd = makeTempDir("@pi-startup-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { file } = await persistedSession(cwd, sessionDir);
		resetPrivateModeForTesting();

		await expect(SessionManager.open(file, sessionDir)).rejects.toThrow(/session is private/);

		const activate = vi.fn(() => enterPrivateMode(["studio-glm"]));
		const adopted = await withPrivateSessionAdoption(activate, () => SessionManager.open(file, sessionDir));
		expect(adopted.isPrivate()).toBe(true);
		expect(activate).toHaveBeenCalled();
	});

	it("`--private` survives /restart", () => {
		expect(restartArgv(["--private", "fix the bug"], "sid")).toEqual(["--private", "--restore", "sid"]);
	});
});

describe("private settings", () => {
	it("fails startup naming private.providers when the allowlist is empty", () => {
		expect(() => activatePrivateMode(Settings.isolated())).toThrow(/private\.providers/);
	});

	it("uses private.modelRoles instead of modelRoles per role and falls back for unlisted roles", async () => {
		const settings = await loadConfiguredSettings({
			modelRoles: { default: "anthropic/claude-sonnet-4-5", smol: "anthropic/claude-haiku-4-5" },
			private: {
				providers: ["studio-glm", "studio-nanbeige"],
				modelRoles: { default: "studio-glm/glm-5.3-flash" },
			},
		});
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		activatePrivateMode(settings);
		expect(settings.getModelRole("default")).toBe("studio-glm/glm-5.3-flash");
		expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		expect(settings.getModelRoles().default).toBe("studio-glm/glm-5.3-flash");
	});

	it("lets an explicit runtime override such as --model win over private.modelRoles", async () => {
		const settings = await loadConfiguredSettings({
			private: { providers: ["studio-glm", "studio-nanbeige"], modelRoles: { default: "studio-glm/glm-5.3-flash" } },
		});
		activatePrivateMode(settings);
		settings.overrideModelRoles({ default: "studio-nanbeige/nanbeige" });
		expect(settings.getModelRole("default")).toBe("studio-nanbeige/nanbeige");
	});
});

describe("private model catalog and fallback chains", () => {
	it("hides providers off the allowlist so a fallback chain cannot select them", () => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		try {
			enterPrivateMode(["openai"]);
			const registry = new ModelRegistry(authStorage);
			const available = registry.getAvailable();
			expect(available.length).toBeGreaterThan(0);
			expect(available.every(model => model.provider === "openai")).toBe(true);
			expect(registry.find("anthropic", "claude-sonnet-4-5")).toBeUndefined();

			const current = registry.find("openai", "gpt-4o-mini");
			if (!current) throw new Error("Expected the openai model to stay available");
			const candidates = findRetryFallbackCandidates(
				{
					chains: { default: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5", "openai/gpt-4o"] },
					getModelRole: () => undefined,
					modelLookup: registry,
				},
				"default",
				"openai/gpt-4o-mini",
				current,
			);
			expect(candidates.some(candidate => candidate.provider === "anthropic")).toBe(false);
		} finally {
			authStorage.close();
		}
	});
});

describe("private session surfaces", () => {
	it("removes web_search from the tool plan, even when requested by name", async () => {
		const session = (): ToolSession => ({
			cwd: "/tmp",
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			skipPythonPreflight: true,
		});
		const normal = await resolveBuiltinToolPlan(session());
		expect(normal.isAllowed("web_search")).toBe(true);

		enterPrivateMode(["studio-glm"]);
		const plan = await resolveBuiltinToolPlan(session());
		expect(plan.isAllowed("web_search")).toBe(false);
		const explicit = await resolveBuiltinToolPlan(session(), ["read", "web_search"]);
		expect(explicit.names).not.toContain("web_search");
	});

	it("refuses /advisor on and never toggles the advisor", async () => {
		enterPrivateMode(["studio-glm"]);
		const toggleAdvisorEnabled = vi.fn(() => true);
		const showStatus = vi.fn();
		const runtime = {
			ctx: { session: { toggleAdvisorEnabled }, showStatus, editor: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;

		await executeBuiltinSlashCommand("/advisor on", runtime);

		expect(toggleAdvisorEnabled).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("private session"));
	});

	it("refuses to share a private session", async () => {
		enterPrivateMode(["studio-glm"]);
		const cwd = makeTempDir("@pi-share-cwd-");
		const { manager } = await persistedSession(cwd, path.join(cwd, "sessions"));
		await expect(shareSession(manager)).rejects.toThrow(/private session cannot be shared/);
	});
});

describe("private subagents", () => {
	it("a subagent worker booted from a private parent is blocked from disallowed providers", () => {
		enterPrivateMode(["studio-glm"]);
		const globals = privateModeThreadService.globals();

		// The worker is a fresh realm: simulate it by clearing this one before booting from the globals.
		resetPrivateModeForTesting();
		expect(() => assertProviderAllowedInPrivateMode("anthropic")).not.toThrow();
		privateModeThreadService.boot(globals);

		expect(() => assertProviderAllowedInPrivateMode("anthropic")).toThrow(PrivateModeError);
		expect(() => assertProviderAllowedInPrivateMode("studio-glm")).not.toThrow();
	});

	it("a subagent session created in a private process is private", () => {
		enterPrivateMode(["studio-glm"]);
		const cwd = makeTempDir("@pi-subagent-cwd-");
		expect(SessionManager.create(cwd, path.join(cwd, "sessions")).isPrivate()).toBe(true);
		expect(SessionManager.inMemory(cwd).isPrivate()).toBe(true);
	});
});

describe("private explicit model selection", () => {
	it("refuses a CLI model on a provider outside private.providers, naming it and the allowlist", () => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		try {
			const settings = Settings.isolated({ "private.providers": ["openai"] });
			enterPrivateMode(["openai"]);
			const registry = new ModelRegistry(authStorage);

			const refused = resolveCliModel({
				cliModel: "anthropic/claude-sonnet-4-5",
				modelRegistry: registry,
				settings,
			});
			expect(refused.model).toBeUndefined();
			expect(refused.disabledProvider).toBe("anthropic");
			expect(refused.error).toBe("anthropic is not allowed in a private session (private.providers: openai).");

			const allowed = resolveCliModel({ cliModel: "openai/gpt-4o-mini", modelRegistry: registry, settings });
			expect(allowed.model?.provider).toBe("openai");
		} finally {
			authStorage.close();
		}
	});
});

describe("private compaction endpoint", () => {
	it("ignores compaction.remoteEndpoint whichever layer set it, so remote compaction needs a provider-native route", () => {
		const settings = { remoteEndpoint: "http://evil.test/v1/chat/completions" } as never;
		const localModel = { ...getBundledModel("openai", "gpt-4o-mini"), provider: "studio-glm" };
		expect(resolveMethodSettings(settings, "remote").remoteEndpoint).toBe("http://evil.test/v1/chat/completions");

		enterPrivateMode(["studio-glm"]);
		const resolved = resolveMethodSettings(settings, "remote");
		expect(resolved.remoteEndpoint).toBeUndefined();
		expect(canUseRemoteCompaction(localModel, resolved)).toBe(false);
	});
});

describe("private memory", () => {
	it("turns every memory backend off in a private process", async () => {
		const settings = await loadConfiguredSettings({
			memory: { backend: "hindsight" },
			hindsight: { apiUrl: "http://evil.test" },
			private: { providers: ["studio-glm"] },
		});
		expect((await resolveMemoryBackend(settings)).id).toBe("hindsight");
		activatePrivateMode(settings);
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("keeps only the Personal agent's Mnemopi in a private process", async () => {
		const personal = await loadConfiguredSettings({
			personal: { enabled: true },
			memory: { backend: "mnemopi" },
			private: { providers: ["studio-glm"] },
		});
		activatePrivateMode(personal);
		expect((await resolveMemoryBackend(personal)).id).toBe("mnemopi");
		resetPrivateModeForTesting();

		for (const config of [
			{ memory: { backend: "mnemopi" } },
			{ personal: { enabled: true }, memory: { backend: "hindsight" } },
			{ personal: { enabled: true }, memory: { backend: "local" } },
		]) {
			const settings = await loadConfiguredSettings({ ...config, private: { providers: ["studio-glm"] } });
			activatePrivateMode(settings);
			expect((await resolveMemoryBackend(settings)).id).toBe("off");
			resetPrivateModeForTesting();
		}
	});

	it("does not collect private transcripts into a normal process's memory", async () => {
		const sessionDir = makeTempDir("@pi-memory-threads-");
		const header = (id: string, extra: Record<string, unknown> = {}) =>
			`${JSON.stringify({ type: "session", id, cwd: sessionDir, timestamp: new Date().toISOString(), ...extra })}\n`;
		await Bun.write(path.join(sessionDir, "normal.jsonl"), header("normal-1"));
		await Bun.write(path.join(sessionDir, "secret.jsonl"), header("secret-1", { private: true }));
		const session = { sessionManager: { getSessionDir: () => sessionDir } } as unknown as AgentSession;

		const threads = await collectThreads(session);

		expect(threads.map(thread => thread.id)).toEqual(["normal-1"]);
	});
});

describe("private archive and shared stores", () => {
	it("reports private sessions to the listing and refuses them in the archive", async () => {
		enterPrivateMode(["studio-glm"]);
		const cwd = makeTempDir("@pi-archive-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const { file } = await persistedSession(cwd, sessionDir);
		resetPrivateModeForTesting();
		const normal = await persistedSession(cwd, sessionDir);

		const listed = await listRecentSessions({ limit: 10, sessionDir });
		expect(listed.find(info => info.path === file)?.private).toBe(true);
		expect(listed.find(info => info.path === normal.file)?.private).toBeUndefined();

		await expect(archiveSession(file, 5)).rejects.toThrow(/Not a readable session file/);
	});

	it("records no prompts in the shared history.db while private", async () => {
		const history = HistoryStorage.open(path.join(makeTempDir("@pi-history-"), "history.db"));
		await history.add("normal prompt", "/work", "s1");
		expect(history.getRecent(10).map(entry => entry.prompt)).toEqual(["normal prompt"]);

		enterPrivateMode(["studio-glm"]);
		await history.add("secret prompt", "/work", "s2");
		expect(history.getRecent(10).map(entry => entry.prompt)).toEqual(["normal prompt"]);
	});
});

describe("private restart and credential resolution", () => {
	it("/restart keeps a private process private even without the flag on its argv", () => {
		expect(restartArgv(["fix the bug"], "sid")).toEqual(["--restore", "sid"]);
		enterPrivateMode(["studio-glm"]);
		expect(restartArgv(["fix the bug"], "sid")).toEqual(["--private", "--restore", "sid"]);
		expect(restartArgv(["--private"], undefined)).toEqual(["--private"]);
	});

	it("refuses to resolve credentials for a disallowed provider, so no OAuth refresh runs", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("studio-glm", "local-key");
		try {
			enterPrivateMode(["studio-glm"]);
			await expect(authStorage.keys.get("anthropic")).rejects.toBeInstanceOf(PrivateModeError);
			expect(await authStorage.keys.get("studio-glm")).toBe("local-key");
		} finally {
			authStorage.close();
		}
	});
});

describe("refused session switch", () => {
	it("leaves the current session writable when the target is refused", async () => {
		const cwd = makeTempDir("@pi-switch-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const normal = await persistedSession(cwd, sessionDir);
		enterPrivateMode(["studio-glm"]);
		const { manager, file } = await persistedSession(cwd, sessionDir);

		await expect(manager.setSessionFile(normal.file)).rejects.toThrow(PrivateSessionError);

		expect(manager.getSessionFile()).toBe(file);
		manager.appendMessage({ role: "user", content: "still here", timestamp: Date.now() });
		await manager.flush();
		expect(fs.readFileSync(file, "utf8")).toContain("still here");
	});
});
