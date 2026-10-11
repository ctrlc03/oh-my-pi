import { describe, expect, it } from "bun:test";
import type { SessionCacheStats } from "@oh-my-pi/pi-wire";
import { fmtHit, fmtRate, lastRequestMiss, missLabel } from "../src/lib/cache-strip";
import { MockCache } from "../scripts/mock-cache";

describe("cache strip helpers", () => {
	it("names every cause and passes an unknown one through", () => {
		expect(missLabel("system-prompt")).toBe("system prompt changed");
		expect(missLabel("ttl")).toBe("cache expired while idle");
		expect(missLabel("disk-full")).toBe("disk-full");
	});

	it("attaches a miss only to the request it belongs to", () => {
		const base = { requests: 3, misses: 1 } as const;
		const last = { at: 200, model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 1, costUsd: 0 };
		const miss = { at: 200, reasons: ["tools" as const], reprocessedTokens: 5_000, model: "m" };
		const current: SessionCacheStats = { ...base, last, recentMisses: [miss] };
		expect(lastRequestMiss(current)?.reasons).toEqual(["tools"]);
		const later: SessionCacheStats = { ...base, last: { ...last, at: 300 }, recentMisses: [miss] };
		expect(lastRequestMiss(later)).toBeUndefined();
	});

	it("formats hit share and rate", () => {
		expect(fmtHit(92.4)).toBe("92%");
		expect(fmtHit(undefined)).toBe("—");
		expect(fmtRate(38.04)).toBe("38.0 tok/s");
		expect(fmtRate(420.6)).toBe("421 tok/s");
	});
});

describe("mock host cache", () => {
	it("starts cold, warms, and attributes a model change", () => {
		const cache = new MockCache();
		expect(cache.snapshot()).toBeUndefined();
		cache.settle("m", 1);
		expect(cache.snapshot()?.last?.hitPct).toBe(0);
		expect(cache.snapshot()?.misses).toBe(0);
		cache.settle("m", 2);
		expect(cache.snapshot()?.last?.hitPct).toBeGreaterThan(90);
		cache.note("model");
		cache.settle("m2", 3);
		const snapshot = cache.snapshot();
		expect(snapshot?.misses).toBe(1);
		expect(snapshot?.recentMisses[0]?.reasons).toEqual(["model"]);
		expect(snapshot?.last?.hitPct).toBe(0);
	});
});
