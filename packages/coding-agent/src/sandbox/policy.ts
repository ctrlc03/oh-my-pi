/**
 * Sandbox policy: which paths a sandboxed shell command may read, write, and
 * whether it may use the network. The policy is backend-neutral; `seatbelt.ts`
 * and `bubblewrap.ts` render it for the OS.
 *
 * Reads: everywhere except {@link SECRET_HOME_PATHS}, the agent credential
 * database, and `tools.pathRules` deny rules. Writes (`workspace-write`): the
 * session cwd, its repo root, extra workspace roots, temp directories and the
 * tool caches in {@link CACHE_HOME_PATHS}; `read-only` allows temp directories
 * only. Inside writable roots the git hooks/config and harness config
 * ({@link PROTECTED_PROJECT_ENTRIES}) stay read-only, so a sandboxed command
 * cannot plant code or settings that later run outside the sandbox.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, getConfigDirName } from "@oh-my-pi/pi-utils";
import { SCHEDULE_IPC_FILE } from "@oh-my-pi/pi-wire/schedule";
import type { Settings } from "../config/settings";
import { type PathRule, parsePathRules } from "../tools/path-rules";
import { cfgToolsPathRules } from "../tools/settings";
import { getVmRoot } from "../vm/paths";
import { escapeRegexLiteral, globToRegexSource } from "./glob-regex";
import { effectiveSandboxMode, effectiveSandboxNetwork, type SandboxMode } from "./settings";

/** A path set: a directory tree/file, or an anchored regex source over absolute paths. */
export type SandboxPathMatcher = { subpath: string } | { regex: string };

export interface SandboxPolicy {
	mode: Exclude<SandboxMode, "off">;
	network: boolean;
	/** Real paths a command may write under. */
	writableRoots: string[];
	/** Real paths of the workspace roots (a subset of `writableRoots`; empty in `read-only`). */
	projectRoots: string[];
	/** Paths under a writable root that stay read-only. */
	readOnly: SandboxPathMatcher[];
	/** Paths a command can neither read nor write. */
	denyAccess: SandboxPathMatcher[];
	/** Paths a command can read but not write (`tools.pathRules` write-only denies). */
	denyWrite: SandboxPathMatcher[];
}

/** Home-relative locations holding credentials; unreadable inside the sandbox. */
export const SECRET_HOME_PATHS: readonly string[] = [
	".ssh",
	".aws",
	".gnupg",
	".azure",
	".kube",
	".config/gcloud",
	".config/gh",
	".docker/config.json",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	"Library/Keychains",
];

/** Home-relative tool caches writable in `workspace-write` so builds and installs keep working. */
export const CACHE_HOME_PATHS: readonly string[] = [
	".cache",
	"Library/Caches",
	".bun/install",
	".npm",
	".yarn",
	".pnpm-store",
	".local/share/pnpm",
	".cargo/registry",
	".cargo/git",
	"go/pkg",
	".gradle",
	".m2/repository",
	".nuget/packages",
	".node-gyp",
];

/** Entries of a writable root that stay read-only (code or settings the harness or git runs unsandboxed). */
const PROTECTED_PROJECT_ENTRIES: readonly string[] = [
	".omp",
	".pi",
	".claude",
	".codex",
	".gemini",
	".cursor",
	".mcp.json",
];

const ABSOLUTE_SYSTEM_SECRETS: readonly string[] = ["/Library/Keychains"];

/** Real path of `target`, resolving the deepest existing ancestor and re-appending the missing tail. */
export function realpathLoose(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		const parent = path.dirname(target);
		if (parent === target) return target;
		return path.join(realpathLoose(parent), path.basename(target));
	}
}

function readGitPointer(gitFile: string): string | undefined {
	try {
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, "utf8"));
		return match ? path.resolve(path.dirname(gitFile), match[1]) : undefined;
	} catch {
		return undefined;
	}
}

/** Git state of a repo rooted at `root`: `.git`, or a worktree's pointer file, its gitdir and the common dir. */
function gitStateOf(root: string): { dirs: string[]; pointerFile?: string } {
	const dotGit = path.join(root, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dotGit);
	} catch {
		return { dirs: [] };
	}
	if (stat.isDirectory()) return { dirs: [dotGit] };
	const gitDir = readGitPointer(dotGit);
	if (!gitDir) return { dirs: [], pointerFile: dotGit };
	const dirs = [gitDir];
	try {
		const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
		if (common) dirs.push(path.resolve(gitDir, common));
	} catch {
		// A plain gitdir (submodule, separate git dir) has no commondir.
	}
	return { dirs, pointerFile: dotGit };
}

/**
 * Whether a writable root would cover the home directory (or `/`): making it writable would
 * expose shell startup files and launch agents, so such a root stays read-only.
 */
function coversHome(root: string, realHome: string): boolean {
	const real = realpathLoose(root);
	return real === realHome || realHome.startsWith(real.endsWith(path.sep) ? real : real + path.sep);
}

/**
 * Regexes keeping git state under `root` from being replaced: any `.git` entry cannot be created,
 * renamed or removed (so a repo cannot be swapped for one with a hostile config), and the hooks and
 * config of every `.git` (nested clones, submodules under `.git/modules`) are read-only. Git runs
 * these outside the sandbox later.
 */
function gitProtectionRegexes(root: string): string[] {
	const base = escapeRegexLiteral(root.replaceAll("\\", "/"));
	return [
		`^${base}/(.*/)?\\.git$`,
		`^${base}/(.*/)?\\.git/(modules/([^/]+/)*)?(hooks|config|config\\.worktree)(/.*)?$`,
	];
}

/** The same for a git directory outside the workspace (a linked worktree's gitdir, the common dir). */
function gitDirProtectionRegex(gitDir: string): string {
	const base = escapeRegexLiteral(gitDir.replaceAll("\\", "/"));
	return `^${base}/((modules|worktrees)/([^/]+/)*)?(hooks|config|config\\.worktree|commondir)(/.*)?$`;
}

/** Nearest ancestor of `cwd` holding `.git`, ignoring one rooted at the home directory or `/`. */
function findRepoRoot(cwd: string): string | undefined {
	const home = realpathLoose(os.homedir());
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			const real = realpathLoose(dir);
			return real === home || real === path.parse(real).root ? undefined : dir;
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

/** Temp directories commands always need: the process temp dir, its sibling cache dir, and the system ones. */
export function tempDirectories(): string[] {
	const dirs = new Set<string>();
	const tmp = realpathLoose(os.tmpdir());
	dirs.add(tmp);
	// macOS keeps per-user temp (`…/T`) and cache (`…/C`) side by side; clang, git and xcrun use both.
	if (process.platform === "darwin" && path.basename(tmp) === "T") dirs.add(path.join(path.dirname(tmp), "C"));
	for (const system of ["/tmp", "/var/tmp"]) dirs.add(realpathLoose(system));
	if (process.platform === "linux") dirs.add("/dev/shm");
	return [...dirs];
}

function dedupeMatchers(matchers: SandboxPathMatcher[]): SandboxPathMatcher[] {
	const seen = new Set<string>();
	return matchers.filter(matcher => {
		const key = "subpath" in matcher ? `s:${matcher.subpath}` : `r:${matcher.regex}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Both spellings of a path (as given and resolved), since Seatbelt and bwrap match resolved paths. */
function pathForms(target: string): string[] {
	const real = realpathLoose(target);
	return real === target ? [target] : [target, real];
}

const READ_RULE_TOOLS: readonly string[] = ["read", "grep", "glob", "find", "ast_grep"];
const WRITE_RULE_TOOLS: readonly string[] = ["write", "edit", "ast_edit"];

/**
 * Regex sources (anchored, over absolute paths) matching what a deny rule's glob covers: the
 * path and everything beneath it. Relative globs match under each project root; a glob without
 * `/` matches that name at any depth, as in `tools.pathRules`.
 */
function ruleRegexSources(glob: string, roots: readonly string[]): string[] {
	let pattern = glob.replaceAll("\\", "/");
	if (pattern === "~" || pattern.startsWith("~/")) pattern = os.homedir().replaceAll("\\", "/") + pattern.slice(1);
	if (pattern.startsWith("./")) pattern = pattern.slice(2);
	const suffix = "(/.*)?$";
	if (pattern.startsWith("/")) {
		return [`^${absolutePatternSource(pattern)}${suffix}`];
	}
	if (!pattern.includes("/")) return [`^(.*/)?${globToRegexSource(pattern)}${suffix}`];
	const sources: string[] = [];
	for (const root of roots) {
		for (const form of pathForms(root)) {
			sources.push(`^${escapeRegexLiteral(form.replaceAll("\\", "/"))}/${globToRegexSource(pattern)}${suffix}`);
		}
	}
	return sources;
}

/** Absolute glob → regex, resolving symlinks in its literal directory prefix (`/tmp/x/**` → `/private/tmp/x/**`). */
function absolutePatternSource(pattern: string): string {
	const segments = pattern.split("/");
	const literal: string[] = [];
	for (const segment of segments) {
		if (/[*?[\]{}]/.test(segment)) break;
		literal.push(segment);
	}
	const prefix = literal.join("/");
	const rest = segments.slice(literal.length).join("/");
	const resolved = prefix === "" ? "" : realpathLoose(prefix);
	const forms = new Set([prefix, resolved]);
	const alternatives = [...forms].map(form => escapeRegexLiteral(form));
	const tail = rest ? `/${globToRegexSource(rest)}` : "";
	return alternatives.length === 1 ? `${alternatives[0]}${tail}` : `(${alternatives.join("|")})${tail}`;
}

function pathRuleMatchers(
	rules: readonly PathRule[],
	roots: readonly string[],
): { access: SandboxPathMatcher[]; write: SandboxPathMatcher[] } {
	const access: SandboxPathMatcher[] = [];
	const write: SandboxPathMatcher[] = [];
	for (const rule of rules) {
		if (rule.action !== "deny") continue;
		const covers = (tools: readonly string[]): boolean =>
			rule.tools === undefined || rule.tools.some(tool => tools.includes(tool));
		const reads = covers(READ_RULE_TOOLS);
		const writes = covers(WRITE_RULE_TOOLS);
		if (!reads && !writes) continue;
		for (const regex of ruleRegexSources(rule.glob, roots)) {
			// SBPL regex literals cannot carry a double quote.
			if (regex.includes('"')) continue;
			(reads ? access : write).push({ regex });
		}
	}
	return { access, write };
}

export interface SandboxPolicyInput {
	settings: Settings;
	cwd: string;
	/** Extra workspace roots (multi-root sessions). */
	additionalDirectories?: readonly string[];
	/** Replaces `sandbox.network` for this run (the `network` escalation). */
	network?: boolean;
}

/** Policy for the session's settings, or `undefined` when `sandbox.mode` is off. */
export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy | undefined {
	const mode = effectiveSandboxMode(input.settings);
	if (mode === "off") return undefined;
	const network = input.network ?? effectiveSandboxNetwork(input.settings) === "on";
	const home = os.homedir();
	const realHome = realpathLoose(home);
	const cwd = path.resolve(input.cwd);

	const projectRoots = new Set<string>([cwd]);
	const repoRoot = findRepoRoot(cwd);
	if (repoRoot) projectRoots.add(repoRoot);
	for (const extra of input.additionalDirectories ?? []) projectRoots.add(path.resolve(cwd, expandHome(extra)));

	const writable = new Set<string>(tempDirectories());
	const workspaceRoots = new Set<string>();
	const readOnly: SandboxPathMatcher[] = [];
	const agentDir = getAgentDir();
	// Grants, credentials, schedules and settings of the harness: never writable, wherever the cwd is.
	for (const form of pathForms(agentDir)) readOnly.push({ subpath: form });
	const protectedEntries = new Set([...PROTECTED_PROJECT_ENTRIES, getConfigDirName()]);
	if (mode === "workspace-write") {
		for (const root of projectRoots) {
			if (coversHome(root, realHome)) continue;
			for (const form of pathForms(root)) {
				writable.add(form);
				workspaceRoots.add(form);
				for (const entry of protectedEntries) readOnly.push({ subpath: path.join(form, entry) });
				for (const regex of gitProtectionRegexes(form)) if (!regex.includes('"')) readOnly.push({ regex });
			}
			const git = gitStateOf(root);
			if (git.pointerFile) {
				for (const form of pathForms(git.pointerFile)) readOnly.push({ subpath: form });
			}
			for (const gitDir of git.dirs) {
				for (const form of pathForms(gitDir)) {
					writable.add(form);
					for (const name of ["hooks", "config", "config.worktree", "commondir"]) {
						readOnly.push({ subpath: path.join(form, name) });
					}
					const regex = gitDirProtectionRegex(form);
					if (!regex.includes('"')) readOnly.push({ regex });
				}
			}
		}
		for (const cache of CACHE_HOME_PATHS) {
			for (const form of pathForms(path.join(home, cache))) writable.add(form);
		}
	}

	const denyAccess: SandboxPathMatcher[] = [];
	for (const secret of SECRET_HOME_PATHS) {
		for (const form of pathForms(path.join(home, secret))) denyAccess.push({ subpath: form });
	}
	for (const secret of ABSOLUTE_SYSTEM_SECRETS) denyAccess.push({ subpath: secret });
	// The agent's own credential store: provider keys and OAuth tokens live in agent.db.
	const agentDb = getAgentDbPath();
	for (const suffix of ["", "-wal", "-shm", "-journal"]) {
		for (const form of pathForms(`${agentDb}${suffix}`)) denyAccess.push({ subpath: form });
	}
	// The companion's state: its schedule IPC file holds a bearer token for creating unsandboxed runs.
	for (const form of pathForms(agentDir)) {
		denyAccess.push({ subpath: path.join(form, SCHEDULE_IPC_FILE) });
		if (!form.includes('"'))
			denyAccess.push({ regex: `^${escapeRegexLiteral(form.replaceAll("\\", "/"))}/collab-companion[^/]*(/.*)?$` });
		try {
			for (const name of fs.readdirSync(form)) {
				if (name.startsWith("collab-companion")) denyAccess.push({ subpath: path.join(form, name) });
			}
		} catch {
			// No agent dir yet: nothing to hide.
		}
	}

	// VM sessions: the GitHub App key and the VMs' SSH keys live under the VM root.
	for (const form of pathForms(getVmRoot())) denyAccess.push({ subpath: form });

	const ruleMatchers = pathRuleMatchers(parsePathRules(cfgToolsPathRules.get(input.settings)), [...projectRoots]);
	denyAccess.push(...ruleMatchers.access);

	return {
		mode,
		network,
		writableRoots: [...writable],
		projectRoots: [...workspaceRoots],
		readOnly: dedupeMatchers(readOnly),
		denyAccess: dedupeMatchers(denyAccess),
		denyWrite: dedupeMatchers(ruleMatchers.write),
	};
}

/** One-line description of a policy for notices and `/sandbox`. */
export function describePolicy(mode: SandboxMode, network: boolean): string {
	if (mode === "off") return "off";
	const writes =
		mode === "workspace-write"
			? "writes limited to the workspace, temp dirs and tool caches"
			: "writes limited to temp dirs";
	return `${mode} (${writes}; network ${network ? "on" : "off"})`;
}
