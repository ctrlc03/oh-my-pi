/**
 * Whether switching from one agent profile to another would loosen the session's permissions.
 * A collab guest may only tighten the host's profile; the host itself may switch freely.
 */
import type { PathRule } from "../tools/path-rules";
import type {
	ProfileApprovalMode,
	ProfileApprovalPolicy,
	ProfileDefinition,
	ProfileOutsideProject,
} from "./definition";
import { APPROVAL_MODE_RANK } from "./merge";

/** What a profile switch inherits from the session when a profile leaves a field unset. */
export interface ProfileStrictnessBase {
	approvalMode: ProfileApprovalMode;
	/** Whether the target profile's mode is capped by the base mode (CLI flag or project-sourced profile). */
	approvalModeCapped: boolean;
}

const POLICY_RANK: Record<ProfileApprovalPolicy, number> = { allow: 0, prompt: 1, deny: 2 };
const OUTSIDE_RANK: Record<ProfileOutsideProject, number> = { allow: 0, prompt: 1, deny: 2 };

function ruleKey(rule: PathRule): string {
	return JSON.stringify(rule);
}

/** Tools `to` leaves enabled that `from` does not; `undefined` when `to` enables nothing new. */
function addedTool(from: ProfileDefinition, to: ProfileDefinition): string | undefined {
	const fromDenied = new Set(from.disabledTools);
	const toDenied = new Set(to.disabledTools);
	const fromEnabled = (name: string): boolean => (!from.tools || from.tools.includes(name)) && !fromDenied.has(name);
	if (to.tools) {
		return to.tools.find(name => !toDenied.has(name) && !fromEnabled(name));
	}
	if (from.tools) return "every tool";
	return from.disabledTools?.find(name => !toDenied.has(name));
}

/**
 * Describes how `to` is less strict than `from` (the active profile), or returns undefined when
 * `to` is at least as strict on every axis: approval mode, tool set, per-tool approval, path
 * rules, outside-project policy and LSP write actions. Unset fields inherit the session's, so an
 * unset field in `to` counts as loosening when `from` set it stricter.
 */
export function describeLoosening(
	from: ProfileDefinition,
	to: ProfileDefinition,
	base: ProfileStrictnessBase,
): string | undefined {
	const fromMode = from.approvalMode ?? base.approvalMode;
	const toMode = to.approvalMode
		? base.approvalModeCapped && APPROVAL_MODE_RANK[base.approvalMode] > APPROVAL_MODE_RANK[to.approvalMode]
			? base.approvalMode
			: to.approvalMode
		: base.approvalMode;
	if (APPROVAL_MODE_RANK[toMode] < APPROVAL_MODE_RANK[fromMode]) {
		return `approval mode ${toMode} is looser than ${fromMode}`;
	}

	const tool = addedTool(from, to);
	if (tool) return `enables ${tool === "every tool" ? "tools" : `the ${tool} tool`} the active profile does not`;

	for (const [name, policy] of Object.entries(from.approval ?? {})) {
		const next = to.approval?.[name];
		if (POLICY_RANK[next ?? "allow"] < POLICY_RANK[policy]) {
			return `approval for ${name} is looser than ${policy}`;
		}
	}
	for (const [name, policy] of Object.entries(to.approval ?? {})) {
		if (policy === "allow" && POLICY_RANK[from.approval?.[name] ?? "prompt"] > POLICY_RANK.allow) {
			return `allows ${name} without approval`;
		}
	}

	const toRules = new Set((to.pathRules ?? []).map(ruleKey));
	const fromRules = new Set((from.pathRules ?? []).map(ruleKey));
	for (const rule of from.pathRules ?? []) {
		if (rule.action !== "allow" && !toRules.has(ruleKey(rule)))
			return `drops the ${rule.action} path rule ${rule.glob}`;
	}
	for (const rule of to.pathRules ?? []) {
		if (rule.action === "allow" && !fromRules.has(ruleKey(rule))) return `adds the allow path rule ${rule.glob}`;
	}

	if (OUTSIDE_RANK[to.outsideProject ?? "allow"] < OUTSIDE_RANK[from.outsideProject ?? "allow"]) {
		return `outsideProject ${to.outsideProject ?? "unset"} is looser than ${from.outsideProject}`;
	}
	if (from.lspReadOnly && !to.lspReadOnly) return "allows LSP edits (rename, code actions)";
	return undefined;
}
