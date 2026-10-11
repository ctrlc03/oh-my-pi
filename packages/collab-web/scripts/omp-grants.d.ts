/**
 * Types for omp's approval-grant logic, which the foreign agent host reuses so a "for this session" choice
 * means what it means in omp (tsconfig `paths` maps `@oh-my-pi/pi-coding-agent/tools/approval-grants` and
 * `…/tools/path-rules` here, for the reason given in `omp-registry.d.ts`). Keep in sync with
 * packages/coding-agent/src/tools/approval-grants.ts and path-rules.ts.
 */

/** What a choice would save: the candidate derived from a prompted call. */
export interface ApprovalGrantRule {
	kind: "bash" | "path" | "tool";
	tool: string;
	pattern: string;
	/** The command or path the rule was derived from. */
	sample?: string;
}

/** The slice of a tool that grant derivation reads. */
export interface GrantSubject {
	name: string;
	approvalTargets?(args: unknown): readonly string[] | undefined;
}

/** The rules "Always allow" would save for this call; empty when no sensible narrow rule exists. */
export function deriveGrantRules(tool: GrantSubject, args: unknown, cwd: string): ApprovalGrantRule[];

/** Whether `pattern` covers `command`; an allow never matches a compound or shell-controlled line. */
export function bashGrantMatches(command: string, pattern: string, segmentwise: boolean): boolean;

/** Whether `glob` covers `targetPath` once symlinks are resolved. */
export function pathMatchesGrantGlob(
	glob: string,
	targetPath: string,
	session: { cwd: string; additionalDirectories?: string[] },
): boolean;

/** `targetPath` resolved against `cwd` with symlinks followed. */
export function resolveGrantPath(targetPath: string, cwd: string): string;
