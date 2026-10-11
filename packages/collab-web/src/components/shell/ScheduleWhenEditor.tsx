import {
	describeWhen,
	formatRunTime,
	MAX_CRON_CHARS,
	MIN_INTERVAL_MINUTES,
	nextRuns,
	parseScheduleWhen,
	type ScheduleWhen,
	weekdayLabel,
} from "@oh-my-pi/pi-wire/schedule";
import type { ReactNode } from "react";

/** Weekdays in the order the editor lists them (Monday first); values are `Date#getDay` numbers. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const UNIT_MINUTES = { min: 1, h: 60, day: 1440 } as const;
const CRON_PRESETS = [
	{ label: "Weekdays 09:00", expr: "0 9 * * 1-5" },
	{ label: "Daily 03:00", expr: "0 3 * * *" },
	{ label: "Hourly", expr: "0 * * * *" },
	{ label: "Every 15 min", expr: "*/15 * * * *" },
	{ label: "Mondays 08:00", expr: "0 8 * * 1" },
] as const;

/** The timetable part of the schedule form: `at` is a `datetime-local` value, `time` an `HH:MM` value. */
export interface WhenDraft {
	kind: ScheduleWhen["kind"];
	at: string;
	time: string;
	days: number[];
	every: string;
	unit: keyof typeof UNIT_MINUTES;
	cron: string;
	/** Empty = the computer's local time. */
	tz: string;
}

/** A `datetime-local` value (local time, minutes) for `ms`. */
function toLocalInput(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function blankWhenDraft(): WhenDraft {
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	return {
		kind: "daily",
		at: toLocalInput(tomorrow.getTime()),
		time: "09:00",
		days: [1, 2, 3, 4, 5],
		every: "30",
		unit: "min",
		cron: "0 9 * * 1-5",
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

export function whenDraftOf(when: ScheduleWhen): WhenDraft {
	const draft: WhenDraft = { ...blankWhenDraft(), kind: when.kind };
	switch (when.kind) {
		case "once":
			return { ...draft, at: toLocalInput(when.at) };
		case "daily":
			return { ...draft, time: when.time, days: when.days };
		case "interval": {
			const unit = when.everyMin % 1440 === 0 ? "day" : when.everyMin % 60 === 0 ? "h" : "min";
			return { ...draft, every: String(when.everyMin / UNIT_MINUTES[unit]), unit };
		}
		case "cron":
			return { ...draft, cron: when.expr, tz: when.tz ?? "" };
	}
}

/** The timetable `draft` describes, or what is wrong with it; the companion validates again. */
export function whenOf(draft: WhenDraft): { when: ScheduleWhen } | { error: string } {
	let raw: ScheduleWhen;
	switch (draft.kind) {
		case "once": {
			const at = new Date(draft.at).getTime();
			if (!Number.isFinite(at)) return { error: "Pick a date and time." };
			raw = { kind: "once", at };
			break;
		}
		case "daily":
			if (draft.time === "") return { error: "Pick a time." };
			if (draft.days.length === 0) return { error: "Pick at least one weekday." };
			raw = { kind: "daily", time: draft.time, days: draft.days };
			break;
		case "interval": {
			const every = Number(draft.every);
			if (!Number.isFinite(every) || every <= 0) return { error: "Enter how often to run." };
			raw = { kind: "interval", everyMin: Math.round(every * UNIT_MINUTES[draft.unit]) };
			break;
		}
		case "cron":
			if (draft.cron.trim() === "") return { error: "Enter a cron expression." };
			raw = { kind: "cron", expr: draft.cron, ...(draft.tz.trim() === "" ? {} : { tz: draft.tz.trim() }) };
			break;
	}
	try {
		return { when: parseScheduleWhen(raw) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const KIND_LABELS: Record<ScheduleWhen["kind"], string> = {
	once: "Once",
	daily: "Daily",
	interval: "Interval",
	cron: "Cron",
};

/** IANA names for the time zone suggestions (older browsers lack the list: the field still takes any name). */
const ZONE_NAMES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export interface ScheduleWhenEditorProps {
	draft: WhenDraft;
	/** The companion understands cron and interval schedules. */
	canCron: boolean;
	onChange(draft: WhenDraft): void;
}

/** Repeat controls with a live preview of the next three runs. */
export function ScheduleWhenEditor({ draft, canCron, onChange }: ScheduleWhenEditorProps): ReactNode {
	const set = (patch: Partial<WhenDraft>): void => onChange({ ...draft, ...patch });
	const toggleDay = (day: number): void =>
		set({ days: draft.days.includes(day) ? draft.days.filter(d => d !== day) : [...draft.days, day] });
	const kinds: ScheduleWhen["kind"][] = canCron ? ["once", "daily", "interval", "cron"] : ["once", "daily"];
	const built = whenOf(draft);
	const tz = draft.kind === "cron" && draft.tz.trim() !== "" ? draft.tz.trim() : undefined;

	return (
		<div className="sh-sched-field">
			<span className="sh-field-label">Repeat</span>
			<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="Repeat">
				{kinds.map(kind => (
					<button
						key={kind}
						type="button"
						role="radio"
						aria-checked={draft.kind === kind}
						className={draft.kind === kind ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => set({ kind })}
					>
						{KIND_LABELS[kind]}
					</button>
				))}
			</div>
			{draft.kind === "once" && (
				<input
					className="sh-input"
					type="datetime-local"
					value={draft.at}
					onChange={e => set({ at: e.currentTarget.value })}
					aria-label="Date and time"
				/>
			)}
			{draft.kind === "daily" && (
				<>
					<input
						className="sh-input"
						type="time"
						value={draft.time}
						onChange={e => set({ time: e.currentTarget.value })}
						aria-label="Time of day"
					/>
					<div className="sh-sched-days" role="group" aria-label="Weekdays">
						{DAY_ORDER.map(day => (
							<button
								key={day}
								type="button"
								className={
									draft.days.includes(day) ? "sh-chip sh-sched-day sh-sched-day-on" : "sh-chip sh-sched-day"
								}
								aria-pressed={draft.days.includes(day)}
								onClick={() => toggleDay(day)}
							>
								{weekdayLabel(day)}
							</button>
						))}
					</div>
				</>
			)}
			{draft.kind === "interval" && (
				<div className="sh-sched-interval">
					<span className="sh-sched-every">Every</span>
					<input
						className="sh-input"
						value={draft.every}
						onChange={e => set({ every: e.currentTarget.value })}
						inputMode="decimal"
						autoComplete="off"
						aria-label="Interval length"
					/>
					<select
						className="sh-input"
						value={draft.unit}
						onChange={e => set({ unit: e.currentTarget.value as WhenDraft["unit"] })}
						aria-label="Interval unit"
					>
						<option value="min">minutes</option>
						<option value="h">hours</option>
						<option value="day">days</option>
					</select>
				</div>
			)}
			{draft.kind === "cron" && (
				<>
					<input
						className="sh-input sh-sched-cron"
						value={draft.cron}
						onChange={e => set({ cron: e.currentTarget.value })}
						maxLength={MAX_CRON_CHARS}
						placeholder="minute hour day-of-month month day-of-week"
						autoCapitalize="none"
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						aria-label="Cron expression"
					/>
					<div className="sh-sched-days" role="group" aria-label="Cron examples">
						{CRON_PRESETS.map(preset => (
							<button
								key={preset.expr}
								type="button"
								className="sh-chip sh-sched-day"
								onClick={() => set({ cron: preset.expr })}
							>
								{preset.label}
							</button>
						))}
					</div>
					<input
						className="sh-input"
						value={draft.tz}
						onChange={e => set({ tz: e.currentTarget.value })}
						list="sh-sched-zones"
						placeholder="Time zone (empty: the computer's)"
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
						aria-label="Time zone"
					/>
					<datalist id="sh-sched-zones">
						{ZONE_NAMES.map(name => (
							<option key={name} value={name} />
						))}
					</datalist>
				</>
			)}
			{"error" in built ? (
				<span className="sh-sched-preview-error">{built.error}</span>
			) : (
				<WhenPreview when={built.when} tz={tz} />
			)}
			<span className="sh-field-hint">
				{draft.kind === "cron"
					? "Five fields: minute hour day-of-month month day-of-week. Without a time zone it runs on the computer's clock."
					: draft.kind === "interval"
						? `At least ${MIN_INTERVAL_MINUTES} minutes. Counted from when the schedule is saved.`
						: "The computer's local time."}
			</span>
		</div>
	);
}

function WhenPreview({ when, tz }: { when: ScheduleWhen; tz: string | undefined }): ReactNode {
	const runs = nextRuns(when, Date.now(), 3);
	return (
		<div className="sh-sched-preview" aria-label="Next runs">
			<span className="sh-sched-preview-title">{describeWhen(when)}</span>
			{runs.length === 0 ? (
				<span className="sh-sched-preview-line">Never runs again.</span>
			) : (
				<ol className="sh-sched-preview-list">
					{runs.map(run => (
						<li key={run}>{formatRunTime(run, tz)}</li>
					))}
				</ol>
			)}
		</div>
	);
}
