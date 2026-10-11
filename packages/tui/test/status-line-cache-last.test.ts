import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cacheHitPct } from "../src/chat/cache-invalidation-marker";
import { getPreset } from "../src/status-line/presets";
import { STATUS_LINE_SEGMENT_IDS } from "../src/status-line/schema";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

describe("cache status-line segment", () => {
	it("shows the last request's hit share, not the session's", () => {
		const ctx = { lastCacheHitPct: 62.5 } as unknown as SegmentContext;
		const result = renderSegment("cache", ctx);
		expect(result.visible).toBe(true);
		expect(stripVTControlCharacters(result.content)).toContain("63%");
	});

	it("is hidden before any request carried a prompt", () => {
		expect(renderSegment("cache", { lastCacheHitPct: null } as unknown as SegmentContext).visible).toBe(false);
		expect(renderSegment("cache", {} as unknown as SegmentContext).visible).toBe(false);
	});

	it("is not enabled by any preset", () => {
		for (const name of ["default", "minimal", "compact", "full", "nerd", "ascii"] as const) {
			const preset = getPreset(name);
			expect([...preset.leftSegments, ...preset.rightSegments]).not.toContain("cache");
		}
		expect(STATUS_LINE_SEGMENT_IDS).toContain("cache");
	});
});

describe("cacheHitPct", () => {
	it("divides cache reads by every prompt token", () => {
		expect(cacheHitPct({ cacheRead: 600, cacheWrite: 300, input: 100 })).toBeCloseTo(60);
		expect(cacheHitPct({ cacheRead: 800, cacheWrite: 0, input: 200 })).toBeCloseTo(80);
	});

	it("is undefined without prompt tokens", () => {
		expect(cacheHitPct({ cacheRead: 0, cacheWrite: 0, input: 0 })).toBeUndefined();
	});
});
