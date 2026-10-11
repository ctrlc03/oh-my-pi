import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadClaudeHookExtensions } from "@oh-my-pi/pi-coding-agent/claude-compat/dashboard";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

let savedConfigDir: string | undefined;
beforeEach(() => {
	savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

async function project() {
	const root = TempDir.createSync("@pi-claude-dash-");
	process.env.CLAUDE_CONFIG_DIR = root.join("claude-home");
	await Bun.write(
		path.join(root.path(), "repo/.claude/settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] },
		}),
	);
	return { root, cwd: root.join("repo") };
}

describe("Extensions dashboard rows for Claude hooks", () => {
	it("lists loaded hooks, marking disabled ones", async () => {
		const { root, cwd } = await project();
		using _root = root;
		const settings = Settings.isolated({ "claude.hooks": "all" });
		const [row] = await loadClaudeHookExtensions(cwd, settings, []);
		expect(row).toMatchObject({
			kind: "hook",
			trigger: "PreToolUse:Bash",
			state: "active",
			source: { provider: "claude", level: "project" },
		});
		const [disabled] = await loadClaudeHookExtensions(cwd, settings, [row.id]);
		expect(disabled).toMatchObject({ state: "disabled", disabledReason: "item-disabled" });
	});

	it("lists nothing while the setting is off or user-only", async () => {
		const { root, cwd } = await project();
		using _root = root;
		expect(await loadClaudeHookExtensions(cwd, Settings.isolated(), [])).toEqual([]);
		expect(await loadClaudeHookExtensions(cwd, Settings.isolated({ "claude.hooks": "user" }), [])).toEqual([]);
	});
});
