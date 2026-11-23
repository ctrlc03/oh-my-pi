/**
 * The order the user arranged the paired computers in, kept on this device beside the other sidebar state. The
 * sidebar groups, the home screen's cards, the palette and the all-sessions filter all list computers in it.
 * Only ids are stored, so a computer paired or removed since changes nothing but its own place.
 */

import { readJson, writeJson } from "./storage";

const ORDER_KEY = "omp.collab.computer-order";

/** The stored order: the distinct string ids of the array, in order; empty for anything else. */
export function parseOrder(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const ids: string[] = [];
	for (const id of raw) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
	return ids;
}

/** `stored` restricted to the computers still paired, then the ones it does not name (paired since) in their own order. */
export function mergeOrder(stored: readonly string[], present: readonly string[]): string[] {
	const here = new Set(present);
	const known = stored.filter(id => here.has(id));
	const named = new Set(known);
	return [...known, ...present.filter(id => !named.has(id))];
}

/** `items` in the arranged order; computers the order does not name keep their relative order at the end. */
export function orderComputers<T extends { id: string }>(items: readonly T[], stored: readonly string[]): readonly T[] {
	if (stored.length === 0) return items;
	const rank = new Map(
		mergeOrder(
			stored,
			items.map(item => item.id),
		).map((id, at) => [id, at]),
	);
	const sorted = [...items].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
	return sorted.every((item, at) => item === items[at]) ? items : sorted;
}

/** `ids` with `id` taken out and put back at index `to` (clamped); unchanged when `id` is not in it. */
export function moveInOrder(ids: readonly string[], id: string, to: number): string[] {
	const from = ids.indexOf(id);
	if (from === -1) return [...ids];
	const rest = ids.filter(other => other !== id);
	rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
	return rest;
}

/** Where a group dragged from index `from` lands when dropped on the one at `target`, before it or (`after`) behind it. */
export function dropIndex(from: number, target: number, after: boolean): number {
	const slot = target + (after ? 1 : 0);
	return from < slot ? slot - 1 : slot;
}

export function loadComputerOrder(): string[] {
	return parseOrder(readJson(ORDER_KEY));
}

export function saveComputerOrder(ids: readonly string[]): void {
	writeJson(ORDER_KEY, ids.length > 0 ? ids : null);
}
