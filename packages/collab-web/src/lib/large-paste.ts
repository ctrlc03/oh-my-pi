/**
 * Text pasted into the message box beyond {@link LARGE_PASTE_BYTES} becomes a text attachment chip instead of
 * flooding the box; the chip goes through the same path as a picked file (inlined as a fenced block, or uploaded
 * when it is too big to inline and a computer is paired).
 */

/** A paste larger than this (UTF-8 bytes; 32 KiB) is attached instead of inserted. */
export const LARGE_PASTE_BYTES = 32 * 1024;

const encoder = new TextEncoder();

/** Whether pasting `text` should attach it: strictly more than {@link LARGE_PASTE_BYTES} bytes of UTF-8. */
export function isLargePaste(text: string): boolean {
	// A UTF-16 unit is 1–3 bytes of UTF-8, so only the middle band needs counting.
	if (text.length > LARGE_PASTE_BYTES) return true;
	if (text.length * 3 <= LARGE_PASTE_BYTES) return false;
	return encoder.encode(text).byteLength > LARGE_PASTE_BYTES;
}

/** The file a large paste is attached as; `n` numbers the pastes of one draft (1-based). */
export function pastedTextFile(text: string, n: number): File {
	return new File([text], n <= 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`, { type: "text/plain" });
}
