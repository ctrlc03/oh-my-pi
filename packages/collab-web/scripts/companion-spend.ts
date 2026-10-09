/**
 * Spend alerts: the limits the user set in the app, which limits already
 * alerted, and the throttled check that pushes once per crossing (daily: once
 * per local day; session: once per session). Pure over an injected clock and
 * reader so crossing detection is testable without a stats database.
 */

import type { SpendLimits } from "../src/lib/companion";

/** The stats database is only consulted this often. */
export const SPEND_CHECK_MS = 5 * 60 * 1000;
/** Sessions remembered as alerted; the oldest are forgotten first. */
const MAX_ALERTED_SESSIONS = 200;
/** Far above any real budget: a typo like 1e9 is rejected rather than silently never alerting. */
const MAX_LIMIT_USD = 1_000_000;

export interface SpendState {
	limits: SpendLimits;
	/** Local day (`YYYY-MM-DD`) `dailyAlerted` refers to. */
	day: string;
	dailyAlerted: boolean;
	/** Session ids that already alerted, oldest first. */
	sessionsAlerted: string[];
}

/** Spend the stats database reports right now. */
export interface SpendReading {
	/** Across every session, since local midnight. */
	dailyUsd: number;
	/** Total spend of each live session. */
	sessions: { sessionId: string; instanceId: string; title: string; usd: number }[];
}

export interface SpendAlert {
	title: string;
	body: string;
	/** The session to open from the notification, for per-session alerts. */
	instanceId?: string;
}

function isLimit(value: unknown): value is number | null {
	return (
		value === null || (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_LIMIT_USD)
	);
}

/** @throws Error when `raw` is not `{ dailyUsd, sessionUsd }` of positive numbers or null. */
export function parseSpendLimits(raw: unknown): SpendLimits {
	const limits = raw as Partial<Record<keyof SpendLimits, unknown>> | null;
	if (typeof limits !== "object" || limits === null || !isLimit(limits.dailyUsd) || !isLimit(limits.sessionUsd))
		throw new Error("invalid spend limits");
	return { dailyUsd: limits.dailyUsd, sessionUsd: limits.sessionUsd };
}

/** The persisted `spend` field; undefined when absent or damaged. */
export function parseSpendState(raw: unknown): SpendState | undefined {
	const state = raw as Partial<Record<keyof SpendState, unknown>> | null;
	if (typeof state !== "object" || state === null) return undefined;
	try {
		return {
			limits: parseSpendLimits(state.limits),
			day: typeof state.day === "string" ? state.day : "",
			dailyAlerted: state.dailyAlerted === true,
			sessionsAlerted: Array.isArray(state.sessionsAlerted)
				? state.sessionsAlerted.filter((id): id is string => typeof id === "string")
				: [],
		};
	} catch {
		return undefined;
	}
}

/** Local calendar day of `now`, `YYYY-MM-DD`. */
export function dayKey(now: number): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight at or before `now` (Unix ms). */
export function dayStart(now: number): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** State after the user set `limits`: a changed limit alerts afresh, an unchanged one keeps what it already alerted. */
export function withLimits(prev: SpendState | undefined, limits: SpendLimits, now: number): SpendState {
	return {
		limits,
		day: dayKey(now),
		dailyAlerted: prev !== undefined && prev.limits.dailyUsd === limits.dailyUsd && prev.dailyAlerted,
		sessionsAlerted: prev !== undefined && prev.limits.sessionUsd === limits.sessionUsd ? prev.sessionsAlerted : [],
	};
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** Alerts for limits `reading` is at or over and that have not alerted yet, and the state recording them. */
export function detectCrossings(
	prev: SpendState,
	reading: SpendReading,
	now: number,
): { state: SpendState; alerts: SpendAlert[] } {
	const today = dayKey(now);
	const alerts: SpendAlert[] = [];
	let dailyAlerted = prev.day === today && prev.dailyAlerted;
	const { dailyUsd, sessionUsd } = prev.limits;
	if (dailyUsd !== null && !dailyAlerted && reading.dailyUsd >= dailyUsd) {
		dailyAlerted = true;
		alerts.push({
			title: "Daily spend limit",
			body: `${usd(reading.dailyUsd)} spent today, over your ${usd(dailyUsd)} limit.`,
		});
	}
	const sessionsAlerted = [...prev.sessionsAlerted];
	if (sessionUsd !== null) {
		for (const session of reading.sessions) {
			if (session.usd < sessionUsd || sessionsAlerted.includes(session.sessionId)) continue;
			sessionsAlerted.push(session.sessionId);
			alerts.push({
				title: session.title,
				body: `This session has spent ${usd(session.usd)}, over your ${usd(sessionUsd)} limit.`,
				instanceId: session.instanceId,
			});
		}
	}
	return {
		state: { ...prev, day: today, dailyAlerted, sessionsAlerted: sessionsAlerted.slice(-MAX_ALERTED_SESSIONS) },
		alerts,
	};
}

export interface SpendMonitorOptions {
	now(): number;
	state(): SpendState | undefined;
	/** Persist the state after a check recorded alerts. */
	save(state: SpendState): Promise<void>;
	/** Someone can receive the alert: without one the check (and its stats sync) is skipped. */
	wanted(): boolean;
	read(limits: SpendLimits, now: number): Promise<SpendReading>;
	alert(alert: SpendAlert): void;
	onError(err: unknown): void;
}

/** Checks spend at most every {@link SPEND_CHECK_MS}, one check at a time. */
export function createSpendMonitor(options: SpendMonitorOptions): { tick(force?: boolean): Promise<void> } {
	let lastRun = Number.NEGATIVE_INFINITY;
	let running = false;
	return {
		async tick(force = false) {
			const prev = options.state();
			const now = options.now();
			if (running || !prev || !options.wanted()) return;
			if (prev.limits.dailyUsd === null && prev.limits.sessionUsd === null) return;
			if (!force && now - lastRun < SPEND_CHECK_MS) return;
			lastRun = now;
			running = true;
			try {
				const reading = await options.read(prev.limits, now);
				// The user changed the limits while the stats were read: this reading answers the old ones.
				if (options.state() !== prev) return;
				const { state, alerts } = detectCrossings(prev, reading, now);
				if (alerts.length === 0 && state.day === prev.day) return;
				// Record before pushing: an alert must not repeat after a failed save and restart.
				await options.save(state);
				for (const alert of alerts) options.alert(alert);
			} catch (err) {
				options.onError(err);
			} finally {
				running = false;
			}
		},
	};
}
