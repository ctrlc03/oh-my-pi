/**
 * The fork's status-line facts (packages/tui/test/status-line-private.test.ts and
 * status-line-cache-last.test.ts before the pi-tui rewrite): the `mode` segment's private
 * badge and agent profile, and the `cache_last` segment, as the native bar's spans.
 */
import { describe, expect, it } from "bun:test";
import { STATUS_LINE_SEGMENT_IDS } from "../../../src/config/status-line-schema";
import { STATUS_LINE_PRESETS } from "../../../src/modes/view-model/status-line/presets";
import { cacheHitPct } from "../../../src/session/transcript/cache-invalidation-marker";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { corpusStatusFacts } from "./fixture";

const settings = effectiveStatusSettings({ preset: "custom", sessionAccent: false });

function text(id: "mode" | "cache_last", facts: Partial<StatusFacts>): string | undefined {
	return segmentView(id, { ...corpusStatusFacts(), plan: undefined, ...facts }, settings)
		?.spans.map(part => part.t)
		.join("");
}

describe("mode segment: private badge and agent profile", () => {
	it("shows the Private badge alone, and ahead of an active mode", () => {
		expect(text("mode", { privateSession: true })).toBe("Private");
		expect(text("mode", { privateSession: true, plan: { enabled: true, paused: false } })).toBe("Private Plan");
	});

	it("leads with the agent profile, after the Private badge", () => {
		expect(text("mode", { agentProfile: "review" })).toBe("review");
		expect(text("mode", { privateSession: true, agentProfile: "review" })).toBe("Private review");
	});

	it("renders nothing for a normal session without modes", () => {
		expect(text("mode", {})).toBeUndefined();
	});
});

describe("cache_last segment", () => {
	it("shows the last request's hit share, rounded", () => {
		expect(text("cache_last", { lastCacheHitPct: 62.5 })).toBe("63%");
	});

	it("is hidden before any request carried a prompt", () => {
		expect(text("cache_last", {})).toBeUndefined();
	});

	it("is not enabled by any preset", () => {
		for (const preset of Object.values(STATUS_LINE_PRESETS)) {
			expect([...preset.leftSegments, ...preset.rightSegments]).not.toContain("cache_last");
		}
		expect(STATUS_LINE_SEGMENT_IDS).toContain("cache_last");
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
