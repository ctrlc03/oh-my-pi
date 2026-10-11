import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	describeCron,
	describeWhen,
	MIN_INTERVAL_MINUTES,
	nextRunAfter,
	nextRuns,
	parseCron,
	parseScheduleWhen,
	type ScheduleWhen,
} from "@oh-my-pi/pi-wire/schedule";

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const cron = (expr: string, tz?: string): ScheduleWhen => ({ kind: "cron", expr, ...(tz === undefined ? {} : { tz }) });
const originalTz = process.env.TZ;

beforeAll(() => {
	// A cron with a zone must not depend on the machine's zone; a cron without one reads this one.
	process.env.TZ = "Asia/Tokyo";
});
afterAll(() => {
	if (originalTz === undefined) delete process.env.TZ;
	else process.env.TZ = originalTz;
});

describe("parseCron", () => {
	it("reads lists, ranges, steps, names, macros, and 7 as Sunday", () => {
		const spec = parseCron("0,30 9-17/2 1-7 jan,jul mon-fri");
		expect(spec.minute.filter(Boolean)).toHaveLength(2);
		expect(spec.hour.flatMap((on, h) => (on ? [h] : []))).toEqual([9, 11, 13, 15, 17]);
		expect(spec.month.flatMap((on, m) => (on ? [m] : []))).toEqual([1, 7]);
		expect(spec.dow.flatMap((on, d) => (on ? [d] : []))).toEqual([1, 2, 3, 4, 5]);
		expect(parseCron("0 0 * * 7").dow[0]).toBe(true);
		expect(parseCron("@daily").fields).toEqual(["0", "0", "*", "*", "*"]);
		expect(parseCron("  @HOURLY ").fields[0]).toBe("0");
		expect(parseCron("*/5 * * * *").minute.filter(Boolean)).toHaveLength(12);
	});

	it("refuses what cannot be read, never matches, or runs more often than the minimum", () => {
		for (const bad of [
			"* * * *",
			"60 * * * *",
			"* 24 * * *",
			"*/0 * * * *",
			"5-1 * * * *",
			"1/2/3 * * * *",
			"0 0 * * funday",
			"@reboot",
			"",
		]) {
			expect(() => parseCron(bad)).toThrow();
		}
		expect(() => parseCron("0 0 30 2 *")).toThrow("never matches");
		expect(() => parseCron("* * * * *")).toThrow(`shortest allowed is ${MIN_INTERVAL_MINUTES}`);
		expect(() => parseCron("*/4 * * * *")).toThrow("shortest allowed");
		// Two firings in adjacent hours count as close too.
		expect(() => parseCron("58,2 * * * *")).toThrow("shortest allowed");
		expect(() => parseCron("*/5 * * * *")).not.toThrow();
	});
});

describe("nextRunAfter: cron", () => {
	it("keeps 09:00 on the wall clock across the fall-back and spring-forward changes", () => {
		const weekdays = cron("0 9 * * 1-5", "America/New_York");
		// Fri 30 Oct 2026 11:00 EDT -> Mon 2 Nov 09:00 EST.
		expect(nextRunAfter(weekdays, utc(2026, 10, 30, 15))).toBe(utc(2026, 11, 2, 14));
		// Fri 6 Mar 2026 10:00 EST -> Mon 9 Mar 09:00 EDT.
		expect(nextRunAfter(weekdays, utc(2026, 3, 6, 15))).toBe(utc(2026, 3, 9, 13));
	});

	it("runs a time the spring-forward gap skips at the first moment after it, once", () => {
		const nightly = cron("30 2 * * *", "America/New_York");
		const first = nextRunAfter(nightly, utc(2026, 3, 7, 17));
		expect(first).toBe(utc(2026, 3, 8, 7, 30));
		expect(nextRunAfter(nightly, first ?? 0)).toBe(utc(2026, 3, 9, 6, 30));
		// A zone whose gap starts at 01:00 UTC.
		expect(nextRunAfter(cron("0 1 * * *", "Europe/London"), utc(2026, 3, 28, 12))).toBe(utc(2026, 3, 29, 1));
	});

	it("runs a fixed time the fall-back hour repeats once, at its first occurrence", () => {
		const nightly = cron("30 1 * * *", "America/New_York");
		const first = nextRunAfter(nightly, utc(2026, 10, 31, 16));
		expect(first).toBe(utc(2026, 11, 1, 5, 30));
		expect(nextRunAfter(nightly, first ?? 0)).toBe(utc(2026, 11, 2, 6, 30));
	});

	it("keeps an hourly cron ticking through the repeated hour, and does not double the gap hour", () => {
		const hourly = cron("0 * * * *", "America/New_York");
		expect(nextRuns(hourly, utc(2026, 11, 1, 4, 30), 3)).toEqual([
			utc(2026, 11, 1, 5),
			utc(2026, 11, 1, 6),
			utc(2026, 11, 1, 7),
		]);
		expect(nextRuns(hourly, utc(2026, 3, 8, 6, 30), 3)).toEqual([
			utc(2026, 3, 8, 7),
			utc(2026, 3, 8, 8),
			utc(2026, 3, 8, 9),
		]);
	});

	it("handles zones that change by half an hour and zones off the hour", () => {
		// Lord Howe's DST ends 5 Apr 2026 at 02:00 (+11), going back to 01:30 (+10:30).
		const nightly = cron("45 1 * * *", "Australia/Lord_Howe");
		const first = nextRunAfter(nightly, utc(2026, 4, 4, 3));
		expect(first).toBe(utc(2026, 4, 4, 14, 45));
		expect(nextRunAfter(nightly, first ?? 0)).toBe(utc(2026, 4, 5, 15, 15));
		expect(nextRunAfter(cron("30 9 * * *", "Asia/Kolkata"), utc(2026, 10, 9))).toBe(utc(2026, 10, 9, 4));
	});

	it("reads its own zone, not the machine's, and the machine's when it has none", () => {
		const berlin = cron("0 9 * * *", "Europe/Berlin");
		expect(nextRunAfter(berlin, utc(2026, 10, 9))).toBe(utc(2026, 10, 9, 7));
		expect(nextRunAfter(cron("0 9 * * *"), utc(2026, 10, 8, 12))).toBe(utc(2026, 10, 9, 0));
	});

	it("matches a day by month day or weekday when both are given, and by both otherwise", () => {
		expect(nextRuns(cron("0 0 13 * 5", "UTC"), utc(2026, 10, 1), 3)).toEqual([
			utc(2026, 10, 2),
			utc(2026, 10, 9),
			utc(2026, 10, 13),
		]);
		// A day-of-month list alone ignores the weekday.
		expect(nextRunAfter(cron("0 0 1-7 * *", "UTC"), utc(2026, 10, 7))).toBe(utc(2026, 11, 1));
		expect(nextRunAfter(cron("0 0 * * 7", "UTC"), utc(2026, 10, 9))).toBe(utc(2026, 10, 11));
	});

	it("finds a leap day years away", () => {
		expect(nextRunAfter(cron("0 0 29 2 *", "UTC"), utc(2026, 1, 1))).toBe(utc(2028, 2, 29));
	});
});

describe("nextRunAfter: interval", () => {
	it("counts from its anchor whatever the delay in noticing a slot, and from `after` without one", () => {
		const anchor = utc(2026, 10, 9, 9);
		const every30: ScheduleWhen = { kind: "interval", everyMin: 30, anchor };
		expect(nextRunAfter(every30, anchor + 10 * 60_000)).toBe(anchor + 30 * 60_000);
		expect(nextRunAfter(every30, anchor + 30 * 60_000)).toBe(anchor + 60 * 60_000);
		expect(nextRunAfter(every30, anchor + 31 * 60_000 + 15_000)).toBe(anchor + 60 * 60_000);
		expect(nextRunAfter(every30, anchor - 5 * 60_000)).toBe(anchor + 30 * 60_000);
		expect(nextRunAfter({ kind: "interval", everyMin: 30 }, anchor)).toBe(anchor + 30 * 60_000);
	});
});

describe("parseScheduleWhen", () => {
	it("trims and validates a cron and its zone, and bounds an interval", () => {
		expect(parseScheduleWhen({ kind: "cron", expr: " 0 9 * * 1-5 ", tz: "Europe/Berlin" })).toEqual(
			cron("0 9 * * 1-5", "Europe/Berlin"),
		);
		expect(() => parseScheduleWhen({ kind: "cron", expr: "0 9 * * 1-5", tz: "Mars/Base" })).toThrow("time zone");
		expect(() => parseScheduleWhen({ kind: "cron", expr: 9 })).toThrow("text");
		expect(() => parseScheduleWhen({ kind: "interval", everyMin: MIN_INTERVAL_MINUTES - 1 })).toThrow("interval");
		expect(() => parseScheduleWhen({ kind: "interval", everyMin: 7.5 })).toThrow("interval");
		expect(parseScheduleWhen({ kind: "interval", everyMin: 15 })).toEqual({ kind: "interval", everyMin: 15 });
	});
});

describe("wording", () => {
	it("names common cron expressions in words, with the zone when there is one", () => {
		expect(describeCron("0 9 * * 1-5", "Europe/Berlin")).toBe("At 09:00 on weekdays (Europe/Berlin)");
		expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
		expect(describeCron("0 8,17 * * 1,3 ")).toContain("Mon, Wed");
		expect(describeWhen({ kind: "interval", everyMin: 90 })).toBe("Every 1 h 30 min");
		expect(describeWhen(cron("not cron"))).toBe("not cron");
	});
});
