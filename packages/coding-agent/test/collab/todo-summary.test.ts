import { describe, expect, it } from "bun:test";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import {
	MAX_TODO_TEXT_CHARS,
	sessionTodoSummary,
	summarizeTodoPhases,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { promptedSinceTodoChange } from "@oh-my-pi/pi-coding-agent/session/todo-recency";

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
		const summary = summarizeTodoPhases([
			phase(["first\nsecond  line", "in_progress"], ["x".repeat(500), "completed"]),
		]);
		expect(summary?.current).toBe("first second line");
		expect(summary?.lastDone?.length).toBe(MAX_TODO_TEXT_CHARS);
		expect(summary?.lastDone?.endsWith("…")).toBe(true);
	});
});

describe("sessionTodoSummary", () => {
	const finished = [phase(["Fast-forward main", "completed"], ["Reinstall omp", "completed"])];
	const open = [phase(["Fast-forward main", "completed"], ["Reinstall omp", "in_progress"])];

	function sessionWith(build: (manager: SessionManager) => void, phases: ReturnType<typeof phase>[]) {
		const manager = SessionManager.inMemory("/tmp");
		build(manager);
		return { getTodoPhases: () => phases, promptedSinceTodoChange: () => promptedSinceTodoChange(manager) };
	}
	const prompt = (manager: SessionManager, text: string) =>
		manager.appendMessage({ role: "user", content: text, timestamp: 1 });
	const todoCall = (manager: SessionManager) =>
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "todo",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		});

	it("keeps a finished list until the user asks for something else", () => {
		const current = sessionWith(manager => {
			prompt(manager, "release it");
			todoCall(manager);
		}, finished);
		expect(sessionTodoSummary(current)?.lastDone).toBe("Reinstall omp");

		const stale = sessionWith(manager => {
			prompt(manager, "release it");
			todoCall(manager);
			prompt(manager, "why was this triggered today?");
		}, finished);
		expect(sessionTodoSummary(stale)).toBeUndefined();
	});

	it("counts a prompt sent from the app, and not an injected one", () => {
		const fromApp = sessionWith(manager => {
			todoCall(manager);
			manager.appendCustomMessageEntry(
				COLLAB_PROMPT_MESSAGE_TYPE,
				"and the IRC feed?",
				true,
				{ from: "phone" },
				"user",
			);
		}, finished);
		expect(sessionTodoSummary(fromApp)).toBeUndefined();

		const injected = sessionWith(manager => {
			todoCall(manager);
			manager.appendMessage({ role: "user", content: "continue", synthetic: true, timestamp: 3 });
		}, finished);
		expect(sessionTodoSummary(injected)?.done).toBe(2);
	});

	it("keeps a list with open tasks whatever came after it", () => {
		const session = sessionWith(manager => {
			todoCall(manager);
			prompt(manager, "also look at this");
		}, open);
		expect(sessionTodoSummary(session)?.current).toBe("Reinstall omp");
	});
});
