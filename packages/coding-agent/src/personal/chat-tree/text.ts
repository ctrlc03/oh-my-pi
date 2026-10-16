/**
 * Text helpers of the chat-tree memory mode. Every size is in UTF-8 bytes (a lone surrogate counts as the 3 bytes
 * of U+FFFD, as `TextEncoder` encodes it); nothing here counts tokens. Pieces and clips never split a surrogate pair.
 */
import { MESSAGE_SPLIT_BYTES, TOOL_OUTPUT_MAX_CHARS } from "./constants";

/** The bytes of `text` in UTF-8. */
export function utf8Size(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The UTF-8 bytes of the code point starting at `index`, and how many UTF-16 units it takes. */
function unitAt(text: string, index: number): { bytes: number; units: number } {
	const code = text.charCodeAt(index);
	if (code < 0x80) return { bytes: 1, units: 1 };
	if (code < 0x800) return { bytes: 2, units: 1 };
	if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
		const next = text.charCodeAt(index + 1);
		if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
	}
	return { bytes: 3, units: 1 };
}

/** The end index and byte size of the longest piece of `text` starting at `start` that is at most `maxBytes` bytes. */
function cutAt(text: string, start: number, maxBytes: number): { end: number; bytes: number } {
	let end = start;
	let bytes = 0;
	while (end < text.length) {
		const unit = unitAt(text, end);
		if (bytes + unit.bytes > maxBytes) break;
		bytes += unit.bytes;
		end += unit.units;
	}
	return { end, bytes };
}

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes, never splitting a character (surrogate pair). */
export function firstBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	// A string of at most `maxBytes` UTF-16 units is at most 3x that in bytes; only measure when it could not fit.
	if (text.length * 3 <= maxBytes) return text;
	return text.slice(0, cutAt(text, 0, maxBytes).end);
}

/** Replace every \r and \n by one space each (UTF-8 size unchanged). */
export function toOneLine(text: string): string {
	return text.replace(/[\r\n]/g, " ");
}

/** The number of code points of `text` (a lone surrogate counts as one). */
function codePointCount(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += unitAt(text, index).units) count++;
	return count;
}

/** The index just after the first `count` code points of `text`. */
function indexAfterCodePoints(text: string, count: number): number {
	let index = 0;
	for (let taken = 0; taken < count && index < text.length; taken++) index += unitAt(text, index).units;
	return index;
}

/** The index where the last `count` code points of `text` begin. */
function indexOfLastCodePoints(text: string, count: number): number {
	let index = text.length;
	for (let taken = 0; taken < count && index > 0; taken++) {
		const low = text.charCodeAt(index - 1);
		const paired = index >= 2 && low >= 0xdc00 && low <= 0xdfff && (text.charCodeAt(index - 2) & 0xfc00) === 0xd800;
		index -= paired ? 2 : 1;
	}
	return index;
}

const CUT_MARKER_PREFIX = "\n[... ";
const CUT_MARKER_SUFFIX = " characters cut ...]\n";

/**
 * A tool's output clipped to its head and tail, at most `maxChars` characters (code points) IN ALL including the
 * marker; unchanged when it fits. The marker between head and tail is `\n[... N characters cut ...]\n` with N the
 * exact number of code points removed. Head and tail never split a surrogate pair; the head gets the larger half
 * when the kept count is odd.
 */
export function clipToolOutput(text: string, maxChars: number = TOOL_OUTPUT_MAX_CHARS): string {
	// Code points never outnumber UTF-16 units, so a text of at most `maxChars` units fits without counting.
	if (text.length <= maxChars) return text;
	const total = codePointCount(text);
	if (total <= maxChars) return text;
	const fixed = CUT_MARKER_PREFIX.length + CUT_MARKER_SUFFIX.length;
	// The number of digits of N changes the marker's length and so N itself: take the digit count that agrees.
	for (let digits = 1; digits <= 16; digits++) {
		const kept = maxChars - fixed - digits;
		if (kept < 0) break;
		const cut = total - kept;
		if (String(cut).length !== digits) continue;
		const headCount = Math.ceil(kept / 2);
		const tailCount = kept - headCount;
		const head = text.slice(0, indexAfterCodePoints(text, headCount));
		const tail = text.slice(indexOfLastCodePoints(text, tailCount));
		return `${head}${CUT_MARKER_PREFIX}${cut}${CUT_MARKER_SUFFIX}${tail}`;
	}
	throw new RangeError(`maxChars ${maxChars} is too small to hold the cut marker`);
}

/**
 * Splits a long text into consecutive pieces, each at most `maxBytes` UTF-8 bytes (default `MESSAGE_SPLIT_BYTES`),
 * whose concatenation is EXACTLY the input: nothing cut, nothing added, nothing trimmed. A piece prefers to end
 * after a blank line (`\n\n`), else after a newline, else after a space, looking only in the last 25% of the
 * allowed piece; otherwise it breaks at the byte limit (still never mid-character). A text that fits is returned
 * as a single piece; empty text gives `[]`. `maxBytes` must be an integer of at least 4 (one character).
 */
export function splitLongText(text: string, maxBytes: number = MESSAGE_SPLIT_BYTES): string[] {
	if (!Number.isInteger(maxBytes) || maxBytes < 4) {
		throw new RangeError(`maxBytes must be an integer >= 4, got ${maxBytes}`);
	}
	if (text.length === 0) return [];
	if (utf8Size(text) <= maxBytes) return [text];
	// A piece may end at a separator only if it then holds at least this many bytes (the last quarter of the limit).
	const floorBytes = maxBytes - Math.floor(maxBytes / 4);
	const pieces: string[] = [];
	let start = 0;
	while (start < text.length) {
		const full = cutAt(text, start, maxBytes);
		if (full.end >= text.length) {
			pieces.push(text.slice(start));
			break;
		}
		const lower = cutAt(text, start, floorBytes);
		const minEnd = lower.bytes === floorBytes ? lower.end : lower.end + 1;
		let end = full.end;
		const blank = text.lastIndexOf("\n\n", full.end - 2);
		const newline = text.lastIndexOf("\n", full.end - 1);
		const space = text.lastIndexOf(" ", full.end - 1);
		if (blank >= start && blank + 2 >= minEnd) end = blank + 2;
		else if (newline >= start && newline + 1 >= minEnd) end = newline + 1;
		else if (space >= start && space + 1 >= minEnd) end = space + 1;
		pieces.push(text.slice(start, end));
		start = end;
	}
	return pieces;
}
