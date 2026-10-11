/**
 * Geometry of dragging a session row between the sections of the list. Everything is in content
 * coordinates (viewport position plus the scroll offset of the list's scroller), measured once when
 * the drag starts, so the rows sliding aside never disturb what the pointer is tested against.
 */

import type { OrgSection } from "./session-org";

export interface RowBox {
	key: string;
	section: OrgSection;
	top: number;
	height: number;
}

export interface ZoneBox {
	section: OrgSection;
	top: number;
	bottom: number;
}

/** The zone under `y`; between zones (the gap of the list) the nearest one; null without zones. */
export function zoneAt(zones: readonly ZoneBox[], y: number): ZoneBox | null {
	let best: ZoneBox | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const zone of zones) {
		const distance = y < zone.top ? zone.top - y : y > zone.bottom ? y - zone.bottom : 0;
		if (distance < bestDistance) {
			best = zone;
			bestDistance = distance;
		}
	}
	return best;
}

/** Where a dragged row at `y` lands among `rows` (the rows of one section without the dragged one, top to bottom): the number of rows whose middle is above it. */
export function insertionIndex(rows: readonly RowBox[], y: number): number {
	let index = 0;
	for (const row of rows) if (row.top + row.height / 2 < y) index++;
	return index;
}

/** Where the gap opens for a row dropped at `index` among `rows`: the top of the row it lands before, else the bottom of the last one; null when there is no row. */
export function gapTop(rows: readonly RowBox[], index: number): number | null {
	if (rows.length === 0) return null;
	if (index < rows.length) return rows[index].top;
	const last = rows[rows.length - 1];
	return last.top + last.height;
}

/**
 * How far an element at `top` slides so the gap moves from where the dragged row was (`source`) to
 * `gap`: down by `size` when the gap is above, up when below, for what lies in between.
 */
export function slideDelta(top: number, source: number, gap: number, size: number): number {
	if (gap < source) return top >= gap && top < source ? size : 0;
	return top > source && top < gap ? -size : 0;
}

/** The rows of one section from `a` to `b` inclusive, in list order; empty when either is not in it. */
export function rowsBetween(rows: readonly RowBox[], a: string, b: string): string[] {
	const from = rows.findIndex(row => row.key === a);
	const to = rows.findIndex(row => row.key === b);
	if (from === -1 || to === -1) return [];
	return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(row => row.key);
}

/** The row `y` is on or nearest to (a bulk drag past the first or last row ends on it); null without rows. */
export function rowAt(rows: readonly RowBox[], y: number): string | null {
	let best: RowBox | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		const bottom = row.top + row.height;
		const distance = y < row.top ? row.top - y : y > bottom ? y - bottom : 0;
		if (distance < bestDistance) {
			best = row;
			bestDistance = distance;
		}
	}
	return best?.key ?? null;
}
