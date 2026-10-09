import { describe, expect, it } from "bun:test";
import { ansiClass, nearestAnsi16, parseAnsi } from "../src/lib/ansi";

const ESC = "\x1b";

describe("parseAnsi", () => {
	it("maps the 16 colors and resets them", () => {
		const spans = parseAnsi(`plain ${ESC}[31mred${ESC}[0m ${ESC}[92mbright${ESC}[39m ${ESC}[44mon blue${ESC}[49m`);
		expect(spans.map(s => [s.text, s.fg, s.bg])).toEqual([
			["plain ", null, null],
			["red", 1, null],
			[" ", null, null],
			["bright", 10, null],
			[" ", null, null],
			["on blue", null, 4],
		]);
	});

	it("carries bold and dim until reset and merges runs of one style", () => {
		const spans = parseAnsi(`${ESC}[1;32mok${ESC}[m ${ESC}[2mfaint${ESC}[22m!`);
		expect(spans[0]).toMatchObject({ text: "ok", fg: 2, bold: true });
		expect(spans[1]).toMatchObject({ text: " ", fg: null, bold: false });
		expect(spans[2]).toMatchObject({ text: "faint", dim: true });
		expect(spans[3]).toMatchObject({ text: "!", dim: false });
		expect(parseAnsi(`${ESC}[31ma${ESC}[31mb`)).toHaveLength(1);
	});

	it("approximates 256-color and truecolor values by the nearest of the 16", () => {
		expect(parseAnsi(`${ESC}[38;5;9mx`)[0]?.fg).toBe(9);
		expect(parseAnsi(`${ESC}[38;5;196mx`)[0]?.fg).toBe(nearestAnsi16(255, 0, 0));
		expect(parseAnsi(`${ESC}[38;2;0;255;0mx${ESC}[0m${ESC}[48:2::0:0:255my`)).toMatchObject([
			{ text: "x", fg: 10 },
			{ text: "y", bg: 12 },
		]);
		// The colour arguments are consumed: the 1 after `38;5;2` is bold, not part of the colour.
		expect(parseAnsi(`${ESC}[38;5;2;1mx`)[0]).toMatchObject({ fg: 2, bold: true });
	});

	it("drops cursor movement, titles and carriage returns but keeps the text", () => {
		const spans = parseAnsi(`${ESC}[2J${ESC}[1;1Hhello${ESC}]0;title\x07 world\r\n${ESC}[?25l`);
		expect(spans.map(s => s.text).join("")).toBe("hello world\n");
	});

	it("swaps colors for inverse text in the class names", () => {
		const [span] = parseAnsi(`${ESC}[7;31mx`);
		expect(ansiClass(span!)).toBe("sh-term-fg-inv sh-term-bg-1");
		expect(ansiClass({ ...span!, inverse: false, bold: true })).toBe("sh-term-fg-1 sh-term-b");
	});
});
