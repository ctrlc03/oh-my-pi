/**
 * Per-path permission rules for the file tools (`tools.pathRules`,
 * `tools.outsideProject`).
 *
 * Rules are ordered and FIRST-MATCH, like `bash.patterns`: the first rule that
 * applies to the tool and whose glob matches the path decides. Put exceptions
 * before the broader rule they carve out of.
 *
 * A path is judged in two forms — as the model spelled it (`..` normalised) and
 * with symlinks resolved — and the stricter verdict wins (deny > prompt >
 * allow). That is what stops a link inside the project from reaching a denied
 * file or the outside world.
 *
 * Enforcement points: the file tools' `approval(args)` (deny → refusal, prompt →
 * the regular approval prompt), result filtering in grep/glob/find/ast_grep,
 * and execute-time checks where a tool resolves the final path itself.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { normalizeToolName } from "./builtin-names";
import { expandPath, normalizePathLikeInput } from "./path-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { cfgToolsOutsideProject, cfgToolsPathRules } from "./settings";

export type PathRuleAction = "allow" | "deny" | "prompt";

export interface PathRule {
	/** Tools the rule applies to. Omitted: every file tool ({@link PATH_RULE_TOOLS}). */
	tools?: string[];
	/** Glob matched against the absolute and project-relative path; see {@link evaluatePathRule}. */
	glob: string;
	action: PathRuleAction;
}

/** Tools `tools.pathRules` and `tools.outsideProject` cover when a rule names no tools. */
export const PATH_RULE_TOOLS: readonly string[] = [
	"read",
	"edit",
	"write",
	"ast_edit",
	"ast_grep",
	"grep",
	"glob",
	"find",
];

export interface PathRuleDecision {
	action: PathRuleAction;
	/** The rule that decided; absent for the outside-project check and the default allow. */
	rule?: PathRule;
	/** The decision came from `tools.outsideProject`. */
	outsideProject?: boolean;
	/** Model- and user-readable explanation for a non-allow decision. */
	reason?: string;
}

export interface PathRuleOptions {
	/** Extra roots counted as inside the project (multi-root sessions). */
	additionalRoots?: readonly string[];
	/** Skip `tools.outsideProject`: for paths the harness itself provides, such as internal-URL targets. */
	ignoreOutsideProject?: boolean;
}

/** The slice of `ToolSession` path-rule evaluation reads. */
export interface PathRuleSession {
	settings: Settings;
	cwd: string;
	additionalDirectories?: string[];
}

const ACTIONS: ReadonlySet<string> = new Set(["allow", "deny", "prompt"]);
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const ACTION_RANK: Record<PathRuleAction, number> = { allow: 0, prompt: 1, deny: 2 };

function normalizeAction(value: unknown): PathRuleAction | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return ACTIONS.has(lowered) ? (lowered as PathRuleAction) : undefined;
}

function parseRule(item: unknown): PathRule | undefined {
	if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	const action = normalizeAction(record.action);
	if (typeof record.glob !== "string" || record.glob.trim().length === 0 || !action) return undefined;
	const rule: PathRule = { glob: record.glob.trim(), action };
	const rawTools = record.tools;
	if (rawTools !== undefined) {
		const list = typeof rawTools === "string" ? [rawTools] : rawTools;
		if (!Array.isArray(list) || !list.every(entry => typeof entry === "string")) return undefined;
		rule.tools = list.map(name => normalizeToolName(name.trim()));
	}
	return rule;
}

const parsedRules = new WeakMap<object, PathRule[]>();

/** Normalise a raw `tools.pathRules` value. Malformed items are dropped (and logged once per configured array). */
export function parsePathRules(value: unknown): PathRule[] {
	if (!Array.isArray(value)) return [];
	let parsed = parsedRules.get(value);
	if (!parsed) {
		parsed = value.map(parseRule).filter((rule): rule is PathRule => rule !== undefined);
		if (parsed.length !== value.length) {
			logger.warn("tools.pathRules: ignoring malformed rules (need glob and action allow|deny|prompt)", {
				ignored: value.length - parsed.length,
			});
		}
		parsedRules.set(value, parsed);
	}
	return parsed;
}

function ruleAppliesTo(rule: PathRule, tool: string): boolean {
	return rule.tools ? rule.tools.includes(tool) : PATH_RULE_TOOLS.includes(tool);
}

// ──────────────────────────────────────────────────────────────────────────
// Glob matching
// ──────────────────────────────────────────────────────────────────────────

const compiledGlobs = new Map<string, Bun.Glob[]>();

function fold(value: string): string {
	return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

/**
 * A glob without `/` matches the basename at any depth (`.env*` behaves like a recursive `.env*`).
 * `~/` expands to the home directory. A trailing `/**` also matches the
 * directory itself.
 */
function compileGlob(glob: string): Bun.Glob[] {
	const cached = compiledGlobs.get(glob);
	if (cached) return cached;
	let pattern = glob.replaceAll("\\", "/");
	if (pattern === "~" || pattern.startsWith("~/")) pattern = os.homedir().replaceAll("\\", "/") + pattern.slice(1);
	if (pattern.startsWith("./")) pattern = pattern.slice(2);
	if (!pattern.includes("/")) pattern = `**/${pattern}`;
	pattern = fold(pattern);
	const patterns = [pattern];
	if (pattern.endsWith("/**") && pattern.length > 3) patterns.push(pattern.slice(0, -3));
	const compiled = patterns.map(entry => new Bun.Glob(entry));
	compiledGlobs.set(glob, compiled);
	return compiled;
}

/** `value` and each of its ancestor directories, nearest first. */
function* withAncestors(value: string): Generator<string> {
	let current = value;
	while (current.length > 0) {
		yield current;
		const slash = current.lastIndexOf("/");
		if (slash < 0) return;
		current = slash === 0 ? "" : current.slice(0, slash);
	}
}

function globMatchesAny(glob: string, forms: readonly string[]): boolean {
	const compiled = compileGlob(glob);
	for (const form of forms) {
		for (const candidate of withAncestors(fold(form))) {
			if (compiled.some(matcher => matcher.match(candidate))) return true;
		}
	}
	return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────────────────

function toSlashes(value: string): string {
	return path.sep === "/" ? value : value.replaceAll(path.sep, "/");
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") || value.startsWith(`~${path.sep}`)
		? path.join(os.homedir(), value.slice(1))
		: value;
}

/** Realpath of `target`, tolerating a missing tail and following dangling links. */
function resolveReal(target: string, depth = 0): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		// Missing, dangling, or unsearchable: resolve the parent and re-apply the last component.
	}
	const parent = path.dirname(target);
	if (parent === target) return target;
	const realParent = resolveReal(parent, depth);
	const joined = path.join(realParent, path.basename(target));
	try {
		if (depth < 32 && fs.lstatSync(joined).isSymbolicLink()) {
			return resolveReal(path.resolve(realParent, fs.readlinkSync(joined)), depth + 1);
		}
	} catch {
		// Not present: nothing further to follow.
	}
	return joined;
}

const repoRoots = new Map<string, string | undefined>();

/** Nearest ancestor of `cwd` holding `.git`, ignoring a repo rooted at the home directory or `/`. */
function findRepoRoot(cwd: string): string | undefined {
	if (repoRoots.has(cwd)) return repoRoots.get(cwd);
	const home = resolveReal(os.homedir());
	let found: string | undefined;
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			const real = resolveReal(dir);
			found = real === home || real === path.parse(real).root ? undefined : dir;
			break;
		}
		if (path.dirname(dir) === dir) break;
	}
	if (repoRoots.size > 64) repoRoots.clear();
	repoRoots.set(cwd, found);
	return found;
}

function isInside(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface ProjectRoots {
	lexical: string[];
	real: string[];
}

function projectRoots(cwd: string, additionalRoots: readonly string[] | undefined): ProjectRoots {
	const lexical = new Set<string>([path.resolve(cwd)]);
	const repo = findRepoRoot(path.resolve(cwd));
	if (repo) lexical.add(repo);
	for (const extra of additionalRoots ?? []) lexical.add(path.resolve(cwd, expandHome(extra)));
	const lexicalRoots = [...lexical];
	return { lexical: lexicalRoots, real: [...new Set(lexicalRoots.map(root => resolveReal(root)))] };
}

/** The forms a rule glob is tested against: absolute, plus project-relative under each root. */
function candidateForms(candidate: string, roots: readonly string[]): string[] {
	const forms = [toSlashes(candidate)];
	for (const root of roots) {
		if (!isInside(candidate, root)) continue;
		const relative = path.relative(root, candidate);
		forms.push(relative === "" ? "." : toSlashes(relative));
	}
	return forms;
}

function displayPath(candidate: string, cwd: string): string {
	const root = path.resolve(cwd);
	return isInside(candidate, root) ? toSlashes(path.relative(root, candidate) || ".") : candidate;
}

function decideCandidate(
	candidate: string,
	roots: readonly string[],
	rules: readonly PathRule[],
	outside: PathRuleAction,
	cwd: string,
): PathRuleDecision {
	const forms = candidateForms(candidate, roots);
	for (const rule of rules) {
		if (!globMatchesAny(rule.glob, forms)) continue;
		if (rule.action === "allow") return { action: "allow", rule };
		return {
			action: rule.action,
			rule,
			reason: `Path "${displayPath(candidate, cwd)}" matches tools.pathRules ${rule.action} rule (glob: "${rule.glob}")`,
		};
	}
	if (outside !== "allow" && !roots.some(root => isInside(candidate, root))) {
		return {
			action: outside,
			outsideProject: true,
			reason: `Path "${candidate}" is outside the project; tools.outsideProject is "${outside}"`,
		};
	}
	return { action: "allow" };
}

/** Per-instance memo of directory realpaths, shared across the many lookups of one search. */
export type RealpathCache = Map<string, string>;

function realOf(abs: string, cache: RealpathCache | undefined): string {
	if (!cache) return resolveReal(abs);
	const dir = path.dirname(abs);
	let realDir = cache.get(dir);
	if (realDir === undefined) {
		realDir = resolveReal(dir);
		cache.set(dir, realDir);
	}
	const joined = path.join(realDir, path.basename(abs));
	try {
		return fs.lstatSync(joined).isSymbolicLink() ? resolveReal(abs) : joined;
	} catch {
		return joined;
	}
}

function evaluateWith(
	settings: Settings,
	tool: string,
	targetPath: string,
	cwd: string,
	options: PathRuleOptions,
	cache: RealpathCache | undefined,
	roots: ProjectRoots | undefined,
): PathRuleDecision {
	const canonicalTool = normalizeToolName(tool);
	const rules = parsePathRules(cfgToolsPathRules.get(settings)).filter(rule => ruleAppliesTo(rule, canonicalTool));
	const configured = normalizeAction(cfgToolsOutsideProject.get(settings)) ?? "allow";
	const outside = options.ignoreOutsideProject || !PATH_RULE_TOOLS.includes(canonicalTool) ? "allow" : configured;
	if (rules.length === 0 && outside === "allow") return { action: "allow" };

	const abs = path.resolve(cwd, expandPath(targetPath));
	const real = realOf(abs, cache);
	const resolvedRoots = roots ?? projectRoots(cwd, options.additionalRoots);
	const lexical = decideCandidate(abs, resolvedRoots.lexical, rules, outside, cwd);
	if (real === abs) return lexical;
	const resolved = decideCandidate(real, resolvedRoots.real, rules, outside, cwd);
	return ACTION_RANK[resolved.action] > ACTION_RANK[lexical.action] ? resolved : lexical;
}

/**
 * Judge `targetPath` for `tool` against `tools.pathRules` and `tools.outsideProject`.
 *
 * `targetPath` is a filesystem path as the model supplied it: relative to `cwd`,
 * absolute, or `~/…`; `..` is normalised and symlinks are resolved. The glob is
 * tested against the absolute path and the path relative to the session cwd (and
 * repo root); a glob without `/` matches the basename at any depth; a glob that
 * matches a directory covers everything beneath it. On macOS and Windows the
 * match is case-insensitive.
 *
 * The first applicable rule that matches decides. An `allow` match exempts the
 * path from `tools.outsideProject` but is not an approval grant: the normal
 * approval mode still applies. With no matching rule, a path outside the cwd /
 * repo root (and `additionalRoots`) takes the `tools.outsideProject` action.
 *
 * Returns `{ action: "allow" }` when nothing restricts the path. Internal URLs
 * are not paths: callers evaluate only what they resolve to a filesystem path.
 */
export function evaluatePathRule(
	settings: Settings,
	tool: string,
	targetPath: string,
	cwd: string,
	options: PathRuleOptions = {},
): PathRuleDecision {
	return evaluateWith(settings, tool, targetPath, cwd, options, undefined, undefined);
}

/** Strictest decision (deny > prompt > allow) across `targets`; the first of equal strictness wins. */
export function evaluatePathRules(
	session: PathRuleSession,
	tool: string,
	targets: Iterable<string>,
	options: PathRuleOptions = {},
): PathRuleDecision {
	const merged: PathRuleOptions = {
		...options,
		additionalRoots: [...(session.additionalDirectories ?? []), ...(options.additionalRoots ?? [])],
	};
	let strictest: PathRuleDecision = { action: "allow" };
	for (const target of targets) {
		const decision = evaluatePathRule(session.settings, tool, target, session.cwd, merged);
		if (ACTION_RANK[decision.action] > ACTION_RANK[strictest.action]) strictest = decision;
		if (strictest.action === "deny") break;
	}
	return strictest;
}

/** Whether any path rule or `tools.outsideProject` could restrict `tool`: the cheap gate for hot paths. */
export function pathRulesActive(settings: Settings, tool: string): boolean {
	const canonicalTool = normalizeToolName(tool);
	if (parsePathRules(cfgToolsPathRules.get(settings)).some(rule => ruleAppliesTo(rule, canonicalTool))) return true;
	return (
		PATH_RULE_TOOLS.includes(canonicalTool) &&
		(normalizeAction(cfgToolsOutsideProject.get(settings)) ?? "allow") !== "allow"
	);
}

/**
 * Execute-time guard: refuse `absolutePath` (what a tool actually resolved to, after suffix recovery
 * and symlinks) when a `tools.pathRules` deny covers it. The approval gate judged the path as spelled
 * and settled any prompt, so only a deny can still apply. Pass `ignoreOutsideProject` for targets the
 * harness itself supplies (internal URLs).
 */
export function assertPathNotDenied(
	session: PathRuleSession,
	tool: string,
	absolutePath: string,
	options?: PathRuleOptions,
): void {
	if (!pathRulesActive(session.settings, tool)) return;
	const decision = evaluatePathRules(session, tool, [absolutePath], options);
	if (decision.action === "deny") throw new ToolError(`Access denied: ${decision.reason}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Path extraction from tool arguments
// ──────────────────────────────────────────────────────────────────────────

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Filesystem paths a `path`-style tool argument could name. Deliberately
 * generous: the raw value, the pieces of a `;`/newline list, and each piece
 * with a `[path#TAG]` wrapper, `?question`, `#fragment`, or `:selector` /
 * `archive:member` suffix cut away. Over-generating only ever adds a stricter
 * verdict. Internal URLs and web URLs are skipped; `file://` is unwrapped.
 */
export function pathArgCandidates(raw: string): string[] {
	const out = new Set<string>();
	const add = (value: string): void => {
		const trimmed = value.trim();
		if (trimmed.length > 0) out.add(trimmed);
	};
	for (const piece of raw.split(/[;\n]/)) {
		let part = expandPath(piece.trim());
		if (part.length === 0) continue;
		if (/^file:\/\//i.test(part)) part = part.slice("file://".length);
		else if (URL_SCHEME.test(part)) continue;
		const wrapper = /^\[(.*)#[0-9A-Za-z]+\]$/s.exec(part);
		if (wrapper?.[1]) part = expandPath(wrapper[1]);
		add(part);
		const unquoted = normalizePathLikeInput(part);
		if (unquoted !== part) add(unquoted);
		for (const separator of ["?", "#"]) {
			const cut = part.indexOf(separator);
			if (cut > 0) add(part.slice(0, cut));
		}
		for (let colon = part.indexOf(":"); colon >= 0; colon = part.indexOf(":", colon + 1)) {
			if (colon > 1) add(part.slice(0, colon));
		}
	}
	return [...out];
}

/** The non-glob directory prefix of a search-path entry (a `src/` + recursive `*.ts` glob gives `src`; a bare glob gives `.`). */
function searchBase(entry: string): string {
	const segments = entry.split("/");
	const base: string[] = [];
	for (const segment of segments) {
		if (GLOB_CHARS.test(segment)) break;
		base.push(segment);
	}
	const joined = base.join("/");
	return joined.length === 0 ? (entry.startsWith("/") ? "/" : ".") : joined;
}

/** Search roots named by a grep/glob/ast_grep/ast_edit `path`-style argument: string, list, or delimited list. */
export function searchRootCandidates(raw: string | readonly string[] | undefined): string[] {
	const entries = typeof raw === "string" ? [raw] : (raw ?? []);
	const out = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length === 0) {
			out.add(".");
			continue;
		}
		for (const piece of trimmed.split(/[;\n,]/)) {
			for (const candidate of pathArgCandidates(piece)) out.add(searchBase(candidate));
		}
	}
	if (out.size === 0) out.add(".");
	return [...out];
}

// ──────────────────────────────────────────────────────────────────────────
// Approval integration
// ──────────────────────────────────────────────────────────────────────────

function tierOf(decision: ToolApprovalDecision): ToolTier {
	return typeof decision === "string" ? decision : decision.tier;
}

/**
 * Fold a path-rule verdict into a tool's own approval decision. `deny` becomes
 * a tool-policy deny (a refusal the model can read), `prompt` an explicit
 * prompt honored in every approval mode; `allow` leaves `base` untouched.
 */
export function applyPathRuleApproval(base: ToolApprovalDecision, decision: PathRuleDecision): ToolApprovalDecision {
	if (decision.action === "allow") return base;
	if (typeof base !== "string" && base.policy === "deny") return base;
	return {
		tier: tierOf(base),
		override: true,
		policy: decision.action,
		...(decision.reason ? { reason: decision.reason } : {}),
	};
}

/** Approval decision for a tool that acts on specific `targets`: strictest verdict across them. */
export function pathRuleApproval(
	session: PathRuleSession,
	tool: string,
	base: ToolApprovalDecision,
	targets: Iterable<string>,
	options?: PathRuleOptions,
): ToolApprovalDecision {
	if (!pathRulesActive(session.settings, tool)) return base;
	return applyPathRuleApproval(base, evaluatePathRules(session, tool, targets, options));
}

/**
 * Approval decision for a search tool: only `prompt` gates the call. A denied
 * root is not refused — {@link createPathRuleFilter} drops what it covers from the results.
 */
export function searchRootApproval(
	session: PathRuleSession,
	tool: string,
	base: ToolApprovalDecision,
	roots: Iterable<string>,
): ToolApprovalDecision {
	if (!pathRulesActive(session.settings, tool)) return base;
	let prompt: PathRuleDecision | undefined;
	for (const root of roots) {
		const decision = evaluatePathRules(session, tool, [root]);
		if (decision.action === "prompt") prompt ??= decision;
	}
	return prompt ? applyPathRuleApproval(base, prompt) : base;
}

// ──────────────────────────────────────────────────────────────────────────
// Result filtering for search tools
// ──────────────────────────────────────────────────────────────────────────

export interface PathRuleFilter {
	/** Whether `targetPath` (absolute, or relative to the session cwd) must be left out of results. Counts what it hides. */
	hides(targetPath: string): boolean;
	/** Number of distinct paths hidden so far. */
	readonly hiddenCount: number;
	/** Model-facing note appended to results; undefined while nothing was hidden. */
	note(): string | undefined;
}

/**
 * Filter for a search tool's results, or `undefined` when no rule can restrict
 * the tool (the default: zero cost).
 *
 * A `deny` match is hidden. A `prompt` match is hidden too, unless one of the
 * explicit search `roots` itself resolved to `prompt`: the user already approved
 * that root at the gate, so what lies under it is in scope. A hidden path is
 * still reachable by naming it directly, which triggers the prompt.
 */
export function createPathRuleFilter(
	session: PathRuleSession,
	tool: string,
	roots: Iterable<string>,
): PathRuleFilter | undefined {
	const { settings, cwd } = session;
	if (!pathRulesActive(settings, tool)) return undefined;
	const options: PathRuleOptions = { additionalRoots: session.additionalDirectories };
	const cache: RealpathCache = new Map();
	const projectRootSet = projectRoots(cwd, options.additionalRoots);
	let rootApproved = false;
	for (const root of roots) {
		if (evaluateWith(settings, tool, root, cwd, options, cache, projectRootSet).action === "prompt")
			rootApproved = true;
	}
	const hiddenPaths = new Set<string>();
	return {
		hides(targetPath: string): boolean {
			const decision = evaluateWith(settings, tool, targetPath, cwd, options, cache, projectRootSet);
			const hidden = decision.action === "deny" || (decision.action === "prompt" && !rootApproved);
			if (hidden) hiddenPaths.add(path.resolve(cwd, targetPath));
			return hidden;
		},
		get hiddenCount() {
			return hiddenPaths.size;
		},
		note() {
			return hiddenPaths.size === 0
				? undefined
				: `${hiddenPaths.size} path(s) omitted by tools.pathRules / tools.outsideProject. Name a path directly to request access.`;
		},
	};
}
