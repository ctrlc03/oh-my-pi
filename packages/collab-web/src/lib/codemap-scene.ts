/**
 * Code map graphs as Excalidraw scene skeletons: the focus with what uses it and what it uses, or the flow
 * walk from a symbol. A skeleton is Excalidraw's own shorthand (shapes with a `label`, arrows naming their
 * `start`/`end` shapes); the canvas expands it into a full scene, measuring text and binding the arrows.
 * Pure: colors come in through a {@link GraphPalette} so the module reads no CSS.
 */

import type { CodemapFlowDirection, CodemapFlowStep, CodemapLink, CodemapNode, CodemapView } from "./companion";

/** Colors the scene uses; the canvas resolves them from the app's tokens. */
export interface GraphPalette {
	/** Arrow color. */
	line: string;
	/** Arrows that cross languages or go through an event. */
	bridge: string;
	/** Outline of a node of `lang`. */
	lang(lang: string): string;
}

/** A shape or arrow in Excalidraw's skeleton shorthand. */
export interface SkeletonElement {
	id: string;
	type: "rectangle" | "arrow";
	x: number;
	y: number;
	width?: number;
	height?: number;
	strokeColor: string;
	backgroundColor?: string;
	strokeStyle?: "solid" | "dashed";
	roundness?: { type: 3 };
	label?: { text: string; fontSize: number; strokeColor: string };
	start?: { id: string };
	end?: { id: string };
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 140;
const ROW_GAP = 28;
const LABEL_SIZE = 16;
/** Longest node caption line before it is cut: a box this wide holds about this many characters. */
const CAPTION_CHARS = 34;

function clip(text: string): string {
	return text.length > CAPTION_CHARS ? `${text.slice(0, CAPTION_CHARS - 1)}…` : text;
}

/** Secondary caption of a node: its path, with the line for a symbol. */
function where(node: CodemapNode): string {
	if (node.kind === "symbol") return `${node.path}:${node.line ?? 1}`;
	return node.path || "repository root";
}

function nodeBox(id: string, node: CodemapNode, x: number, y: number, palette: GraphPalette): SkeletonElement {
	const stroke = palette.lang(node.lang);
	return {
		id,
		type: "rectangle",
		x,
		y,
		width: NODE_WIDTH,
		height: NODE_HEIGHT,
		strokeColor: stroke,
		backgroundColor: "transparent",
		roundness: { type: 3 },
		label: { text: `${clip(node.label)}\n${clip(where(node))}`, fontSize: LABEL_SIZE, strokeColor: palette.line },
	};
}

function arrow(
	id: string,
	from: string,
	to: string,
	bridge: boolean,
	palette: GraphPalette,
	caption: string | null,
): SkeletonElement {
	const element: SkeletonElement = {
		id,
		type: "arrow",
		x: 0,
		y: 0,
		strokeColor: bridge ? palette.bridge : palette.line,
		strokeStyle: bridge ? "dashed" : "solid",
		start: { id: from },
		end: { id: to },
	};
	if (caption) element.label = { text: clip(caption), fontSize: LABEL_SIZE - 2, strokeColor: palette.line };
	return element;
}

/** Y of the top of row `index` in a column of `count` boxes centred on `middle`. */
function rowTop(index: number, count: number, middle: number): number {
	const height = count * NODE_HEIGHT + (count - 1) * ROW_GAP;
	return middle - height / 2 + index * (NODE_HEIGHT + ROW_GAP);
}

/**
 * The focus view: what uses the focus on the left, the focus in the middle, what it uses on the right, an
 * arrow per link pointing the way the use goes (user → focus → used). Links beyond the view's caps are not
 * there to draw.
 */
export function focusToSkeleton(view: CodemapView, palette: GraphPalette): SkeletonElement[] {
	const elements: SkeletonElement[] = [];
	const middleX = NODE_WIDTH + COLUMN_GAP;
	const rightX = 2 * (NODE_WIDTH + COLUMN_GAP);
	const rows = Math.max(view.upstream.length, view.downstream.length, 1);
	const middleY = (rows * (NODE_HEIGHT + ROW_GAP)) / 2;
	elements.push(nodeBox("focus", view.focus, middleX, middleY - NODE_HEIGHT / 2, palette));
	const side = (links: readonly CodemapLink[], prefix: "up" | "down", x: number): void => {
		links.forEach((link, index) => {
			const id = `${prefix}-${index}`;
			elements.push(nodeBox(id, link.node, x, rowTop(index, links.length, middleY), palette));
			elements.push(
				prefix === "up"
					? arrow(`${id}-edge`, id, "focus", link.bridge, palette, link.label)
					: arrow(`${id}-edge`, "focus", id, link.bridge, palette, link.label),
			);
		});
	};
	side(view.upstream, "up", 0);
	side(view.downstream, "down", rightX);
	return elements;
}

/**
 * The flow walk as hop columns left to right, an arrow from each step to the step it was reached from (the
 * other way round for an upstream walk, so arrows always run with the data).
 */
export function flowToSkeleton(
	steps: readonly CodemapFlowStep[],
	direction: CodemapFlowDirection,
	palette: GraphPalette,
): SkeletonElement[] {
	const elements: SkeletonElement[] = [];
	const columns: number[][] = [];
	steps.forEach((step, index) => {
		while (columns.length <= step.hop) columns.push([]);
		columns[step.hop]!.push(index);
	});
	const tallest = Math.max(1, ...columns.map(column => column.length));
	const middleY = (tallest * (NODE_HEIGHT + ROW_GAP)) / 2;
	columns.forEach((column, hop) => {
		column.forEach((index, row) => {
			const step = steps[index]!;
			elements.push(
				nodeBox(
					`step-${index}`,
					step.node,
					hop * (NODE_WIDTH + COLUMN_GAP),
					rowTop(row, column.length, middleY),
					palette,
				),
			);
		});
	});
	steps.forEach((step, index) => {
		if (step.from === null) return;
		const parent = `step-${step.from}`;
		const child = `step-${index}`;
		elements.push(
			direction === "down"
				? arrow(`edge-${index}`, parent, child, step.bridge, palette, step.label)
				: arrow(`edge-${index}`, child, parent, step.bridge, palette, step.label),
		);
	});
	return elements;
}
