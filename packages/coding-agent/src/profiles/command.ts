/**
 * `/profile [name]`: show the agent profiles and switch between them. Shared by the TUI, ACP and
 * RPC slash-command dispatchers (the handler only needs the session and an output sink).
 */
import type { AgentSession } from "../session/agent-session";
import type { ProfileDefinition } from "./definition";
import type { ProfileSwitchResult } from "./controller";

/** One status line per switch outcome, shared by `/profile` and the cycle key. */
export function describeSwitch(result: ProfileSwitchResult): string {
	if (!result.ok) return `Cannot switch profile: ${result.reason}`;
	switch (result.status) {
		case "applied":
			return `Profile: ${result.profile.name}`;
		case "queued":
			return `Profile ${result.profile.name} applies when the current turn ends`;
		case "unchanged":
			return `Already in profile ${result.profile.name}`;
	}
}

/** What a profile changes, in a few words: `read-only tools`, `model @review`, `prompt`... */
function summarize(profile: ProfileDefinition): string {
	const parts: string[] = [];
	if (profile.tools) parts.push(`${profile.tools.length} tools`);
	if (profile.disabledTools) parts.push(`-${profile.disabledTools.length} tools`);
	if (profile.approvalMode) parts.push(`approval ${profile.approvalMode}`);
	if (profile.approval) parts.push(`${Object.keys(profile.approval).length} approval rules`);
	if (profile.pathRules) parts.push(`${profile.pathRules.length} path rules`);
	if (profile.model) parts.push(`model ${profile.model}`);
	if (profile.thinkingLevel) parts.push(`thinking ${profile.thinkingLevel}`);
	if (profile.prompt) parts.push("prompt");
	return parts.join(", ");
}

/** The active profile and every available one, with load warnings. */
export function describeProfiles(session: AgentSession): string {
	const controller = session.profiles;
	const { profiles, warnings } = controller.catalog();
	const active = controller.active.name.toLowerCase();
	const lines = [`Profile: ${controller.active.name}`];
	if (controller.pendingName) lines.push(`Queued for the next turn: ${controller.pendingName}`);
	lines.push("Available:");
	for (const profile of profiles) {
		const marker = profile.name.toLowerCase() === active ? "*" : " ";
		const detail = [profile.description, summarize(profile)].filter(Boolean).join(" — ");
		lines.push(`${marker} ${profile.name}${detail ? `  ${detail}` : ""}`);
	}
	for (const warning of warnings) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}
