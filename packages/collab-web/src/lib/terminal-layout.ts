/**
 * How the Shell sheet divides its room among terminals: a binary tree, as in a tiling terminal. A leaf is one
 * terminal (by the id the computer gave it); a split puts two subtrees side by side (`row`) or one over the other
 * (`column`) with a draggable divider at `ratio` of the way. Everything here is a pure function of plain data, so
 * the splitting, closing and resizing rules are testable; `ShellSheet` keeps the tree and `ShellSplit` draws it.
 */

export type SplitAxis = "row" | "column";

export interface TerminalLeaf {
	kind: "leaf";
	/** The terminal's id on the computer. */
	id: string;
}

export interface TerminalSplit {
	kind: "split";
	/** Names the divider; stays the same while the divider is dragged. */
	id: string;
	/** `row`: the subtrees are side by side; `column`: one over the other. */
	axis: SplitAxis;
	/** Share of the room (0–1) the first subtree takes. */
	ratio: number;
	first: LayoutNode;
	second: LayoutNode;
}

export type LayoutNode = TerminalLeaf | TerminalSplit;

/** A pane never gets smaller than this share of its split, so a divider cannot be dragged until a terminal vanishes. */
export const MIN_RATIO = 0.12;

/** Splits nested deeper than this are not read back from storage (a hand-edited or damaged value). */
const MAX_DEPTH = 16;

export function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.5;
	return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

/** The terminals in reading order (left to right, top to bottom). */
export function leafIds(node: LayoutNode): string[] {
	return node.kind === "leaf" ? [node.id] : [...leafIds(node.first), ...leafIds(node.second)];
}

export function hasLeaf(node: LayoutNode, id: string): boolean {
	return leafIds(node).includes(id);
}

/** `target` shares its room with a new terminal `added`: to its right (`row`) or below it (`column`). A target that is not in the tree leaves it unchanged. */
export function splitLeaf(node: LayoutNode, target: string, axis: SplitAxis, added: string): LayoutNode {
	if (node.kind === "leaf") {
		if (node.id !== target) return node;
		return { kind: "split", id: `split-${added}`, axis, ratio: 0.5, first: node, second: { kind: "leaf", id: added } };
	}
	const first = splitLeaf(node.first, target, axis, added);
	if (first !== node.first) return { ...node, first };
	const second = splitLeaf(node.second, target, axis, added);
	return second === node.second ? node : { ...node, second };
}

/** The tree without terminal `id`: its sibling takes the room. Null when it was the only terminal. */
export function removeLeaf(node: LayoutNode, id: string): LayoutNode | null {
	if (node.kind === "leaf") return node.id === id ? null : node;
	const first = removeLeaf(node.first, id);
	const second = removeLeaf(node.second, id);
	if (first === null) return second;
	if (second === null) return first;
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Move divider `splitId` to `ratio` (kept inside {@link MIN_RATIO}). */
export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
	if (node.kind === "leaf") return node;
	if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) };
	const first = setRatio(node.first, splitId, ratio);
	const second = setRatio(node.second, splitId, ratio);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** The terminal `delta` places after (or before) `from` in reading order, wrapping; null when there is no other. */
export function neighbour(node: LayoutNode, from: string, delta: 1 | -1): string | null {
	const ids = leafIds(node);
	const at = ids.indexOf(from);
	if (at < 0 || ids.length < 2) return null;
	return ids[(at + delta + ids.length) % ids.length] ?? null;
}

/**
 * `stored` (the layout last kept) made to match the terminals that exist now: terminals that are gone leave, their
 * sibling takes the room; terminals the layout does not know (opened from another device, or the layout was lost)
 * are added to the right of the last one. Null when none exist.
 */
export function reconcile(stored: LayoutNode | null, alive: readonly string[]): LayoutNode | null {
	const live = new Set(alive);
	let tree = stored;
	if (tree !== null) {
		for (const id of leafIds(tree)) if (!live.has(id)) tree = tree === null ? null : removeLeaf(tree, id);
	}
	for (const id of alive) {
		if (tree === null) tree = { kind: "leaf", id };
		else if (!hasLeaf(tree, id)) {
			const ids = leafIds(tree);
			tree = splitLeaf(tree, ids[ids.length - 1]!, "row", id);
		}
	}
	return tree;
}

/** Whatever was stored, as a layout; anything that is not a well-formed tree of leaves with distinct ids is dropped (null). */
export function parseLayout(raw: unknown): LayoutNode | null {
	const seen = new Set<string>();
	const read = (value: unknown, depth: number): LayoutNode | null => {
		if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return null;
		const node = value as Record<string, unknown>;
		if (node.kind === "leaf") {
			if (typeof node.id !== "string" || seen.has(node.id)) return null;
			seen.add(node.id);
			return { kind: "leaf", id: node.id };
		}
		if (node.kind !== "split" || typeof node.id !== "string" || typeof node.ratio !== "number") return null;
		if (node.axis !== "row" && node.axis !== "column") return null;
		const first = read(node.first, depth + 1);
		const second = read(node.second, depth + 1);
		if (first === null || second === null) return null;
		return { kind: "split", id: node.id, axis: node.axis, ratio: clampRatio(node.ratio), first, second };
	};
	return read(raw, 0);
}

/** An area as shares (0–1) of the sheet's body. */
export interface Area {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A divider and the area of the split it divides (the drag measures against it). */
export interface Divider {
	id: string;
	axis: SplitAxis;
	/** The whole split's area: the divider moves within it. */
	area: Area;
	ratio: number;
}

export interface Geometry {
	panes: { id: string; area: Area }[];
	dividers: Divider[];
}

/**
 * Where each terminal and divider is, as shares of the body. The sheet draws the terminals in one flat list at these
 * places (so a terminal that gets a new neighbour is moved, not remounted, and keeps its screen and scrollback).
 */
export function geometry(node: LayoutNode, area: Area = { x: 0, y: 0, w: 1, h: 1 }): Geometry {
	if (node.kind === "leaf") return { panes: [{ id: node.id, area }], dividers: [] };
	const row = node.axis === "row";
	const firstArea: Area = row ? { ...area, w: area.w * node.ratio } : { ...area, h: area.h * node.ratio };
	const secondArea: Area = row
		? { ...area, x: area.x + firstArea.w, w: area.w - firstArea.w }
		: { ...area, y: area.y + firstArea.h, h: area.h - firstArea.h };
	const first = geometry(node.first, firstArea);
	const second = geometry(node.second, secondArea);
	return {
		panes: [...first.panes, ...second.panes],
		dividers: [{ id: node.id, axis: node.axis, area, ratio: node.ratio }, ...first.dividers, ...second.dividers],
	};
}
