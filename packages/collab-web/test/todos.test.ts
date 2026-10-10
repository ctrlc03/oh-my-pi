import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../src/lib/client";
import { currentTodos } from "../src/lib/todos";

type Status = "pending" | "in_progress" | "completed" | "abandoned";

function phases(...lists: [string, Status][][]): unknown {
	return lists.map((tasks, i) => ({
		name: `Phase ${i + 1}`,
		tasks: tasks.map(([content, status]) => ({ content, status })),
	}));
}

let seq = 0;

function result(toolName: string, details: unknown, isError = false): SessionEntry {
	return {
		type: "message",
		id: `r${++seq}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: `c${seq}`,
			toolName,
			content: [{ type: "text", text: "ok" }],
			details,
			isError,
			timestamp: 1,
		},
	};
}

const todo = (board: unknown, isError = false): SessionEntry => result("todo", { phases: board }, isError);

describe("currentTodos", () => {
	it("is null when the agent never used the todo tool", () => {
		expect(currentTodos([result("bash", { phases: phases([["a", "pending"]]) })])).toBeNull();
	});

	it("takes the last todo result, not the first", () => {
		const state = currentTodos([
			todo(phases([["old", "in_progress"]])),
			todo(
				phases([
					["a", "completed"],
					["b", "pending"],
				]),
			),
		]);
		expect(state?.total).toBe(2);
		expect(state?.done).toBe(1);
		expect(state?.current).toBe("b");
	});

	it("ignores a failed todo call and keeps the previous board", () => {
		const state = currentTodos([todo(phases([["a", "in_progress"]])), todo(phases([["junk", "completed"]]), true)]);
		expect(state?.current).toBe("a");
		expect(state?.done).toBe(0);
	});

	it("counts abandoned tasks as neither done nor remaining", () => {
		const state = currentTodos([
			todo(
				phases([
					["a", "completed"],
					["b", "abandoned"],
					["c", "pending"],
				]),
			),
		]);
		expect(state?.done).toBe(1);
		expect(state?.total).toBe(2);
		expect(currentTodos([todo(phases([["a", "abandoned"]]))])?.current).toBeNull();
	});

	it("prefers the in-progress task over earlier pending ones", () => {
		const state = currentTodos([
			todo(
				phases(
					[
						["a", "pending"],
						["b", "completed"],
					],
					[["c", "in_progress"]],
				),
			),
		]);
		expect(state?.current).toBe("c");
	});

	it("falls back to the first pending task, and to null when all are done", () => {
		const open = currentTodos([
			todo(
				phases([
					["a", "completed"],
					["b", "pending"],
					["c", "pending"],
				]),
			),
		]);
		expect(open?.current).toBe("b");
		const closed = currentTodos([todo(phases([["a", "completed"]]))]);
		expect(closed?.current).toBeNull();
		expect(closed?.done).toBe(closed?.total);
	});

	it("reads a todo run through `write xd://todo`", () => {
		const board = phases([["a", "in_progress"]]);
		const state = currentTodos([
			result("write", { xdev: { mode: "execute", tool: "todo", args: {}, inner: { phases: board } } }),
		]);
		expect(state?.current).toBe("a");
		// Another device's details are not a task list, even if they happen to carry `phases`.
		expect(
			currentTodos([
				result("write", { xdev: { mode: "execute", tool: "ast_edit", args: {}, inner: { phases: board } } }),
			]),
		).toBeNull();
	});

	it("treats an emptied list as no remaining work, not as the previous list", () => {
		const state = currentTodos([todo(phases([["a", "pending"]])), todo([])]);
		expect(state?.total).toBe(0);
	});

	it("uses a running todo call's partial board over committed entries", () => {
		const entries = [todo(phases([["a", "in_progress"]]))];
		const live = new Map<string, ActiveTool>([
			[
				"x",
				{
					toolCallId: "x",
					toolName: "todo",
					args: {},
					partialResult: { details: { phases: phases([["a", "completed"]], [["b", "in_progress"]]) } },
					startedAt: 0,
				},
			],
		]);
		expect(currentTodos(entries, live)?.current).toBe("b");
		expect(currentTodos(entries, new Map())?.current).toBe("a");
	});
});
