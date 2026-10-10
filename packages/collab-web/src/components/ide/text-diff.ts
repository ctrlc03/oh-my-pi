/**
 * Line diff between the text an editor shows and the text now on disk, as the
 * minimal edits that turn one into the other (so the editor keeps the cursor and
 * scroll position through a reload) and the lines of the new text that differ.
 */
import { diffLines } from "diff";

/** One replacement in `before` coordinates, in the shape CodeMirror's `ChangeSpec` takes. */
export interface TextEdit {
	from: number;
	to: number;
	insert: string;
}

export interface TextDiff {
	/** Ordered, non-overlapping edits against `before`. */
	edits: TextEdit[];
	/** 1-based lines of `after` that were added or changed; for a pure deletion, the line that now sits where it was. */
	changedLines: number[];
}

export function diffText(before: string, after: string): TextDiff {
	const edits: TextEdit[] = [];
	const changed: Record<number, true> = {};
	let pos = 0;
	let line = 1;
	const lastLine = after.split("\n").length;
	for (const part of diffLines(before, after)) {
		const lines = part.count ?? 0;
		if (part.removed) {
			const last = edits[edits.length - 1];
			// A removal right after an insertion at the same spot widens that edit.
			if (last !== undefined && last.to === pos && last.from === pos) last.to = pos + part.value.length;
			else edits.push({ from: pos, to: pos + part.value.length, insert: "" });
			pos += part.value.length;
			changed[Math.min(line, lastLine)] = true;
		} else if (part.added) {
			const last = edits[edits.length - 1];
			if (last !== undefined && last.to === pos) last.insert += part.value;
			else edits.push({ from: pos, to: pos, insert: part.value });
			for (let i = 0; i < lines; i++) changed[line + i] = true;
			line += lines;
		} else {
			pos += part.value.length;
			line += lines;
		}
	}
	return {
		edits,
		changedLines: Object.keys(changed)
			.map(Number)
			.sort((a, b) => a - b),
	};
}
