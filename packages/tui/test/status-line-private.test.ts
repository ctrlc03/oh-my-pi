import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

/** Contract: a private session's `mode` segment leads with a `Private` badge, before any session mode. */
beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(over: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...over,
	};
}

describe("status line private badge", () => {
	it("shows the Private badge alone, and ahead of an active mode", () => {
		const alone = renderSegment("mode", createContext({ private: true }));
		expect(alone.visible).toBe(true);
		expect(Bun.stripANSI(alone.content)).toBe("Private");

		const withPlan = renderSegment(
			"mode",
			createContext({ private: true, planMode: { enabled: true, paused: false } }),
		);
		expect(Bun.stripANSI(withPlan.content).startsWith("Private ")).toBe(true);
	});

	it("renders nothing for a normal session", () => {
		expect(renderSegment("mode", createContext()).visible).toBe(false);
	});
});
