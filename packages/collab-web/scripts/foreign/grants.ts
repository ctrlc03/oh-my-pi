/**
 * "Approve for this session" in a foreign agent's room, built on omp's own grant logic so the choice means
 * what it means in omp: a shell grant is a program-and-subcommand pattern that never covers a compound or
 * shell-controlled line, an edit or write grant names one resolved path inside the working folder, and only
 * the read-only tools can be granted whole. Everything else (fetch, web search, tools of unknown kind) is
 * approved one call at a time.
 */

import * as path from "node:path";
import { bashGrantMatches, deriveGrantRules } from "@oh-my-pi/pi-coding-agent/tools/approval-grants";
import { pathMatchesGrantGlob, resolveGrantPath } from "@oh-my-pi/pi-coding-agent/tools/path-rules";

/** A rule a "for this session" answer saved. */
export interface SessionGrant {
	kind: "bash" | "path" | "tool";
	tool: string;
	pattern: string;
}

/** A tool call as a grant sees it. */
export interface GrantCall {
	name: string;
	args: Record<string, unknown>;
	/** Every file the call reads or writes, as the agent spelled them. */
	targets: readonly string[];
}

const PATH_TOOLS: Record<string, true> = { edit: true, write: true };
const READ_ONLY_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

/** Whether `target` is the folder `cwd` or inside it once symlinks are resolved. */
export function insideFolder(target: string, cwd: string): boolean {
	const relative = path.relative(resolveGrantPath(".", cwd), resolveGrantPath(target, cwd));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function commandOf(call: GrantCall): string {
	return typeof call.args.command === "string" ? call.args.command : "";
}

/** The rules a "for this session" answer would save for `call`; empty when no narrow, safe rule exists. */
export function deriveSessionGrants(call: GrantCall, cwd: string): SessionGrant[] {
	if (call.name === "bash") {
		return deriveGrantRules({ name: "bash" }, { command: commandOf(call) }, cwd).map(rule => ({
			kind: "bash",
			tool: "bash",
			pattern: rule.pattern,
		}));
	}
	if (Object.hasOwn(PATH_TOOLS, call.name)) {
		if (call.targets.length === 0 || !call.targets.every(target => insideFolder(target, cwd))) return [];
		return deriveGrantRules({ name: call.name, approvalTargets: () => call.targets }, {}, cwd)
			.filter(rule => rule.kind === "path")
			.map(rule => ({ kind: "path", tool: call.name, pattern: rule.pattern }));
	}
	if (Object.hasOwn(READ_ONLY_TOOLS, call.name) && call.targets.every(target => insideFolder(target, cwd))) {
		return [{ kind: "tool", tool: call.name, pattern: "*" }];
	}
	return [];
}

/** Whether the saved grants cover `call`. A path grant needs every target covered; a whole-tool grant needs them inside `cwd`. */
export function grantsCover(grants: readonly SessionGrant[], call: GrantCall, cwd: string): boolean {
	const own = grants.filter(grant => grant.tool === call.name);
	if (own.length === 0) return false;
	if (call.name === "bash") {
		const command = commandOf(call);
		return own.some(grant => grant.kind === "bash" && bashGrantMatches(command, grant.pattern, false));
	}
	if (!call.targets.every(target => insideFolder(target, cwd))) return false;
	if (Object.hasOwn(PATH_TOOLS, call.name)) {
		const pathGrants = own.filter(grant => grant.kind === "path");
		return (
			call.targets.length > 0 &&
			call.targets.every(target => pathGrants.some(grant => pathMatchesGrantGlob(grant.pattern, target, { cwd })))
		);
	}
	return Object.hasOwn(READ_ONLY_TOOLS, call.name) && own.some(grant => grant.kind === "tool");
}

/** One line naming what the grants cover, for the prompt: `bash: bun test *`, `edit: src/app.ts`, `read (inside this folder)`. */
export function describeGrants(grants: readonly SessionGrant[], cwd: string): string {
	return grants
		.map(grant => {
			if (grant.kind === "tool") return `${grant.tool} (inside this folder)`;
			if (grant.kind === "bash") return `bash: ${grant.pattern}`;
			const relative = path.relative(resolveGrantPath(".", cwd), grant.pattern);
			return `${grant.tool}: ${relative === "" ? "." : relative}`;
		})
		.join(", ");
}
