import { describe, expect, it } from "bun:test";
import { encodeRecording, formatElapsed, insertAtCaret, MAX_AUDIO_BYTES } from "../src/lib/voice";

describe("insertAtCaret", () => {
	it("appends to a draft with a separating space", () => {
		expect(insertAtCaret("fix the bug", "and add a test", 11, 11)).toEqual({
			text: "fix the bug and add a test",
			caret: 26,
		});
	});

	it("adds no space at the start, after whitespace, or into an empty draft", () => {
		expect(insertAtCaret("", "hello", 0, 0)).toEqual({ text: "hello", caret: 5 });
		expect(insertAtCaret("line one\n", "line two", 9, 9).text).toBe("line one\nline two");
	});

	it("splits a word boundary in the middle of text and keeps the caret behind the insert", () => {
		const result = insertAtCaret("fix bug", "the", 4, 4);
		expect(result.text).toBe("fix the bug");
		expect(result.text.slice(result.caret)).toBe(" bug");
	});

	it("replaces a selection", () => {
		expect(insertAtCaret("rename foo please", "bar", 7, 10).text).toBe("rename bar please");
	});

	it("clamps a caret that outran an edited draft", () => {
		expect(insertAtCaret("ab", "cd", 40, 50).text).toBe("ab cd");
	});
});

describe("encodeRecording", () => {
	it("refuses empty and oversized recordings", async () => {
		await expect(encodeRecording(new Blob([]))).rejects.toThrow("Nothing was recorded");
		await expect(encodeRecording(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)]))).rejects.toThrow("too large");
	});
});

describe("formatElapsed", () => {
	it("renders m:ss", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(65)).toBe("1:05");
		expect(formatElapsed(180)).toBe("3:00");
	});
});
