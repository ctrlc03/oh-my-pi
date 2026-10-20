/**
 * How an agent profile's permission settings combine with the session's own. A profile may add
 * restrictions and may widen what the session leaves open, but it never lifts a `deny` the user or
 * project configured: those apply under every profile.
 */
import type { PathRule } from "../tools/path-rules";
import type { ProfileApprovalMode } from "./definition";
import { SANDBOX_MODE_RANK, type SandboxMode } from "../sandbox/settings";

type OutsideProject = "allow" | "prompt" | "deny";

const OUTSIDE_PROJECT_RANK: Record<OutsideProject, number> = { allow: 0, prompt: 1, deny: 2 };

function isDeny(value: unknown): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === "deny";
}

/** `tools.approval` with the profile's per-tool policies laid over it; a configured `deny` stays. */
export function mergeApproval(base: Record<string, unknown>, profile: Record<string, string>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [tool, policy] of Object.entries(profile)) {
		if (!isDeny(base[tool])) merged[tool] = policy;
	}
	return merged;
}

/**
 * `tools.pathRules` for a session under a profile. Rules are first-match, so order carries the
 * guarantee: the profile's `deny` rules lead, then the session's rules through its last `deny`
 * (carve-outs written before it keep working), then the profile's `prompt` rules, its `allow`
 * rules, and the rest of the session's. Neither a profile `prompt` nor a profile `allow` can
 * therefore shadow a configured `deny`.
 *
 * With `tools.outsideProject: deny` configured, a profile `allow` rule is dropped as well: a path
 * rule that allows a path exempts it from that check.
 */
export function mergePathRules(
	base: readonly PathRule[],
	profile: readonly PathRule[],
	outsideProject: OutsideProject,
): PathRule[] {
	const denies = profile.filter(rule => rule.action === "deny");
	const prompts = profile.filter(rule => rule.action === "prompt");
	const allows = outsideProject === "deny" ? [] : profile.filter(rule => rule.action === "allow");
	const lastDeny = base.findLastIndex(rule => rule.action === "deny");
	return [...denies, ...base.slice(0, lastDeny + 1), ...prompts, ...allows, ...base.slice(lastDeny + 1)];
}

/** The stricter of the session's `tools.outsideProject` and the profile's. */
export function stricterOutsideProject(base: OutsideProject, profile: OutsideProject): OutsideProject {
	return OUTSIDE_PROJECT_RANK[profile] > OUTSIDE_PROJECT_RANK[base] ? profile : base;
}

/**
 * Strictness of an approval mode: the more calls it stops to ask about, the higher. `always-ask-cached`
 * ranks below `always-ask` because its remembered grants let later file writes through unasked.
 */
export const APPROVAL_MODE_RANK: Record<ProfileApprovalMode, number> = {
	yolo: 0,
	write: 1,
	"always-ask-cached": 2,
	"always-ask": 3,
};

/** The stricter of two approval modes (`always-ask` over `always-ask-cached` over `write` over `yolo`). */
export function stricterApprovalMode(a: ProfileApprovalMode, b: ProfileApprovalMode): ProfileApprovalMode {
	return APPROVAL_MODE_RANK[b] > APPROVAL_MODE_RANK[a] ? b : a;
}

/** The stricter of two sandbox modes (`read-only` over `workspace-write` over `off`). */
export function stricterSandboxMode(a: SandboxMode, b: SandboxMode): SandboxMode {
	return SANDBOX_MODE_RANK[b] > SANDBOX_MODE_RANK[a] ? b : a;
}
