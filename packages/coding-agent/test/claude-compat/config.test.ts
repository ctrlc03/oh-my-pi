import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadClaudeCompatConfig } from "@oh-my-pi/pi-coding-agent/claude-compat/config";
import { TempDir } from "@oh-my-pi/pi-utils";

const hook = (command: string, matcher?: string) => ({
	...(matcher === undefined ? {} : { matcher }),
	hooks: [{ type: "command", command }],
});

async function fixture() {
	const home = TempDir.createSync("@pi-claude-home-");
	const project = TempDir.createSync("@pi-claude-project-");
	await Bun.write(
		path.join(home.path(), ".claude/settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: [hook("user-hook", "Bash")] },
			permissions: { deny: ["Read(./.env)"] },
		}),
	);
	await Bun.write(
		path.join(project.path(), ".claude/settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: [hook("project-hook", "Bash")], Stop: [hook("stop-hook")] },
			permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm:*)"] },
		}),
	);
	await Bun.write(
		path.join(project.path(), ".claude/settings.local.json"),
		JSON.stringify({ hooks: { UserPromptSubmit: [hook("local-hook")] } }),
	);
	return { home, project };
}

let savedConfigDir: string | undefined;
beforeEach(() => {
	savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

describe("loadClaudeCompatConfig", () => {
	it("reads nothing when both switches are off", async () => {
		const { home, project } = await fixture();
		using _home = home;
		using _project = project;
		const config = await loadClaudeCompatConfig({
			cwd: project.path(),
			home: home.path(),
			hooks: "off",
			permissions: "off",
		});
		expect(config.hooks).toEqual([]);
		expect(config.sources).toEqual([]);
		expect(config.permissions).toEqual({ allow: [], deny: [], ask: [] });
	});

	it('"user" reads only the user file', async () => {
		const { home, project } = await fixture();
		using _home = home;
		using _project = project;
		const config = await loadClaudeCompatConfig({
			cwd: project.path(),
			home: home.path(),
			hooks: "user",
			permissions: "user",
		});
		expect(config.hooks.map(entry => entry.command)).toEqual(["user-hook"]);
		expect(config.permissions.deny).toEqual(["Read(./.env)"]);
		expect(config.sources.map(source => source.level)).toEqual(["user"]);
	});

	it('"all" adds project and local files in Claude precedence order', async () => {
		const { home, project } = await fixture();
		using _home = home;
		using _project = project;
		const config = await loadClaudeCompatConfig({
			cwd: project.path(),
			home: home.path(),
			hooks: "all",
			permissions: "all",
		});
		expect(config.hooks.map(entry => `${entry.event}:${entry.command}`)).toEqual([
			"PreToolUse:user-hook",
			"PreToolUse:project-hook",
			"Stop:stop-hook",
			"UserPromptSubmit:local-hook",
		]);
		expect(config.permissions.deny).toEqual(["Read(./.env)", "Bash(rm:*)"]);
		expect(config.permissions.allow).toEqual(["Bash(git status)"]);
		expect(config.hooks.every(entry => entry.timeoutSec === 60)).toBe(true);
	});

	it("gates hooks and permissions independently", async () => {
		const { home, project } = await fixture();
		using _home = home;
		using _project = project;
		const config = await loadClaudeCompatConfig({
			cwd: project.path(),
			home: home.path(),
			hooks: "off",
			permissions: "all",
		});
		expect(config.hooks).toEqual([]);
		expect(config.permissions.deny).toEqual(["Read(./.env)", "Bash(rm:*)"]);
	});

	it("drops disabled hook ids and honors disableAllHooks and explicit timeouts", async () => {
		const { home, project } = await fixture();
		using _home = home;
		using _project = project;
		const base = { cwd: project.path(), home: home.path(), hooks: "all", permissions: "off" } as const;
		const all = await loadClaudeCompatConfig(base);
		const userHook = all.hooks.find(entry => entry.command === "user-hook");
		const withoutOne = await loadClaudeCompatConfig({ ...base, disabledIds: [userHook!.id] });
		expect(withoutOne.hooks.some(entry => entry.command === "user-hook")).toBe(false);

		await Bun.write(
			path.join(project.path(), ".claude/settings.local.json"),
			JSON.stringify({
				disableAllHooks: true,
				hooks: { Stop: [{ hooks: [{ type: "command", command: "x", timeout: 5 }] }] },
			}),
		);
		expect((await loadClaudeCompatConfig(base)).hooks).toEqual([]);
	});

	it("skips malformed files and non-command hooks with warnings", async () => {
		using home = TempDir.createSync("@pi-claude-home-");
		using project = TempDir.createSync("@pi-claude-project-");
		await Bun.write(path.join(home.path(), ".claude/settings.json"), "{ not json");
		await Bun.write(
			path.join(project.path(), ".claude/settings.json"),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "hi" }] }], Bogus: [] } }),
		);
		const config = await loadClaudeCompatConfig({
			cwd: project.path(),
			home: home.path(),
			hooks: "all",
			permissions: "off",
		});
		expect(config.hooks).toEqual([]);
		expect(config.warnings.length).toBeGreaterThanOrEqual(3);
	});
});
