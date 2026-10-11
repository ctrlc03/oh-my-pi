import { describe, expect, it } from "bun:test";
import type { InspectRow } from "@oh-my-pi/pi-wire";
import { cacheFraction, decodeMs, median, shortModel, slowestMs, summarize, timingBar } from "../src/lib/timeline";

function row(overrides: Partial<InspectRow>): InspectRow {
	return {
		seq: 1,
		entryId: "a",
		at: 0,
		model: "anthropic/claude-sonnet-4-5",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		stopReason: "stop",
		injected: [],
		...overrides,
	};
}

describe("cacheFraction", () => {
	it("is cache reads over everything the request read in", () => {
		expect(cacheFraction({ input: 100, cacheRead: 800, cacheWrite: 100 })).toBeCloseTo(0.8);
	});

	it("is null, not NaN, when the request reported no input", () => {
		expect(cacheFraction({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});

describe("timingBar", () => {
	it("scales the whole bar to the slowest request and splits it at the first token", () => {
		const bar = timingBar({ ttftMs: 1_000, durationMs: 2_000 }, 4_000);
		expect(bar?.wait).toBeCloseTo(0.25);
		expect(bar?.decode).toBeCloseTo(0.25);
		expect(timingBar({ ttftMs: 500, durationMs: 4_000 }, 4_000)).toEqual({ wait: 0.125, decode: 0.875 });
	});

	it("draws the whole bar as decode when the first-token time is missing", () => {
		expect(timingBar({ durationMs: 1_000 }, 2_000)).toEqual({ wait: 0, decode: 0.5 });
	});

	it("clamps a first-token time longer than the duration", () => {
		const bar = timingBar({ ttftMs: 5_000, durationMs: 1_000 }, 1_000);
		expect(bar).toEqual({ wait: 1, decode: 0 });
	});

	it("has no bar without a duration or a slowest request", () => {
		expect(timingBar({ ttftMs: 100 }, 1_000)).toBeNull();
		expect(timingBar({ durationMs: 0 }, 1_000)).toBeNull();
		expect(timingBar({ durationMs: 500 }, 0)).toBeNull();
	});
});

describe("decodeMs and slowestMs", () => {
	it("is duration minus first-token time, null when either is missing", () => {
		expect(decodeMs({ ttftMs: 300, durationMs: 1_300 })).toBe(1_000);
		expect(decodeMs({ durationMs: 1_300 })).toBeNull();
		expect(decodeMs({ ttftMs: 300 })).toBeNull();
	});

	it("finds the longest duration, 0 when none reported one", () => {
		expect(slowestMs([{ durationMs: 10 }, {}, { durationMs: 90 }])).toBe(90);
		expect(slowestMs([{}])).toBe(0);
	});
});

describe("median", () => {
	it("takes the middle value, and the mean of the two middle ones for an even count", () => {
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(median([])).toBeNull();
	});
});

describe("summarize", () => {
	it("totals cost and tokens and pools the cache share across requests", () => {
		const summary = summarize([
			row({ input: 100, output: 10, cacheRead: 0, cacheWrite: 900, cost: 0.5, ttftMs: 1_000 }),
			row({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: 0.25, ttftMs: 3_000 }),
			row({ cost: 0.1, error: "boom", stopReason: "error" }),
		]);
		expect(summary.requests).toBe(3);
		expect(summary.cost).toBeCloseTo(0.85);
		expect(summary.tokens).toBe(2_030);
		expect(summary.medianTtftMs).toBe(2_000);
		expect(summary.cacheFraction).toBeCloseTo(0.45);
		expect(summary.errors).toBe(1);
	});

	it("has no median or cache share for an empty list", () => {
		const summary = summarize([]);
		expect(summary.medianTtftMs).toBeNull();
		expect(summary.cacheFraction).toBeNull();
	});
});

describe("shortModel", () => {
	it("drops the provider", () => {
		expect(shortModel("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(shortModel("local")).toBe("local");
	});
});
