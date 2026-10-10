import { describe, expect, it } from "bun:test";
import { checkMimeType, dictationModelKey, parseFloatWav } from "../scripts/companion-voice";

/** A WAV with `chunks` between the header and the audio, as `afconvert` writes them. */
function wav(
	samples: number[],
	options: { before?: Uint8Array; rate?: number; channels?: number; dataSize?: number } = {},
) {
	const ascii = (text: string) => new TextEncoder().encode(text);
	const u32 = (value: number) => new Uint8Array(new Uint32Array([value]).buffer);
	const u16 = (value: number) => new Uint8Array(new Uint16Array([value]).buffer);
	const data = new Uint8Array(new Float32Array(samples).buffer);
	const fmt = [u16(3), u16(options.channels ?? 1), u32(options.rate ?? 16_000), u32(64_000), u16(4), u16(32)];
	const parts = [
		ascii("RIFF"),
		u32(0),
		ascii("WAVE"),
		ascii("fmt "),
		u32(16),
		...fmt,
		options.before ?? new Uint8Array(),
		ascii("data"),
		u32(options.dataSize ?? data.length),
		data,
	];
	return Uint8Array.from(parts.flatMap(part => [...part]));
}

describe("parseFloatWav", () => {
	it("skips chunks between the format and the data, however many bytes they take", () => {
		// An odd-sized chunk is padded to an even size, which also leaves the samples unaligned.
		const chunk = Uint8Array.from([...new TextEncoder().encode("FLLR"), 3, 0, 0, 0, 1, 2, 3, 0]);
		expect([...parseFloatWav(wav([0.5, -0.25], { before: chunk }))]).toEqual([0.5, -0.25]);
	});

	it("reads to the end when the data size is a streaming placeholder", () => {
		expect([...parseFloatWav(wav([1, 2, 3], { dataSize: 0xffffffff }))]).toEqual([1, 2, 3]);
	});

	it("refuses audio that is not 16 kHz mono float", () => {
		expect(() => parseFloatWav(wav([0], { rate: 44_100 }))).toThrow();
		expect(() => parseFloatWav(wav([0], { channels: 2 }))).toThrow();
		expect(() => parseFloatWav(new TextEncoder().encode("not a wav file at all"))).toThrow();
	});
});

describe("checkMimeType", () => {
	it("accepts recording formats, ignoring codec parameters and case", () => {
		expect(checkMimeType("audio/mp4").ext).toBe("m4a");
		expect(checkMimeType("Audio/WebM;codecs=opus").ext).toBe("webm");
		expect(checkMimeType("audio/webm;codecs=opus").afconvert).toBe(false);
	});

	it("refuses everything else, including object prototype keys", () => {
		for (const value of ["text/plain", "video/mp4", "", "constructor", "__proto__", "toString", 42, null]) {
			expect(() => checkMimeType(value), String(value)).toThrow();
		}
	});
});

describe("dictationModelKey", () => {
	const known = (key: string) => key === "whisper-base";

	it("takes the local model of the dictation role", () => {
		expect(dictationModelKey("modelRoles:\n  dictation: local/whisper-base\n", known)).toBe("whisper-base");
	});

	it("falls back to omp's default for no config, other models and broken YAML", () => {
		for (const text of [
			null,
			"",
			"modelRoles:\n  default: a/b\n",
			"modelRoles:\n  dictation: local/nope\n",
			"modelRoles:\n  dictation: openai/whisper-1\n",
			"modelRoles: [",
			"- 1",
		]) {
			expect(dictationModelKey(text, known), String(text)).toBe("parakeet-tdt-0.6b-v3");
		}
	});
});
