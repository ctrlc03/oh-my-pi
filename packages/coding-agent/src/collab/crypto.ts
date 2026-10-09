/**
 * AES-256-GCM sealing for collab frames.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]`. The plaintext is UTF-8 JSON, or
 * (when the sender compresses) {@link ZIP_MARKER} followed by deflate-raw JSON;
 * {@link open} auto-detects.
 */
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES, ZIP_MARKER, ZIP_MIN_BYTES } from "@oh-my-pi/pi-wire";
import type { CollabFrame } from "./protocol";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
/** Bound on an inflated frame, so a tiny sealed frame cannot expand without limit. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);

export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, frame: CollabFrame, compress = false): Promise<Uint8Array> {
	return sealSerialized(key, JSON.stringify(frame), compress);
}

/** `compress` deflates the frame when its JSON exceeds {@link ZIP_MIN_BYTES}; only set it for a peer that can open compressed frames. */
export async function sealSerialized(key: CryptoKey, frame: string, compress = false): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	let plaintext: Uint8Array<ArrayBuffer> = TEXT_ENCODER.encode(frame);
	if (compress && plaintext.byteLength > ZIP_MIN_BYTES) {
		const deflated = await deflateRawAsync(plaintext);
		const marked = new Uint8Array(1 + deflated.byteLength);
		marked[0] = ZIP_MARKER;
		marked.set(deflated, 1);
		plaintext = marked;
	}
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export async function open(key: CryptoKey, data: Uint8Array): Promise<CollabFrame> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = asStrict(data.subarray(0, IV_LENGTH));
	const ciphertext = asStrict(data.subarray(IV_LENGTH));
	let plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	if (plaintext[0] === ZIP_MARKER) {
		plaintext = await inflateRawAsync(plaintext.subarray(1), { maxOutputLength: MAX_INFLATED_BYTES });
	}
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as CollabFrame;
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
