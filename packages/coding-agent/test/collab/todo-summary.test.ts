import { describe, expect, it } from "bun:test";
import { MAX_TODO_TEXT_CHARS, summarizeTodoPhases } from "@oh-my-pi/pi-coding-agent/collab/registry";

const phase = (...tasks: [content: string, status: string][]) => ({
	tasks: tasks.map(([content, status]) => ({ content, status })),
});

describe("summarizeTodoPhases", () => {
	it("has nothing to report for an empty list or one of abandoned tasks only", () => {
		expect(summarizeTodoPhases([])).toBeUndefined();
		expect(summarizeTodoPhases([phase(["a", "abandoned"])])).toBeUndefined();
	});

	it("counts across phases, leaving abandoned tasks out of the total", () => {
		const summary = summarizeTodoPhases([
			phase(["a", "completed"], ["b", "abandoned"]),
			phase(["c", "completed"], ["d", "in_progress"], ["e", "pending"]),
		]);
		expect(summary).toEqual({ done: 2, total: 4, current: "d", lastDone: "c" });
	});

	it("prefers the task in progress to an earlier pending one", () => {
		const summary = summarizeTodoPhases([phase(["a", "pending"], ["b", "in_progress"])]);
		expect(summary?.current).toBe("b");
	});

	it("falls back to the first pending task when none is in progress", () => {
		const summary = summarizeTodoPhases([phase(["a", "completed"], ["b", "pending"], ["c", "pending"])]);
		expect(summary).toEqual({ done: 1, total: 3, current: "b", lastDone: "a" });
	});

	it("leaves current empty once everything is done, keeping the last completed task", () => {
		const summary = summarizeTodoPhases([phase(["a", "completed"], ["b", "completed"])]);
		expect(summary).toEqual({ done: 2, total: 2, current: null, lastDone: "b" });
	});

	it("makes each task text one bounded line", () => {
		const summary = summarizeTodoPhases([phase(["first\nsecond  line", "in_progress"], ["x".repeat(500), "completed"])]);
		expect(summary?.current).toBe("first second line");
		expect(summary?.lastDone?.length).toBe(MAX_TODO_TEXT_CHARS);
		expect(summary?.lastDone?.endsWith("…")).toBe(true);
	});
});
