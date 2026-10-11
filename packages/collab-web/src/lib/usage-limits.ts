/**
 * Subscription limit windows and the limited state of a session (host feature `usage-limits`):
 * countdown and clock wording, grouping the windows by account, and when the app may offer to
 * resume at the reset. Pure: callers pass `now`.
 */

import type { SessionLimited, SessionState, WireLimitWindow } from "@oh-my-pi/pi-wire";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A window at or above this fraction used reads as running low. */
const LOW_FRACTION = 0.8;

/** "now", "<1m", "12m", "2h 05m", "3d 4h": how long until `resetsAt`, rounded down to the minute. */
export function countdown(resetsAt: number, now: number): string {
	const delta = resetsAt - now;
	if (delta <= 0) return "now";
	if (delta < MINUTE) return "<1m";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
	if (delta < DAY) {
		const minutes = Math.floor((delta % HOUR) / MINUTE);
		return `${Math.floor(delta / HOUR)}h ${String(minutes).padStart(2, "0")}m`;
	}
	return `${Math.floor(delta / DAY)}d ${Math.floor((delta % DAY) / HOUR)}h`;
}

/** "14:30" today, "Tue 14:30" on another day: when a window resets, on the user's clock. */
export function clockLabel(at: number, now: number): string {
	const date = new Date(at);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	if (date.toDateString() === today.toDateString()) return time;
	return `${date.toLocaleString("en", { weekday: "short" })} ${time}`;
}

/** When the open session's limit resets, if it is limited and the host says; null once that time has passed. */
export function limitedUntil(state: Pick<SessionState, "limited"> | undefined, now: number): number | null {
	const until = state?.limited?.until;
	return until !== undefined && until > now ? until : null;
}

/** Whether "Resume at reset" can be offered: the reset is known and ahead. */
export function canResumeAtReset(limited: SessionLimited | undefined, now: number): boolean {
	return limited?.until !== undefined && limited.until > now;
}

/** The one-line status of a limited session: "Limited until 14:30 · in 2h 05m". */
export function limitedText(limited: SessionLimited, now: number): string {
	const lead = limited.kind === "blocked" ? "Limited" : limited.kind === "wrap-up" ? "Wrap-up allowance" : "Slow lane";
	const provider = limited.provider === undefined ? "" : ` on ${limited.provider}`;
	if (limited.until === undefined) return `${lead}${provider}`;
	if (limited.until <= now) return `${lead}${provider}: limit reset`;
	return `${lead}${provider} until ${clockLabel(limited.until, now)} · in ${countdown(limited.until, now)}`;
}

/** Percent used, rounded, or null when the provider reports no amount. */
export function usedPercent(window: WireLimitWindow): number | null {
	return window.usedFraction === undefined ? null : Math.round(window.usedFraction * 100);
}

export type WindowTone = "ok" | "low" | "full";

export function windowTone(window: WireLimitWindow): WindowTone {
	if (window.status === "exhausted" || (window.usedFraction ?? 0) >= 1) return "full";
	if (window.status === "warning" || (window.usedFraction ?? 0) >= LOW_FRACTION) return "low";
	return "ok";
}

/** Bar fill 0..100: a reset window with no amount reads as empty. */
export function barPercent(window: WireLimitWindow): number {
	return Math.max(0, Math.min(100, (window.usedFraction ?? 0) * 100));
}

export interface LimitGroup {
	key: string;
	provider: string;
	account?: string;
	/** The group belongs to the open session's provider. */
	active: boolean;
	/** Soonest reset first; windows with no reset time last. */
	windows: WireLimitWindow[];
}

/** Windows grouped by provider account, the open session's provider first, then by name. */
export function groupWindows(windows: readonly WireLimitWindow[], activeProvider: string | undefined): LimitGroup[] {
	const groups: Record<string, LimitGroup> = {};
	const order: string[] = [];
	for (const window of windows) {
		const key = `${window.provider}\0${window.account ?? ""}`;
		if (!Object.hasOwn(groups, key)) {
			groups[key] = {
				key,
				provider: window.provider,
				account: window.account,
				active: window.provider === activeProvider,
				windows: [],
			};
			order.push(key);
		}
		groups[key].windows.push(window);
	}
	const out = order.map(key => groups[key]);
	for (const group of out) {
		group.windows.sort((a, b) => (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY));
	}
	return out.sort(
		(a, b) =>
			Number(b.active) - Number(a.active) ||
			a.provider.localeCompare(b.provider) ||
			(a.account ?? "").localeCompare(b.account ?? ""),
	);
}
