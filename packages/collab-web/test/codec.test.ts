import { describe, expect, it } from "bun:test";
import type { WireFrame } from "@oh-my-pi/pi-wire";
import { ZIP_MARKER, ZIP_MIN_BYTES } from "@oh-my-pi/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import { decodeBase64Url } from "../src/lib/link";

/** Interop vector generated with the real coding-agent `seal()` (see contract). */
const VECTOR_KEY = "AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk";
const VECTOR_SEALED = "m0PA1QNfpOGtl_iq1yfKhoux0moFN_WQtCExumBVOWKeHFY_yx7T4s3B5YFUSn6Dc9aAyVsjIjPQXLxqsg8_UQiZ9Q";

describe("collab codec", () => {
	it("decrypts the coding-agent interop vector", async () => {
		const keyBytes = decodeBase64Url(VECTOR_KEY);
		const sealed = decodeBase64Url(VECTOR_SEALED);
		if (!keyBytes || !sealed) throw new Error("vector constants must decode");
		const key = await importRoomKey(keyBytes);
		const frame = await open(key, sealed);
		expect(frame).toEqual({ t: "hello", proto: 1, name: "vector" });
	});

	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: WireFrame = { t: "prompt", text: "hello there" };
		const opened = await open(key, await seal(key, frame));
		expect(opened).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1] ^= 0xff;
		await expect(open(key, sealed)).rejects.toThrow();
	});

	describe("compression", () => {
		const big: WireFrame = { t: "transcript", reqId: 1, text: "line of log output\n".repeat(400), newSize: 7600 };

		/** First plaintext byte of a sealed frame: `{` for plain JSON, ZIP_MARKER for compressed. */
		async function firstByte(key: CryptoKey, sealed: Uint8Array): Promise<number> {
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: sealed.slice(0, 12) },
				key,
				sealed.slice(12),
			);
			return new Uint8Array(plaintext)[0]!;
		}

		it("round-trips a large frame compressed, much smaller than plain", async () => {
			const key = await importRoomKey(generateRoomKey());
			const plain = await seal(key, big);
			const zipped = await seal(key, big, true);
			expect(await firstByte(key, plain)).toBe("{".charCodeAt(0));
			expect(await firstByte(key, zipped)).toBe(ZIP_MARKER);
			expect(zipped.byteLength).toBeLessThan(plain.byteLength / 10);
			expect(await open<WireFrame>(key, zipped)).toEqual(big);
			expect(await open<WireFrame>(key, plain)).toEqual(big);
		});

		it("keeps a frame under the size floor plain when compression is requested", async () => {
			const key = await importRoomKey(generateRoomKey());
			const small: WireFrame = { t: "abort" };
			expect(JSON.stringify(small).length).toBeLessThan(ZIP_MIN_BYTES);
			expect(await firstByte(key, await seal(key, small, true))).toBe("{".charCodeAt(0));
		});

		it("preserves multi-byte text through compression", async () => {
			const key = await importRoomKey(generateRoomKey());
			const frame: WireFrame = { t: "prompt", text: "ünïcode 🚀 日本語 ".repeat(200) };
			expect(await open<WireFrame>(key, await seal(key, frame, true))).toEqual(frame);
		});
	});
});
