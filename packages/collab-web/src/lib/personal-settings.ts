/**
 * The Personal agent's settings form and the status wording of its Agent tab: form <-> patch conversion, validation,
 * time and money parsing, source drafts. Pure: no I/O and no React. Wire shapes are in `@oh-my-pi/pi-wire/personal`.
 */

import type {
	PersonalReviewStatus,
	PersonalRunState,
	PersonalSettings,
	PersonalSettingsPatch,
	PersonalSource,
	PersonalStatus,
} from "@oh-my-pi/pi-wire/personal";
import { spendCapped } from "./personal";

// ── parsing ──────────────────────────────────────────────────────────────────

const MAX_USD = 100_000;

/** A dollar amount typed by the owner ("5", "$5.50", "0.05"); null when it is not a non-negative amount with at most 4 decimals. */
export function parseMoney(text: string): number | null {
	const match = /^\$?\s*(\d+(?:\.\d{1,4})?)$/.exec(text.trim());
	if (match === null) return null;
	const usd = Number(match[1]);
	return usd <= MAX_USD ? usd : null;
}

/** `HH:MM` (24 h, zero-padded) from what an `<input type="time">` or a person typed ("4:00", "04:00:00"); null when it is not a time of day. */
export function parseTime(text: string): string | null {
	const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
	if (match === null) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

/** Absolute on the home computer: a POSIX root, a drive letter, or a UNC share. */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Rough token count of About-you text: 4 characters per token, as the companion counts it. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ── the settings form ────────────────────────────────────────────────────────

/** Every field as typed: money and times stay text until saved. */
export interface SettingsForm {
	dayUsd: string;
	monthUsd: string;
	reviewEnabled: boolean;
	reviewTime: string;
	reviewBudgetUsd: string;
	rolloverTime: string;
	/** Empty = the default folder inside the profile. */
	backupFolder: string;
}

export type FormGroup = "limits" | "review" | "rollover" | "backup";

const GROUP_FIELDS: Record<FormGroup, readonly (keyof SettingsForm)[]> = {
	limits: ["dayUsd", "monthUsd"],
	review: ["reviewEnabled", "reviewTime", "reviewBudgetUsd"],
	rollover: ["rolloverTime"],
	backup: ["backupFolder"],
};

const FORM_GROUPS = Object.keys(GROUP_FIELDS) as readonly FormGroup[];

export function formFromSettings(settings: PersonalSettings): SettingsForm {
	return {
		dayUsd: String(settings.limits.dayUsd),
		monthUsd: String(settings.limits.monthUsd),
		reviewEnabled: settings.review.enabled,
		reviewTime: settings.review.time,
		reviewBudgetUsd: String(settings.review.budgetUsd),
		rolloverTime: settings.rollover.time,
		backupFolder: settings.backup.folder ?? "",
	};
}

/** What saving one group sends (only the fields that changed) and why it cannot be saved yet. */
export interface GroupChange {
	patch: PersonalSettingsPatch;
	error: string | null;
}

const MONEY_ERROR = "Enter an amount in dollars, or 0 for no limit.";
const TIME_ERROR = "Enter a time of day, like 04:00.";

/** The patch for `group`: only fields that differ from `base`, or the first thing wrong with the form. */
export function groupChange(group: FormGroup, form: SettingsForm, base: PersonalSettings): GroupChange {
	switch (group) {
		case "limits": {
			const day = parseMoney(form.dayUsd);
			const month = parseMoney(form.monthUsd);
			if (day === null || month === null) return { patch: {}, error: MONEY_ERROR };
			const limits: Partial<PersonalSettings["limits"]> = {};
			if (day !== base.limits.dayUsd) limits.dayUsd = day;
			if (month !== base.limits.monthUsd) limits.monthUsd = month;
			return { patch: Object.keys(limits).length === 0 ? {} : { limits }, error: null };
		}
		case "review": {
			const time = parseTime(form.reviewTime);
			const budget = parseMoney(form.reviewBudgetUsd);
			if (time === null) return { patch: {}, error: TIME_ERROR };
			if (budget === null) return { patch: {}, error: MONEY_ERROR };
			const review: Partial<PersonalSettings["review"]> = {};
			if (form.reviewEnabled !== base.review.enabled) review.enabled = form.reviewEnabled;
			if (time !== base.review.time) review.time = time;
			if (budget !== base.review.budgetUsd) review.budgetUsd = budget;
			return { patch: Object.keys(review).length === 0 ? {} : { review }, error: null };
		}
		case "rollover": {
			const time = parseTime(form.rolloverTime);
			if (time === null) return { patch: {}, error: TIME_ERROR };
			return { patch: time === base.rollover.time ? {} : { rollover: { time } }, error: null };
		}
		case "backup": {
			const folder = form.backupFolder.trim() === "" ? null : form.backupFolder.trim();
			if (folder !== null && !isAbsolutePath(folder)) {
				return { patch: {}, error: "The backup folder must be an absolute path." };
			}
			return { patch: folder === base.backup.folder ? {} : { backup: { folder } }, error: null };
		}
	}
}

/** The group differs from the saved settings (an invalid entry counts: it is something to fix or undo). */
export function groupDirty(group: FormGroup, form: SettingsForm, base: PersonalSettings): boolean {
	const change = groupChange(group, form, base);
	return change.error !== null || Object.keys(change.patch).length > 0;
}

/** A new settings answer arrived: groups with nothing unsaved take its values, groups being edited keep the owner's text. */
export function syncForm(form: SettingsForm, previous: PersonalSettings, next: PersonalSettings): SettingsForm {
	const fresh = formFromSettings(next);
	const merged: SettingsForm = { ...form };
	for (const group of FORM_GROUPS) {
		if (groupDirty(group, form, previous)) continue;
		for (const field of GROUP_FIELDS[group]) Object.assign(merged, { [field]: fresh[field] });
	}
	return merged;
}

/** A group's fields restored to the saved values (after Save, or to drop an edit). */
export function resetGroup(form: SettingsForm, group: FormGroup, base: PersonalSettings): SettingsForm {
	const fresh = formFromSettings(base);
	const merged: SettingsForm = { ...form };
	for (const field of GROUP_FIELDS[group]) Object.assign(merged, { [field]: fresh[field] });
	return merged;
}

// ── sources ──────────────────────────────────────────────────────────────────

export const MIN_SOURCE_MINUTES = 5;
const MAX_SOURCE_MINUTES = 7 * 24 * 60;

/** One source as being edited; `id` is null for a new one. */
export interface SourceDraft {
	id: string | null;
	label: string;
	mcpServer: string;
	everyMinutes: string;
	prompt: string;
	enabled: boolean;
}

export function draftFromSource(source: PersonalSource | null, servers: readonly string[]): SourceDraft {
	if (source === null) {
		return { id: null, label: "", mcpServer: servers[0] ?? "", everyMinutes: "30", prompt: "", enabled: true };
	}
	return {
		id: source.id,
		label: source.label,
		mcpServer: source.mcpServer,
		everyMinutes: String(source.everyMinutes),
		prompt: source.prompt,
		enabled: source.enabled,
	};
}

function parseMinutes(text: string): number | null {
	if (!/^\d+$/.test(text.trim())) return null;
	const minutes = Number(text);
	return minutes >= MIN_SOURCE_MINUTES && minutes <= MAX_SOURCE_MINUTES ? minutes : null;
}

/** The first thing wrong with a draft, or null. */
export function validateDraft(draft: SourceDraft, servers: readonly string[]): string | null {
	if (draft.label.trim() === "") return "Give the source a name, like Work email.";
	if (!servers.includes(draft.mcpServer)) return "Pick an MCP server from the profile's mcp.json.";
	if (parseMinutes(draft.everyMinutes) === null) {
		return `Check every ${MIN_SOURCE_MINUTES} to ${MAX_SOURCE_MINUTES} minutes (a whole number).`;
	}
	if (draft.prompt.trim() === "") return "Say what to check and report.";
	return null;
}

/** `src-` and eight hex characters of a random UUID. */
export function newSourceId(): string {
	return `src-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** A valid draft as the source to save: its poll history stays, an old error does not (the next check reports anew). */
export function sourceFromDraft(
	draft: SourceDraft,
	existing: PersonalSource | null,
	makeId: () => string = newSourceId,
): PersonalSource {
	const source: PersonalSource = {
		id: draft.id ?? makeId(),
		label: draft.label.trim(),
		kind: "mcp-poll",
		mcpServer: draft.mcpServer,
		everyMinutes: parseMinutes(draft.everyMinutes) ?? MIN_SOURCE_MINUTES,
		prompt: draft.prompt.trim(),
		enabled: draft.enabled,
	};
	if (existing?.lastPollAt !== undefined) source.lastPollAt = existing.lastPollAt;
	return source;
}

/** The list with `source` replacing the one of its id, or added at the end. */
export function upsertSource(sources: readonly PersonalSource[], source: PersonalSource): PersonalSource[] {
	return sources.some(item => item.id === source.id)
		? sources.map(item => (item.id === source.id ? source : item))
		: [...sources, source];
}

// ── the Agent tab's wording ──────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 86_400_000;

/**
 * A moment in the owner's local calendar: "today 04:00", "tomorrow 04:00", "Fri 04:00" within the week, "14 Oct 04:00"
 * otherwise (and for earlier days). Days are counted by the calendar, not by 24-hour spans, so a clock change does not shift them.
 */
export function whenLabel(at: number, now: number = Date.now()): string {
	const date = new Date(at);
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	const days = Math.round(
		(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
			new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
			DAY_MS,
	);
	if (days === 0) return `today ${clock}`;
	if (days === 1) return `tomorrow ${clock}`;
	if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()]} ${clock}`;
	return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}

/** Why the last due review did not run, in words. */
export const REVIEW_SKIPPED: Record<NonNullable<PersonalReviewStatus["skipped"]>, string> = {
	disabled: "Reviews are off.",
	"no-login": "Skipped: no login.",
	"spend-limit": "Skipped: a spend limit is reached.",
	"nothing-new": "Nothing new to review.",
	"agent-busy": "Skipped: the agent was busy; will retry.",
};

/** One sentence about what the agent is doing. */
export function headline(status: PersonalStatus): string {
	if (!status.enabled) return "Personal is off. Its memory and settings are kept.";
	switch (status.run) {
		case "off":
			return "Personal is off.";
		case "stopped":
			return status.login.state === "missing"
				? "Waiting for a login before it can start."
				: "No session is running. Background jobs (events, sources, review, backups) still run.";
		case "starting":
			return "Starting a session…";
		case "idle":
			return spendCapped(status)
				? "Spend limit reached. It takes no new prompts until the window passes or you raise the limit."
				: "Ready. Waiting for you or for news.";
		case "working":
			return "Working on something now.";
		case "waiting":
			return "It asked you something and is waiting for the answer.";
		case "failed":
			return "The last start failed.";
	}
}

export interface RunControls {
	start: boolean;
	stop: boolean;
	restart: boolean;
}

const LIVE_RUNS: Record<PersonalRunState, boolean> = {
	off: false,
	stopped: false,
	starting: true,
	idle: true,
	working: true,
	waiting: true,
	failed: false,
};

/** Which of Start, Stop and Restart apply to the run state. */
export function runControls(run: PersonalRunState): RunControls {
	const alive = LIVE_RUNS[run];
	return { start: run === "stopped" || run === "failed", stop: alive, restart: alive && run !== "starting" };
}

/** "2 questions, 1 proposal, 3 digests waiting", or null when nothing waits. */
export function countsLine(counts: PersonalStatus["counts"]): string | null {
	const parts = [
		counts.questions > 0 ? `${counts.questions} ${counts.questions === 1 ? "question" : "questions"}` : null,
		counts.proposals > 0 ? `${counts.proposals} ${counts.proposals === 1 ? "proposal" : "proposals"}` : null,
		counts.digests > 0 ? `${counts.digests} ${counts.digests === 1 ? "digest" : "digests"}` : null,
	].filter((part): part is string => part !== null);
	return parts.length === 0 ? null : `${parts.join(", ")} waiting`;
}
