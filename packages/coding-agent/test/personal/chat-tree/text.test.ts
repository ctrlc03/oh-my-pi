import { describe, expect, it } from "bun:test";
import { MESSAGE_SPLIT_BYTES, TOOL_OUTPUT_MAX_CHARS } from "../../../src/personal/chat-tree/constants";
import { clipToolOutput, firstBytes, splitLongText, toOneLine, utf8Size } from "../../../src/personal/chat-tree/text";

/** A small deterministic generator so the shapes below are the same on every run. */
function prng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function codePoints(text: string): number {
	return Array.from(text).length;
}

describe("utf8Size", () => {
	it("counts bytes, not characters", () => {
		expect(utf8Size("")).toBe(0);
		expect(utf8Size("abc")).toBe(3);
		expect(utf8Size("é")).toBe(2);
		expect(utf8Size("€")).toBe(3);
		expect(utf8Size("😀")).toBe(4);
		expect(utf8Size("a€😀é")).toBe(1 + 3 + 4 + 2);
	});
});

describe("firstBytes", () => {
	it("returns the whole text when it fits and nothing for a zero limit", () => {
		expect(firstBytes("héllo", 6)).toBe("héllo");
		expect(firstBytes("héllo", 100)).toBe("héllo");
		expect(firstBytes("héllo", 0)).toBe("");
	});

	it("never splits a character: an emoji at the boundary is dropped whole", () => {
		const text = "ab😀cd";
		expect(firstBytes(text, 2)).toBe("ab");
		expect(firstBytes(text, 3)).toBe("ab");
		expect(firstBytes(text, 5)).toBe("ab");
		expect(firstBytes(text, 6)).toBe("ab😀");
		expect(firstBytes("é€", 2)).toBe("é");
		expect(firstBytes("é€", 4)).toBe("é");
		expect(firstBytes("é€", 5)).toBe("é€");
	});

	it("is the longest well-formed prefix within the limit, for every limit", () => {
		const text = "a é € 😀 b 😀😀 z";
		for (let limit = 0; limit <= utf8Size(text) + 2; limit++) {
			const head = firstBytes(text, limit);
			expect(text.startsWith(head)).toBe(true);
			expect(head.isWellFormed()).toBe(true);
			expect(utf8Size(head)).toBeLessThanOrEqual(limit);
			const rest = text.slice(head.length);
			if (rest.length > 0)
				expect(utf8Size(head) + utf8Size(String.fromCodePoint(rest.codePointAt(0) as number))).toBeGreaterThan(
					limit,
				);
		}
	});
});

describe("toOneLine", () => {
	it("turns each \\r and \\n into one space and keeps the byte size", () => {
		const text = "a\nb\r\nc\rd\n\ne😀\né";
		const line = toOneLine(text);
		expect(line).toBe("a b  c d  e😀 é");
		expect(utf8Size(line)).toBe(utf8Size(text));
		expect(line).not.toMatch(/[\r\n]/);
	});

	it("leaves a one-line text unchanged", () => {
		expect(toOneLine("plain text")).toBe("plain text");
	});
});

describe("clipToolOutput", () => {
	it("returns a text that fits unchanged, at the exact limit too", () => {
		expect(clipToolOutput("short")).toBe("short");
		const exact = "x".repeat(TOOL_OUTPUT_MAX_CHARS);
		expect(clipToolOutput(exact)).toBe(exact);
		const emoji = "😀".repeat(TOOL_OUTPUT_MAX_CHARS);
		expect(emoji.length).toBe(2 * TOOL_OUTPUT_MAX_CHARS);
		expect(clipToolOutput(emoji)).toBe(emoji);
	});

	it("keeps exactly 30,000 code points in all, marker included, even with emoji", () => {
		const text = "😀".repeat(TOOL_OUTPUT_MAX_CHARS + 5000);
		const clipped = clipToolOutput(text);
		expect(codePoints(clipped)).toBe(TOOL_OUTPUT_MAX_CHARS);
		expect(clipped.isWellFormed()).toBe(true);
	});

	it("states the exact number of code points removed and keeps the real head and tail", () => {
		const chars = Array.from({ length: 41_234 }, (_, k) => (k % 7 === 0 ? "😀" : String.fromCharCode(97 + (k % 26))));
		const text = chars.join("");
		const clipped = clipToolOutput(text);
		const match = /^([\s\S]*)\n\[\.\.\. (\d+) characters cut \.\.\.\]\n([\s\S]*)$/.exec(clipped);
		expect(match).not.toBeNull();
		const [, head, cut, tail] = match as RegExpExecArray;
		const headChars = Array.from(head);
		const tailChars = Array.from(tail);
		expect(Number(cut)).toBe(chars.length - headChars.length - tailChars.length);
		expect(codePoints(clipped)).toBe(TOOL_OUTPUT_MAX_CHARS);
		expect(headChars).toEqual(chars.slice(0, headChars.length));
		expect(tailChars).toEqual(chars.slice(chars.length - tailChars.length));
		expect(headChars.length - tailChars.length).toBeLessThanOrEqual(1);
		expect(headChars.length).toBeGreaterThanOrEqual(tailChars.length);
	});

	it("is exact for every digit count of the marker and every parity of the kept count", () => {
		for (const maxChars of [60, 61, 100]) {
			for (let total = maxChars + 1; total <= maxChars + 1200; total++) {
				const chars = Array.from({ length: total }, (_, k) => (k % 5 === 0 ? "😀" : "z"));
				const clipped = clipToolOutput(chars.join(""), maxChars);
				expect(codePoints(clipped)).toBe(maxChars);
				const match = /^([\s\S]*)\n\[\.\.\. (\d+) characters cut \.\.\.\]\n([\s\S]*)$/.exec(
					clipped,
				) as RegExpExecArray;
				const kept = codePoints(match[1]) + codePoints(match[3]);
				expect(Number(match[2])).toBe(total - kept);
				expect(codePoints(match[1]) - codePoints(match[3])).toBeGreaterThanOrEqual(0);
				expect(codePoints(match[1]) - codePoints(match[3])).toBeLessThanOrEqual(1);
			}
		}
	});

	it("rejects a limit too small for the marker", () => {
		expect(() => clipToolOutput("x".repeat(100), 10)).toThrow(RangeError);
	});
});

describe("splitLongText", () => {
	function check(text: string, maxBytes: number): string[] {
		const pieces = splitLongText(text, maxBytes);
		expect(pieces.join("")).toBe(text);
		for (const piece of pieces) {
			expect(piece.length).toBeGreaterThan(0);
			expect(utf8Size(piece)).toBeLessThanOrEqual(maxBytes);
			expect(piece.isWellFormed()).toBe(true);
		}
		return pieces;
	}

	it("gives [] for empty text and one piece for a text that fits", () => {
		expect(splitLongText("")).toEqual([]);
		expect(splitLongText("hello")).toEqual(["hello"]);
		const exact = "é".repeat(MESSAGE_SPLIT_BYTES / 2);
		expect(splitLongText(exact)).toEqual([exact]);
		expect(splitLongText(`${exact}x`)).toHaveLength(2);
	});

	it("defaults to MESSAGE_SPLIT_BYTES", () => {
		const text = "word ".repeat(10_000);
		const pieces = splitLongText(text);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) expect(utf8Size(piece)).toBeLessThanOrEqual(MESSAGE_SPLIT_BYTES);
		expect(pieces.join("")).toBe(text);
	});

	it("joins back exactly for long paragraphs, one huge line, multibyte text and text without whitespace", () => {
		const paragraphs = Array.from({ length: 40 }, (_, k) => `Paragraph ${k}: ${"lorem ipsum ".repeat(30 + k)}`).join(
			"\n\n",
		);
		check(paragraphs, 1000);
		check(`${"one huge line without a newline ".repeat(500)}`, 777);
		check("é€😀 mixed ünïcödé 日本語 text. ".repeat(400), 333);
		check("a".repeat(10_001), 100);
		check("😀".repeat(1001), 10);
		check("日本語".repeat(500), 7);
		check("\n\n\n\n \n \n\n x".repeat(300), 50);
	});

	it("joins back exactly and stays within the limit on random shapes", () => {
		const random = prng(42);
		const alphabet = ["a", "b", " ", "\n", "\n\n", "é", "€", "😀", "word", "\r\n", "x"];
		for (let round = 0; round < 60; round++) {
			let text = "";
			const length = Math.floor(random() * 2000);
			for (let k = 0; k < length; k++) text += alphabet[Math.floor(random() * alphabet.length)];
			check(text, 4 + Math.floor(random() * 300));
		}
	});

	it("splits without whitespace at the byte limit", () => {
		const pieces = check("a".repeat(250), 100);
		expect(pieces.map(piece => piece.length)).toEqual([100, 100, 50]);
	});

	it("never breaks inside an emoji", () => {
		const pieces = check("😀".repeat(100), 10);
		expect(pieces.every(piece => piece === "😀😀")).toBe(true);
	});

	it("prefers a blank line in the last quarter, even over a later newline", () => {
		const text = `${"a".repeat(80)}\n\n${"b".repeat(8)}\n${"c".repeat(200)}`;
		const pieces = check(text, 100);
		expect(pieces[0]).toBe(`${"a".repeat(80)}\n\n`);
	});

	it("prefers a newline to a space in the last quarter", () => {
		const text = `${"a".repeat(30)}\n\n${"b".repeat(50)}\n${"c".repeat(10)} ${"d".repeat(100)}`;
		const pieces = check(text, 100);
		expect(pieces[0]).toBe(`${"a".repeat(30)}\n\n${"b".repeat(50)}\n`);
	});

	it("falls back to a space in the last quarter", () => {
		const text = `${"a".repeat(10)}\n${"b".repeat(70)} ${"c".repeat(200)}`;
		const pieces = check(text, 100);
		expect(pieces[0]).toBe(`${"a".repeat(10)}\n${"b".repeat(70)} `);
	});

	it("ignores separators before the last quarter", () => {
		const text = `${"a".repeat(40)}\n\n${"b".repeat(200)}`;
		const pieces = check(text, 100);
		expect(pieces[0]).toBe(`${"a".repeat(40)}\n\n${"b".repeat(58)}`);
		const spaced = `${"a".repeat(10)} ${"b".repeat(200)}`;
		expect(check(spaced, 100)[0]).toBe(`${"a".repeat(10)} ${"b".repeat(89)}`);
	});

	it("does not trim or add anything: whitespace stays at the piece ends", () => {
		const text = `${"a".repeat(60)}   \n\n   ${"b".repeat(60)}   `;
		const pieces = check(text, 70);
		expect(pieces.join("")).toBe(text);
	});

	it("rejects a limit below one character", () => {
		expect(() => splitLongText("abc", 3)).toThrow(RangeError);
	});
});
