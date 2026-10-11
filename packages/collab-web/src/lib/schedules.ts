/**
 * Scheduled runs: the shapes the companion persists and the app edits, and the
 * wording the app shows for them. Times are the computer's local time; the
 * companion computes `nextRun` (see scripts/companion-schedule.ts).
 */

/** A scheduled prompt longer than this is refused. */
export const MAX_SCHEDULE_PROMPT_CHARS = 20_000;
export const MAX_SCHEDULE_TITLE_CHARS = 120;
/** Far above any real per-run budget: a typo like 1e9 is refused rather than silently never stopping the run. */
export const MAX_SCHEDULE_COST_USD = 10_000;

export type ScheduleWhen =
	/** One run at `at` (ms since epoch). */
	| { kind: "once"; at: number }
	/** Every chosen weekday (0 = Sunday … 6 = Saturday) at `time` (`HH:MM`, 24 h). */
	| { kind: "daily"; time: string; days: number[] };

/** What the latest trigger did: it started `instanceId`, or `error` says why it did not (`skipped: …` when deliberately). */
export interface ScheduleRun {
	at: number;
	instanceId?: string;
	error?: string;
}

export interface Schedule {
	id: string;
	title: string;
	prompt: string;
	/** Absolute folder on the computer. */
	cwd: string;
	/** `resume` continues session `sessionId` instead of starting a new one. */
	mode: "new" | "resume";
	sessionId?: string;
	/** New sessions only: run on a fresh branch in its own git worktree. */
	worktree?: boolean;
	sandboxed?: boolean;
	/** New sessions only: the run stops at a safe point once it has spent this many USD (`omp --max-cost`). */
	maxCostUsd?: number;
	when: ScheduleWhen;
	enabled: boolean;
	lastRun?: ScheduleRun;
	/** Next trigger (ms since epoch); null once nothing more will run. */
	nextRun: number | null;
}

/** What the app sends to create (no `id`) or replace a schedule; the companion fills in `nextRun`. */
export type ScheduleInput = Omit<Schedule, "id" | "lastRun" | "nextRun"> & { id?: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Day-of-week labels, Sunday first, as the editor lists them. */
export function weekdayLabel(day: number): string {
	return WEEKDAYS[day] ?? "";
}

function clock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "Daily 09:00", "Weekdays 09:00", "Mon, Wed 18:30", "Once Sat 10 Oct 09:00". */
export function describeWhen(when: ScheduleWhen): string {
	if (when.kind === "once") {
		const date = new Date(when.at);
		return `Once ${WEEKDAYS[date.getDay()]} ${date.getDate()} ${date.toLocaleString("en", { month: "short" })} ${clock(when.at)}`;
	}
	const days = [...new Set(when.days)].sort((a, b) => a - b);
	if (days.length === 7) return `Daily ${when.time}`;
	if (days.join() === "1,2,3,4,5") return `Weekdays ${when.time}`;
	if (days.join() === "0,6") return `Weekends ${when.time}`;
	return `${days.map(weekdayLabel).join(", ")} ${when.time}`;
}

/** "in 5 min", "in 3 h 20 min", "tomorrow 09:00", "Mon 12 Oct 09:00". Input: epoch ms. */
export function untilWords(ms: number, now: number): string {
	const delta = ms - now;
	if (delta <= 60_000) return delta <= 0 ? "due now" : "in under a minute";
	const minutes = Math.round(delta / 60_000);
	if (minutes < 60) return `in ${minutes} min`;
	const target = new Date(ms);
	const today = new Date(now);
	const dayDelta = Math.round(
		(new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() -
			new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
			86_400_000,
	);
	if (dayDelta === 0) {
		const rest = minutes % 60;
		return `in ${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
	}
	if (dayDelta === 1) return `tomorrow ${clock(ms)}`;
	return `${WEEKDAYS[target.getDay()]} ${target.getDate()} ${target.toLocaleString("en", { month: "short" })} ${clock(ms)}`;
}
