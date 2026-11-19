/**
 * The bytes between a terminal view and the shell on the computer (see `@oh-my-pi/pi-wire/terminal`): the frames carry
 * base64, the view draws bytes, and output after a re-attach has to continue exactly where the replay ended.
 */
import { TERMINAL_MAX_INPUT_BYTES } from "@oh-my-pi/pi-wire/terminal";

const ENCODER = new TextEncoder();

/** Binary strings (one character per byte) go through here in slices: `String.fromCharCode(...bytes)` overflows the stack on large arrays. */
const BASE64_SLICE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += BASE64_SLICE) {
		binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_SLICE));
	}
	return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** What the view typed, as `terminal-input` payloads: `text` as UTF-8, or (`binary`) one byte per character, as xterm.js reports mouse and other non-UTF-8 input. Each payload fits the frame limit. */
export function inputPayloads(text: string, binary = false, limit = TERMINAL_MAX_INPUT_BYTES): string[] {
	let bytes: Uint8Array;
	if (binary) {
		bytes = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
	} else bytes = ENCODER.encode(text);
	const payloads: string[] = [];
	for (let at = 0; at < bytes.length; at += limit) payloads.push(bytesToBase64(bytes.subarray(at, at + limit)));
	return payloads;
}

/** What to draw of a `terminal-output` chunk, given how much of the output the view has drawn. */
export interface ChunkDecision {
	/** The part not drawn yet; null when the chunk is entirely old (the replay already had it). */
	draw: Uint8Array | null;
	/** The computer skipped output between what was drawn and this chunk (it sends no faster than a rate limit). */
	skipped: boolean;
	/** Offset after the chunk: what the view has drawn once it has drawn `draw`. */
	received: number;
}

/**
 * Output after an `attach` can overlap the replay (output sent while the answer was on its way), and a shell that
 * outruns the rate limit has stretches skipped; `received` is the offset after the last byte drawn.
 */
export function decideChunk(received: number, from: number, bytes: Uint8Array): ChunkDecision {
	const end = from + bytes.length;
	if (end <= received) return { draw: null, skipped: false, received };
	if (from < received) return { draw: bytes.subarray(received - from), skipped: false, received: end };
	return { draw: bytes, skipped: from > received, received: end };
}

/** Cancels an escape sequence the skip may have cut in two, then says so in dim text. */
export const SKIPPED_NOTICE = "\x18\r\n\x1b[2m[output skipped: the shell wrote faster than the connection allows]\x1b[0m\r\n";

/** `data` typed while the key row's Ctrl is armed: a letter (or one of `@ [ \ ] ^ _`) becomes its control character, so `c` is Ctrl+C; anything else is unchanged. */
export function applyCtrl(data: string): string {
	const upper = data.toUpperCase();
	if (upper.length !== 1) return data;
	const code = upper.charCodeAt(0);
	return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : data;
}
