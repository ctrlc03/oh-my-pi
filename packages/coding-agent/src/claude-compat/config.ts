/**
 * Reads the Claude Code settings files that carry `hooks` and `permissions`.
 *
 * Claude merges `~/.claude/settings.json`, `<project>/.claude/settings.json`, and the untracked
 * `<project>/.claude/settings.local.json` (later files take precedence; list-valued keys are
 * concatenated). The modes `off` / `user` / `all` decide which of those files are read at all.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { resolveClaudePaths } from "../config/claude-paths";
import type { ClaudeCompatMode } from "./mode";

export const CLAUDE_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart"] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/** Claude's documented default command-hook timeout, in seconds. */
export const DEFAULT_HOOK_TIMEOUT_SEC = 60;

export interface ClaudeSettingsSource {
	path: string;
	level: "user" | "project";
}

export interface ClaudeHookCommand {
	event: ClaudeHookEvent;
	/** Raw Claude matcher; `undefined` matches every tool. Only meaningful for tool events. */
	matcher: string | undefined;
	command: string;
	timeoutSec: number;
	source: ClaudeSettingsSource;
	/** Stable `disabledExtensions` id (`hook:claude:<event>:<matcher>:<command>`). */
	id: string;
}

export interface ClaudePermissionLists {
	allow: string[];
	deny: string[];
	ask: string[];
}

export interface ClaudeLoadedSource extends ClaudeSettingsSource {
	hookCount: number;
	permissionCount: number;
}

export interface ClaudeCompatConfig {
	hooks: ClaudeHookCommand[];
	permissions: ClaudePermissionLists;
	/** Files that parsed, in precedence order (lowest first). */
	sources: ClaudeLoadedSource[];
	warnings: string[];
}

export interface LoadClaudeCompatOptions {
	cwd: string;
	hooks: ClaudeCompatMode;
	permissions: ClaudeCompatMode;
	/** `disabledExtensions` entries; matching hook ids are dropped. */
	disabledIds?: readonly string[];
	home?: string;
}

export function claudeHookId(event: ClaudeHookEvent, matcher: string | undefined, command: string): string {
	return `hook:claude:${event}:${matcher ?? "*"}:${command}`;
}

async function readJsonFile(filePath: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") warnings.push(`Failed to read ${filePath}: ${String(error)}`);
		return undefined;
	}
	const data = tryParseJson<unknown>(text);
	if (!isRecord(data)) {
		warnings.push(`Failed to parse JSON object in ${filePath}`);
		return undefined;
	}
	return data;
}

function parseHooks(
	data: Record<string, unknown>,
	source: ClaudeSettingsSource,
	warnings: string[],
): ClaudeHookCommand[] {
	const hooks = data.hooks;
	if (hooks === undefined) return [];
	if (!isRecord(hooks)) {
		warnings.push(`${source.path}: "hooks" must be an object`);
		return [];
	}
	const result: ClaudeHookCommand[] = [];
	for (const [eventName, groups] of Object.entries(hooks)) {
		const event = CLAUDE_HOOK_EVENTS.find(candidate => candidate === eventName);
		if (!event) {
			warnings.push(`${source.path}: hook event "${eventName}" is not supported`);
			continue;
		}
		if (!Array.isArray(groups)) {
			warnings.push(`${source.path}: hooks.${eventName} must be an array`);
			continue;
		}
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) {
				warnings.push(`${source.path}: hooks.${eventName} entries need a "hooks" array`);
				continue;
			}
			const matcher = typeof group.matcher === "string" && group.matcher !== "" ? group.matcher : undefined;
			for (const entry of group.hooks) {
				if (!isRecord(entry) || entry.type !== "command" || typeof entry.command !== "string") {
					warnings.push(`${source.path}: only {"type":"command"} hooks are supported (hooks.${eventName})`);
					continue;
				}
				const command = entry.command.trim();
				if (command === "") continue;
				const timeout = entry.timeout;
				result.push({
					event,
					matcher,
					command,
					timeoutSec:
						typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
							? timeout
							: DEFAULT_HOOK_TIMEOUT_SEC,
					source,
					id: claudeHookId(event, matcher, command),
				});
			}
		}
	}
	return result;
}

function parsePermissions(data: Record<string, unknown>, source: ClaudeSettingsSource, warnings: string[]) {
	const lists: ClaudePermissionLists = { allow: [], deny: [], ask: [] };
	const permissions = data.permissions;
	if (permissions === undefined) return lists;
	if (!isRecord(permissions)) {
		warnings.push(`${source.path}: "permissions" must be an object`);
		return lists;
	}
	for (const key of ["allow", "deny", "ask"] as const) {
		const entries = permissions[key];
		if (entries === undefined) continue;
		if (!Array.isArray(entries)) {
			warnings.push(`${source.path}: permissions.${key} must be an array`);
			continue;
		}
		for (const entry of entries) {
			if (typeof entry === "string" && entry.trim() !== "") lists[key].push(entry.trim());
		}
	}
	return lists;
}

function appendUnique(target: string[], values: readonly string[]): void {
	for (const value of values) if (!target.includes(value)) target.push(value);
}

/**
 * Load Claude hooks and permissions from the files `options` admit. Does no I/O when both modes are `off`.
 * `disableAllHooks: true` in any admitted file suppresses every hook, as in Claude.
 */
export async function loadClaudeCompatConfig(options: LoadClaudeCompatOptions): Promise<ClaudeCompatConfig> {
	const config: ClaudeCompatConfig = {
		hooks: [],
		permissions: { allow: [], deny: [], ask: [] },
		sources: [],
		warnings: [],
	};
	if (options.hooks === "off" && options.permissions === "off") return config;

	const userDir = resolveClaudePaths(options.home ?? os.homedir()).configDir;
	const projectDir = path.join(options.cwd, ".claude");
	const files: ClaudeSettingsSource[] = [{ path: path.join(userDir, "settings.json"), level: "user" }];
	if (options.hooks === "all" || options.permissions === "all") {
		files.push(
			{ path: path.join(projectDir, "settings.json"), level: "project" },
			{ path: path.join(projectDir, "settings.local.json"), level: "project" },
		);
	}

	const disabled = new Set(options.disabledIds);
	let hooksDisabled = false;
	const seenHooks = new Set<string>();
	for (const source of files) {
		const data = await readJsonFile(source.path, config.warnings);
		if (!data) continue;
		const wantHooks = options.hooks === "all" || (options.hooks === "user" && source.level === "user");
		const wantPermissions =
			options.permissions === "all" || (options.permissions === "user" && source.level === "user");
		let hookCount = 0;
		let permissionCount = 0;
		if (wantHooks) {
			if (data.disableAllHooks === true) hooksDisabled = true;
			for (const hook of parseHooks(data, source, config.warnings)) {
				if (disabled.has(hook.id) || seenHooks.has(hook.id)) continue;
				seenHooks.add(hook.id);
				config.hooks.push(hook);
				hookCount++;
			}
		}
		if (wantPermissions) {
			const lists = parsePermissions(data, source, config.warnings);
			appendUnique(config.permissions.deny, lists.deny);
			appendUnique(config.permissions.ask, lists.ask);
			appendUnique(config.permissions.allow, lists.allow);
			permissionCount = lists.allow.length + lists.deny.length + lists.ask.length;
		}
		config.sources.push({ ...source, hookCount, permissionCount });
	}
	if (hooksDisabled) {
		config.hooks = [];
		for (const source of config.sources) source.hookCount = 0;
	}
	for (const warning of config.warnings) logger.warn("Claude compatibility", { warning });
	return config;
}
