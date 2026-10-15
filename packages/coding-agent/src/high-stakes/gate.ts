/**
 * The agent's command gate for high-stakes sessions. A tool's `approval` calls {@link highStakesDecision} with what
 * it is about to run; a publishing command in a checkout whose high-stakes mode is on and whose HEAD tree no quiz
 * pass covers gets a `deny` decision, which the approval machinery refuses before any approval mode, saved grant,
 * user policy or sandbox escalation (see `resolveApproval`). Design and residual risks: docs/collab.md,
 * *High-stakes sessions*. There is no function here, and none anywhere in the agent, that writes the state file or
 * answers a quiz.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { STAKES_REFUSAL_ASK, STAKES_REFUSAL_LEAD, STAKES_STATE_DIR } from "@oh-my-pi/pi-wire/stakes";
import { type ClassifyOptions, classifyPublish, classifyScript, type PublishFinding } from "./classify";
import { headTree, readStakesFile, resolveCheckout } from "./state";

export interface HighStakesRequest {
	/** The session's working folder. */
	cwd: string;
	/** Where the command runs when that is not the session's folder (the `bash` tool's `cwd` argument); relative `cd`/`-C` are resolved from it. */
	commandCwd?: string;
	/** The agent directory the companion publishes into; defaults to the active one. */
	agentDir?: string;
	/** A shell command about to run (`bash`). */
	command?: string;
	/** The source of an `eval` cell about to run. */
	script?: string;
	/** A `github` tool operation about to run that publishes. */
	githubOp?: "pr_create" | "pr_push";
}

/** Findings the gate refuses even when the tree is covered: they take the pre-push check away. */
const ALWAYS_REFUSED = ["no-verify", "hooks-bypass"];

function expandHome(dir: string): string {
	if (dir === "~") return os.homedir();
	return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

/** `git config --get-regexp ^alias\.` in `dir`, cached per folder for one decision. */
function gitAliasResolver(cwd: string): NonNullable<ClassifyOptions["resolveAlias"]> {
	const cache = new Map<string, Map<string, string>>();
	return (name, dir) => {
		const folder = dir === undefined ? cwd : path.resolve(cwd, expandHome(dir));
		let aliases = cache.get(folder);
		if (aliases === undefined) {
			aliases = new Map();
			cache.set(folder, aliases);
			try {
				const run = Bun.spawnSync(["git", "config", "--get-regexp", "^alias\\."], {
					cwd: folder,
					stdout: "pipe",
					stderr: "ignore",
					stdin: "ignore",
				});
				for (const line of run.stdout.toString().split("\n")) {
					const space = line.indexOf(" ");
					if (space > "alias.".length) aliases.set(line.slice("alias.".length, space), line.slice(space + 1));
				}
			} catch {
				// No git, or the folder is gone: no aliases to follow.
			}
		}
		return aliases.get(name.toLowerCase());
	};
}

function findingsFor(request: HighStakesRequest): PublishFinding[] {
	const findings: PublishFinding[] = [];
	const base = request.commandCwd ?? request.cwd;
	if (request.command !== undefined && request.command !== "") {
		findings.push(...classifyPublish(request.command, { resolveAlias: gitAliasResolver(base) }));
	}
	if (request.script !== undefined && request.script !== "") {
		findings.push(...classifyScript(request.script, { resolveAlias: gitAliasResolver(base) }));
	}
	if (request.githubOp === "pr_create") findings.push({ kind: "pr", what: "creating a pull request" });
	if (request.githubOp === "pr_push") findings.push({ kind: "git-push", what: "pushing a branch" });
	return findings;
}

/**
 * `deny` for a publishing command in a high-stakes checkout that is not covered; undefined when the command is
 * allowed to go on to the rest of the approval machinery. Does no I/O unless the agent directory holds published
 * state, and runs git only for a command that publishes (or names a git alias to expand).
 */
export function highStakesDecision(request: HighStakesRequest): ToolApprovalDecision | undefined {
	const agentDir = request.agentDir ?? getAgentDir();
	if (!fs.existsSync(path.join(agentDir, STAKES_STATE_DIR))) return undefined;
	const findings = findingsFor(request);
	if (findings.length === 0) return undefined;

	// The session's checkout, and every folder a finding names (`cd`, `git -C`).
	const base = request.commandCwd ?? request.cwd;
	const folders = request.commandCwd === undefined ? [request.cwd] : [request.cwd, request.commandCwd];
	for (const finding of findings) {
		if (finding.dir !== undefined) folders.push(path.resolve(base, expandHome(finding.dir)));
	}
	const checkouts = new Set<string>();
	for (const folder of folders) {
		const checkout = resolveCheckout(folder);
		if (checkout !== null) checkouts.add(checkout);
	}
	for (const checkout of checkouts) {
		const state = readStakesFile(checkout, agentDir);
		if (state === null || !state.on) continue;
		const bypass = findings.find(finding => ALWAYS_REFUSED.includes(finding.kind));
		if (bypass)
			return refuse(`\`${bypass.what}\` is refused in a high-stakes session: it would skip the pre-push check.`);
		const tree = headTree(checkout);
		if (tree !== null && state.trees.includes(tree)) continue;
		const what = findings[0].what;
		const detail =
			tree === null
				? `\`${what}\` is blocked: this checkout has no commit that a quiz pass covers.`
				: state.trees.length === 0
					? `\`${what}\` is blocked: nothing covers HEAD yet, because no quiz has been passed for this checkout.`
					: `\`${what}\` is blocked: the changes since the last passed quiz are not covered.`;
		return refuse(detail);
	}
	return undefined;
}

function refuse(detail: string): ToolApprovalDecision {
	return {
		tier: "exec",
		override: true,
		policy: "deny",
		reason: `${STAKES_REFUSAL_LEAD} ${detail} ${STAKES_REFUSAL_ASK}`,
	};
}
