/**
 * Scheduled runs, shared by the companion (which fires them), the web app (which edits and previews them)
 * and omp's `schedule` tool (which asks the companion to create them). Everything here is pure: the
 * timetable maths takes the clock as an argument and the zone as a name, so DST behaviour is testable.
 *
 * Times: `once` (an instant), `daily` (chosen weekdays at an `HH:MM` on the computer's local clock),
 * `interval` (every N minutes) and `cron` (five fields, optionally in an IANA time zone).
 *
 * Wall-clock rules around a DST change, for `daily` and `cron` alike: a wall time the spring-forward gap
 * skips runs an hour later the same day (the first valid moment), and a wall time the fall-back hour
 * repeats runs at its first occurrence only — except a cron whose hour field is `*`, which keeps ticking
 * through both occurrences.
 */

/** A scheduled prompt longer than this is refused. */
export const MAX_SCHEDULE_PROMPT_CHARS = 20_000;
export const MAX_SCHEDULE_TITLE_CHARS = 120;
/** Far above any real per-run budget: a typo like 1e9 is refused rather than silently never stopping the run. */
export const MAX_SCHEDULE_COST_USD = 10_000;
/** Nothing repeats more often than this: every run starts an omp session that costs money. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
export const MAX_CRON_CHARS = 120;
/** Far enough out for any real plan, and inside the range `Date` represents. */
export const MAX_ONCE_AT = Date.UTC(2100, 0, 1);

export type ScheduleWhen =
	/** One run at `at` (ms since epoch). */
	| { kind: "once"; at: number }
	/** Every chosen weekday (0 = Sunday … 6 = Saturday) at `time` (`HH:MM`, 24 h), on the computer's local clock. */
	| { kind: "daily"; time: string; days: number[] }
	/** Every `everyMin` minutes counted from `anchor` (ms; set by the companion when the schedule is saved). */
	| { kind: "interval"; everyMin: number; anchor?: number }
	/** A five-field cron expression (or `@daily`-style macro) read on the clock of `tz` (IANA name; omitted = the computer's local time). */
	| { kind: "cron"; expr: string; tz?: string };

/**
 * What to do with a run that came due while the companion (or the computer) was down:
 * `skip` starts it only when it is under an hour late and otherwise records it as missed;
 * `run-once` starts one run however late it is, however many slots were missed.
 */
export type CatchUpPolicy = "skip" | "run-once";

/** What the latest trigger did: it started `instanceId`, or `error` says why it did not (`skipped: …` when deliberately). */
export interface ScheduleRun {
	at: number;
	instanceId?: string;
	error?: string;
	/** Set when this run was a catch-up: the slot (ms) it was originally due for. */
	missedAt?: number;
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
	/** Absent = `skip`. */
	catchUp?: CatchUpPolicy;
	/** Created by an agent through omp's `schedule` tool rather than in the app. */
	createdBy?: "agent";
	/**
	 * `personal`: when due, the prompt is handed to the Personal agent's live session as an event
	 * (`PersonalEvent` kind `schedule`) instead of starting a process; `cwd`, `mode`, `worktree`, `sandboxed` and
	 * `maxCostUsd` are ignored. A schedule the owner made is an `owner`-trust event; one with `createdBy: "agent"`
	 * is `external` (the agent wrote its text, possibly while reading outside content). Only the home computer's
	 * companion accepts it, and only while the Personal agent is enabled.
	 */
	deliverTo?: "personal";
	enabled: boolean;
	lastRun?: ScheduleRun;
	/** Next trigger (ms since epoch); null once nothing more will run. */
	nextRun: number | null;
}

/** What the app sends to create (no `id`) or replace a schedule; the companion fills in `nextRun`. */
export type ScheduleInput = Omit<Schedule, "id" | "lastRun" | "nextRun"> & { id?: string };

// ---------------------------------------------------------------------------
// Wall clocks

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Offsets are sampled per quarter hour: no zone changes its offset off a quarter-hour boundary. */
const OFFSET_BUCKET_MS = 15 * MINUTE_MS;

interface Zone {
	/** The wall clock at `instant`, as milliseconds since 1970 read as if the wall clock were UTC. */
	wall(instant: number): number;
	/** UTC offset at `instant` (wall minus instant). */
	offset(instant: number): number;
	/** Same, from a per-quarter-hour cache: for sampling around a candidate, not for exact transition checks. */
	sample(instant: number): number;
}

const formatters: Record<string, Intl.DateTimeFormat> = {};

/** @throws Error when `tz` is not a time zone this runtime knows. */
export function checkTimeZone(tz: string): void {
	try {
		zoneFormatter(tz);
	} catch {
		throw new Error(`unknown time zone "${tz}" (use an IANA name such as Europe/Berlin)`);
	}
}

function zoneFormatter(tz: string): Intl.DateTimeFormat {
	if (Object.hasOwn(formatters, tz)) return formatters[tz];
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	});
	formatters[tz] = formatter;
	return formatter;
}

function makeZone(tz: string | undefined): Zone {
	const cache = new Map<number, number>();
	const wall =
		tz === undefined
			? (instant: number): number => {
					const d = new Date(instant);
					return Date.UTC(
						d.getFullYear(),
						d.getMonth(),
						d.getDate(),
						d.getHours(),
						d.getMinutes(),
						d.getSeconds(),
					);
				}
			: (instant: number): number => {
					const parts: Record<string, number> = {};
					for (const part of zoneFormatter(tz).formatToParts(instant)) {
						if (part.type !== "literal") parts[part.type] = Number(part.value);
					}
					return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
				};
	const offset = (instant: number): number => {
		const whole = Math.floor(instant / 1000) * 1000;
		return wall(whole) - whole;
	};
	return {
		wall,
		offset,
		sample(instant) {
			const bucket = Math.floor(instant / OFFSET_BUCKET_MS);
			const known = cache.get(bucket);
			if (known !== undefined) return known;
			const value = offset(bucket * OFFSET_BUCKET_MS);
			cache.set(bucket, value);
			return value;
		},
	};
}

/**
 * The instants (ascending) at which the wall clock of `zone` reads `wall`: one normally, two when the
 * fall-back hour repeats it, and, for a time the spring-forward gap skips, the instant that is that
 * wall time on the pre-change offset (the first valid moment after the gap's start).
 */
function instantsOfWall(zone: Zone, wall: number): number[] {
	const before = zone.sample(wall - DAY_MS);
	const after = zone.sample(wall + DAY_MS);
	if (before === after) return [wall - before];
	const valid: number[] = [];
	for (const offset of [before, after]) {
		const instant = wall - offset;
		if (zone.offset(instant) === offset) valid.push(instant);
	}
	if (valid.length === 0) return [wall - before];
	return valid.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Cron

export interface CronSpec {
	/** Indexed by value: minutes 0-59, hours 0-23, days of month 1-31, months 1-12, weekdays 0-6 (Sunday 0). */
	minute: boolean[];
	hour: boolean[];
	dom: boolean[];
	month: boolean[];
	dow: boolean[];
	/** The field starts with `*` (a bare star or a star with a step): with both day fields restricted a day matches either one, else both. */
	domStar: boolean;
	dowStar: boolean;
	/** The hour field starts with `*`: a repeated fall-back hour ticks twice. */
	hourStar: boolean;
	/** The five fields as written (after macro expansion), for describing. */
	fields: [string, string, string, string, string];
}

const CRON_MACROS: Record<string, string> = {
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly": "0 * * * *",
};
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function cronNumber(text: string, name: string, names: string[] | undefined, offset: number): number {
	if (/^\d+$/.test(text)) return Number(text);
	const index = names?.indexOf(text.toLowerCase()) ?? -1;
	if (index < 0) throw new Error(`cron ${name}: "${text}" is not a number${names ? " or name" : ""}`);
	return index + offset;
}

function parseCronField(
	text: string,
	name: string,
	min: number,
	max: number,
	names?: string[],
	nameOffset = 0,
): boolean[] {
	const set = Array.from({ length: max + 1 }, () => false);
	for (const part of text.split(",")) {
		const [range, stepText, extra] = part.split("/");
		if (range === "" || extra !== undefined) throw new Error(`cron ${name}: cannot read "${part}"`);
		if (stepText !== undefined && !/^\d+$/.test(stepText)) throw new Error(`cron ${name}: bad step "${stepText}"`);
		const step = stepText === undefined ? 1 : Number(stepText);
		if (step < 1) throw new Error(`cron ${name}: step must be at least 1`);
		let low: number;
		let high: number;
		if (range === "*") {
			low = min;
			high = max;
		} else if (range.includes("-")) {
			const bounds = range.split("-");
			if (bounds.length !== 2) throw new Error(`cron ${name}: cannot read "${part}"`);
			low = cronNumber(bounds[0], name, names, nameOffset);
			high = cronNumber(bounds[1], name, names, nameOffset);
		} else {
			low = cronNumber(range, name, names, nameOffset);
			high = stepText === undefined ? low : max;
		}
		if (low < min || high > max) throw new Error(`cron ${name}: ${low < min ? low : high} is outside ${min}-${max}`);
		if (low > high) throw new Error(`cron ${name}: range ${low}-${high} runs backwards`);
		for (let value = low; value <= high; value += step) set[value] = true;
	}
	return set;
}

/** Smallest gap (minutes) between two firings in a day, wrapping at midnight. */
function minGapMinutes(minute: boolean[], hour: boolean[]): number {
	const times: number[] = [];
	for (let h = 0; h < 24; h++) {
		if (!hour[h]) continue;
		for (let m = 0; m < 60; m++) if (minute[m]) times.push(h * 60 + m);
	}
	let gap = 24 * 60;
	for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
	if (times.length > 1) gap = Math.min(gap, times[0] + 24 * 60 - times[times.length - 1]);
	return gap;
}

/** @throws Error naming the field that cannot be read, or why the expression never (or too often) fires. */
export function parseCron(expr: string): CronSpec {
	if (expr.length > MAX_CRON_CHARS) throw new Error(`cron expression is over ${MAX_CRON_CHARS} characters`);
	const trimmed = expr.trim();
	const expanded = Object.hasOwn(CRON_MACROS, trimmed.toLowerCase()) ? CRON_MACROS[trimmed.toLowerCase()] : trimmed;
	const parts = expanded.split(/\s+/);
	if (parts.length !== 5)
		throw new Error("cron needs five fields: minute hour day-of-month month day-of-week (e.g. 0 9 * * 1-5)");
	const [minuteText, hourText, domText, monthText, dowText] = parts;
	const minute = parseCronField(minuteText, "minute", 0, 59);
	const hour = parseCronField(hourText, "hour", 0, 23);
	const dom = parseCronField(domText, "day-of-month", 1, 31);
	const month = parseCronField(monthText, "month", 1, 12, MONTH_NAMES, 1);
	const rawDow = parseCronField(dowText, "day-of-week", 0, 7, DAY_NAMES, 0);
	// 7 is a second spelling of Sunday.
	const dow = rawDow.slice(0, 7);
	if (rawDow[7]) dow[0] = true;
	const spec: CronSpec = {
		minute,
		hour,
		dom,
		month,
		dow,
		domStar: domText.startsWith("*"),
		dowStar: dowText.startsWith("*"),
		hourStar: hourText.startsWith("*"),
		fields: [minuteText, hourText, domText, monthText, dowText],
	};
	// 2024 is a leap year: an expression no real calendar date satisfies (30 Feb) matches nowhere in it or later.
	if (nextCronWall(spec, Date.UTC(2024, 0, 1)) === null) throw new Error("that cron expression never matches a date");
	const gap = minGapMinutes(minute, hour);
	if (gap < MIN_INTERVAL_MINUTES)
		throw new Error(`that cron expression runs every ${gap} min; the shortest allowed is ${MIN_INTERVAL_MINUTES}`);
	return spec;
}

function cronDayMatches(spec: CronSpec, date: Date): boolean {
	const byDate = spec.dom[date.getUTCDate()];
	const byWeekday = spec.dow[date.getUTCDay()];
	return !spec.domStar && !spec.dowStar ? byDate || byWeekday : byDate && byWeekday;
}

/** The first wall time (as UTC-read ms) at or after `from` that satisfies `spec`; null within the next 8 years if none. */
function nextCronWall(spec: CronSpec, from: number): number | null {
	let t = Math.floor(from / MINUTE_MS) * MINUTE_MS;
	const end = Date.UTC(new Date(t).getUTCFullYear() + 9, 0, 1);
	while (t < end) {
		const d = new Date(t);
		const year = d.getUTCFullYear();
		const month = d.getUTCMonth();
		const day = d.getUTCDate();
		const hours = d.getUTCHours();
		if (!spec.month[month + 1]) {
			t = Date.UTC(year, month + 1, 1);
		} else if (!cronDayMatches(spec, d)) {
			t = Date.UTC(year, month, day + 1);
		} else if (!spec.hour[hours]) {
			t = Date.UTC(year, month, day, hours + 1);
		} else if (!spec.minute[d.getUTCMinutes()]) {
			t += MINUTE_MS;
		} else {
			return t;
		}
	}
	return null;
}

function nextCronAfter(spec: CronSpec, tz: string | undefined, after: number): number | null {
	const zone = makeZone(tz);
	let cursor = Math.floor((zone.wall(after) - 3 * HOUR_MS) / MINUTE_MS) * MINUTE_MS;
	let best: number | null = null;
	let bestWall = 0;
	for (;;) {
		const wall = nextCronWall(spec, cursor);
		if (wall === null || (best !== null && wall > bestWall + 3 * HOUR_MS)) return best;
		const instants = instantsOfWall(zone, wall);
		for (const instant of spec.hourStar ? instants : instants.slice(0, 1)) {
			if (instant > after && (best === null || instant < best)) {
				best = instant;
				bestWall = wall;
			}
		}
		cursor = wall + MINUTE_MS;
	}
}

// ---------------------------------------------------------------------------
// Timetable

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function nextDailyAfter(when: Extract<ScheduleWhen, { kind: "daily" }>, after: number): number | null {
	const [hours, minutes] = when.time.split(":").map(Number);
	const from = new Date(after);
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes);
		if (when.days.includes(candidate.getDay()) && candidate.getTime() > after) return candidate.getTime();
	}
	return null;
}

/**
 * First trigger strictly after `after`; null when nothing is left to run. A daily or cron time that does
 * not exist on a DST day runs an hour later, one that happens twice runs at its first occurrence (see the
 * module comment). A `when` that fails {@link parseScheduleWhen} gives null.
 */
export function nextRunAfter(when: ScheduleWhen, after: number): number | null {
	switch (when.kind) {
		case "once":
			return when.at > after ? when.at : null;
		case "daily":
			return nextDailyAfter(when, after);
		case "interval": {
			const step = when.everyMin * MINUTE_MS;
			if (when.anchor === undefined) return after + step;
			return when.anchor + (Math.floor(Math.max(0, after - when.anchor) / step) + 1) * step;
		}
		case "cron": {
			let spec: CronSpec;
			try {
				spec = parseCron(when.expr);
			} catch {
				return null;
			}
			return nextCronAfter(spec, when.tz, after);
		}
	}
}

/** The next `count` triggers after `after`, in order (fewer when the timetable ends sooner). */
export function nextRuns(when: ScheduleWhen, after: number, count: number): number[] {
	const out: number[] = [];
	let cursor = after;
	while (out.length < count) {
		const next = nextRunAfter(when, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next;
	}
	return out;
}

/** @throws Error with a message fit for the app and the agent when `raw` is not a timetable the companion can run. */
export function parseScheduleWhen(raw: unknown): ScheduleWhen {
	const when = raw as {
		kind?: unknown;
		at?: unknown;
		time?: unknown;
		days?: unknown;
		everyMin?: unknown;
		anchor?: unknown;
		expr?: unknown;
		tz?: unknown;
	} | null;
	if (typeof when !== "object" || when === null) throw new Error("invalid schedule time");
	if (when.kind === "once") {
		if (typeof when.at !== "number" || !Number.isInteger(when.at) || when.at <= 0 || when.at >= MAX_ONCE_AT)
			throw new Error("invalid date and time");
		return { kind: "once", at: when.at };
	}
	if (when.kind === "daily") {
		if (typeof when.time !== "string" || !TIME_RE.test(when.time)) throw new Error("time must be HH:MM");
		if (
			!Array.isArray(when.days) ||
			when.days.length === 0 ||
			!when.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
		)
			throw new Error("pick at least one weekday");
		return { kind: "daily", time: when.time, days: [...new Set<number>(when.days)].sort((a, b) => a - b) };
	}
	if (when.kind === "interval") {
		if (
			typeof when.everyMin !== "number" ||
			!Number.isInteger(when.everyMin) ||
			when.everyMin < MIN_INTERVAL_MINUTES ||
			when.everyMin > MAX_INTERVAL_MINUTES
		)
			throw new Error(
				`the interval must be a whole number of minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`,
			);
		if (
			when.anchor !== undefined &&
			(typeof when.anchor !== "number" ||
				!Number.isInteger(when.anchor) ||
				when.anchor <= 0 ||
				when.anchor >= MAX_ONCE_AT)
		)
			throw new Error("invalid interval start");
		return {
			kind: "interval",
			everyMin: when.everyMin,
			...(when.anchor === undefined ? {} : { anchor: when.anchor }),
		};
	}
	if (when.kind === "cron") {
		if (typeof when.expr !== "string") throw new Error("cron expression must be text");
		if (when.tz !== undefined && (typeof when.tz !== "string" || when.tz === ""))
			throw new Error("invalid time zone");
		parseCron(when.expr);
		if (when.tz !== undefined) checkTimeZone(when.tz);
		return { kind: "cron", expr: when.expr.trim(), ...(when.tz === undefined ? {} : { tz: when.tz }) };
	}
	throw new Error("invalid schedule time");
}

// ---------------------------------------------------------------------------
// Wording

/** Day-of-week labels, Sunday first, as the editor lists them. */
export function weekdayLabel(day: number): string {
	return WEEKDAYS[day] ?? "";
}

/** `HH:MM` of `ms` on the computer's local clock. */
export function clockTime(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function valuesOf(set: boolean[], min: number): number[] {
	const out: number[] = [];
	for (let value = min; value < set.length; value++) if (set[value]) out.push(value);
	return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function weekdaysPhrase(days: number[]): string {
	if (days.length === 7) return "every day";
	const key = days.join();
	if (key === "1,2,3,4,5") return "on weekdays";
	if (key === "0,6") return "on weekends";
	return `on ${days.map(weekdayLabel).join(", ")}`;
}

/** "At 09:00 on weekdays", "Every 15 minutes", "At 08:00, 17:30 on Mon, Wed in Jan, Mar". */
export function describeCron(expr: string, tz?: string): string {
	const spec = parseCron(expr);
	const [minuteText] = spec.fields;
	const minutes = valuesOf(spec.minute, 0);
	const hours = valuesOf(spec.hour, 0);
	const allHours = hours.length === 24;
	let time: string;
	if (minutes.length === 60 && allHours) time = "Every minute";
	else if (allHours && /^\*\/\d+$/.test(minuteText)) time = `Every ${minuteText.slice(2)} minutes`;
	else if (allHours && minutes.length === 1)
		time = minutes[0] === 0 ? "Every hour, on the hour" : `At minute ${minutes[0]} of every hour`;
	else if (minutes.length * hours.length <= 6) {
		const clocks: string[] = [];
		for (const hour of hours) for (const minute of minutes) clocks.push(`${pad2(hour)}:${pad2(minute)}`);
		time = `At ${clocks.join(", ")}`;
	} else {
		time = `At minute ${minutes.join(", ")} past hour ${hours.join(", ")}`;
	}
	const dows = valuesOf(spec.dow, 0);
	const doms = valuesOf(spec.dom, 1);
	let day: string;
	if (spec.domStar && spec.dowStar) day = "every day";
	else if (spec.domStar) day = weekdaysPhrase(dows);
	else if (spec.dowStar) day = `on day ${doms.join(", ")} of the month`;
	else day = `on day ${doms.join(", ")} of the month or ${weekdaysPhrase(dows)}`;
	const months = valuesOf(spec.month, 1);
	const monthText = months.length === 12 ? "" : ` in ${months.map(m => MONTH_LABELS[m - 1]).join(", ")}`;
	return `${time}${day === "every day" ? "" : ` ${day}`}${monthText}${tz === undefined ? "" : ` (${tz})`}`;
}

function describeInterval(everyMin: number): string {
	if (everyMin < 60) return `Every ${everyMin} min`;
	const hours = Math.floor(everyMin / 60);
	const rest = everyMin % 60;
	if (hours < 48) return `Every ${hours} h${rest === 0 ? "" : ` ${rest} min`}`;
	return `Every ${Math.round(everyMin / 1440)} days`;
}

/** "Daily 09:00", "Weekdays 09:00", "Mon, Wed 18:30", "Once Sat 10 Oct 09:00", "Every 30 min", "At 09:00 on weekdays (Europe/Berlin)". */
export function describeWhen(when: ScheduleWhen): string {
	if (when.kind === "once") {
		const date = new Date(when.at);
		return `Once ${WEEKDAYS[date.getDay()]} ${date.getDate()} ${date.toLocaleString("en", { month: "short" })} ${clockTime(when.at)}`;
	}
	if (when.kind === "interval") return describeInterval(when.everyMin);
	if (when.kind === "cron") {
		try {
			return describeCron(when.expr, when.tz);
		} catch {
			return when.expr;
		}
	}
	const days = [...new Set(when.days)].sort((a, b) => a - b);
	if (days.length === 7) return `Daily ${when.time}`;
	if (days.join() === "1,2,3,4,5") return `Weekdays ${when.time}`;
	if (days.join() === "0,6") return `Weekends ${when.time}`;
	return `${days.map(weekdayLabel).join(", ")} ${when.time}`;
}

// ---------------------------------------------------------------------------
// Companion IPC (omp's `schedule` tool → the companion on the same computer)

/** File the companion writes next to its state (`<agent dir>/collab-companion-ipc.json`, mode 0600). */
export const SCHEDULE_IPC_FILE = "collab-companion-ipc.json";
/** What the file holds: where the companion listens on loopback and the bearer token that authorizes a request. */
export interface ScheduleIpcEndpoint {
	port: number;
	token: string;
	pid: number;
}

/** `POST /schedule` body. `create` is stored as agent-made and enabled; `delete` only removes agent-made schedules. */
export type ScheduleIpcRequest =
	| { op: "list" }
	| { op: "create"; schedule: ScheduleInput }
	| { op: "delete"; id: string };
export type ScheduleIpcReply =
	| { ok: true; schedules: Schedule[] }
	| { ok: true; schedule: Schedule }
	| { ok: true; deleted: string }
	| { ok: false; error: string };

/** "Mon, 12 Oct, 09:00 CEST": a run time on the clock of `tz` (an IANA name), else on the local clock. */
export function formatRunTime(ms: number, tz?: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...(tz === undefined ? {} : { timeZone: tz, timeZoneName: "short" }),
	}).format(ms);
}
