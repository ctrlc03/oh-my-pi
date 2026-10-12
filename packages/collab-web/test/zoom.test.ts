import { describe, expect, it } from "bun:test";
import { matchCombo, SHORTCUTS, shortcutFires } from "../src/lib/shortcuts";
import { scaleQuery } from "../src/lib/zoom";

describe("scaleQuery", () => {
	it("leaves a page without zoom alone", () => {
		expect(scaleQuery("(min-width: 901px)", 1)).toBe("(min-width: 901px)");
	});

	it("moves a legacy width breakpoint to the zoomed window", () => {
		expect(scaleQuery("(min-width: 901px)", 1.3)).toBe("(min-width: 1171px)");
		expect(scaleQuery("(max-width: 640px)", 1.3)).toBe("(max-width: 832px)");
		expect(scaleQuery("(max-width: 640px)", 0.75)).toBe("(max-width: 480px)");
	});

	it("moves the range syntax a minifier writes", () => {
		expect(scaleQuery("(width >= 901px)", 1.5)).toBe("(width >= 1351px)");
		expect(scaleQuery("(width <= 640px)", 1.3)).toBe("(width <= 832px)");
		expect(scaleQuery("(641px <= width <= 900px)", 1.3)).toBe("(833px <= width <= 1170px)");
		expect(scaleQuery("(width > 640px)", 1.5)).toBe("(width > 960px)");
		expect(scaleQuery("(width < 641px)", 1.5)).toBe("(width < 962px)");
	});

	it("keeps the two halves of a breakpoint pair complementary at whole pixels", () => {
		for (const factor of [0.75, 0.85, 1.15, 1.3, 1.5]) {
			const min = /(\d+)px/.exec(scaleQuery("(min-width: 641px)", factor));
			const max = /(\d+)px/.exec(scaleQuery("(max-width: 640px)", factor));
			expect(Number(min?.[1])).toBe(Number(max?.[1]) + 1);
		}
	});

	it("scales every query of a list and nothing but widths", () => {
		const scaled = scaleQuery("(min-width: 1101px) and (min-height: 600px), (orientation: landscape)", 1.5);
		expect(scaled).toBe("(min-width: 1651px) and (min-height: 600px), (orientation: landscape)");
	});
});

describe("zoom shortcuts", () => {
	const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
		key: k,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...mods,
	});

	it("takes + however the layout makes it", () => {
		expect(shortcutFires("zoomIn", key("+", { shiftKey: true }), null, true)).toBe(true);
		expect(shortcutFires("zoomIn", key("="), null, true)).toBe(true);
		expect(shortcutFires("zoomIn", key("-"), null, true)).toBe(false);
	});

	it("zooms out on - and resets on 0", () => {
		expect(shortcutFires("zoomOut", key("-"), null, true)).toBe(true);
		expect(shortcutFires("zoomReset", key("0"), null, true)).toBe(true);
	});

	it("leaves the browser's own ⌘+ / ⌘- / ⌘0 alone", () => {
		expect(matchCombo(key("=", { metaKey: true }), SHORTCUTS.zoomIn.keys, true)).toBe(false);
		expect(matchCombo(key("-", { ctrlKey: true }), SHORTCUTS.zoomOut.keys, false)).toBe(false);
		expect(matchCombo(key("0", { metaKey: true }), SHORTCUTS.zoomReset.keys, true)).toBe(false);
	});
});
