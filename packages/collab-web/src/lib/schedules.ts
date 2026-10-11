/**
 * Scheduled runs, app side: wording for when a run is next due. The shapes the companion persists and
 * the app edits, and the timetable maths, live in `@oh-my-pi/pi-wire/schedule` (shared with the
 * companion, which fires the runs, and omp's `schedule` tool). Times are the computer's local time
 * unless a cron schedule names a zone.
 */

import { clockTime } from "@oh-my-pi/pi-wire/schedule";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

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
	if (dayDelta === 1) return `tomorrow ${clockTime(ms)}`;
	return `${WEEKDAYS[target.getDay()]} ${target.getDate()} ${target.toLocaleString("en", { month: "short" })} ${clockTime(ms)}`;
}
