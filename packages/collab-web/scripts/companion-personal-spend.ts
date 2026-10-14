/**
 * The Personal agent's rolling spend: the calendar-day and calendar-month totals read from the profile's
 * `spend-ledger.jsonl` (one line per turn end, appended by the sessions), the level each window is at, and the
 * alert (an inbox item plus a push) the first time a window reaches 80% and again at 100%.
 * The limits themselves are enforced inside the session; the companion only reads and reports. Pure over an
 * injected clock and file, and it owns no timer: the companion's poll calls {@link PersonalSpendMonitor.tick}.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import {
	PERSONAL_DEFAULTS,
	type PersonalSettings,
	type PersonalSpend,
	type PersonalSpendLevel,
	type PersonalSpendWindow,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalPaths, PersonalStateStore } from "./companion-personal-store";

/** Which alerts went out for one window; a new window (or a changed limit) starts over. */
export interface SpendWindowAlert {
	/** Start of the window these flags belong to (ms). */
	since: number;
	limitUsd: number | null;
	warned: boolean;
	capped: boolean;
}

export interface SpendAlertState {
	day: SpendWindowAlert;
	month: SpendWindowAlert;
}

/** One ledger line the sessions append (`session/rolling-spend.ts`); only these two fields matter here. */
export interface LedgerEntry {
	at: number;
	costUsd: number;
}

export type SpendWindowName = "day" | "month";

/** Local midnight and the first of the local month at or before `now`. */
export function windowStarts(now: number): Record<SpendWindowName, number> {
	const d = new Date(now);
	return {
		day: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
		month: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
	};
}

/** Ledger entries in `text`; a torn last line or a damaged one is skipped, and so is a negative or non-finite cost. */
export function parseLedger(text: string): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const row = JSON.parse(line) as Partial<Record<keyof LedgerEntry, unknown>>;
			if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
			if (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0) continue;
			entries.push({ at: row.at, costUsd: row.costUsd });
		} catch {
			// torn last line
		}
	}
	return entries;
}

/** Spend per window across every session of the profile. */
export function sumLedger(entries: readonly LedgerEntry[], now: number): Record<SpendWindowName, number> {
	const starts = windowStarts(now);
	const totals = { day: 0, month: 0 };
	for (const entry of entries) {
		if (entry.at > now) continue;
		if (entry.at >= starts.month) totals.month += entry.costUsd;
		if (entry.at >= starts.day) totals.day += entry.costUsd;
	}
	return totals;
}

/** `off` without a limit, `capped` at 100%, `warning` from {@link PERSONAL_DEFAULTS}.spendWarnShare, else `ok`. */
export function spendLevel(usd: number, limitUsd: number | null): PersonalSpendLevel {
	if (limitUsd === null) return "off";
	if (usd >= limitUsd) return "capped";
	return usd >= limitUsd * PERSONAL_DEFAULTS.spendWarnShare ? "warning" : "ok";
}

export function spendWindows(
	totals: Record<SpendWindowName, number>,
	limits: PersonalSettings["limits"],
	now: number,
): PersonalSpend {
	const starts = windowStarts(now);
	const window = (name: SpendWindowName, limitUsd: number): PersonalSpendWindow => {
		const limit = limitUsd > 0 ? limitUsd : null;
		return { usd: totals[name], limitUsd: limit, level: spendLevel(totals[name], limit), since: starts[name] };
	};
	return { day: window("day", limits.dayUsd), month: window("month", limits.monthUsd) };
}

/** Which alert, if any, a window owes given what already went out, and the flags to record. */
export function windowAlert(
	prev: SpendWindowAlert | undefined,
	window: PersonalSpendWindow,
): { next: SpendWindowAlert; notice: "warning" | "capped" | null } {
	const fresh = prev !== undefined && prev.since === window.since && prev.limitUsd === window.limitUsd;
	const flags = fresh ? prev : { since: window.since, limitUsd: window.limitUsd, warned: false, capped: false };
	if (window.level === "capped" && !flags.capped) {
		return { next: { ...flags, warned: true, capped: true }, notice: "capped" };
	}
	if (window.level === "warning" && !flags.warned && !flags.capped) {
		return { next: { ...flags, warned: true }, notice: "warning" };
	}
	return { next: flags, notice: null };
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** The inbox item and push text for `notice` on `name`. */
export function spendNotice(
	name: SpendWindowName,
	window: PersonalSpendWindow,
	notice: "warning" | "capped",
): { title: string; body: string; tag: string } {
	const span = name === "day" ? "today" : "this month";
	const until = name === "day" ? "midnight" : "the first of next month";
	const spent = `${usd(window.usd)} of ${usd(window.limitUsd ?? 0)} spent ${span}.`;
	if (notice === "capped") {
		return {
			title: `Personal agent: ${name === "day" ? "daily" : "monthly"} spend limit reached`,
			body: `${spent} The agent takes no new work until ${until}; events wait in the queue. Raise the limit in Settings → Personal agent.`,
			tag: `personal-spend-${name}-capped`,
		};
	}
	return {
		title: `Personal agent: ${name === "day" ? "daily" : "monthly"} spend at ${Math.round(PERSONAL_DEFAULTS.spendWarnShare * 100)}%`,
		body: `${spent}`,
		tag: `personal-spend-${name}-warning`,
	};
}

export interface SpendDeps {
	paths: Pick<PersonalPaths, "ledgerFile">;
	state: Pick<PersonalStateStore, "read" | "update">;
	now(): number;
	/** The Personal agent is on: only then are alerts raised. */
	enabled(): boolean;
	/** The companion alert (an inbox item of kind `alert` and a push); `companion-personal-inbox`'s `alert`. */
	alert(alert: { title: string; body: string; tag: string }): Promise<unknown>;
	onError(err: unknown): void;
}

export interface PersonalSpendMonitor {
	/** The windows now, for `PersonalStatus.spend`. */
	read(): Promise<PersonalSpend>;
	/** Alerts once per window at 80% and at 100%; a no-op while Personal is off. */
	tick(): Promise<void>;
	/** The window that is at its limit, the day first; `undefined` when the agent may still spend. */
	capped(): Promise<SpendWindowName | undefined>;
	/** True when neither limit is reached: a review or a source poll may run. */
	limitsAllow(): Promise<boolean>;
}

export function createPersonalSpend(deps: SpendDeps): PersonalSpendMonitor {
	// The ledger is re-parsed only when its size or modification time moved.
	let cached: { signature: string; entries: LedgerEntry[] } | undefined;
	let ticking = false;

	async function entries(): Promise<LedgerEntry[]> {
		let stat: Stats;
		try {
			stat = await fs.stat(deps.paths.ledgerFile);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const signature = `${stat.size}:${stat.mtimeMs}`;
		if (cached?.signature !== signature) {
			cached = { signature, entries: parseLedger(await Bun.file(deps.paths.ledgerFile).text()) };
		}
		return cached.entries;
	}

	async function read(): Promise<PersonalSpend> {
		const now = deps.now();
		return spendWindows(sumLedger(await entries(), now), deps.state.read().settings.limits, now);
	}

	const capped = async (): Promise<SpendWindowName | undefined> => {
		const spend = await read();
		if (spend.day.level === "capped") return "day";
		return spend.month.level === "capped" ? "month" : undefined;
	};

	return {
		read,
		capped,
		async limitsAllow() {
			return (await capped()) === undefined;
		},
		async tick() {
			if (ticking || !deps.enabled()) return;
			ticking = true;
			try {
				const spend = await read();
				const prev = deps.state.read().spendAlerts;
				const day = windowAlert(prev?.day, spend.day);
				const month = windowAlert(prev?.month, spend.month);
				const changed =
					prev === undefined ||
					JSON.stringify(prev.day) !== JSON.stringify(day.next) ||
					JSON.stringify(prev.month) !== JSON.stringify(month.next);
				if (!changed) return;
				// Record before alerting: an alert must not repeat after a failed save and restart.
				await deps.state.update(state => ({ ...state, spendAlerts: { day: day.next, month: month.next } }));
				if (day.notice !== null) await deps.alert(spendNotice("day", spend.day, day.notice));
				if (month.notice !== null) await deps.alert(spendNotice("month", spend.month, month.notice));
			} catch (err) {
				deps.onError(err);
			} finally {
				ticking = false;
			}
		},
	};
}
