/**
 * Maps Claude Code `permissions.allow` / `deny` / `ask` rules onto omp's own policy surfaces:
 *
 * - `Bash(...)` rules             -> `bash.patterns` (`{ match, approval }`)
 * - `Read/Edit/Write/Grep/Glob(path)` -> `tools.pathRules` (see `tools/path-rules.ts`)
 * - bare tool rules (`Bash`, `Edit`, `WebSearch`, `mcp__server__tool`) -> `tools.approval`
 * - `WebFetch(...)`, `mcp__server` -> runtime rules the hook extension enforces itself
 *   (omp has no setting that can express them)
 *
 * Claude evaluates deny, then ask, then allow. `bash.patterns` and `tools.pathRules` are ordered
 * first-match lists, so emitted rules are ordered deny, ask, user's own rules, allow: a Claude restriction
 * always applies, and Claude's `allow` never overrides a rule the user wrote for omp.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { cfgBashPatterns } from "../exec/settings";
import { createMCPToolName } from "../mcp/tool-bridge";
import { type PathRule, parsePathRules } from "../tools/path-rules";
import { cfgToolsApproval, cfgToolsPathRules } from "../tools/settings";
import type { ClaudePermissionLists } from "./config";
import { ompToolsForClaudeName } from "./tool-names";

export type ClaudeRuleAction = "allow" | "deny" | "prompt";

export interface BashPatternRule {
	match: string;
	approval: ClaudeRuleAction;
}

/** A rule only the hook extension can enforce. `allow` rules are kept for diagnostics but grant nothing. */
export type RuntimeRule =
	| { kind: "fetch"; domain: string | undefined; action: ClaudeRuleAction; source: string }
	| { kind: "tool-prefix"; prefix: string; action: ClaudeRuleAction; source: string };

export interface MappedClaudePermissions {
	bashPatterns: BashPatternRule[];
	/** Path rules placed before the user's own: deny. */
	pathRulesBefore: PathRule[];
	/** Path rules placed after the user's last deny rule: ask (prompt). */
	pathRulesAsk: PathRule[];
	/** Path rules placed after the user's own: allow. */
	pathRulesAfter: PathRule[];
	/** Bash patterns split the same way. */
	bashBefore: BashPatternRule[];
	bashAsk: BashPatternRule[];
	bashAfter: BashPatternRule[];
	/** `tools.approval` entries, already reduced to the strictest action per tool. */
	toolPolicies: Record<string, ClaudeRuleAction>;
	runtimeRules: RuntimeRule[];
	/** Entries that could not be mapped, with the reason. */
	unsupported: string[];
}

const ACTION_BY_LIST = { deny: "deny", ask: "prompt", allow: "allow" } as const;
const STRICTNESS: Record<ClaudeRuleAction, number> = { allow: 0, prompt: 1, deny: 2 };

const READ_PATH_TOOLS = ["read", "grep", "glob", "find", "ast_grep"];
const WRITE_PATH_TOOLS = ["edit", "write", "ast_edit"];

interface ParsedRule {
	tool: string;
	specifier: string | undefined;
}

export function parseClaudeRule(rule: string): ParsedRule | undefined {
	const match = /^([^()\s]+)(?:\s*\(([\s\S]*)\))?$/.exec(rule.trim());
	if (!match) return undefined;
	const specifier = match[2]?.trim();
	return { tool: match[1], specifier: specifier === "" || specifier === "*" ? undefined : specifier };
}

/** Claude path specifiers: `./x` and `x` are project-relative, `/x` is project-root-relative, `//x` is absolute. */
export function claudePathToGlob(specifier: string): string {
	if (specifier.startsWith("//")) return specifier.slice(1);
	if (specifier.startsWith("~/") || specifier === "~") return specifier;
	if (specifier.startsWith("/")) return specifier.slice(1);
	return specifier.startsWith("./") ? specifier.slice(2) : specifier;
}

/** `git push:*` is Claude's prefix form: the command itself, or the command followed by arguments. */
export function claudeBashSpecifierToPatterns(specifier: string): string[] {
	if (specifier.endsWith(":*")) {
		const prefix = specifier.slice(0, -2).trim();
		return prefix === "" ? ["*"] : [prefix, `${prefix} *`];
	}
	return [specifier];
}

function stricter(a: ClaudeRuleAction | undefined, b: ClaudeRuleAction): ClaudeRuleAction {
	return a === undefined || STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

function mcpToolName(rule: string): { exact?: string; prefix?: string } | undefined {
	const match = /^mcp__(.+?)(?:__(.+))?$/.exec(rule);
	if (!match) return undefined;
	const [, server, tool] = match;
	if (tool === undefined || tool === "*") return { prefix: createMCPToolName(server, "x").slice(0, -1) };
	return { exact: createMCPToolName(server, tool) };
}

export function mapClaudePermissions(lists: ClaudePermissionLists): MappedClaudePermissions {
	const mapped: MappedClaudePermissions = {
		bashPatterns: [],
		pathRulesBefore: [],
		pathRulesAsk: [],
		pathRulesAfter: [],
		bashBefore: [],
		bashAsk: [],
		bashAfter: [],
		toolPolicies: {},
		runtimeRules: [],
		unsupported: [],
	};

	for (const list of ["deny", "ask", "allow"] as const) {
		const action: ClaudeRuleAction = ACTION_BY_LIST[list];
		const bashBucket =
			action === "deny" ? mapped.bashBefore : action === "prompt" ? mapped.bashAsk : mapped.bashAfter;
		const pathBucket =
			action === "deny" ? mapped.pathRulesBefore : action === "prompt" ? mapped.pathRulesAsk : mapped.pathRulesAfter;
		for (const raw of lists[list]) {
			const rule = parseClaudeRule(raw);
			if (!rule) {
				mapped.unsupported.push(`${list}: ${raw} (unparseable)`);
				continue;
			}
			const label = `${list}: ${raw}`;

			if (rule.tool === "Bash") {
				if (rule.specifier === undefined) {
					mapped.toolPolicies.bash = stricter(mapped.toolPolicies.bash, action);
					continue;
				}
				for (const match of claudeBashSpecifierToPatterns(rule.specifier)) {
					bashBucket.push({ match, approval: action });
				}
				continue;
			}

			if (rule.tool === "WebFetch") {
				if (rule.specifier !== undefined && !rule.specifier.startsWith("domain:")) {
					mapped.unsupported.push(`${label} (only domain: specifiers are supported)`);
					continue;
				}
				mapped.runtimeRules.push({
					kind: "fetch",
					domain: rule.specifier?.slice("domain:".length).trim().toLowerCase(),
					action,
					source: raw,
				});
				continue;
			}

			const pathTools =
				rule.tool === "Read"
					? READ_PATH_TOOLS
					: rule.tool === "Grep"
						? ["grep", "find", "ast_grep"]
						: rule.tool === "Glob"
							? ["glob", "find"]
							: ompToolsForClaudeName(rule.tool).filter(tool => WRITE_PATH_TOOLS.includes(tool));
			if (pathTools.length > 0 && rule.specifier !== undefined) {
				pathBucket.push({
					tools: [...pathTools],
					glob: claudePathToGlob(rule.specifier),
					action,
				});
				continue;
			}

			if (rule.tool.startsWith("mcp__")) {
				const names = mcpToolName(rule.tool);
				if (names?.exact) {
					mapped.toolPolicies[names.exact] = stricter(mapped.toolPolicies[names.exact], action);
				} else if (names?.prefix) {
					mapped.runtimeRules.push({ kind: "tool-prefix", prefix: names.prefix, action, source: raw });
				} else {
					mapped.unsupported.push(`${label} (unrecognised MCP rule)`);
				}
				continue;
			}

			const ompTools = ompToolsForClaudeName(rule.tool);
			if (ompTools.length === 0) {
				mapped.unsupported.push(`${label} (no omp equivalent for ${rule.tool})`);
				continue;
			}
			if (rule.specifier !== undefined) {
				mapped.unsupported.push(`${label} (specifiers are not supported for ${rule.tool})`);
				continue;
			}
			for (const tool of ompTools) mapped.toolPolicies[tool] = stricter(mapped.toolPolicies[tool], action);
		}
	}
	mapped.bashPatterns = [...mapped.bashBefore, ...mapped.bashAsk, ...mapped.bashAfter];
	return mapped;
}

/** Structural equality that ignores key order: `parsePathRules` re-emits items with its own field order. */
function sameRule(a: unknown, b: unknown): boolean {
	const canonical = (value: unknown): string =>
		JSON.stringify(value, (_key, nested) =>
			nested !== null && typeof nested === "object" && !Array.isArray(nested)
				? Object.fromEntries(Object.entries(nested).sort(([x], [y]) => x.localeCompare(y)))
				: nested,
		);
	return canonical(a) === canonical(b);
}

/** `existing` without any of `ours`, so applying the same rules twice (subagents, `/new`) does not stack them. */
function withoutOurs<T>(existing: readonly T[], ours: readonly T[]): T[] {
	return existing.filter(item => !ours.some(rule => sameRule(rule, item)));
}

/** Whether a raw `bash.patterns` item is a user deny rule. */
function isDenyBashPattern(item: unknown): boolean {
	if (!item || typeof item !== "object" || Array.isArray(item)) return false;
	const approval = (item as Record<string, unknown>).approval;
	return typeof approval === "string" && approval.trim().toLowerCase() === "deny";
}

/**
 * `existing` with `additions` inserted after its last deny rule. Rules are first-match, so Claude `ask`
 * rules must neither shadow a user deny (turning a refusal into an approvable prompt) nor sit behind a
 * user allow that would swallow them.
 */
function insertAfterLastDeny<T>(existing: readonly T[], isDeny: (item: T) => boolean, additions: readonly T[]): T[] {
	const at = existing.findLastIndex(isDeny) + 1;
	return [...existing.slice(0, at), ...additions, ...existing.slice(at)];
}

/**
 * Write the mapped rules into `settings`' runtime-override layer (never persisted, never the user's files),
 * merged with whatever the other layers already provide. Claude deny rules come first, then the user's rules
 * up to their last deny, then Claude ask rules, the rest of the user's rules, and Claude allow rules. Idempotent.
 */
export function applyClaudePermissions(settings: Settings, mapped: MappedClaudePermissions): void {
	if (mapped.bashPatterns.length > 0) {
		const existing = withoutOurs<unknown>(cfgBashPatterns.get(settings), mapped.bashPatterns);
		settings.writeValue(
			cfgBashPatterns,
			[
				...mapped.bashBefore,
				...insertAfterLastDeny(existing, isDenyBashPattern, mapped.bashAsk),
				...mapped.bashAfter,
			],
			"override",
		);
	}

	const pathRules = [...mapped.pathRulesBefore, ...mapped.pathRulesAsk, ...mapped.pathRulesAfter];
	if (pathRules.length > 0) {
		const existing = withoutOurs(parsePathRules(cfgToolsPathRules.get(settings)), pathRules);
		settings.writeValue(
			cfgToolsPathRules,
			[
				...mapped.pathRulesBefore,
				...insertAfterLastDeny(existing, rule => rule.action === "deny", mapped.pathRulesAsk),
				...mapped.pathRulesAfter,
			],
			"override",
		);
	}

	const toolNames = Object.keys(mapped.toolPolicies);
	if (toolNames.length > 0) {
		const current: Record<string, unknown> = { ...cfgToolsApproval.get(settings) };
		const merged: Record<string, unknown> = { ...current };
		for (const tool of toolNames) {
			const claude = mapped.toolPolicies[tool];
			const userValue = current[tool];
			const user = typeof userValue === "string" ? userValue.trim().toLowerCase() : undefined;
			// The user's own policy stands unless Claude's is stricter: Claude `allow` never loosens it.
			merged[tool] =
				user !== undefined && Object.hasOwn(STRICTNESS, user) ? stricter(user as ClaudeRuleAction, claude) : claude;
		}
		settings.writeValue(cfgToolsApproval, merged, "override");
	}

	for (const entry of mapped.unsupported) logger.warn("Claude permission rule not mapped", { entry });
}

export type RuntimeVerdict = { action: "deny" | "prompt"; rule: string } | undefined;

function hostOf(target: string): string | undefined {
	try {
		return new URL(target.trim()).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Strictest matching runtime rule for a tool call; `allow` rules match but never loosen anything. */
export function evaluateRuntimeRules(
	rules: readonly RuntimeRule[],
	ompTool: string,
	input: Record<string, unknown>,
): RuntimeVerdict {
	let verdict: RuntimeVerdict;
	for (const rule of rules) {
		if (rule.action === "allow") continue;
		const matches =
			rule.kind === "tool-prefix"
				? ompTool.startsWith(rule.prefix)
				: ompTool === "read" && typeof input.path === "string" && fetchRuleMatches(rule.domain, input.path);
		if (!matches) continue;
		if (rule.action === "deny") return { action: "deny", rule: rule.source };
		verdict ??= { action: "prompt", rule: rule.source };
	}
	return verdict;
}

function fetchRuleMatches(domain: string | undefined, target: string): boolean {
	if (!/^https?:\/\//i.test(target.trim())) return false;
	if (domain === undefined) return true;
	const host = hostOf(target);
	return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
}
