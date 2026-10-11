import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { cfgClaudeHooks, cfgClaudePermissions } from "../extensibility/settings";

export type ClaudeCompatMode = "off" | "user" | "all";

type ClaudeCompatSetting = typeof cfgClaudeHooks | typeof cfgClaudePermissions;

function parseMode(value: unknown): ClaudeCompatMode | undefined {
	return value === "off" || value === "user" || value === "all" ? value : undefined;
}

function globalValue(settings: Settings, setting: ClaudeCompatSetting): ClaudeCompatMode | undefined {
	let node: unknown = settings.getGlobalSettings();
	for (const segment of setting.segments) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return parseMode(node);
}

/**
 * Effective `claude.hooks` / `claude.permissions` mode. These switches arm project-controlled code
 * paths, so a project layer (`.omp/config.yml`, `.claude/settings.json`, …) must never supply them:
 * a repository could otherwise enable its own hooks. A project-sourced value is ignored and the
 * user-level (global) value, or `off`, applies instead.
 */
export function resolveClaudeCompatMode(settings: Settings, setting: ClaudeCompatSetting): ClaudeCompatMode {
	if (settings.getProvenance(setting) !== "project") return setting.get(settings);
	logger.warn("Ignoring project-level Claude compatibility setting; set it in the user config", {
		setting: setting.id,
	});
	return globalValue(settings, setting) ?? "off";
}
