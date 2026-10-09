/**
 * AES-256-GCM sealing for collab frames (browser-safe vendored mirror of
 * `@oh-my-pi/pi-coding-agent/src/collab/crypto.ts` — WebCrypto only).
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`. The plaintext is UTF-8 JSON, or
 * (when the sender compresses) {@link ZIP_MARKER} followed by deflate-raw JSON;
 * {@link open} auto-detects. `CompressionStream` also runs under Bun, which the
 * companion uses.
 */
import type { WireFrame } from "@oh-my-pi/pi-wire";
import { ZIP_MARKER, ZIP_MIN_BYTES } from "@oh-my-pi/pi-wire";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Whether this runtime can open compressed frames; advertise `zip` to the other end only when true. */
export const CAN_INFLATE = typeof DecompressionStream === "function";

/** Runs `bytes` through a (de)compression stream and collects the output. */
async function pump(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream) {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(KEY_LENGTH);
	crypto.getRandomValues(key);
	return key;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== KEY_LENGTH) {
		throw new Error(`Room key must be ${KEY_LENGTH} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

/**
 * `compress` deflates the frame when its JSON exceeds {@link ZIP_MIN_BYTES};
 * set it only toward a peer that advertised it can open compressed frames.
 */
export async function seal(key: CryptoKey, frame: object, compress = false): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	let plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
	if (compress && plaintext.byteLength > ZIP_MIN_BYTES && typeof CompressionStream === "function") {
		const deflated = await pump(plaintext, new CompressionStream("deflate-raw"));
		plaintext = new Uint8Array(1 + deflated.byteLength);
		plaintext[0] = ZIP_MARKER;
		plaintext.set(deflated, 1);
	}
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. `T` is trusted, not validated. */
export async function open<T = WireFrame>(key: CryptoKey, data: Uint8Array): Promise<T> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = asStrict(data.subarray(0, IV_LENGTH));
	const ciphertext = asStrict(data.subarray(IV_LENGTH));
	let plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	if (plaintext[0] === ZIP_MARKER) plaintext = await pump(plaintext.slice(1), new DecompressionStream("deflate-raw"));
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as T;
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
