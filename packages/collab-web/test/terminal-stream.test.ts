import { describe, expect, it } from "bun:test";
import {
	applyCtrl,
	base64ToBytes,
	bytesToBase64,
	decideChunk,
	inputPayloads,
} from "../src/lib/terminal-stream";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe("base64", () => {
	it("round-trips every byte value, including a buffer larger than one slice", () => {
		const all = new Uint8Array(0x20000 + 7).map((_, i) => i % 256);
		expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
	});
});

describe("inputPayloads", () => {
	it("sends text as UTF-8", () => {
		expect(inputPayloads("é")).toEqual([bytesToBase64(bytes(0xc3, 0xa9))]);
	});

	it("sends a binary string one byte per character, truncating to a byte", () => {
		expect(inputPayloads("\x1b[M\u00ff", true)).toEqual([bytesToBase64(bytes(0x1b, 0x5b, 0x4d, 0xff))]);
	});

	it("splits a paste so no frame exceeds the limit, in order, without losing a byte", () => {
		const parts = inputPayloads("a".repeat(10), false, 4).map(part => base64ToBytes(part).length);
		expect(parts).toEqual([4, 4, 2]);
		expect(inputPayloads("")).toEqual([]);
	});
});

describe("decideChunk", () => {
	it("draws a chunk that continues the output", () => {
		expect(decideChunk(10, 10, bytes(1, 2))).toEqual({ draw: bytes(1, 2), skipped: false, received: 12 });
	});

	it("drops a chunk the replay already held", () => {
		expect(decideChunk(10, 4, bytes(1, 2, 3))).toEqual({ draw: null, skipped: false, received: 10 });
		expect(decideChunk(10, 7, bytes(1, 2, 3))).toEqual({ draw: null, skipped: false, received: 10 });
	});

	it("draws only the new tail of a chunk that overlaps the replay", () => {
		expect(decideChunk(10, 8, bytes(1, 2, 3, 4))).toEqual({ draw: bytes(3, 4), skipped: false, received: 12 });
	});

	it("reports output the computer skipped", () => {
		expect(decideChunk(10, 50, bytes(9))).toEqual({ draw: bytes(9), skipped: true, received: 51 });
	});
});

describe("applyCtrl", () => {
	it("turns a letter into its control character, either case", () => {
		expect(applyCtrl("c")).toBe("\x03");
		expect(applyCtrl("D")).toBe("\x04");
		expect(applyCtrl("[")).toBe("\x1b");
	});

	it("leaves anything else alone", () => {
		expect(applyCtrl("1")).toBe("1");
		expect(applyCtrl("ab")).toBe("ab");
		expect(applyCtrl("ß")).toBe("ß");
	});
});
