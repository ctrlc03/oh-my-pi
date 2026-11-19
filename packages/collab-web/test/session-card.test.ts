import { describe, expect, it } from "bun:test";
import {
	cardFilterOptions,
	cleanNote,
	filterByCard,
	MAX_NOTE_CHARS,
	parseCardUpdate,
	parseTodoProgress,
	todoLine,
} from "../src/lib/session-card";

describe("cleanNote", () => {
	it("makes one trimmed line of whatever was typed", () => {
		expect(cleanNote("  waiting on\n the   API key \n")).toBe("waiting on the API key");
	});

	it("is empty for anything that is not text", () => {
		expect(cleanNote(undefined)).toBe("");
		expect(cleanNote(42)).toBe("");
	});

	it("cuts a long note to the limit, ending in an ellipsis", () => {
		const note = cleanNote("x".repeat(MAX_NOTE_CHARS + 50));
		expect(note.length).toBe(MAX_NOTE_CHARS);
		expect(note.endsWith("…")).toBe(true);
		expect(cleanNote("x".repeat(MAX_NOTE_CHARS))).toBe("x".repeat(MAX_NOTE_CHARS));
	});
});

describe("parseCardUpdate", () => {
	it("takes a known status, or none, with a cleaned note", () => {
		expect(parseCardUpdate("in-review", " ship it ")).toEqual({ status: "in-review", note: "ship it" });
		expect(parseCardUpdate(null, "only a note")).toEqual({ status: null, note: "only a note" });
		expect(parseCardUpdate(null, undefined)).toEqual({ status: null, note: "" });
	});

	it("refuses a status that is not one of the five", () => {
		expect(() => parseCardUpdate("shipped", "")).toThrow("unknown card status");
		expect(() => parseCardUpdate(undefined, "")).toThrow("unknown card status");
	});

	it("refuses a note that is not text", () => {
		expect(() => parseCardUpdate("todo", 7)).toThrow("invalid note");
	});
});

describe("parseTodoProgress", () => {
	it("reads a well-formed summary", () => {
		expect(parseTodoProgress({ done: 3, total: 7, current: "Write tests", lastDone: "Fix the bug" })).toEqual({
			done: 3,
			total: 7,
			current: "Write tests",
			lastDone: "Fix the bug",
		});
	});

	it("maps a missing or empty task to null", () => {
		expect(parseTodoProgress({ done: 7, total: 7, current: "", lastDone: "Done it" })).toEqual({
			done: 7,
			total: 7,
			current: null,
			lastDone: "Done it",
		});
	});

	it("reads malformed or absent summaries as no progress", () => {
		expect(parseTodoProgress(undefined)).toBeUndefined();
		expect(parseTodoProgress({ done: 1, total: 0 })).toBeUndefined();
		expect(parseTodoProgress({ done: 5, total: 3 })).toBeUndefined();
		expect(parseTodoProgress({ done: -1, total: 3 })).toBeUndefined();
		expect(parseTodoProgress({ done: "1", total: 3 })).toBeUndefined();
	});
});

describe("todoLine", () => {
	it("shows the task in progress, active", () => {
		expect(todoLine({ done: 3, total: 7, current: "Write tests", lastDone: "Fix" })).toEqual({
			progress: "3/7",
			text: "Write tests",
			active: true,
		});
	});

	it("falls back to the last completed task when none is open", () => {
		expect(todoLine({ done: 5, total: 5, current: null, lastDone: "Ship" })).toEqual({
			progress: "5/5",
			text: "Ship",
			active: false,
		});
	});

	it("shows nothing for no todo list", () => {
		expect(todoLine(undefined)).toBeNull();
		expect(todoLine({ done: 0, total: 0, current: null, lastDone: null })).toBeNull();
	});
});

describe("the status filter", () => {
	const rows = [
		{ id: "a", card: { status: "blocked" as const, note: "" } },
		{ id: "b", card: { status: null, note: "just a note" } },
		{ id: "c" },
		{ id: "d", card: { status: "todo" as const, note: "" } },
		{ id: "e", card: { status: "blocked" as const, note: "x" } },
	];

	it("offers the statuses present, in menu order, never a note-only card", () => {
		expect(cardFilterOptions(rows)).toEqual(["todo", "blocked"]);
	});

	it("narrows to a status, or keeps everything for All", () => {
		expect(filterByCard(rows, "blocked").map(row => row.id)).toEqual(["a", "e"]);
		expect(filterByCard(rows, null)).toHaveLength(5);
	});
});
