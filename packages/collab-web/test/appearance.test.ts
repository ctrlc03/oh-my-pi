import { describe, expect, it } from "bun:test";
import { type Appearance, DEFAULT_APPEARANCE, parseAppearance, stepZoom } from "../src/lib/appearance";
import { differsFromBaselines } from "../src/lib/fonts";

describe("parseAppearance", () => {
	it("is the defaults for anything that is not an object", () => {
		for (const raw of [null, undefined, "dark", 42, true, []]) {
			expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
		}
	});

	it("keeps every valid value", () => {
		const stored: Appearance = {
			zoom: 130,
			textSize: "xlarge",
			font: "serif",
			codeFont: "fira",
			spacing: "relaxed",
			accent: "green",
		};
		expect(parseAppearance(stored)).toEqual(stored);
	});

	it("falls back field by field, keeping the valid ones", () => {
		expect(
			parseAppearance({
				zoom: 112,
				textSize: "large",
				font: "comic",
				codeFont: 7,
				spacing: null,
				accent: "blue",
				extra: "ignored",
			}),
		).toEqual({ ...DEFAULT_APPEARANCE, textSize: "large", accent: "blue" });
	});

	it("rejects wrong-typed values, including a zoom stored as a string", () => {
		expect(parseAppearance({ zoom: "115", textSize: 1, accent: ["pink"] })).toEqual(DEFAULT_APPEARANCE);
	});
});

describe("stepZoom", () => {
	it("moves one step in either direction", () => {
		expect(stepZoom(100, 1)).toBe(115);
		expect(stepZoom(100, -1)).toBe(85);
	});

	it("clamps at both ends", () => {
		expect(stepZoom(150, 1)).toBe(150);
		expect(stepZoom(75, -1)).toBe(75);
	});

	it("moves a value between the steps to the nearest step in that direction", () => {
		expect(stepZoom(110, 1)).toBe(115);
		expect(stepZoom(110, -1)).toBe(100);
		expect(stepZoom(200, -1)).toBe(150);
		expect(stepZoom(10, 1)).toBe(75);
	});
});

describe("differsFromBaselines", () => {
	const baseline = { mono: 1000, serif: 900 };

	it("is false for a family the browser does not have: both widths are the generic's", () => {
		expect(differsFromBaselines({ mono: 1000, serif: 900 }, baseline)).toBe(false);
	});

	it("is true when the family changes either width", () => {
		expect(differsFromBaselines({ mono: 1010, serif: 1010 }, baseline)).toBe(true);
		// A font metrically equal to the generic monospace still differs from the serif fallback.
		expect(differsFromBaselines({ mono: 1000, serif: 1000 }, baseline)).toBe(true);
	});

	it("ignores sub-pixel measurement noise", () => {
		expect(differsFromBaselines({ mono: 1000.004, serif: 899.996 }, baseline)).toBe(false);
	});
});
