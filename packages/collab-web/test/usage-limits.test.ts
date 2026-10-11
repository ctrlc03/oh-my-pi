import { describe, expect, it } from "bun:test";
import type { SessionLimited, WireLimitWindow } from "@oh-my-pi/pi-wire";
import {
	barPercent,
	canResumeAtReset,
	clockLabel,
	countdown,
	groupWindows,
	limitedText,
	limitedUntil,
	usedPercent,
	windowTone,
} from "../src/lib/usage-limits";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();

const window = (over: Partial<WireLimitWindow> & { label: string }): WireLimitWindow => ({
	provider: "anthropic",
	...over,
});

describe("countdown", () => {
	it("rounds down to the minute and switches units at the hour and the day", () => {
		expect(countdown(NOW - 1, NOW)).toBe("now");
		expect(countdown(NOW + 30_000, NOW)).toBe("<1m");
		expect(countdown(NOW + 12 * MIN + 59_000, NOW)).toBe("12m");
		expect(countdown(NOW + 2 * HOUR + 5 * MIN, NOW)).toBe("2h 05m");
		expect(countdown(NOW + 3 * 24 * HOUR + 4 * HOUR + 59 * MIN, NOW)).toBe("3d 4h");
	});
});

describe("clockLabel", () => {
	it("shows the weekday only when the time is not today", () => {
		expect(clockLabel(NOW + 2 * HOUR + 30 * MIN, NOW)).toBe("14:30");
		expect(clockLabel(NOW + 24 * HOUR + 30 * MIN, NOW)).toMatch(/^[A-Z][a-z]{2} 12:30$/);
	});
});

describe("limited state", () => {
	const blocked: SessionLimited = { kind: "blocked", provider: "anthropic", until: NOW + 2 * HOUR + 30 * MIN };

	it("words the reset, a reset that has passed, and an unknown reset", () => {
		expect(limitedText(blocked, NOW)).toBe("Limited on anthropic until 14:30 · in 2h 30m");
		expect(limitedText({ ...blocked, until: NOW - 1 }, NOW)).toBe("Limited on anthropic: limit reset");
		expect(limitedText({ kind: "low-priority" }, NOW)).toBe("Slow lane");
	});

	it("offers resume only for a reset that is still ahead", () => {
		expect(canResumeAtReset(blocked, NOW)).toBe(true);
		expect(canResumeAtReset({ ...blocked, until: NOW }, NOW)).toBe(false);
		expect(canResumeAtReset({ kind: "blocked" }, NOW)).toBe(false);
		expect(canResumeAtReset(undefined, NOW)).toBe(false);
	});

	it("gives the reset to the sessions list only while it is ahead", () => {
		expect(limitedUntil({ limited: blocked }, NOW)).toBe(blocked.until!);
		expect(limitedUntil({ limited: { ...blocked, until: NOW - 5 } }, NOW)).toBeNull();
		expect(limitedUntil({}, NOW)).toBeNull();
		expect(limitedUntil(undefined, NOW)).toBeNull();
	});
});

describe("windows", () => {
	it("derives percent, bar fill and tone from the used fraction and status", () => {
		expect(usedPercent(window({ label: "a", usedFraction: 0.624 }))).toBe(62);
		expect(usedPercent(window({ label: "a" }))).toBeNull();
		expect(barPercent(window({ label: "a", usedFraction: 1.4 }))).toBe(100);
		expect(barPercent(window({ label: "a" }))).toBe(0);
		expect(windowTone(window({ label: "a", usedFraction: 0.5 }))).toBe("ok");
		expect(windowTone(window({ label: "a", usedFraction: 0.85 }))).toBe("low");
		expect(windowTone(window({ label: "a", usedFraction: 1 }))).toBe("full");
		expect(windowTone(window({ label: "a", status: "exhausted" }))).toBe("full");
	});

	it("groups by account with the open session's provider first and the soonest reset first", () => {
		const groups = groupWindows(
			[
				window({ provider: "openai", account: "x", label: "wk", resetsAt: NOW + 5 * HOUR }),
				window({ provider: "anthropic", account: "x", label: "7d", resetsAt: NOW + 50 * HOUR }),
				window({ provider: "anthropic", account: "x", label: "5h", resetsAt: NOW + HOUR }),
				window({ provider: "anthropic", account: "x", label: "unknown" }),
			],
			"openai",
		);
		expect(groups.map(group => [group.provider, group.active])).toEqual([
			["openai", true],
			["anthropic", false],
		]);
		expect(groups[1]?.windows.map(w => w.label)).toEqual(["5h", "7d", "unknown"]);
	});
});
