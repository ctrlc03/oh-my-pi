/**
 * Settings of the Personal agent (docs/personal-agent.md), declared by this domain (see `config/registry.ts`).
 * All off or inert unless `personal.enabled` is true, which only the Personal profile's `config.yml` sets
 * (written by the collab companion at setup). None has a settings-panel row: the app's Personal settings
 * are the editing surface; the companion writes the profile's `config.yml` and per-launch overlay.
 */
import { register } from "../config/registry";

function validateNonNegativeInteger(raw: unknown): void {
	if (raw !== undefined && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
		throw new Error(`Expected an integer ≥ 0 (0 = unlimited), got ${Bun.inspect(raw)}`);
	}
}

/**
 * This session is a Personal agent session: the `notify_owner` tool, the event inbox, the per-origin trust
 * rules, the guest-turn exclusion from memory, the refusal of `/collab` share links and the rolling spend
 * limits are on. Off by default; nothing about omp changes while it is off.
 */
export const cfgPersonalEnabled = register({ id: "personal.enabled", type: "boolean", default: false });

/**
 * `live`: the long-lived Personal session. `review`: the nightly learning run (headless): it may write the
 * day's digest with `notify_owner`, takes no events, and may not edit About you. Set per launch by the companion.
 */
export const cfgPersonalRunKind = register({
	id: "personal.runKind",
	type: "enum",
	values: ["live", "review"] as const,
	default: "live",
});

/** `notify_owner` calls allowed per rolling hour, `info` and `question` kinds; the rest are refused with a message the agent sees. 0 = unlimited. */
export const cfgPersonalNotifyMaxPerHour = register({
	id: "personal.notifyOwner.maxPerHour",
	type: "number",
	default: 6,
	validate: validateNonNegativeInteger,
});

/** Questions the agent may have open (unanswered) at once; a new `question` beyond this is refused. 0 = unlimited. */
export const cfgPersonalNotifyMaxOpenQuestions = register({
	id: "personal.notifyOwner.maxOpenQuestions",
	type: "number",
	default: 5,
	validate: validateNonNegativeInteger,
});

/** Turns one event source may start per rolling hour (`PERSONAL_UNMETERED_KINDS` events do not count). 0 = unlimited. */
export const cfgPersonalEventsMaxPerSourcePerHour = register({
	id: "personal.events.maxPerSourcePerHour",
	type: "number",
	default: 4,
	validate: validateNonNegativeInteger,
});

/** Turns all event sources together may start per rolling hour. 0 = unlimited. */
export const cfgPersonalEventsMaxPerHour = register({
	id: "personal.events.maxPerHour",
	type: "number",
	default: 12,
	validate: validateNonNegativeInteger,
});

/** Seconds between looks at the event inbox while the session is idle (also looked at when a turn ends). Minimum 1. */
export const cfgPersonalEventsPollSeconds = register({
	id: "personal.events.pollSeconds",
	type: "number",
	default: 5,
	validate: raw => {
		if (raw !== undefined && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)) {
			throw new Error(`Expected an integer ≥ 1, got ${Bun.inspect(raw)}`);
		}
	},
});

/**
 * What a turn started by outside content (an `external` event) may do:
 * - `always-ask`: every tool that is not a plain read asks the owner first, whatever `tools.approvalMode` says, and `memory_edit`, `schedule` and writes to About you are refused;
 * - `read-only`: as `always-ask` but writes and commands are refused outright;
 * - `none`: no extra restriction (the profile's own approval mode applies).
 */
export const cfgPersonalExternalTurnsPolicy = register({
	id: "personal.externalTurns.policy",
	type: "enum",
	values: ["always-ask", "read-only", "none"] as const,
	default: "always-ask",
});

/**
 * Whether `/collab` may create share links (guest or read-only) for this session. Off for the Personal
 * session: the only way in is a paired device of the owner.
 */
export const cfgPersonalAllowShareLinks = register({ id: "personal.allowShareLinks", type: "boolean", default: false });
