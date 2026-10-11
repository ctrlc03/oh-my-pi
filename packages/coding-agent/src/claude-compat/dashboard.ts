/** Rows for the Extension Control Center: the Claude Code hooks this session loaded from settings.json. */
import { isProviderEnabled } from "../capability";
import type { Settings } from "../config/settings";
import { cfgClaudeHooks } from "../extensibility/settings";
import type { Extension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { loadClaudeCompatConfig } from "./config";
import { resolveClaudeCompatMode } from "./mode";

export async function loadClaudeHookExtensions(
	cwd: string,
	settings: Settings,
	disabledIds: readonly string[],
): Promise<Extension[]> {
	if (!isProviderEnabled("claude")) return [];
	const mode = resolveClaudeCompatMode(settings, cfgClaudeHooks);
	if (mode === "off") return [];
	// Disabled hooks stay listed (so they can be re-enabled) but are marked, hence no `disabledIds` passed to the loader.
	const config = await loadClaudeCompatConfig({ cwd, hooks: mode, permissions: "off" });
	const disabled = new Set(disabledIds);
	return config.hooks.map(hook => ({
		id: hook.id,
		kind: "hook",
		name: hook.command,
		displayName: `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}`,
		description: `Claude Code ${hook.event} hook (${hook.timeoutSec}s timeout)`,
		trigger: `${hook.event}:${hook.matcher ?? "*"}`,
		path: hook.source.path,
		source: { provider: "claude", providerName: "Claude Code", level: hook.source.level },
		state: disabled.has(hook.id) ? "disabled" : "active",
		disabledReason: disabled.has(hook.id) ? "item-disabled" : undefined,
		raw: { type: hook.event, tool: hook.matcher ?? "*", command: hook.command },
	}));
}
