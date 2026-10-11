/**
 * The mock host's subscription limits (feature `usage-limits`): fake windows for two providers and,
 * with `--limited [seconds]`, a session that is at its limit until a reset that many seconds away
 * (default 90 minutes). Arming "resume at reset" sends `continue` shortly after the reset, like the
 * real host; switching to a model of another provider lifts the limit.
 */

import type { SessionLimited, WireLimitWindow } from "@oh-my-pi/pi-wire";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A real host waits 30 s after the reset; the mock waits a little less so a short `--limited` run is quick to watch. */
const MOCK_GRACE_MS = 2_000;

export interface MockLimitsOptions {
	/** Seconds until the limit resets; NaN means the session is not limited. */
	limitedSeconds: number;
	/** The provider the limit applies to. */
	limitedProvider: string;
	provider(): string;
	/** The footer state changed. */
	onState(): void;
	notice(level: "info" | "warning" | "error", message: string): void;
	/** The prompt `continue` goes out as, once the reset has passed. */
	sendContinue(): void;
}

export interface MockLimits {
	/** Present while the open model's provider is at its limit. */
	limited(): SessionLimited | undefined;
	windows(): WireLimitWindow[];
	arm(): { ok: true; at: number } | { ok: false; error: string };
	cancel(): boolean;
}

export function createMockLimits(options: MockLimitsOptions): MockLimits {
	const startedAt = Date.now();
	let limitUntil = Number.isFinite(options.limitedSeconds) ? startedAt + options.limitedSeconds * 1000 : null;
	let resumeAt: number | undefined;
	let timer: Timer | undefined;
	// The 5 hour window of the limited provider is the one that ran out; its reset is the session's.
	const fiveHourReset = limitUntil ?? startedAt + 2 * HOUR + 5 * MINUTE;

	const limited = (): SessionLimited | undefined => {
		if (limitUntil === null || options.provider() !== options.limitedProvider) return undefined;
		return { kind: "blocked", provider: options.limitedProvider, until: limitUntil, resumeAt };
	};

	const fire = (): void => {
		timer = undefined;
		resumeAt = undefined;
		limitUntil = null;
		options.onState();
		options.notice("info", "the usage limit reset: sent continue");
		options.sendContinue();
	};

	/** The next occurrence of a window that resets every `period` ms from `anchor`. */
	const nextReset = (anchor: number, period: number, now: number): number =>
		anchor > now ? anchor : anchor + Math.ceil((now - anchor + 1) / period) * period;

	return {
		limited,
		windows(): WireLimitWindow[] {
			const now = Date.now();
			const exhaustedUntil = limitUntil !== null && limitUntil > now ? limitUntil : undefined;
			return [
				{
					provider: options.limitedProvider,
					account: "dev@example.test",
					windowId: "5h",
					label: "Claude 5 Hour",
					usedFraction: exhaustedUntil === undefined ? 0.04 : 1,
					resetsAt: exhaustedUntil ?? nextReset(fiveHourReset, 5 * HOUR, now),
					status: exhaustedUntil === undefined ? "ok" : "exhausted",
				},
				{
					provider: options.limitedProvider,
					account: "dev@example.test",
					windowId: "7d",
					label: "Claude 7 Day",
					usedFraction: 0.62,
					resetsAt: nextReset(startedAt + 3 * 24 * HOUR, 7 * 24 * HOUR, now),
					status: "ok",
				},
				{
					provider: "openai",
					account: "dev@example.test",
					windowId: "5h",
					label: "Codex 5 Hour",
					usedFraction: 0.86,
					resetsAt: nextReset(startedAt + 40 * MINUTE, 5 * HOUR, now),
					status: "warning",
				},
				{
					provider: "openai",
					account: "dev@example.test",
					windowId: "7d",
					label: "Codex Weekly",
					usedFraction: 0.31,
					resetsAt: nextReset(startedAt + 5 * 24 * HOUR, 7 * 24 * HOUR, now),
					status: "ok",
				},
			];
		},
		arm() {
			const state = limited();
			if (state === undefined) return { ok: false, error: "this session is not limited" };
			if (state.until === undefined || state.until <= Date.now()) {
				return { ok: false, error: "the limit has already reset: send continue instead" };
			}
			clearTimeout(timer);
			resumeAt = state.until + MOCK_GRACE_MS;
			timer = setTimeout(fire, Math.max(0, resumeAt - Date.now()));
			options.onState();
			return { ok: true, at: resumeAt };
		},
		cancel() {
			if (resumeAt === undefined) return false;
			clearTimeout(timer);
			timer = undefined;
			resumeAt = undefined;
			options.onState();
			return true;
		},
	};
}
