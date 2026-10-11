/**
 * Side-by-side layout of a parsed unified diff: each display line holds the row of the old file on the
 * left and of the new file on the right. Context lines sit on both sides; a run of removed lines is
 * paired with the run of added lines that follows it, line for line, and the longer run's tail has an
 * empty other side. Rows are referenced by their index in `parseUnifiedDiff`'s result, so a selection
 * or a comment made on either layout names the same lines.
 */
import type { DiffRow } from "./review-comments";

export type SplitLine =
	/** A hunk header or a "\ No newline" marker: spans both sides. */
	{ kind: "full"; row: number } | { kind: "pair"; left: number | null; right: number | null };

export function splitLines(rows: readonly DiffRow[]): SplitLine[] {
	const lines: SplitLine[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.kind === "hunk") {
			lines.push({ kind: "full", row: i });
		} else if (row.kind === "ctx") {
			lines.push({ kind: "pair", left: i, right: i });
		} else {
			const removed: number[] = [];
			const added: number[] = [];
			for (; i < rows.length && (rows[i]!.kind === "del" || rows[i]!.kind === "add"); i++) {
				(rows[i]!.kind === "del" ? removed : added).push(i);
			}
			i--;
			for (let k = 0; k < Math.max(removed.length, added.length); k++) {
				lines.push({ kind: "pair", left: removed[k] ?? null, right: added[k] ?? null });
			}
		}
	}
	return lines;
}

/** The last unified row a display line holds: where notes and the comment box for its rows go. */
export function lastRow(line: SplitLine): number {
	return line.kind === "full" ? line.row : Math.max(line.left ?? -1, line.right ?? -1);
}
