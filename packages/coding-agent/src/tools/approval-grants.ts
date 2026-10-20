/**
 * Saved tool-approval choices ("Always allow" / "Deny always").
 *
 * A grant is an approval-layer rule, deliberately not a `bash.patterns` / `tools.pathRules` / `tools.approval`
 * entry: a `tools.pathRules` allow only exempts a path from the rules and `tools.outsideProject` (the approval
 * mode still prompts), and a project-level `bash.patterns` array would replace the user's own deny patterns
 * instead of extending them. Grants are consulted by {@link applyApprovalGrants} after the regular resolution:
 *
 * - a `deny` grant refuses a call that would otherwise run or prompt;
 * - an `allow` grant answers only a prompt the approval *mode* raised (`source: "mode"`). Explicit denies
 *   (tool policy, `tools.approval`, `bash.patterns`, `tools.pathRules`), explicit prompts, the critical-command
 *   prompt, and path-rule / `tools.outsideProject` prompts are never overridden.
 *
 * Session grants live in memory; project grants persist to a file in the user's agent directory keyed by the project
 * path (never inside the repository, which is untrusted), carrying a `managedBy` marker and edited only through the
 * approval prompt and `/approvals`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { CollabApprovalChoiceKind, CollabUiApproval } from "@oh-my-pi/pi-wire";
import type { ExtensionApprovalPrompt, ExtensionUIContext } from "../extensibility/extensions/types";
import {
	commandMatchesBashApprovalPattern,
	commandSegmentMatchesBashApprovalPattern,
	hasBashApprovalShellControl,
	normalizeBashApprovalPattern,
} from "./bash";
import type { ResolvedApproval } from "./approval";
import { type PathRuleSession, pathMatchesGrantGlob, resolveGrantPath } from "./path-rules";

/** The session facts grant matching reads: where relative paths resolve and which extra roots count as the project. */
export type GrantSession = Pick<PathRuleSession, "cwd" | "additionalDirectories">;

/** `customType` of the session entry recording a prompted (or grant-answered) tool approval. */
export const TOOL_APPROVAL_ENTRY_TYPE = "tool-approval";

/** Who answered: the local user, a collab guest, or a saved grant (no prompt). */
export type ToolApprovalBy = "tui" | "guest" | "grant";

export interface ToolApprovalEntryData {
	toolCallId: string;
	tool: string;
	approved: boolean;
	by: ToolApprovalBy;
	choice: CollabApprovalChoiceKind | "grant";
	reason?: string;
}

export type ApprovalGrantScope = "session" | "project";
export type ApprovalGrantEffect = "allow" | "deny";
export type ApprovalGrantKind = "bash" | "path" | "tool";

export interface ApprovalGrant {
	/** Stable: the same rule in the same scope always gets the same id. */
	id: string;
	effect: ApprovalGrantEffect;
	scope: ApprovalGrantScope;
	kind: ApprovalGrantKind;
	tool: string;
	/** `bash`: command glob (`*` wildcard). `path`: path or `tools.pathRules`-style glob. `tool`: `*`. */
	pattern: string;
	createdAt: string;
}

/** What a choice would save: the candidate derived from a prompted call. */
export interface ApprovalGrantRule {
	kind: ApprovalGrantKind;
	tool: string;
	pattern: string;
	/** The command or path the rule was derived from; an edited pattern must still cover it. */
	sample?: string;
}

/** The slice of a tool that grant derivation and matching read. */
export interface GrantSubject {
	name: string;
	/** Every path the call writes (move destinations included); `edit` provides it. */
	approvalTargets?(args: unknown): readonly string[] | undefined;
}

const PROJECT_GRANTS_DIR = "approval-grants";
const PROJECT_GRANTS_MARKER = "Managed by omp's tool approval prompt and /approvals; edit with /approvals remove.";
const PROJECT_RECHECK_MS = 1000;
const MAX_PATH_TARGETS = 8;

/** Tools whose grants are scoped to the file they write; every other tool gets a whole-tool grant. */
const PATH_GRANT_TOOLS: Record<string, true> = { edit: true, write: true };
/** CLIs whose second word picks the operation: `bun test *` rather than `bun *`. */
const SUBCOMMAND_PROGRAMS: Record<string, true> = {
	git: true,
	bun: true,
	npm: true,
	pnpm: true,
	yarn: true,
	cargo: true,
	go: true,
	docker: true,
	kubectl: true,
	gh: true,
	pip: true,
	uv: true,
	poetry: true,
	deno: true,
	rustup: true,
	brew: true,
	just: true,
	make: true,
	terraform: true,
	helm: true,
	dotnet: true,
	mvn: true,
	gradle: true,
	swift: true,
	xcodebuild: true,
};
const SCRIPT_RUNNERS: Record<string, true> = { run: true, exec: true, x: true, dlx: true };
const PLAIN_WORD = /^[A-Za-z][\w:-]*$/u;
const GLOB_META = /[*?[\]{}]/u;

// ──────────────────────────────────────────────────────────────────────────
// Rule derivation
// ──────────────────────────────────────────────────────────────────────────

/**
 * The narrowest sensible bash pattern for `command`: program plus subcommand (`bun test *`, `bun run build *`)
 * for the CLIs that have one, else the exact command. `undefined` for compound or shell-controlled lines (an
 * allow never rides those) and for commands containing a literal `*` (it would read as a wildcard).
 */
export function deriveBashGrantPattern(command: string): string | undefined {
	const normalized = normalizeBashApprovalPattern(command);
	if (normalized === "" || normalized.includes("\n") || normalized.includes("*")) return undefined;
	if (hasBashApprovalShellControl(command)) return undefined;
	const tokens = normalized.split(" ");
	const [program, sub, third] = tokens;
	if (program && Object.hasOwn(SUBCOMMAND_PROGRAMS, program) && sub && PLAIN_WORD.test(sub)) {
		const prefix =
			Object.hasOwn(SCRIPT_RUNNERS, sub) && third && PLAIN_WORD.test(third) ? [program, sub, third] : [program, sub];
		return prefix.length === tokens.length ? prefix.join(" ") : `${prefix.join(" ")} *`;
	}
	return normalized;
}

/** `value[key]` when `value` is an object that has it. */
function fieldOf(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function callTargets(tool: GrantSubject, args: unknown): readonly string[] {
	const targets = tool.approvalTargets?.(args);
	if (targets) return targets;
	const direct = fieldOf(args, "path");
	return typeof direct === "string" ? [direct] : [];
}

function bashCommand(args: unknown): string {
	const command = fieldOf(args, "command");
	return typeof command === "string" ? command : "";
}

/**
 * The rules "Always allow" / "Deny always" would save for this call; empty when no sensible narrow rule
 * exists (compound bash, unknown or internal-URL write targets) and the prompt offers once/deny only.
 */
export function deriveGrantRules(tool: GrantSubject, args: unknown, cwd: string): ApprovalGrantRule[] {
	if (tool.name === "bash") {
		const command = bashCommand(args);
		const pattern = deriveBashGrantPattern(command);
		return pattern ? [{ kind: "bash", tool: "bash", pattern, sample: command }] : [];
	}
	if (Object.hasOwn(PATH_GRANT_TOOLS, tool.name)) {
		const targets = callTargets(tool, args);
		if (targets.length === 0 || targets.length > MAX_PATH_TARGETS) return [];
		const rules = new Map<string, ApprovalGrantRule>();
		for (const target of targets) {
			if (target.includes("://")) return [];
			const real = resolveGrantPath(target, cwd);
			if (GLOB_META.test(real)) return [];
			rules.set(real, { kind: "path", tool: tool.name, pattern: real, sample: target });
		}
		return [...rules.values()];
	}
	return [{ kind: "tool", tool: tool.name, pattern: "*" }];
}

/** One-line description of a grant or candidate rule, paths shown relative to `cwd` when inside it. */
export function describeGrantRule(rule: Pick<ApprovalGrantRule, "kind" | "tool" | "pattern">, cwd: string): string {
	if (rule.kind === "tool") return `${rule.tool} (every call)`;
	if (rule.kind === "bash") return `bash: ${rule.pattern}`;
	const relative = path.isAbsolute(rule.pattern) ? path.relative(cwd, rule.pattern) : rule.pattern;
	const shown = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : rule.pattern;
	return `${rule.tool}: ${shown}`;
}

/** Reason a user-edited pattern cannot be saved, or `undefined` when it is fine. */
export function validateGrantPattern(
	rule: Pick<ApprovalGrantRule, "kind" | "tool" | "sample">,
	pattern: string,
	session: GrantSession,
): string | undefined {
	const trimmed = pattern.trim();
	if (trimmed.replace(/[*/\s.~]/gu, "") === "") return "A pattern made only of wildcards would cover everything";
	if (rule.kind === "bash") {
		if (trimmed.startsWith("*")) return "The command name must be literal";
		if (rule.sample !== undefined && !bashGrantMatches(rule.sample, trimmed, false)) {
			return "The pattern does not match this command";
		}
	}
	if (rule.kind === "path" && rule.sample !== undefined && !pathMatchesGrantGlob(trimmed, rule.sample, session)) {
		return "The pattern does not match this path";
	}
	return undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────────────────────────────────

/**
 * Whether `pattern` covers `command`. A pattern ending in ` *` also covers the bare prefix (`bun test *`
 * covers `bun test`). `allow` grants never match a compound or shell-controlled line; `deny` grants match
 * when any segment of one matches, like `bash.patterns` deny rules.
 */
export function bashGrantMatches(command: string, pattern: string, segmentwise: boolean): boolean {
	const normalizedPattern = normalizeBashApprovalPattern(pattern);
	const bare = normalizedPattern.endsWith(" *") ? normalizedPattern.slice(0, -2) : undefined;
	if (segmentwise) {
		return (
			commandSegmentMatchesBashApprovalPattern(command, pattern) ||
			(bare !== undefined && commandSegmentMatchesBashApprovalPattern(command, bare))
		);
	}
	if (hasBashApprovalShellControl(command)) return false;
	return (
		commandMatchesBashApprovalPattern(command, pattern) ||
		(bare !== undefined && normalizeBashApprovalPattern(command) === bare)
	);
}

function grantCovers(
	grants: readonly ApprovalGrant[],
	tool: GrantSubject,
	args: unknown,
	effect: ApprovalGrantEffect,
	session: GrantSession,
): ApprovalGrant | undefined {
	const candidates = grants.filter(grant => grant.effect === effect && grant.tool === tool.name);
	if (candidates.length === 0) return undefined;
	const wholeTool = candidates.find(grant => grant.kind === "tool");
	if (wholeTool) return wholeTool;
	if (tool.name === "bash") {
		const command = bashCommand(args);
		return candidates.find(
			grant => grant.kind === "bash" && bashGrantMatches(command, grant.pattern, effect === "deny"),
		);
	}
	const pathGrants = candidates.filter(grant => grant.kind === "path");
	if (pathGrants.length === 0) return undefined;
	const targets = callTargets(tool, args);
	if (targets.length === 0) return undefined;
	const matchFor = (target: string): ApprovalGrant | undefined =>
		pathGrants.find(grant => pathMatchesGrantGlob(grant.pattern, target, session));
	// An allow must cover every target; a deny fires on any.
	if (effect === "deny") {
		for (const target of targets) {
			const hit = matchFor(target);
			if (hit) return hit;
		}
		return undefined;
	}
	let first: ApprovalGrant | undefined;
	for (const target of targets) {
		const hit = matchFor(target);
		if (!hit) return undefined;
		first ??= hit;
	}
	return first;
}

// ──────────────────────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────────────────────

interface ProjectCache {
	file: string;
	mtimeMs: number;
	checkedAt: number;
	grants: ApprovalGrant[];
}

function grantId(scope: ApprovalGrantScope, effect: ApprovalGrantEffect, rule: ApprovalGrantRule): string {
	const hash = Bun.hash(`${effect}\0${rule.tool}\0${rule.kind}\0${rule.pattern}`).toString(16).slice(0, 8);
	return `${scope === "session" ? "s" : "p"}${hash}`;
}

function parseProjectGrant(value: unknown): ApprovalGrant | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const { effect, kind, tool, pattern } = record;
	if (effect !== "allow" && effect !== "deny") return undefined;
	if (kind !== "bash" && kind !== "path" && kind !== "tool") return undefined;
	if (typeof tool !== "string" || tool === "" || typeof pattern !== "string" || pattern.trim() === "")
		return undefined;
	const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
	return {
		id: grantId("project", effect, { kind, tool, pattern }),
		effect,
		scope: "project",
		kind,
		tool,
		pattern,
		createdAt,
	};
}

/**
 * Approval grants of one session: an in-memory session list plus the project file of the session's
 * live working directory (re-read when it changes on disk).
 */
export class ApprovalGrantStore {
	readonly #getCwd: () => string;
	#session: ApprovalGrant[] = [];
	#project: ProjectCache | undefined;
	#fileKey: { cwd: string; agentDir: string; file: string } | undefined;

	constructor(getCwd: () => string) {
		this.#getCwd = getCwd;
	}

	/**
	 * Where this project's grants live: `<agentDir>/approval-grants/<name>-<hash of the real project path>.json`. The
	 * file is outside the repository on purpose: a project directory is untrusted input (a clone can ship any file in
	 * it, and a sandboxed or `write`-tier call can create one), so a rule only counts when the user's own agent
	 * directory holds it.
	 */
	get projectFile(): string {
		const cwd = this.#getCwd();
		const agentDir = getAgentDir();
		const known = this.#fileKey;
		if (known && known.cwd === cwd && known.agentDir === agentDir) return known.file;
		let real = path.resolve(cwd);
		try {
			real = fs.realpathSync(real);
		} catch {
			// A directory that is gone keeps its lexical path.
		}
		const digest = new Bun.CryptoHasher("sha256").update(real).digest("hex").slice(0, 16);
		const name =
			path
				.basename(real)
				.replace(/[^\w.-]+/gu, "_")
				.slice(0, 40) || "root";
		const file = path.join(agentDir, PROJECT_GRANTS_DIR, `${name}-${digest}.json`);
		this.#fileKey = { cwd, agentDir, file };
		return file;
	}

	#projectGrants(): ApprovalGrant[] {
		const file = this.projectFile;
		const now = Date.now();
		const cached = this.#project;
		if (cached && cached.file === file && now - cached.checkedAt < PROJECT_RECHECK_MS) return cached.grants;
		let mtimeMs = -1;
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			// Absent: no project grants.
		}
		if (cached && cached.file === file && cached.mtimeMs === mtimeMs) {
			cached.checkedAt = now;
			return cached.grants;
		}
		const grants: ApprovalGrant[] = [];
		if (mtimeMs >= 0) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
				const list = fieldOf(parsed, "grants");
				if (Array.isArray(list)) {
					for (const item of list) {
						const grant = parseProjectGrant(item);
						if (grant && !grants.some(existing => existing.id === grant.id)) grants.push(grant);
					}
				}
			} catch (error) {
				logger.warn("approval grants: ignoring unreadable project file", { file, error: String(error) });
			}
		}
		this.#project = { file, mtimeMs, checkedAt: now, grants };
		return grants;
	}

	#writeProject(grants: ApprovalGrant[]): void {
		const file = this.projectFile;
		const body = {
			managedBy: PROJECT_GRANTS_MARKER,
			grants: grants.map(({ effect, tool, kind, pattern, createdAt }) => ({
				effect,
				tool,
				kind,
				pattern,
				createdAt,
				source: "approval-prompt",
			})),
		};
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
			fs.renameSync(tmp, file);
		} catch (error) {
			fs.rmSync(tmp, { force: true });
			throw error;
		}
		this.#project = { file, mtimeMs: fs.statSync(file).mtimeMs, checkedAt: Date.now(), grants };
	}

	/** Session grants, then project grants. */
	list(): ApprovalGrant[] {
		return [...this.#session, ...this.#projectGrants()];
	}

	/**
	 * Save a grant. A rule already saved in that scope is returned unchanged.
	 * @throws when the project file cannot be written.
	 */
	add(rule: ApprovalGrantRule, effect: ApprovalGrantEffect, scope: ApprovalGrantScope): ApprovalGrant {
		const grant: ApprovalGrant = {
			id: grantId(scope, effect, rule),
			effect,
			scope,
			kind: rule.kind,
			tool: rule.tool,
			pattern: rule.pattern.trim(),
			createdAt: new Date().toISOString(),
		};
		if (scope === "session") {
			const existing = this.#session.find(item => item.id === grant.id);
			if (existing) return existing;
			this.#session.push(grant);
			return grant;
		}
		const projectGrants = this.#projectGrants();
		const existing = projectGrants.find(item => item.id === grant.id);
		if (existing) return existing;
		this.#writeProject([...projectGrants, grant]);
		return grant;
	}

	/** Remove by id or by 1-based index into {@link list}. `undefined` when nothing matches. */
	remove(selector: string): ApprovalGrant | undefined {
		const all = this.list();
		const index = /^\d+$/u.test(selector) ? Number(selector) - 1 : -1;
		const grant = index >= 0 ? all[index] : all.find(item => item.id === selector);
		if (!grant) return undefined;
		if (grant.scope === "session") {
			this.#session = this.#session.filter(item => item.id !== grant.id);
		} else {
			this.#writeProject(this.#projectGrants().filter(item => item.id !== grant.id));
		}
		return grant;
	}

	/** Remove every grant of `scope` (both when omitted). Returns how many were removed. */
	clear(scope?: ApprovalGrantScope): number {
		let removed = 0;
		if (scope !== "project") {
			removed += this.#session.length;
			this.#session = [];
		}
		if (scope !== "session") {
			const projectGrants = this.#projectGrants();
			if (projectGrants.length > 0) {
				this.#writeProject([]);
				removed += projectGrants.length;
			}
		}
		return removed;
	}

	/** The grant of `effect` that covers this call, if any. */
	find(
		effect: ApprovalGrantEffect,
		tool: GrantSubject,
		args: unknown,
		session: GrantSession,
	): ApprovalGrant | undefined {
		return grantCovers(this.list(), tool, args, effect, session);
	}
}

/**
 * Fold saved grants into a resolved approval. A deny grant refuses the call unless it is already denied
 * (that reason stays); an allow grant answers a prompt raised by the approval mode alone.
 */
export function applyApprovalGrants(
	store: ApprovalGrantStore | undefined,
	tool: GrantSubject,
	args: unknown,
	resolved: ResolvedApproval,
	session: GrantSession,
): ResolvedApproval {
	if (!store || resolved.policy === "deny") return resolved;
	const deny = store.find("deny", tool, args, session);
	if (deny) {
		return {
			...resolved,
			policy: "deny",
			source: "grant",
			reason: `Denied by saved approval rule (${describeGrantRule(deny, session.cwd)}); remove it with /approvals`,
		};
	}
	if (resolved.policy === "prompt" && resolved.source === "mode" && !resolved.override) {
		const allow = store.find("allow", tool, args, session);
		if (allow) return { ...resolved, policy: "allow", source: "grant" };
	}
	return resolved;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────────────

export const APPROVAL_LABELS: Record<CollabApprovalChoiceKind, string> = {
	once: "Allow once",
	session: "Always allow (this session)",
	project: "Always allow (this project)",
	deny: "Deny",
	"deny-project": "Deny always (this project)",
};
const LEGACY_APPROVE = "Approve";
const CHOICE_ORDER: readonly CollabApprovalChoiceKind[] = ["once", "session", "project", "deny", "deny-project"];

export interface ToolApprovalOutcome {
	approved: boolean;
	by: ToolApprovalBy;
	choice: CollabApprovalChoiceKind;
	/** Grants this answer saved. */
	saved: ApprovalGrant[];
}

export interface AskToolApprovalOptions {
	ui: Pick<ExtensionUIContext, "select" | "approve" | "editor" | "notify">;
	prompt: ExtensionApprovalPrompt;
	tool: string;
	/** What the always/deny-always choices would save; empty or no store: plain Approve / Deny. */
	rules: readonly ApprovalGrantRule[];
	store: ApprovalGrantStore | undefined;
	/** Whether a collab guest's project-scoped choice is honored (`collab.guestsCanSaveApprovals`). */
	guestsCanSaveProject: boolean;
	session: GrantSession;
}

function choiceFromLabel(label: string | undefined): CollabApprovalChoiceKind {
	if (label === LEGACY_APPROVE) return "once";
	return CHOICE_ORDER.find(kind => APPROVAL_LABELS[kind] === label) ?? "deny";
}

/**
 * Ask whether to run a tool call. With grantable `rules` the prompt offers once / session / project /
 * deny / deny-always choices and saves the chosen rule (a local user may edit a single rule's pattern
 * first); otherwise it is the plain Approve / Deny prompt, in the host's approval dialog when it has one. A
 * guest's project-scoped choice is downgraded to its once form unless `guestsCanSaveProject`. Abort and
 * dismissal throw / deny exactly as the bare select does.
 */
export async function askToolApproval(options: AskToolApprovalOptions): Promise<ToolApprovalOutcome> {
	const { ui, prompt, tool, rules, store, guestsCanSaveProject, session } = options;
	const answer: { source: "local" | "remote" } = { source: "local" };
	const onAnswer = (answered: "local" | "remote"): void => {
		answer.source = answered;
	};
	const by = (): ToolApprovalBy => (answer.source === "remote" ? "guest" : "tui");

	if (rules.length === 0 || !store) {
		// The host's approval dialog when it has one (Ctrl+Enter approves); a plain select elsewhere.
		const approved = ui.approve
			? (await ui.approve(prompt, { onAnswer })) !== "deny"
			: (await ui.select(prompt.full, [LEGACY_APPROVE, "Deny"], { onAnswer })) === LEGACY_APPROVE;
		return { approved, by: by(), choice: approved ? "once" : "deny", saved: [] };
	}

	const labels = CHOICE_ORDER.map(kind => APPROVAL_LABELS[kind]);
	const saves = rules.map(rule => describeGrantRule(rule, session.cwd)).join(", ");
	const approval: CollabUiApproval = {
		tool,
		rule: saves,
		guestProject: guestsCanSaveProject,
		choices: CHOICE_ORDER.map(kind => ({ label: APPROVAL_LABELS[kind], kind })),
	};
	const chosen = choiceFromLabel(
		await ui.select(`${prompt.full}\nRule saved by "always" choices: ${saves}`, labels, { approval, onAnswer }),
	);
	let choice = chosen;
	const warnings: string[] = [];
	if (answer.source === "remote" && (chosen === "project" || chosen === "deny-project") && !guestsCanSaveProject) {
		choice = chosen === "project" ? "once" : "deny";
		warnings.push(
			"A guest's project-wide choice was applied to this call only: collab.guestsCanSaveApprovals is off",
		);
	}
	if (choice === "once" || choice === "deny") {
		for (const warning of warnings) ui.notify(warning, "warning");
		return { approved: choice === "once", by: by(), choice, saved: [] };
	}

	const effect: ApprovalGrantEffect = choice === "deny-project" ? "deny" : "allow";
	const scope: ApprovalGrantScope = choice === "session" ? "session" : "project";
	let toSave = [...rules];
	const [only] = rules;
	if (only && rules.length === 1 && only.kind !== "tool" && answer.source === "local") {
		const edited = await ui.editor(
			`Pattern to ${effect === "allow" ? "always allow" : "always deny"} for ${tool} (${scope === "session" ? "this session" : "this project"}); Esc applies this call only`,
			only.pattern,
		);
		const problem = edited === undefined ? "Rule not saved" : validateGrantPattern(only, edited, session);
		if (edited === undefined || problem) {
			ui.notify(edited === undefined ? "Rule not saved" : `Rule not saved: ${problem}`, "warning");
			const approved = effect === "allow";
			return { approved, by: by(), choice: approved ? "once" : "deny", saved: [] };
		}
		toSave = [{ ...only, pattern: edited.trim() }];
	}

	const saved: ApprovalGrant[] = [];
	for (const rule of toSave) {
		try {
			saved.push(store.add(rule, effect, scope));
		} catch (error) {
			warnings.push(
				`Could not save the rule to ${store.projectFile}: ${error instanceof Error ? error.message : String(error)}`,
			);
			saved.push(store.add(rule, effect, "session"));
		}
	}
	for (const warning of warnings) ui.notify(warning, "warning");
	ui.notify(
		`Saved ${effect === "allow" ? "always allow" : "deny always"} (${scope}): ${toSave.map(rule => describeGrantRule(rule, session.cwd)).join(", ")}`,
		"info",
	);
	return { approved: effect === "allow", by: by(), choice, saved };
}

/** `/approvals` listing: numbered grants, session first. */
export function formatApprovalGrants(store: ApprovalGrantStore, cwd: string): string {
	const grants = store.list();
	if (grants.length === 0) {
		return `No saved approvals. "Always allow" on a tool approval prompt saves one (project file: ${store.projectFile}).`;
	}
	const lines = grants.map(
		(grant, index) =>
			`${index + 1}. [${grant.scope}] ${grant.effect === "allow" ? "allow" : "deny "} ${describeGrantRule(grant, cwd)}  (${grant.id})`,
	);
	return `Saved approvals:\n${lines.join("\n")}\n\n/approvals remove <number|id>   /approvals clear [session|project]`;
}

/** Run `/approvals [list | remove <number|id> | clear [session|project]]` and return the text to show. */
export function runApprovalsCommand(store: ApprovalGrantStore, args: string, cwd: string): string {
	const [action = "list", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
	try {
		if (action === "list") return formatApprovalGrants(store, cwd);
		if (action === "remove") {
			const [selector] = rest;
			if (!selector) return "Usage: /approvals remove <number|id>";
			const removed = store.remove(selector);
			return removed
				? `Removed ${removed.scope} ${removed.effect} rule: ${describeGrantRule(removed, cwd)}`
				: `No saved approval matches "${selector}".`;
		}
		if (action === "clear") {
			const [scope] = rest;
			if (scope !== undefined && scope !== "session" && scope !== "project")
				return "Usage: /approvals clear [session|project]";
			return `Removed ${store.clear(scope)} saved approval(s).`;
		}
	} catch (error) {
		return `Could not update ${store.projectFile}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return "Usage: /approvals [list | remove <number|id> | clear [session|project]]";
}
