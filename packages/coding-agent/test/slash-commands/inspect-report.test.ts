/**
 * Contract: the inspector's text report states the cache share against every prompt token, takes
 * the median time to first token over the requests that reported one, and tolerates requests
 * without timing or prompt tokens.
 */
import { describe, expect, it } from "bun:test";
import type { InspectRow } from "@oh-my-pi/pi-wire";
import {
	formatInspectReport,
	inspectRowDetail,
	inspectRowLine,
	inspectSummary,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/inspect-report";

function row(partial: Partial<InspectRow>): InspectRow {
	return {
		seq: 1,
		entryId: "e1",
		at: 1_700_000_000_000,
		model: "anthropic/claude-test",
		input: 100,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		stopReason: "stop",
		injected: [],
		...partial,
	};
}

describe("inspect report", () => {
	it("divides cache reads by every prompt token", () => {
		expect(inspectRowLine(row({ input: 100, cacheRead: 800, cacheWrite: 100 }))).toContain("cache 80%");
	});

	it("summarises the median ttft of the requests that reported one and the overall cache share", () => {
		const summary = inspectSummary([
			row({ ttftMs: 3_000, input: 0, cacheRead: 100 }),
			row({ ttftMs: 1_000, input: 100 }),
			row({ input: 100 }),
		]);
		expect(summary).toContain("3 requests");
		expect(summary).toContain("median ttft 3.0s");
		expect(summary).toContain("cache 33%");
		expect(inspectSummary([])).toBe("No model requests yet.");
	});

	it("does not invent timing or a cache share where the request has none", () => {
		const line = inspectRowLine(row({ input: 0, output: 0 }));
		expect(line).toContain("no timing");
		expect(line).toContain("cache -");
	});

	it("derives decode time and lists injected items with their excerpts in the detail", () => {
		const detail = inspectRowDetail(
			row({
				ttftMs: 500,
				durationMs: 2_500,
				injected: [{ kind: "todo", label: "Todo reminder", tokens: 12, text: "finish\nyour todos" }],
			}),
		);
		expect(detail).toContain("decode 2.0s");
		expect(detail).toContain("Todo reminder");
		expect(detail).toContain("    your todos");
		expect(formatInspectReport({ rows: [row({})], total: 5 })).toContain("newest 1 of 5");
	});
});
