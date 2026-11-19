/**
 * Which lines of a file an agent wrote, for the editor's and the diffs' gutter markers: the pure half of line
 * attribution (`companion-attribution.ts` reads the sessions and the file).
 *
 * Every successful `edit` or `write` an agent made to the file is a list of {@link LineChange}s (what its result diff
 * says it replaced and with which lines). Replaying the edits oldest first over a sparse model of the file, a list of
 * the lines the agents wrote and where each sits now, keeps the positions right while later edits insert and remove
 * lines around them, and lets a later edit take over the lines it rewrote. The model is then checked against the file
 * as it is on disk ({@link attributeLines}): a line counts only while its text still is what the agent wrote, so a
 * person's edit to a line (or an edit by anything else) flips it back, and lines that something else moved are found
 * again by their text.
 */

/** One place an edit replaced old lines with new ones. */
export interface LineChange {
	/** 1-based first line of the old text it replaced; for a pure insertion, the old line it went before. */
	oldStart: number;
	/** Old lines it replaced. */
	removed: number;
	/** 1-based first line of the new text in the file as the edit left it. */
	newStart: number;
	/** The new lines, as written. */
	added: string[];
}

/** One edit of a file, as {@link attributeLines} replays it. */
export interface AttributionEdit {
	/** Who wrote it (the turn of a session): lines of edits with the same key are one range. */
	key: string;
	changes: readonly LineChange[];
	/** The edit wrote the whole file (the `write` tool), so what earlier edits wrote there is gone. */
	rewrite?: boolean;
}

/** A run of lines (1-based, inclusive) an agent wrote and the file still has. */
export interface AttributedRange {
	start: number;
	end: number;
	key: string;
}

/** A line of an omp edit result: ` 12|kept`, `-12|removed` (old number), `+12|added` (new number); `ast_edit` previews use `│`. */
const RESULT_LINE_RE = /^([+\- ])\s*(\d+)\s*[|│](.*)$/;

/** How far from where the replay says a run should be it is looked for when the file does not have it there. */
export const RESYNC_WINDOW = 400;

/**
 * The changes an edit result's diff lists, in file order. Removed lines carry their number in the old file, added
 * lines their number in the new one; lines between hunks (and unchanged ones) end a change. A pure insertion's place in
 * the old file and a pure deletion's in the new one follow from the net lines the changes before it added.
 */
export function parseLineChanges(diff: string): LineChange[] {
	const changes: LineChange[] = [];
	let delta = 0;
	let group: { firstOld: number | null; removed: number; firstNew: number | null; added: string[] } | null = null;
	const flush = (): void => {
		if (group === null) return;
		const { firstOld, removed, firstNew, added } = group;
		changes.push({
			oldStart: firstOld ?? (firstNew ?? 1) - delta,
			removed,
			newStart: firstNew ?? (firstOld ?? 1) + delta,
			added,
		});
		delta += added.length - removed;
		group = null;
	};
	for (const line of diff.split("\n")) {
		const match = RESULT_LINE_RE.exec(line);
		if (match === null || match[1] === " ") {
			flush();
			continue;
		}
		const number = Number(match[2]);
		group ??= { firstOld: null, removed: 0, firstNew: null, added: [] };
		if (match[1] === "-") {
			group.firstOld ??= number;
			group.removed++;
		} else {
			group.firstNew ??= number;
			group.added.push(match[3]!);
		}
	}
	flush();
	return changes;
}

/** A line as compared: without its indentation and line ending. */
function normalize(line: string): string {
	return line.trim();
}

/** Nothing but brackets and punctuation (`}`, `);`): says nothing about where it belongs. */
function isTrivial(text: string): boolean {
	return !/[\p{L}\p{N}_]/u.test(text);
}

interface Cell {
	/** 1-based, in the file as of the edit being replayed. */
	line: number;
	text: string;
	/** Index of the edit that wrote it. */
	edit: number;
}

/** `cells` (ascending by line) after `edit`: the lines it replaced gone, the ones after them moved, its own lines in. */
function replay(cells: readonly Cell[], edit: AttributionEdit, index: number): Cell[] {
	const changes = [...edit.changes].sort((a, b) => a.oldStart - b.oldStart);
	const next = new Map<number, Cell>();
	if (edit.rewrite !== true) {
		let at = 0;
		let delta = 0;
		for (const cell of cells) {
			// Past every change that ended before this line: its net lines moved the line.
			while (at < changes.length && changes[at]!.oldStart + changes[at]!.removed <= cell.line) {
				delta += changes[at]!.added.length - changes[at]!.removed;
				at++;
			}
			if (at < changes.length && cell.line >= changes[at]!.oldStart) continue;
			next.set(cell.line + delta, { ...cell, line: cell.line + delta });
		}
	}
	// What the edit wrote takes the place of whatever sits on its lines.
	for (const change of changes) {
		change.added.forEach((text, i) => {
			const line = Math.max(1, change.newStart) + i;
			next.set(line, { line, text: normalize(text), edit: index });
		});
	}
	return [...next.values()].sort((a, b) => a.line - b.line);
}

/** Consecutive cells of one edit. */
function runsOf(cells: readonly Cell[]): Cell[][] {
	const runs: Cell[][] = [];
	for (const cell of cells) {
		const run = runs.at(-1);
		const last = run?.at(-1);
		if (run !== undefined && last !== undefined && last.edit === cell.edit && last.line + 1 === cell.line) run.push(cell);
		else runs.push([cell]);
	}
	return runs;
}

/**
 * The lines of `current` that the agents' `edits` wrote and that still have the text they wrote, as ranges.
 * `edits` are oldest first. Indentation and trailing whitespace do not count as a change; a blank line only belongs to
 * a range between lines that do.
 *
 * A run of lines the replay places where the file has something else is looked for nearby, whole: something outside the
 * edits (a person typing above it, a formatter) moved it. It is taken at the one offset where most of it is found,
 * and not at all when that is a tie or only brackets match, since a line like `}` is found everywhere.
 */
export function attributeLines(current: readonly string[], edits: readonly AttributionEdit[]): AttributedRange[] {
	let cells: Cell[] = [];
	edits.forEach((edit, index) => {
		cells = replay(cells, edit, index);
	});
	const text = current.map(normalize);
	const owner = new Map<number, number>();
	// Oldest edit first, so a later edit's run wins the lines they both claim.
	const runs = runsOf(cells).sort((a, b) => a[0]!.edit - b[0]!.edit);
	for (const run of runs) {
		const matches = (offset: number): number => {
			let count = 0;
			for (const cell of run) if (text[cell.line + offset - 1] === cell.text) count++;
			return count;
		};
		const meaningful = (offset: number): boolean =>
			run.some(cell => text[cell.line + offset - 1] === cell.text && !isTrivial(cell.text));
		const half = Math.ceil(run.length / 2);
		let offset = 0;
		if (matches(0) < half) {
			let best = 0;
			let at: number | null = null;
			let tie = false;
			for (let candidate = -RESYNC_WINDOW; candidate <= RESYNC_WINDOW; candidate++) {
				if (candidate === 0) continue;
				const score = matches(candidate);
				if (score > best) {
					best = score;
					at = candidate;
					tie = false;
				} else if (score === best && score > 0) {
					tie = true;
				}
			}
			// What the run still has in place when nothing better is found: the part a person left alone.
			if (at !== null && !tie && best >= half && meaningful(at)) offset = at;
		}
		if (!meaningful(offset)) continue;
		for (const cell of run) {
			const line = cell.line + offset;
			if (line >= 1 && line <= text.length && text[line - 1] === cell.text) owner.set(line, cell.edit);
		}
	}
	return rangesOf(owner, text, edits);
}

/** Runs of lines with one writer, merged across edits with the same key; blank lines at a run's ends are not part of it. */
function rangesOf(
	owner: ReadonlyMap<number, number>,
	text: readonly string[],
	edits: readonly AttributionEdit[],
): AttributedRange[] {
	const ranges: AttributedRange[] = [];
	const lines = [...owner.keys()].sort((a, b) => a - b);
	let current: AttributedRange | null = null;
	const close = (): void => {
		if (current === null) return;
		while (current.start <= current.end && text[current.start - 1] === "") current.start++;
		while (current.end >= current.start && text[current.end - 1] === "") current.end--;
		if (current.start <= current.end) ranges.push(current);
		current = null;
	};
	for (const line of lines) {
		const key = edits[owner.get(line)!]!.key;
		if (current !== null && current.key === key && current.end + 1 === line) current.end = line;
		else {
			close();
			current = { start: line, end: line, key };
		}
	}
	close();
	return ranges;
}
