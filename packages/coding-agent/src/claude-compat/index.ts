/**
 * Claude Code compatibility for hooks and permissions, gated by `claude.hooks` / `claude.permissions`.
 * Both default to `off`, in which case nothing here touches the filesystem.
 */
import { isProviderEnabled } from "../capability";
import type { Settings } from "../config/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import { cfgClaudeHooks, cfgClaudePermissions, cfgDisabledExtensions } from "../extensibility/settings";
import { type ClaudeCompatConfig, loadClaudeCompatConfig } from "./config";
import { createClaudeHooksExtension } from "./extension";
import { resolveClaudeCompatMode } from "./mode";
import { applyClaudePermissions, mapClaudePermissions } from "./permissions";

export type { ClaudeCompatConfig, ClaudeHookCommand, ClaudeHookEvent } from "./config";
export { loadClaudeCompatConfig } from "./config";
export { resolveClaudeCompatMode } from "./mode";

export interface ClaudeCompat {
	config: ClaudeCompatConfig;
	/** Hook extension to bind to the session; absent when there is nothing to enforce. */
	extension?: ExtensionFactory;
}

/**
 * Load the admitted Claude settings files for `cwd`, write the mapped permission rules into `settings`'
 * runtime-override layer, and build the hook extension. `undefined` when both switches are off.
 */
export async function setUpClaudeCompat(cwd: string, settings: Settings): Promise<ClaudeCompat | undefined> {
	if (!isProviderEnabled("claude")) return undefined;
	const hooks = resolveClaudeCompatMode(settings, cfgClaudeHooks);
	const permissions = resolveClaudeCompatMode(settings, cfgClaudePermissions);
	if (hooks === "off" && permissions === "off") return undefined;

	const config = await loadClaudeCompatConfig({
		cwd,
		hooks,
		permissions,
		disabledIds: cfgDisabledExtensions.get(settings),
	});
	const mapped = mapClaudePermissions(config.permissions);
	applyClaudePermissions(settings, mapped);

	if (config.hooks.length === 0 && mapped.runtimeRules.length === 0) return { config };
	return {
		config,
		extension: createClaudeHooksExtension({ hooks: config.hooks, runtimeRules: mapped.runtimeRules, settings }),
	};
}
