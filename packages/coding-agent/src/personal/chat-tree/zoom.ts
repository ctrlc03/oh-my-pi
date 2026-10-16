/**
 * What the `zoom` and `date` tools answer (the spec's §6): `zoom(id, n)` opens the line `id+n` of the view into the
 * two lines it was made from, `zoom(id, 1)` gives message `id` whole in pages, `date(id)` gives its date.
 */
import { ZOOM_PAGE_CHARS } from "./constants";
import type { ChatTree } from "./chat-tree";
import { renderViewLine } from "./view";

/** Why a call cannot be answered; the tool shows `message` to the model. */
export class ZoomError extends Error {}

function checkId(chat: ChatTree, id: unknown): number {
	if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
		throw new ZoomError(`id must be a whole number of 0 or more, got ${String(id)}.`);
	}
	if (id >= chat.messageCount) {
		throw new ZoomError(
			`There is no message ${id}: the chat has ${chat.messageCount} messages (ids 0 to ${chat.messageCount - 1}).`,
		);
	}
	return id;
}

/**
 * Whether `n` is 1, 2, 4, 8, ... up to 2^52. Bitwise tests truncate to 32 bits, and `Math.log2` alone rounds a
 * neighbour of a large power (2^53 - 1) to a whole number, so the power is rebuilt from the rounded exponent.
 */
function isPowerOfTwo(n: unknown): n is number {
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && 2 ** Math.round(Math.log2(n)) === n;
}

/** The page of a long message, as a whole number: a fraction is cut, anything that is not a number is refused. */
function checkPage(page: unknown): number {
	if (typeof page !== "number" || Number.isNaN(page)) {
		throw new ZoomError(`page must be a number (1 or more), got ${String(page)}.`);
	}
	return Math.trunc(page);
}

/** The `[start, end)` slice of `text` that is `chars` characters long without cutting a surrogate pair. */
function pageSlice(text: string, page: number, chars: number): { slice: string; pages: number } {
	const starts: number[] = [0];
	while (true) {
		let end = (starts.at(-1) as number) + chars;
		if (end >= text.length) break;
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end--;
		starts.push(end);
	}
	const pages = starts.length;
	const at = Math.min(Math.max(page, 1), pages) - 1;
	return { slice: text.slice(starts[at], starts[at + 1] ?? text.length), pages };
}

/**
 * `zoom(id, n)`. `n` is a power of 2 and `id` a multiple of `n`. For `n` of 1 the message comes whole, `page` (from 1)
 * picking the page of a long one; otherwise the two lines `id+n/2` and `id+n/2+n/2`, as the view shows them.
 */
export async function zoom(chat: ChatTree, id: number, n: number, page = 1): Promise<string> {
	checkId(chat, id);
	if (!isPowerOfTwo(n)) {
		throw new ZoomError(`n must be a power of 2 (1, 2, 4, 8, ...), got ${String(n)}.`);
	}
	if (id % n !== 0) throw new ZoomError(`id must be a multiple of n: ${id} is not a multiple of ${n}.`);
	if (n === 1) return await wholeMessage(chat, id, page);
	const level = Math.log2(n);
	const first = id / n;
	const lines: string[] = [];
	for (const child of [2 * first, 2 * first + 1]) {
		const childFirst = child * 2 ** (level - 1);
		if (childFirst >= chat.messageCount) {
			lines.push(`${childFirst}+${n / 2}|(no messages there yet: the chat has ${chat.messageCount})`);
			continue;
		}
		const row = chat.log.hasNode(level - 1, child) ? await chat.log.readNode(level - 1, child) : undefined;
		lines.push(renderViewLine([level - 1, child], row?.text ?? undefined));
	}
	return lines.join("\n");
}

async function wholeMessage(chat: ChatTree, id: number, page: unknown): Promise<string> {
	const pageNumber = checkPage(page);
	const row = await chat.log.readMessage(id);
	if (!row) throw new ZoomError(`Message ${id} could not be read.`);
	const { slice, pages } = pageSlice(row.text, pageNumber, ZOOM_PAGE_CHARS);
	const head = `message ${id}, ${row.kind}, ${row.size} bytes`;
	if (pages === 1) return `${head}\n${slice}`;
	const shown = Math.min(Math.max(pageNumber, 1), pages);
	const more = shown < pages ? ` Next: zoom(${id}, 1, page=${shown + 1}).` : "";
	return `${head}, page ${shown} of ${pages}.${more}\n${slice}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `2026-10-16 14:03:22 Friday, UTC+02:00`: the local wall-clock reading of `date`. */
export function formatLocal(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(offsetMinutes);
	const offset = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return `${day} ${time} ${WEEKDAYS[date.getDay()]}, ${offset}`;
}

/** `date(id)`: when message `id` was logged. */
export function dateOf(chat: ChatTree, id: number): string {
	checkId(chat, id);
	const meta = chat.log.messageMeta(id);
	if (!meta) throw new ZoomError(`Message ${id} is not in the log.`);
	return `message ${id}: ${formatLocal(new Date(meta.date))} (${meta.date})`;
}
