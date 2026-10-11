/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";
import { DEFAULT_SKILLS_URL } from "@oh-my-pi/pi-wire/skillshare";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgExtensions = register({ id: "extensions", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgDisabledExtensions = register({ id: "disabledExtensions", type: "array", default: EMPTY_STRING_ARRAY });

// Skill registry (omp skill)
export const cfgSkillsRegistryUrl = register({
	id: "skills.registryUrl",
	type: "string",
	default: DEFAULT_SKILLS_URL,
	ui: {
		tab: "interaction",
		group: "Skills",
		label: "Skill Registry",
		description:
			"Skillshare registry used by `omp skill` to install, search, and publish skills (https://host[:port])",
	},
});

// Skills
export const cfgSkillsEnabled = register({ id: "skills.enabled", type: "boolean", default: true });

export const cfgSkillsEnableSkillCommands = register({
	id: "skills.enableSkillCommands",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "Skill Commands",
		description: "Register skills as /skill:name commands",
	},
});

export const cfgSkillsEnableCodexUser = register({ id: "skills.enableCodexUser", type: "boolean", default: false });

export const cfgSkillsEnableClaudeUser = register({ id: "skills.enableClaudeUser", type: "boolean", default: false });

export const cfgSkillsEnableClaudeProject = register({
	id: "skills.enableClaudeProject",
	type: "boolean",
	default: true,
});

export const cfgSkillsEnablePiUser = register({ id: "skills.enablePiUser", type: "boolean", default: true });

export const cfgSkillsEnablePiProject = register({ id: "skills.enablePiProject", type: "boolean", default: true });

export const cfgSkillsEnableAgentsUser = register({ id: "skills.enableAgentsUser", type: "boolean", default: true });

export const cfgSkillsEnableAgentsProject = register({
	id: "skills.enableAgentsProject",
	type: "boolean",
	default: true,
});

export const cfgSkillsCustomDirectories = register({
	id: "skills.customDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgSkillsIgnoredSkills = register({
	id: "skills.ignoredSkills",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgSkillsIncludeSkills = register({
	id: "skills.includeSkills",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

/** Skill discovery options (`skills.*` except the `omp skill` registry URL). */
export const cfgSkills = combine({
	enabled: cfgSkillsEnabled,
	enableSkillCommands: cfgSkillsEnableSkillCommands,
	enableCodexUser: cfgSkillsEnableCodexUser,
	enableClaudeUser: cfgSkillsEnableClaudeUser,
	enableClaudeProject: cfgSkillsEnableClaudeProject,
	enablePiUser: cfgSkillsEnablePiUser,
	enablePiProject: cfgSkillsEnablePiProject,
	enableAgentsUser: cfgSkillsEnableAgentsUser,
	enableAgentsProject: cfgSkillsEnableAgentsProject,
	customDirectories: cfgSkillsCustomDirectories,
	ignoredSkills: cfgSkillsIgnoredSkills,
	includeSkills: cfgSkillsIncludeSkills,
});

/** Skill discovery options ({@link cfgSkills}); omitted fields fall back to the setting defaults. */
export type SkillsSettings = Partial<SettingValueOf<typeof cfgSkills>>;

// Commands
export const cfgCommandsEnableClaudeUser = register({
	id: "commands.enableClaudeUser",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "Claude User Commands",
		description: "Load commands from ~/.claude/commands/",
	},
});

export const cfgCommandsEnableClaudeProject = register({
	id: "commands.enableClaudeProject",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "Claude Project Commands",
		description: "Load commands from .claude/commands/",
	},
});

export const cfgCommandsEnableOpencodeUser = register({
	id: "commands.enableOpencodeUser",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "OpenCode User Commands",
		description: "Load commands from ~/.config/opencode/commands/",
	},
});

export const cfgCommandsEnableOpencodeProject = register({
	id: "commands.enableOpencodeProject",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "OpenCode Project Commands",
		description: "Load commands from .opencode/commands/",
	},
});

// Honored from the user config, a runtime override, or `--config` only; a project layer cannot enable itself
// (see `config/command-shell.ts`).
export const cfgCommandsShellExpansion = register({
	id: "commands.shellExpansion",
	type: "enum",
	values: ["off", "user", "all"] as const,
	default: "user",
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "Shell in Commands",
		description:
			"Replace !`cmd` in markdown commands and prompt templates with the command's output. Project command files can run shell: `all` trusts them.",
		options: [
			{ value: "off", label: "Off", description: "Leave !`cmd` text as written." },
			{
				value: "user",
				label: "User commands only",
				description: "Run !`cmd` only from your own command directories, never from a project's.",
			},
			{
				value: "all",
				label: "User and project commands",
				description: "Also run !`cmd` from project command files. Enable only for repositories you trust.",
			},
		],
	},
});

export const cfgCommandsShellTimeoutMs = register({
	id: "commands.shellTimeoutMs",
	type: "number",
	default: 10_000,
	validate: raw => {
		if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)) {
			throw new Error(`Expected a positive number of milliseconds, got ${Bun.inspect(raw)}`);
		}
	},
	ui: {
		tab: "tasks",
		group: "Commands & Skills",
		label: "Shell in Commands Timeout (ms)",
		description: "Longest a !`cmd` snippet in a markdown command may run before its output is replaced by an error",
	},
});

const CLAUDE_COMPAT_OPTIONS = [
	{ value: "off", label: "Off", description: "Do not load anything from Claude Code settings." },
	{
		value: "user",
		label: "User only",
		description: "Load only from ~/.claude/settings.json (or CLAUDE_CONFIG_DIR).",
	},
	{
		value: "all",
		label: "User and project",
		description:
			"Also load <project>/.claude/settings.json and settings.local.json. Project files run arbitrary commands: enable only for repositories you trust.",
	},
];

// Honored from the user config, a runtime override, or `--config` only; a project layer cannot enable itself
// (see `claude-compat/mode.ts`).
export const cfgClaudeHooks = register({
	id: "claude.hooks",
	type: "enum",
	values: ["off", "user", "all"] as const,
	default: "off",
	ui: {
		tab: "tools",
		group: "Extensions",
		label: "Claude Code Hooks",
		description:
			"Run command hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart) from Claude Code settings.json files. Project hooks execute arbitrary commands.",
		options: CLAUDE_COMPAT_OPTIONS,
	},
});

export const cfgClaudePermissions = register({
	id: "claude.permissions",
	type: "enum",
	values: ["off", "user", "all"] as const,
	default: "off",
	ui: {
		tab: "tools",
		group: "Extensions",
		label: "Claude Code Permissions",
		description:
			"Map permissions.allow/deny/ask from Claude Code settings.json files onto bash.patterns, tools.approval, and path rules for this session.",
		options: CLAUDE_COMPAT_OPTIONS,
	},
});

export const cfgExtensionHandlersToolCallTimeoutMs = register({
	id: "extensionHandlers.toolCallTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "Extensions",
		label: "Tool Call Handler Timeout (ms)",
		description:
			"Positive finite active-work timeout for extension tool_call handlers; invalid values use 30000ms, and time awaiting OMP-owned dialogs does not count",
	},
});
