/**
 * Collab usage limits: report → wire windows, when a provider serves again, and the resume-at-reset
 * timer (arm, fire, re-arm after a refused continue, cancel) against a fake clock and fake timers.
 */
import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { WireLimitWindow } from "@oh-my-pi/pi-wire";
import {
	blockedUntil,
	HostUsageLimits,
	type LimitMessage,
	limitedFromStage,
	limitWindows,
	RESUME_CHECK_MS,
	RESUME_GRACE_MS,
	RESUME_MAX_REARMS,
} from "../../src/collab/usage-limits";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function limit(
	over: Partial<UsageLimit> & { id: string; usedFraction?: number; resetsAt?: number; windowId?: string },
): UsageLimit {
	return {
		id: over.id,
		label: over.label ?? over.id,
		scope: { provider: "anthropic", ...over.scope },
		window:
			over.resetsAt === undefined && over.windowId === undefined
				? undefined
				: { id: over.windowId ?? over.id, label: over.window?.label ?? over.id, resetsAt: over.resetsAt },
		amount: { unit: "percent", usedFraction: over.usedFraction },
		status: over.status,
	} as UsageLimit;
}

function report(email: string | undefined, limits: UsageLimit[]): UsageReport {
	return { provider: "anthropic", fetchedAt: NOW, limits, metadata: email ? { email } : undefined };
}

describe("limitWindows", () => {
	it("keeps limits with an amount or a reset, names the account, and derives a missing status", () => {
		const windows = limitWindows([
			report("a@example.test", [
				limit({ id: "5h", label: "5 Hour", usedFraction: 1, resetsAt: NOW + HOUR }),
				limit({ id: "7d", label: "7 Day", usedFraction: 0.4 }),
				limit({ id: "none" }),
			]),
		]);
		expect(windows.map(w => [w.windowId, w.account, w.usedFraction, w.status, w.resetsAt])).toEqual([
			["5h", "a@example.test", 1, "exhausted", NOW + HOUR],
			[undefined, "a@example.test", 0.4, "ok", undefined],
		]);
	});

	it("is empty for no reports", () => {
		expect(limitWindows(null)).toEqual([]);
		expect(limitWindows([])).toEqual([]);
	});
});

describe("blockedUntil", () => {
	const window = (
		account: string | undefined,
		resetsAt: number | undefined,
		status: WireLimitWindow["status"],
	): WireLimitWindow => ({
		provider: "anthropic",
		account,
		label: "w",
		resetsAt,
		status,
	});

	it("waits for the last exhausted window of the earliest-freed account", () => {
		const windows = [
			window("a", NOW + 1 * HOUR, "exhausted"),
			window("a", NOW + 24 * HOUR, "exhausted"),
			window("b", NOW + 3 * HOUR, "exhausted"),
		];
		expect(blockedUntil(windows, "anthropic", NOW)).toBe(NOW + 3 * HOUR);
	});

	it("is undefined while another account has room, or a reset time is unknown", () => {
		expect(
			blockedUntil([window("a", NOW + HOUR, "exhausted"), window("b", undefined, "ok")], "anthropic", NOW),
		).toBeUndefined();
		expect(blockedUntil([window("a", undefined, "exhausted")], "anthropic", NOW)).toBeUndefined();
		expect(blockedUntil([window("a", NOW + HOUR, "exhausted")], "openai", NOW)).toBeUndefined();
	});

	it("ignores a window that already reset", () => {
		expect(blockedUntil([window("a", NOW - HOUR, "exhausted")], "anthropic", NOW)).toBeUndefined();
	});
});

describe("limitedFromStage", () => {
	it("maps the provider stage and converts the reset to ms", () => {
		expect(limitedFromStage({ stage: "low_priority", resetsAtSec: 100 }, "anthropic")).toEqual({
			kind: "low-priority",
			provider: "anthropic",
			until: 100_000,
		});
		expect(limitedFromStage({ stage: "wrap_up", extraUsage: false }, "anthropic")?.until).toBeUndefined();
		expect(limitedFromStage(undefined, "anthropic")).toBeUndefined();
	});
});

interface Harness {
	limits: HostUsageLimits;
	clock: { now: number };
	sent: number;
	changes: number;
	pushed: number;
	session: {
		isStreaming: boolean;
		model: { provider: string };
		fetchUsageReports: () => Promise<UsageReport[] | null>;
	};
	/** Advance the clock and run every fake timer that falls due, in order. */
	advance(ms: number): void;
	setReports(reports: UsageReport[] | null): void;
}

function harness(): Harness {
	const clock = { now: NOW };
	const timers = new Map<number, { at: number; run: () => void }>();
	let nextTimer = 1;
	let reports: UsageReport[] | null = [];
	const state: Harness = {
		clock,
		sent: 0,
		changes: 0,
		pushed: 0,
		session: {
			isStreaming: false,
			model: { provider: "anthropic" },
			fetchUsageReports: () => Promise.resolve(reports),
		},
		limits: undefined as never,
		advance(ms) {
			const target = clock.now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				clock.now = Math.max(clock.now, due[1].at);
				due[1].run();
			}
			clock.now = target;
		},
		setReports(next) {
			reports = next;
		},
	};
	state.limits = new HostUsageLimits({
		session: state.session,
		sendContinue: () => {
			state.sent++;
			return Promise.resolve();
		},
		onStateChange: () => {
			state.changes++;
		},
		onWindows: () => {
			state.pushed++;
		},
		hasWriters: () => true,
		onError: () => {},
		now: () => clock.now,
		setTimer: (run, ms) => {
			const id = nextTimer++;
			timers.set(id, { at: clock.now + ms, run });
			return id;
		},
		clearTimer: handle => {
			timers.delete(handle as number);
		},
	});
	return state;
}

const limitError = (retryMs?: number): { type: string; message: LimitMessage } => ({
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "error",
		provider: "openai-codex",
		errorStatus: 429,
		errorMessage: `The usage limit has been reached${retryMs === undefined ? "" : ` retry-after-ms=${retryMs}`}`,
	},
});
const success = { type: "message_end", message: { role: "assistant", stopReason: "stop", provider: "openai-codex" } };

describe("HostUsageLimits", () => {
	it("reports a limit error as limited until the reset the error states", () => {
		const h = harness();
		h.limits.observe(limitError(2 * HOUR));
		expect(h.limits.limited()).toEqual({
			kind: "blocked",
			provider: "openai-codex",
			until: NOW + 2 * HOUR,
			resumeAt: undefined,
		});
	});

	it("learns the reset from the usage windows when the error states none", async () => {
		const h = harness();
		h.session.model = { provider: "anthropic" };
		h.setReports([report("a@example.test", [limit({ id: "5h", usedFraction: 1, resetsAt: NOW + HOUR })])]);
		h.limits.observe({ ...limitError(), message: { ...limitError().message, provider: "anthropic" } });
		expect(h.limits.limited()?.until).toBeUndefined();
		await h.limits.refresh(true);
		expect(h.limits.limited()?.until).toBe(NOW + HOUR);
		expect(h.pushed).toBe(1);
	});

	it("refuses to arm without a limit or a reset time", () => {
		const h = harness();
		expect(h.limits.arm()).toEqual({ ok: false, error: "this session is not limited" });
		h.limits.observe(limitError());
		expect(h.limits.arm().ok).toBe(false);
	});

	it("sends continue once, after the reset plus the grace", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		const armed = h.limits.arm();
		expect(armed).toEqual({ ok: true, at: NOW + HOUR + RESUME_GRACE_MS });
		expect(h.limits.limited()?.resumeAt).toBe(NOW + HOUR + RESUME_GRACE_MS);
		h.advance(HOUR);
		expect(h.sent).toBe(0);
		h.advance(RESUME_GRACE_MS);
		expect(h.sent).toBe(1);
		expect(h.limits.armedAt).toBeUndefined();
		h.advance(10 * HOUR);
		expect(h.sent).toBe(1);
	});

	it("keeps checking the wall clock instead of trusting one long timer", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		h.limits.arm();
		// A sleeping machine moves the clock without running timers; the next check must still fire.
		h.clock.now += 2 * HOUR;
		h.advance(RESUME_CHECK_MS);
		expect(h.sent).toBe(1);
	});

	it("cancel disarms and nothing is sent", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		h.limits.arm();
		expect(h.limits.cancel()).toBe(true);
		expect(h.limits.cancel()).toBe(false);
		expect(h.limits.limited()?.resumeAt).toBeUndefined();
		h.advance(2 * HOUR);
		expect(h.sent).toBe(0);
	});

	it("drops the resume when the session works again before the reset", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		h.limits.arm();
		h.limits.observe(success);
		expect(h.limits.limited()).toBeUndefined();
		h.advance(2 * HOUR);
		expect(h.sent).toBe(0);
	});

	it("does not interrupt a session that is already working at the reset", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		h.limits.arm();
		h.session.isStreaming = true;
		h.advance(HOUR + RESUME_GRACE_MS);
		expect(h.sent).toBe(0);
	});

	it("arms again when the continue is refused by the limit, up to a cap", () => {
		const h = harness();
		h.limits.observe(limitError(HOUR));
		h.limits.arm();
		for (let attempt = 1; attempt <= RESUME_MAX_REARMS + 1; attempt++) {
			h.advance(HOUR + RESUME_GRACE_MS);
			expect(h.sent).toBe(attempt);
			// The continue fails on the limit again, a little later.
			h.limits.observe(limitError(HOUR));
		}
		expect(h.limits.armedAt).toBeUndefined();
		const sent = h.sent;
		h.advance(10 * HOUR);
		expect(h.sent).toBe(sent);
	});

	it("shows the provider's wrap-up stage as limited and arms for its reset", () => {
		const h = harness();
		(h.session as Record<string, unknown>).getUsageLimitState = () => ({
			stage: "wrap_up",
			resetsAtSec: (NOW + HOUR) / 1000,
			extraUsage: false,
		});
		// Re-create against the extended session.
		const limits = new HostUsageLimits({
			session: h.session as never,
			sendContinue: () => Promise.resolve(),
			onStateChange: () => {},
			onWindows: () => {},
			hasWriters: () => false,
			onError: () => {},
			now: () => h.clock.now,
		});
		expect(limits.limited()).toEqual({
			kind: "wrap-up",
			provider: "anthropic",
			until: NOW + HOUR,
			resumeAt: undefined,
		});
		const armed = limits.arm();
		expect(armed.ok).toBe(true);
		limits.dispose();
	});
});
