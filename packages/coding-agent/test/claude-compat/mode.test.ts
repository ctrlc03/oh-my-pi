import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveClaudeCompatMode } from "@oh-my-pi/pi-coding-agent/claude-compat/mode";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgClaudeHooks, cfgClaudePermissions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("claude.hooks / claude.permissions gate", () => {
	it("default off", () => {
		const settings = Settings.isolated();
		expect(resolveClaudeCompatMode(settings, cfgClaudeHooks)).toBe("off");
		expect(resolveClaudeCompatMode(settings, cfgClaudePermissions)).toBe("off");
	});

	it("honors runtime and user-level values", () => {
		expect(resolveClaudeCompatMode(Settings.isolated({ "claude.hooks": "user" }), cfgClaudeHooks)).toBe("user");
		expect(resolveClaudeCompatMode(Settings.isolated({ "claude.permissions": "all" }), cfgClaudePermissions)).toBe(
			"all",
		);
	});

	it("ignores a project layer that tries to enable itself", async () => {
		using root = TempDir.createSync("@pi-claude-mode-");
		const agentDir = path.join(root.path(), "agent");
		const cwd = path.join(root.path(), "repo");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "claude:\n  hooks: all\n  permissions: all\n");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		expect(settings.getProvenance(cfgClaudeHooks)).toBe("project");
		expect(resolveClaudeCompatMode(settings, cfgClaudeHooks)).toBe("off");
		expect(resolveClaudeCompatMode(settings, cfgClaudePermissions)).toBe("off");
	});

	it("falls back to the user-level value when the project layer also sets one", async () => {
		using root = TempDir.createSync("@pi-claude-mode-");
		const agentDir = path.join(root.path(), "agent");
		const cwd = path.join(root.path(), "repo");
		await Bun.write(path.join(agentDir, "config.yml"), "claude:\n  hooks: user\n");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "claude:\n  hooks: all\n");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		expect(resolveClaudeCompatMode(settings, cfgClaudeHooks)).toBe("user");
	});
});
