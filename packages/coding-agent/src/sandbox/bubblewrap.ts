/**
 * Linux bubblewrap rendering of a {@link SandboxPolicy}: the argv prefix for
 * `bwrap`. The root is mounted read-only, writable roots are bind-mounted
 * over it, and denied paths are masked (directories by an empty tmpfs, files
 * by `/dev/null`). Bubblewrap cannot match globs, so regex matchers (from
 * `tools.pathRules` globs) are not enforced on Linux; literal directory
 * matchers are, and nested `.git` directories under the workspace roots are
 * enumerated and protected here, since Seatbelt does that with regexes.
 *
 * A protected path that does not exist yet (`.omp`, `.mcp.json`, a missing
 * `.git/hooks`) is mounted over an empty placeholder so it cannot be created.
 * Bubblewrap creates the placeholder on the host; {@link bwrapCleanupScript}
 * removes the ones still empty afterwards.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { quotePosixArgv } from "../utils/shell-quote";
import type { SandboxPathMatcher, SandboxPolicy } from "./policy";

/** Nested `.git` search: how deep under a workspace root, and how many directories at most. */
const NESTED_GIT_DEPTH = 4;
const NESTED_GIT_BUDGET = 4000;
const GIT_PROTECTED_NAMES: readonly string[] = ["hooks", "config", "config.worktree"];
/** Placeholder is a file rather than a directory for these names. */
const FILE_TARGET = /\.(json|ya?ml)$|^(config|config\.worktree|commondir|gitdir)$/;

export interface BwrapPlan {
	args: string[];
	/** Placeholders bubblewrap creates on the host for protected paths that did not exist. */
	syntheticDirs: string[];
	syntheticFiles: string[];
}

function subpaths(matchers: readonly SandboxPathMatcher[]): string[] {
	return matchers.flatMap(matcher => ("subpath" in matcher ? [matcher.subpath] : []));
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/** Git directories below `dir` (a `modules` directory), recursively; a submodule named `a/b` sits in `modules/a/b`. */
function collectModuleGitDirs(dir: string, found: string[], depth: number): void {
	if (depth > NESTED_GIT_DEPTH) return;
	for (const name of safeReaddir(dir)) {
		const child = path.join(dir, name);
		if (fs.existsSync(path.join(child, "HEAD"))) {
			found.push(child);
			collectModuleGitDirs(path.join(child, "modules"), found, depth + 1);
		} else if (isDirectory(child)) {
			collectModuleGitDirs(child, found, depth + 1);
		}
	}
}

/** `.git` entries (directories and worktree pointer files) under `root`, within the walk bounds. */
function nestedDotGits(root: string): string[] {
	const found: string[] = [];
	let budget = NESTED_GIT_BUDGET;
	let level = [root];
	for (let depth = 0; depth <= NESTED_GIT_DEPTH && level.length > 0 && budget > 0; depth++) {
		const next: string[] = [];
		for (const dir of level) {
			if (budget-- <= 0) break;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.name === ".git") found.push(path.join(dir, ".git"));
				else if (entry.isDirectory()) next.push(path.join(dir, entry.name));
			}
		}
		level = next;
	}
	return found;
}

/** Everything bubblewrap must mount to protect git state under the workspace roots. */
function gitProtection(policy: SandboxPolicy): { binds: Set<string>; readOnly: Set<string> } {
	const binds = new Set<string>();
	const readOnly = new Set<string>();
	for (const root of policy.projectRoots) {
		for (const dotGit of nestedDotGits(root)) {
			if (!isDirectory(dotGit)) {
				readOnly.add(dotGit);
				continue;
			}
			const gitDirs = [dotGit];
			collectModuleGitDirs(path.join(dotGit, "modules"), gitDirs, 0);
			for (const gitDir of gitDirs) {
				// A bind mount point cannot be renamed or removed.
				binds.add(gitDir);
				for (const name of GIT_PROTECTED_NAMES) readOnly.add(path.join(gitDir, name));
			}
		}
	}
	return { binds, readOnly };
}

function isUnderWritableRoot(target: string, policy: SandboxPolicy): boolean {
	return policy.writableRoots.some(
		root => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`),
	);
}

export function planBwrap(policy: SandboxPolicy, options: { tty?: boolean } = {}): BwrapPlan {
	const args = ["--die-with-parent", "--unshare-pid"];
	// A controlling terminal shared with the sandbox lets it push keystrokes into the host shell.
	if (!options.tty) args.push("--new-session");
	args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
	if (!policy.network) args.push("--unshare-net");
	for (const root of policy.writableRoots) {
		if (fs.existsSync(root)) args.push("--bind", root, root);
	}

	const git = gitProtection(policy);
	for (const gitDir of git.binds) args.push("--bind", gitDir, gitDir);

	const syntheticDirs: string[] = [];
	const syntheticFiles: string[] = [];
	const protectedPaths = new Set([...subpaths(policy.readOnly), ...subpaths(policy.denyWrite), ...git.readOnly]);
	for (const target of protectedPaths) {
		if (fs.existsSync(target)) {
			args.push("--ro-bind", target, target);
			continue;
		}
		const parent = path.dirname(target);
		if (!fs.existsSync(parent) || !isUnderWritableRoot(parent, policy)) continue;
		if (FILE_TARGET.test(path.basename(target))) {
			args.push("--ro-bind", "/dev/null", target);
			syntheticFiles.push(target);
		} else {
			args.push("--tmpfs", target, "--remount-ro", target);
			syntheticDirs.push(target);
		}
	}

	for (const denied of subpaths(policy.denyAccess)) {
		if (!fs.existsSync(denied)) continue;
		if (isDirectory(denied)) args.push("--tmpfs", denied);
		else args.push("--ro-bind", "/dev/null", denied);
	}
	args.push("--");
	return { args, syntheticDirs, syntheticFiles };
}

export function buildBwrapArgs(policy: SandboxPolicy, options: { tty?: boolean } = {}): string[] {
	return planBwrap(policy, options).args;
}

/**
 * Shell line running `argv` (a `bwrap` invocation) and then removing the placeholders it created
 * that are still empty, keeping its exit status. Without placeholders it is just the quoted argv.
 */
export function bwrapCleanupScript(argv: readonly string[], plan: BwrapPlan): string {
	if (plan.syntheticDirs.length === 0 && plan.syntheticFiles.length === 0) return quotePosixArgv(argv);
	const cleanup = [
		...plan.syntheticDirs.map(dir => `rmdir -- ${quotePosixArgv([dir])} 2>/dev/null`),
		...plan.syntheticFiles.map(file => `[ -s ${quotePosixArgv([file])} ] || rm -f -- ${quotePosixArgv([file])}`),
	].join("; ");
	const script = `"$@"; status=$?; ${cleanup}; exit $status`;
	return quotePosixArgv(["/bin/sh", "-c", script, "sandbox-cleanup", ...argv]);
}
