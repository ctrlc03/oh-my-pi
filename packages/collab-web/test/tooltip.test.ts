import { describe, expect, it } from "bun:test";
import { formatKeyshortcuts, placeTip, resolveTipText } from "../src/lib/tooltip";

const none = { dataTip: null, title: null, ariaLabel: null, text: "" };

describe("resolveTipText", () => {
	it("prefers data-tip, then title, then the aria-label of an icon-only control", () => {
		expect(resolveTipText({ ...none, dataTip: "Tip", title: "Title", ariaLabel: "Label" })).toBe("Tip");
		expect(resolveTipText({ ...none, title: "Title", ariaLabel: "Label" })).toBe("Title");
		expect(resolveTipText({ ...none, ariaLabel: "Label" })).toBe("Label");
	});

	it("ignores the aria-label of a control with visible text", () => {
		expect(resolveTipText({ ...none, ariaLabel: "Open the menu", text: "Menu" })).toBeNull();
	});

	it("is null when there is nothing to say or the visible text already says it", () => {
		expect(resolveTipText(none)).toBeNull();
		expect(resolveTipText({ ...none, dataTip: "  " })).toBeNull();
		expect(resolveTipText({ ...none, title: "Copy", text: " Copy " })).toBeNull();
		expect(resolveTipText({ ...none, title: "copy.", text: "Copy reply" })).toBeNull();
	});

	it("keeps a tip that says more than the visible text", () => {
		expect(resolveTipText({ ...none, title: "Copy the reply to the clipboard", text: "Copy" })).toBe(
			"Copy the reply to the clipboard",
		);
	});

	it("collapses runs of blanks but keeps line breaks", () => {
		expect(resolveTipText({ ...none, title: "  Stash   the\tdraft " })).toBe("Stash the draft");
		expect(resolveTipText({ ...none, title: "Relay audit\n  ~/Projects/pi" })).toBe("Relay audit\n~/Projects/pi");
	});
});

describe("formatKeyshortcuts", () => {
	it("spells modifiers as symbols on Mac and as words elsewhere", () => {
		expect(formatKeyshortcuts("Meta+k", true)).toBe("⌘K");
		expect(formatKeyshortcuts("Meta+Shift+ArrowUp", true)).toBe("⌘⇧↑");
		expect(formatKeyshortcuts("Meta+k", false)).toBe("Ctrl+K");
		expect(formatKeyshortcuts("Meta+Shift+ArrowUp", false)).toBe("Ctrl+Shift+↑");
	});

	it("shows only the first alternative and nothing for an empty value", () => {
		expect(formatKeyshortcuts("Meta+k Control+k", false)).toBe("Ctrl+K");
		expect(formatKeyshortcuts("  ", false)).toBeNull();
	});
});

describe("placeTip", () => {
	const view = { width: 800, height: 600 };
	const insets = { top: 0, right: 0, bottom: 0, left: 0 };
	const tip = { width: 100, height: 30 };

	it("centres above the target", () => {
		const place = placeTip({ left: 350, top: 300, width: 40, height: 40 }, tip, view, insets);
		expect(place).toEqual({ left: 320, top: 260, side: "top", arrow: 50 });
	});

	it("flips below when there is no room above", () => {
		const place = placeTip({ left: 350, top: 10, width: 40, height: 40 }, tip, view, insets);
		expect(place.side).toBe("bottom");
		expect(place.top).toBe(60);
	});

	it("stays inside the viewport margin and safe-area insets, with the arrow still on the target", () => {
		const left = placeTip({ left: 0, top: 300, width: 20, height: 20 }, tip, view, { ...insets, left: 20 });
		expect(left.left).toBe(28);
		expect(left.arrow).toBe(12);
		const right = placeTip({ left: 780, top: 300, width: 20, height: 20 }, tip, view, insets);
		expect(right.left).toBe(692);
		expect(right.arrow).toBe(88);
	});

	it("uses the roomier side when neither fits", () => {
		const place = placeTip({ left: 350, top: 20, width: 40, height: 560 }, { width: 100, height: 40 }, view, insets);
		expect(place.side).toBe("top");
	});
});
