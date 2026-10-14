/**
 * A line diff for About you: the conflict panel (my draft against the current text) and the history (a version against
 * the one before it). Pure, so it is tested without a DOM; proposals arrive with their diff already computed by the companion.
 */

import type { PersonalDiffLine } from "@oh-my-pi/pi-wire/personal";

/** Either side of the changed middle longer than this is not worth the quadratic table: it is shown as removed and added. */
export const MAX_DIFF_LINES = 2000;

/** The lines of `text`; a trailing newline does not make an extra empty line, and no text is no lines. */
export function textLines(text: string): string[] {
	if (text === "") return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Line-by-line difference of `before` into `after`, in reading order. Unchanged lines are `keep`. */
export function lineDiff(before: string, after: string): PersonalDiffLine[] {
	const a = textLines(before);
	const b = textLines(after);
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);

	const out: PersonalDiffLine[] = a.slice(0, head).map(text => ({ op: "keep", text }));
	out.push(...diffMiddle(midA, midB));
	out.push(...a.slice(a.length - tail).map((text): PersonalDiffLine => ({ op: "keep", text })));
	return out;
}

function diffMiddle(a: readonly string[], b: readonly string[]): PersonalDiffLine[] {
	if (a.length === 0 || b.length === 0 || a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
		return [
			...a.map((text): PersonalDiffLine => ({ op: "del", text })),
			...b.map((text): PersonalDiffLine => ({ op: "add", text })),
		];
	}
	// lcs[i][j]: longest common subsequence of a[i..] and b[j..], flattened (rows of b.length + 1).
	const width = b.length + 1;
	const lcs = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i * width + j] =
				a[i] === b[j]
					? lcs[(i + 1) * width + j + 1] + 1
					: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}
	const out: PersonalDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ op: "keep", text: a[i] });
			i++;
			j++;
		} else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
			out.push({ op: "del", text: a[i++] });
		} else {
			out.push({ op: "add", text: b[j++] });
		}
	}
	while (i < a.length) out.push({ op: "del", text: a[i++] });
	while (j < b.length) out.push({ op: "add", text: b[j++] });
	return out;
}
