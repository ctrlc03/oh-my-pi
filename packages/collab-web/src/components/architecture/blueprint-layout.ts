/**
 * Left-to-right layered layout of one diagram. Deterministic: the same diagram always gives the same
 * coordinates, because every tie breaks on the order the map lists its nodes and edges in.
 *
 * A small Sugiyama pipeline instead of a layout library (dagre is ~30 KB min, elkjs well over 1 MB, and both
 * need glue to keep results stable): break cycles by reversing back edges, put each node one layer past its
 * deepest predecessor (sources then move up against their successors), split edges that skip layers with
 * dummy points so they route between nodes, order each layer by barycenter sweeps, and place the layers' nodes
 * with an isotonic-regression pass that keeps each node near the middle of its neighbours without overlap.
 * Nodes with no edges go into a grid under the graph instead of one long column.
 */
import type { BlueprintDiagram, BlueprintEdge, BlueprintNode } from "@oh-my-pi/pi-wire/blueprint";
import { clip, nodeKind } from "./blueprint-model";

export interface Point {
	x: number;
	y: number;
}

export interface PlacedNode {
	node: BlueprintNode;
	/** Top-left corner. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlacedLabel {
	/** Centre of the pill. */
	x: number;
	y: number;
	width: number;
	text: string;
}

export interface PlacedEdge {
	edge: BlueprintEdge;
	/** SVG path from the source to the target; the arrowhead sits on the target end. */
	d: string;
	label: PlacedLabel;
}

export interface DiagramLayout {
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
}

export const NODE_HEIGHT = 60;
const NODE_MIN_WIDTH = 150;
const NODE_MAX_WIDTH = 252;
const ROW_GAP = 30;
const DUMMY_GAP = 16;
const DUMMY_HEIGHT = 6;
const MIN_COLUMN_GAP = 96;
const MAX_COLUMN_GAP = 260;
const PADDING = 32;
const LABEL_CHARS = 34;
const LABEL_HEIGHT = 20;
const SWEEPS = 10;
const RELAX_PASSES = 6;
/** Crossing counts are pairwise per layer pair: skip them (and keep the last sweep) past this many links. */
const MAX_COUNTED_LINKS = 1500;
/** The widest the grid of unconnected nodes grows. */
const MAX_GRID_COLUMNS = 8;

/** Characters of a node label that fit its box, for the drawing to clip to. */
export function nodeLabelChars(width: number): number {
	return Math.floor((width - 56) / 7.4);
}

function nodeWidth(node: BlueprintNode): number {
	const byLabel = node.label.length * 7.6 + 58;
	const byKind = nodeKind(node.kind).length * 6.6 + 64;
	return Math.round(Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, byLabel, byKind)));
}

function labelWidth(text: string): number {
	return Math.round(Math.min(230, clip(text, LABEL_CHARS).length * 6.3 + 18));
}

interface Item {
	/** Index into the diagram's nodes; -1 for a routing point of a long edge. */
	node: number;
	layer: number;
	/** Height of the item for spacing. */
	height: number;
	width: number;
	y: number;
	x: number;
	order: number;
}

interface Flow {
	edge: BlueprintEdge;
	/** Points the edge passes: layer-ascending item indexes, from the lower layer to the higher. */
	chain: number[];
	/** The edge runs against the layering (it closes a cycle). */
	reversed: boolean;
	/** Position among the edges that join the same two nodes, and how many there are. */
	lane: number;
	lanes: number;
}

/** Minimise the squared distance to `desired` with `sep[i]` the least distance from item i to i+1 (pool adjacent violators). */
function place(desired: number[], sep: number[]): number[] {
	const n = desired.length;
	const offset: number[] = [0];
	for (let i = 1; i < n; i++) offset.push(offset[i - 1]! + sep[i - 1]!);
	const blocks: { sum: number; count: number }[] = [];
	for (let i = 0; i < n; i++) {
		blocks.push({ sum: desired[i]! - offset[i]!, count: 1 });
		while (blocks.length > 1) {
			const last = blocks[blocks.length - 1]!;
			const before = blocks[blocks.length - 2]!;
			if (before.sum / before.count <= last.sum / last.count) break;
			before.sum += last.sum;
			before.count += last.count;
			blocks.pop();
		}
	}
	const out: number[] = [];
	for (const block of blocks) {
		for (let k = 0; k < block.count; k++) out.push(block.sum / block.count + offset[out.length]!);
	}
	return out;
}

export function layoutDiagram(diagram: BlueprintDiagram): DiagramLayout {
	const nodes = diagram.nodes;
	const index = new Map<string, number>();
	nodes.forEach((node, i) => {
		if (!index.has(node.id)) index.set(node.id, i);
	});
	const edges = diagram.edges.filter(edge => index.has(edge.from) && index.has(edge.to));
	const widths = nodes.map(nodeWidth);

	// --- classify edges: self loops are drawn on the node; the rest take part in layering.
	const linked = new Set<number>();
	const flowEdges: { edge: BlueprintEdge; a: number; b: number }[] = [];
	const loops: BlueprintEdge[] = [];
	for (const edge of edges) {
		const a = index.get(edge.from)!;
		const b = index.get(edge.to)!;
		if (a === b) {
			loops.push(edge);
			continue;
		}
		flowEdges.push({ edge, a, b });
		linked.add(a);
		linked.add(b);
	}

	// --- break cycles: a depth-first walk in node order reverses every edge that closes a cycle.
	const outgoing: number[][] = nodes.map(() => []);
	flowEdges.forEach((flow, i) => outgoing[flow.a]!.push(i));
	const state = new Uint8Array(nodes.length);
	const backEdge = new Set<number>();
	for (let start = 0; start < nodes.length; start++) {
		if (state[start] !== 0 || !linked.has(start)) continue;
		const stack: { node: number; next: number }[] = [{ node: start, next: 0 }];
		state[start] = 1;
		while (stack.length > 0) {
			const top = stack[stack.length - 1]!;
			const out = outgoing[top.node]!;
			if (top.next >= out.length) {
				state[top.node] = 2;
				stack.pop();
				continue;
			}
			const flow = flowEdges[out[top.next++]!]!;
			if (state[flow.b] === 1) backEdge.add(out[top.next - 1]!);
			else if (state[flow.b] === 0) {
				state[flow.b] = 1;
				stack.push({ node: flow.b, next: 0 });
			}
		}
	}
	// DAG arcs (low → high): [from, to, flow index].
	const arcs = flowEdges.map((flow, i): [number, number, number] =>
		backEdge.has(i) ? [flow.b, flow.a, i] : [flow.a, flow.b, i],
	);

	// --- layers: one past the deepest predecessor, then sources move up against their successors.
	const preds: number[][] = nodes.map(() => []);
	const succs: number[][] = nodes.map(() => []);
	for (const [from, to] of arcs) {
		succs[from]!.push(to);
		preds[to]!.push(from);
	}
	const layer = Array.from<number>({ length: nodes.length }).fill(0);
	const waiting = nodes.map((_, i) => preds[i]!.length);
	const topo: number[] = [];
	const queue: number[] = [];
	for (let i = 0; i < nodes.length; i++) if (linked.has(i) && waiting[i] === 0) queue.push(i);
	for (let head = 0; head < queue.length; head++) {
		const node = queue[head]!;
		topo.push(node);
		for (const next of succs[node]!) {
			layer[next] = Math.max(layer[next]!, layer[node]! + 1);
			if (--waiting[next] === 0) queue.push(next);
		}
	}
	for (let k = topo.length - 1; k >= 0; k--) {
		const node = topo[k]!;
		if (preds[node]!.length === 0 && succs[node]!.length > 0) {
			layer[node] = Math.min(...succs[node]!.map(next => layer[next]!)) - 1;
		}
	}

	// --- items: every linked node, plus a routing point per skipped layer of an edge.
	const items: Item[] = [];
	const itemOf = new Map<number, number>();
	for (let i = 0; i < nodes.length; i++) {
		if (!linked.has(i)) continue;
		itemOf.set(i, items.length);
		items.push({ node: i, layer: layer[i]!, height: NODE_HEIGHT, width: widths[i]!, y: 0, x: 0, order: 0 });
	}
	const pair = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
	const lanesUsed = new Map<string, number>();
	const laneTotal = new Map<string, number>();
	for (const flow of flowEdges) laneTotal.set(pair(flow.a, flow.b), (laneTotal.get(pair(flow.a, flow.b)) ?? 0) + 1);
	const flows: Flow[] = arcs.map(([from, to, i]) => {
		const flow = flowEdges[i]!;
		const chain = [itemOf.get(from)!];
		for (let l = layer[from]! + 1; l < layer[to]!; l++) {
			chain.push(items.length);
			items.push({ node: -1, layer: l, height: DUMMY_HEIGHT, width: 0, y: 0, x: 0, order: 0 });
		}
		chain.push(itemOf.get(to)!);
		const key = pair(flow.a, flow.b);
		const lane = lanesUsed.get(key) ?? 0;
		lanesUsed.set(key, lane + 1);
		return { edge: flow.edge, chain, reversed: backEdge.has(i), lane, lanes: laneTotal.get(key)! };
	});

	// Normalise layers to start at 0 (sources moved up may have left a gap at the top).
	const lowest = items.length === 0 ? 0 : Math.min(...items.map(item => item.layer));
	for (const item of items) item.layer -= lowest;
	const layerCount = items.length === 0 ? 0 : Math.max(...items.map(item => item.layer)) + 1;
	const columns: number[][] = Array.from({ length: layerCount }, () => []);
	items.forEach((item, i) => columns[item.layer]!.push(i));
	const up: number[][] = items.map(() => []);
	const down: number[][] = items.map(() => []);
	for (const flow of flows) {
		for (let k = 1; k < flow.chain.length; k++) {
			down[flow.chain[k - 1]!]!.push(flow.chain[k]!);
			up[flow.chain[k]!]!.push(flow.chain[k - 1]!);
		}
	}

	// --- order each layer: barycenter sweeps, keeping the ordering with the fewest crossings.
	const setOrder = (): void => {
		for (const column of columns) column.forEach((item, position) => (items[item]!.order = position));
	};
	setOrder();
	const links = flows.reduce((sum, flow) => sum + flow.chain.length - 1, 0);
	const crossings = (): number => {
		let total = 0;
		for (let l = 0; l + 1 < layerCount; l++) {
			const segments: [number, number][] = [];
			for (const item of columns[l]!) {
				for (const next of down[item]!) segments.push([items[item]!.order, items[next]!.order]);
			}
			for (let i = 0; i < segments.length; i++) {
				for (let j = i + 1; j < segments.length; j++) {
					const [a1, b1] = segments[i]!;
					const [a2, b2] = segments[j]!;
					if ((a1 - a2) * (b1 - b2) < 0) total++;
				}
			}
		}
		return total;
	};
	const count = links <= MAX_COUNTED_LINKS;
	let best = columns.map(column => [...column]);
	let bestCrossings = count ? crossings() : Number.POSITIVE_INFINITY;
	for (let sweep = 0; sweep < SWEEPS; sweep++) {
		const downward = sweep % 2 === 0;
		const range = downward
			? columns.map((_, l) => l).slice(1)
			: columns
					.map((_, l) => l)
					.slice(0, -1)
					.reverse();
		for (const l of range) {
			const keyed = columns[l]!.map(item => {
				const neighbours = downward ? up[item]! : down[item]!;
				const bary =
					neighbours.length === 0
						? items[item]!.order
						: neighbours.reduce((sum, other) => sum + items[other]!.order, 0) / neighbours.length;
				return { item, bary, was: items[item]!.order };
			});
			keyed.sort((a, b) => a.bary - b.bary || a.was - b.was);
			columns[l] = keyed.map(entry => entry.item);
			columns[l]!.forEach((item, position) => (items[item]!.order = position));
		}
		if (count) {
			const now = crossings();
			if (now < bestCrossings) {
				bestCrossings = now;
				best = columns.map(column => [...column]);
			}
		}
	}
	if (count) {
		for (let l = 0; l < layerCount; l++) columns[l] = best[l]!;
		setOrder();
	}

	// --- vertical placement.
	const separation = (column: number[]): number[] =>
		column.slice(0, -1).map((item, k) => {
			const here = items[item]!;
			const next = items[column[k + 1]!]!;
			const gap = here.node >= 0 && next.node >= 0 ? ROW_GAP : DUMMY_GAP;
			return (here.height + next.height) / 2 + gap;
		});
	for (const column of columns) {
		const spots = place(
			column.map(() => 0),
			separation(column),
		);
		column.forEach((item, k) => (items[item]!.y = spots[k]!));
	}
	const settle = (l: number, toward: number[][]): void => {
		const column = columns[l]!;
		const desired = column.map(item => {
			const near = toward[item]!;
			if (near.length === 0) return items[item]!.y;
			return near.reduce((sum, other) => sum + items[other]!.y, 0) / near.length;
		});
		const spots = place(desired, separation(column));
		column.forEach((item, k) => (items[item]!.y = spots[k]!));
	};
	for (let pass = 0; pass < RELAX_PASSES; pass++) {
		for (let l = 1; l < layerCount; l++) settle(l, up);
		for (let l = layerCount - 2; l >= 0; l--) settle(l, down);
	}

	// --- horizontal placement: column widths, and gaps wide enough for the labels leaving each column.
	const columnWidth = columns.map(column => Math.max(0, ...column.map(item => items[item]!.width)));
	const gapAfter = Array.from<number>({ length: layerCount }).fill(MIN_COLUMN_GAP);
	for (const flow of flows) {
		const from = items[flow.chain[0]!]!.layer;
		gapAfter[from] = Math.min(MAX_COLUMN_GAP, Math.max(gapAfter[from]!, labelWidth(flow.edge.label) + 52));
	}
	const columnX: number[] = [];
	let cursor = 0;
	for (let l = 0; l < layerCount; l++) {
		columnX.push(cursor);
		cursor += columnWidth[l]! + gapAfter[l]!;
	}
	for (const item of items) item.x = columnX[item.layer]! + (columnWidth[item.layer]! - item.width) / 2;

	// --- assemble placed nodes; unconnected ones go in a grid below.
	const placed = new Map<number, PlacedNode>();
	for (const item of items) {
		if (item.node < 0) continue;
		placed.set(item.node, {
			node: nodes[item.node]!,
			x: item.x,
			y: item.y - item.height / 2,
			width: item.width,
			height: item.height,
		});
	}
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxX = 0;
	// Routing points count too: a long edge may swing past the outermost node.
	for (const item of items) {
		minY = Math.min(minY, item.y - item.height / 2);
		maxY = Math.max(maxY, item.y + item.height / 2);
		maxX = Math.max(maxX, item.x + item.width);
	}
	if (items.length === 0) {
		minY = 0;
		maxY = 0;
	}
	// Loops hang above their node: leave room for the arc and its label.
	const loopRoom = loops.some(edge => linked.has(index.get(edge.from)!)) ? 58 : 0;
	const top = minY - loopRoom;
	// Shift everything so the graph starts at the padding.
	const shiftY = PADDING - top;
	for (const node of placed.values()) node.y += shiftY;
	for (const item of items) item.y += shiftY;
	maxY += shiftY;
	const shiftX = PADDING;
	for (const node of placed.values()) node.x += shiftX;
	for (const item of items) item.x += shiftX;
	maxX += shiftX;

	const lonely = nodes.map((_, i) => i).filter(i => !linked.has(i) && index.get(nodes[i]!.id) === i);
	// A node that only has a loop is "unlinked" for layering but still gets its loop drawn: it sits in the grid.
	if (lonely.length > 0) {
		const cell = Math.max(...lonely.map(i => widths[i]!)) + 28;
		const rowHeight = NODE_HEIGHT + ROW_GAP + (loops.length > 0 ? 40 : 0);
		const wanted =
			placed.size > 0 ? Math.floor((maxX - PADDING + 28) / cell) : Math.ceil(Math.sqrt(lonely.length * 1.8));
		const cols = Math.max(1, Math.min(MAX_GRID_COLUMNS, wanted, lonely.length));
		const startY = placed.size > 0 ? maxY + 56 : PADDING + (loops.length > 0 ? 40 : 0);
		lonely.forEach((i, k) => {
			const col = k % cols;
			const row = Math.floor(k / cols);
			placed.set(i, {
				node: nodes[i]!,
				x: PADDING + col * cell,
				y: startY + row * rowHeight,
				width: widths[i]!,
				height: NODE_HEIGHT,
			});
		});
		const rows = Math.ceil(lonely.length / cols);
		maxY = Math.max(maxY, startY + (rows - 1) * rowHeight + NODE_HEIGHT);
		maxX = Math.max(maxX, PADDING + cols * cell - 28);
	}

	// --- edge geometry.
	const placedEdges: PlacedEdge[] = [];
	const smooth = (points: Point[]): string => {
		let d = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
		for (let k = 1; k < points.length; k++) {
			const p = points[k - 1]!;
			const q = points[k]!;
			const dx = (q.x - p.x) * 0.5;
			d += ` C ${round(p.x + dx)} ${round(p.y)} ${round(q.x - dx)} ${round(q.y)} ${round(q.x)} ${round(q.y)}`;
		}
		return d;
	};
	for (const flow of flows) {
		const first = items[flow.chain[0]!]!;
		const last = items[flow.chain[flow.chain.length - 1]!]!;
		const lane = (flow.lane - (flow.lanes - 1) / 2) * 12;
		const points: Point[] = [{ x: first.x + first.width, y: first.y + lane }];
		for (const mid of flow.chain.slice(1, -1)) {
			const item = items[mid]!;
			points.push({ x: item.x, y: item.y + lane });
		}
		points.push({ x: last.x, y: last.y + lane });
		const next = points[1]!;
		const start = points[0]!;
		const label: PlacedLabel = {
			x: (start.x + next.x) / 2,
			y: (start.y + next.y) / 2,
			width: labelWidth(flow.edge.label),
			text: clip(flow.edge.label, LABEL_CHARS),
		};
		if (flow.reversed) points.reverse();
		placedEdges.push({ edge: flow.edge, d: smooth(points), label });
	}
	// Edges keep the map's own order, so a later edge draws over an earlier one deterministically.
	const order = new Map(edges.map((edge, i) => [edge, i] as const));
	placedEdges.sort((a, b) => order.get(a.edge)! - order.get(b.edge)!);

	let loopSeen = 0;
	for (const edge of loops) {
		const node = placed.get(index.get(edge.from)!)!;
		const a = { x: node.x + node.width * 0.7, y: node.y };
		const b = { x: node.x + node.width * 0.3, y: node.y };
		const lift = 36 + (loopSeen++ % 3) * 10;
		placedEdges.push({
			edge,
			d: `M ${round(a.x)} ${round(a.y)} C ${round(a.x + 18)} ${round(a.y - lift)} ${round(b.x - 18)} ${round(b.y - lift)} ${round(b.x)} ${round(b.y)}`,
			label: {
				x: node.x + node.width / 2,
				y: node.y - lift - 6,
				width: labelWidth(edge.label),
				text: clip(edge.label, LABEL_CHARS),
			},
		});
	}

	// --- bounds, including label pills.
	let width = maxX;
	let height = maxY;
	for (const edge of placedEdges) {
		width = Math.max(width, edge.label.x + edge.label.width / 2);
		height = Math.max(height, edge.label.y + LABEL_HEIGHT / 2);
	}
	return {
		width: Math.ceil(width + PADDING),
		height: Math.ceil(height + PADDING),
		nodes: nodes.flatMap((_, i) => {
			const hit = placed.get(i);
			return hit === undefined ? [] : [hit];
		}),
		edges: placedEdges,
	};
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Height of an edge label pill, for the drawing. */
export const EDGE_LABEL_HEIGHT = LABEL_HEIGHT;
