/**
 * Agent profile definitions: a named bundle of tool selection, approval policy, path rules, model,
 * thinking level and an extra system-prompt section that a session switches between as one unit.
 *
 * A definition comes from a `profiles.<name>` settings entry or from a markdown file (frontmatter
 * fields below, body = the extra prompt); both parse through {@link parseProfile}.
 */
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { parseArrayOrCSV } from "../discovery/helpers";
import { normalizeToolNames } from "../tools/builtin-names";
import { type PathRule, parsePathRules } from "../tools/path-rules";

export type ProfileSource = "builtin" | "settings" | "user" | "project";
export type ProfileApprovalMode = "always-ask" | "write" | "yolo";
export type ProfileApprovalPolicy = "allow" | "deny" | "prompt";
export type ProfileOutsideProject = "allow" | "prompt" | "deny";

/** Name of the built-in profile that changes nothing: the session's own settings. */
export const DEFAULT_PROFILE_NAME = "build";

export interface ProfileDefinition {
	name: string;
	description?: string;
	source: ProfileSource;
	filePath?: string;
	/** Allowlist: only these tools stay active (intersected with what the session has enabled). */
	tools?: string[];
	/** Denylist: these tools are removed from the active set. Applied after `tools`. */
	disabledTools?: string[];
	/**
	 * Replaces `tools.approvalMode` while the profile is active, except that an approval mode set by
	 * a CLI flag, and the user's own mode under a project-sourced profile, are never loosened: the
	 * stricter of the two applies.
	 */
	approvalMode?: ProfileApprovalMode;
	/** Laid over `tools.approval` per tool while the profile is active; a configured `deny` is kept. */
	approval?: Record<string, ProfileApprovalPolicy>;
	/** Limits the `lsp` tool to navigation and diagnostics (no rename, file rename or applied code actions) while the profile is active. */
	lspReadOnly?: boolean;
	/** Evaluated ahead of the session's `tools.pathRules`, but never ahead of one of its `deny` rules. */
	pathRules?: PathRule[];
	/** Combined with `tools.outsideProject` by taking the stricter of the two. */
	outsideProject?: ProfileOutsideProject;
	/** Model selector (`provider/id`, a pattern, or a role alias such as `@review`), optionally with a `:level` suffix. */
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Extra system-prompt section appended while the profile is active. */
	prompt?: string;
}

export interface ParsedProfile {
	profile: ProfileDefinition | undefined;
	warnings: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const APPROVAL_MODES: Record<string, true> = { "always-ask": true, write: true, yolo: true };
const POLICIES: Record<string, true> = { allow: true, deny: true, prompt: true };

/** Tools the profile tool filter never removes: the subagent completion channel. */
export const PROFILE_PROTECTED_TOOLS: readonly string[] = ["yield"];

/** Built-ins: `build` is the session as configured; `review` is read-only code review. */
export const BUILTIN_PROFILES: readonly ProfileDefinition[] = [
	{
		name: DEFAULT_PROFILE_NAME,
		description: "Your own settings, unchanged (the default)",
		source: "builtin",
	},
	{
		name: "review",
		description: "Read-only code review: no edits, no shell",
		source: "builtin",
		tools: [
			"read",
			"grep",
			"find",
			"glob",
			"ast_grep",
			"lsp",
			"web_search",
			"trace",
			"flow",
			"recall",
			"todo",
			"ask",
			"wait",
			"think",
		],
		approval: {
			edit: "deny",
			write: "deny",
			ast_edit: "deny",
			bash: "deny",
			eval: "deny",
			task: "deny",
			github: "deny",
		},
		lspReadOnly: true,
		prompt:
			"## Review profile\n\nYou are in read-only review mode. Read, search and analyse the code; do not modify files, run commands, or delegate work. Report concrete findings ordered by severity, each with file and line, the failure it causes and the smallest fix. If you cannot verify a suspicion by reading code, say so instead of asserting it.",
	},
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toolList(value: unknown, field: string, warnings: string[]): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const list = parseArrayOrCSV(value);
	if (!list) {
		warnings.push(`${field} must be a list of tool names`);
		return undefined;
	}
	return normalizeToolNames(list.map(entry => entry.trim()).filter(Boolean));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parses one profile from its raw fields. Invalid fields are dropped with a warning so one typo
 * cannot take the profile (or the settings file) down; only an unusable name returns no profile.
 */
export function parseProfile(
	name: string,
	raw: unknown,
	source: ProfileSource,
	options: { filePath?: string; body?: string } = {},
): ParsedProfile {
	const where = options.filePath ?? `profiles.${name}`;
	const warnings: string[] = [];
	if (!NAME_PATTERN.test(name)) {
		return { profile: undefined, warnings: [`${where}: profile names use letters, digits, "-" and "_" (max 48)`] };
	}
	const fields = asRecord(raw);
	if (!fields) {
		return { profile: undefined, warnings: [`${where}: a profile must be an object`] };
	}
	const profile: ProfileDefinition = { name, source };
	if (options.filePath) profile.filePath = options.filePath;

	const description = optionalString(fields.description);
	if (description) profile.description = description;

	const fieldWarnings: string[] = [];
	const tools = toolList(fields.tools, "tools", fieldWarnings);
	if (tools) profile.tools = tools;
	const disabledTools = toolList(fields.disabledTools, "disabledTools", fieldWarnings);
	if (disabledTools) profile.disabledTools = disabledTools;

	if (fields.approvalMode !== undefined) {
		const mode = typeof fields.approvalMode === "string" ? fields.approvalMode.trim().toLowerCase() : "";
		if (Object.hasOwn(APPROVAL_MODES, mode)) profile.approvalMode = mode as ProfileApprovalMode;
		else fieldWarnings.push(`approvalMode must be always-ask, write or yolo`);
	}

	if (fields.approval !== undefined) {
		const approval = asRecord(fields.approval);
		if (!approval) {
			fieldWarnings.push("approval must map tool names to allow, deny or prompt");
		} else {
			const policies: Record<string, ProfileApprovalPolicy> = {};
			for (const [tool, value] of Object.entries(approval)) {
				const policy = typeof value === "string" ? value.trim().toLowerCase() : "";
				if (Object.hasOwn(POLICIES, policy)) policies[tool] = policy as ProfileApprovalPolicy;
				else fieldWarnings.push(`approval.${tool} must be allow, deny or prompt`);
			}
			if (Object.keys(policies).length > 0) profile.approval = policies;
		}
	}

	if (fields.pathRules !== undefined) {
		const rules = parsePathRules(fields.pathRules);
		const given = Array.isArray(fields.pathRules) ? fields.pathRules.length : 0;
		if (!Array.isArray(fields.pathRules)) fieldWarnings.push("pathRules must be a list of { glob, action, tools? }");
		else if (rules.length < given) fieldWarnings.push(`${given - rules.length} malformed pathRules entries ignored`);
		if (rules.length > 0) profile.pathRules = [...rules];
	}

	if (fields.outsideProject !== undefined) {
		const value = typeof fields.outsideProject === "string" ? fields.outsideProject.trim().toLowerCase() : "";
		if (Object.hasOwn(POLICIES, value)) profile.outsideProject = value as ProfileOutsideProject;
		else fieldWarnings.push("outsideProject must be allow, prompt or deny");
	}

	if (fields.lspReadOnly !== undefined) {
		if (typeof fields.lspReadOnly === "boolean") profile.lspReadOnly = fields.lspReadOnly;
		else fieldWarnings.push("lspReadOnly must be true or false");
	}

	const model = optionalString(fields.model);
	if (fields.model !== undefined && !model) fieldWarnings.push("model must be a non-empty selector");
	if (model) profile.model = model;

	const rawThinking = fields.thinkingLevel ?? fields.thinking;
	if (rawThinking !== undefined) {
		const level = typeof rawThinking === "string" ? parseConfiguredThinkingLevel(rawThinking) : undefined;
		if (level !== undefined) profile.thinkingLevel = level;
		else fieldWarnings.push(`thinkingLevel ${JSON.stringify(rawThinking)} is not a known level`);
	}

	const promptText = optionalString(options.body) ?? optionalString(fields.prompt);
	if (promptText) profile.prompt = promptText;

	for (const message of fieldWarnings) warnings.push(`${where}: ${message}`);
	return { profile, warnings };
}
