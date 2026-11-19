import { describe, expect, it } from "bun:test";
import { escapeLeavesFocus, parseFocusMode } from "../src/lib/focus-mode";

describe("parseFocusMode", () => {
	it("is on only for a stored true", () => {
		expect(parseFocusMode(true)).toBe(true);
		for (const raw of [null, undefined, false, "true", 1, {}, []]) expect(parseFocusMode(raw)).toBe(false);
	});
});

describe("escapeLeavesFocus", () => {
	const element = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });

	it("leaves focus mode when Esc lands on the page, with nothing open", () => {
		expect(escapeLeavesFocus(null, false)).toBe(true);
		expect(escapeLeavesFocus(element("BUTTON"), false)).toBe(true);
		expect(escapeLeavesFocus(element("DIV"), false)).toBe(true);
	});

	it("keeps Esc for a text field, a select, the editor and the terminal", () => {
		expect(escapeLeavesFocus(element("TEXTAREA"), false)).toBe(false);
		expect(escapeLeavesFocus(element("INPUT"), false)).toBe(false);
		expect(escapeLeavesFocus(element("SELECT"), false)).toBe(false);
		// The editor's and the terminal's input surfaces are an editable element or a hidden textarea.
		expect(escapeLeavesFocus(element("DIV", true), false)).toBe(false);
	});

	it("keeps Esc for a sheet or a menu that is open", () => {
		expect(escapeLeavesFocus(null, true)).toBe(false);
		expect(escapeLeavesFocus(element("BUTTON"), true)).toBe(false);
	});
});
