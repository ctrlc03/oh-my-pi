/**
 * Pure helpers over a {@link Blueprint}: what the viewer, the sheet and the HTML export all need to read a map
 * without drawing it. No React, no DOM, no companion: the standalone export bundles this file too.
 */
import type {
	Blueprint,
	BlueprintChange,
	BlueprintDiagram,
	BlueprintEdge,
	BlueprintExcerpt,
	BlueprintNode,
	BlueprintRef,
} from "@oh-my-pi/pi-wire/blueprint";

/** Node kinds the viewer styles; anything else is drawn as `component`. */
const NODE_KINDS: Record<string, true> = {
	system: true,
	service: true,
	component: true,
	package: true,
	module: true,
	file: true,
	symbol: true,
	store: true,
	queue: true,
	actor: true,
	ui: true,
	external: true,
};
/** Edge kinds the viewer styles; anything else is drawn as `call`. */
const EDGE_KINDS: Record<string, true> = {
	call: true,
	import: true,
	event: true,
	data: true,
	http: true,
	rpc: true,
	spawn: true,
};

/** The style key of a node kind. */
export function nodeKind(kind: string): string {
	return Object.hasOwn(NODE_KINDS, kind) ? kind : "component";
}

/** The style key of an edge kind. */
export function edgeKind(kind: string | undefined): string {
	return kind !== undefined && Object.hasOwn(EDGE_KINDS, kind) ? kind : "call";
}

/** Every node kind the viewer has a style for, for the legend. */
export const NODE_KIND_LIST: readonly string[] = Object.keys(NODE_KINDS);
/** Every edge kind the viewer has a style for, for the legend. */
export const EDGE_KIND_LIST: readonly string[] = Object.keys(EDGE_KINDS);

/** An excerpt as exported: the highlighted markup is made at export time, where the highlighter is loaded. */
export interface ExportedExcerpt extends BlueprintExcerpt {
	html?: string;
}

/** Identity of a ref, for caches and the export's excerpt table. */
export function refKey(ref: BlueprintRef): string {
	return `${ref.side ?? "head"}:${ref.path}@${ref.line}@${ref.token}`;
}

/** `path@line@token`, the form refs have in prompts. */
export function formatRef(ref: BlueprintRef): string {
	return `${ref.path}@${ref.line}@${ref.token}`;
}

/** Distinct refs of the map, in the order they are first cited; only those of the agent's diagrams when `origin` says so. */
export function allRefs(map: Blueprint, origin?: BlueprintDiagram["origin"]): BlueprintRef[] {
	const seen = new Set<string>();
	const refs: BlueprintRef[] = [];
	const add = (list: BlueprintRef[] | undefined): void => {
		for (const ref of list ?? []) {
			const key = refKey(ref);
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push(ref);
		}
	};
	for (const diagram of Object.values(map.diagrams)) {
		if (origin !== undefined && diagram.origin !== origin) continue;
		for (const node of diagram.nodes) add(node.refs);
		for (const edge of diagram.edges) add(edge.refs);
	}
	return refs;
}

/** The diagram with this id, or undefined when the map has none (a `child` that was dropped). */
export function diagramOf(map: Blueprint, id: string): BlueprintDiagram | undefined {
	return Object.hasOwn(map.diagrams, id) ? map.diagrams[id] : undefined;
}

/** The node's child diagram when the map has it. */
export function childOf(map: Blueprint, node: BlueprintNode): BlueprintDiagram | undefined {
	return node.child === undefined ? undefined : diagramOf(map, node.child);
}

/** The diagram to open the map on: the declared root, else the first one. */
export function rootDiagram(map: Blueprint): BlueprintDiagram | undefined {
	return diagramOf(map, map.root) ?? Object.values(map.diagrams)[0];
}

/** Diagrams from the root down to `id`, following `parent` (or, failing that, the node whose `child` it is). */
export function ancestry(map: Blueprint, id: string): BlueprintDiagram[] {
	const chain: BlueprintDiagram[] = [];
	const seen = new Set<string>();
	let current = diagramOf(map, id);
	while (current !== undefined && !seen.has(current.id)) {
		seen.add(current.id);
		chain.push(current);
		const parentId: string | undefined = current.parent ?? parentByChild(map, current.id);
		current = parentId === undefined ? undefined : diagramOf(map, parentId);
	}
	return chain.reverse();
}

function parentByChild(map: Blueprint, id: string): string | undefined {
	for (const diagram of Object.values(map.diagrams)) {
		if (diagram.nodes.some(node => node.child === id)) return diagram.id;
	}
	return undefined;
}

/** The node in `parent` that opens `child`, if any: the zoom transition grows out of it. */
export function nodeOpening(parent: BlueprintDiagram, child: string): BlueprintNode | undefined {
	return parent.nodes.find(node => node.child === child);
}

export interface ChangeCounts {
	added: number;
	modified: number;
	removed: number;
}

const NO_CHANGES: ChangeCounts = { added: 0, modified: 0, removed: 0 };

function bump(counts: ChangeCounts, change: BlueprintChange | undefined): void {
	if (change !== undefined) counts[change] += 1;
}

/** Nodes and edges marked as changed across every diagram of the map. */
export interface ChangeSummary {
	nodes: ChangeCounts;
	edges: ChangeCounts;
	total: number;
}

export function summarizeChanges(map: Blueprint): ChangeSummary {
	const nodes = { ...NO_CHANGES };
	const edges = { ...NO_CHANGES };
	for (const diagram of Object.values(map.diagrams)) {
		for (const node of diagram.nodes) bump(nodes, node.change);
		for (const edge of diagram.edges) bump(edges, edge.change);
	}
	const total = nodes.added + nodes.modified + nodes.removed + edges.added + edges.modified + edges.removed;
	return { nodes, edges, total };
}

/** Whether a map is a diff map (its head is compared with a base). */
export function isDiffMap(map: Blueprint): boolean {
	return map.base !== undefined;
}

/**
 * Diagrams that contain a change themselves or through a node's child, so an unchanged node can show that something
 * changed inside it. Computed once per map; a cycle of `child` links is followed once.
 */
export function diagramsWithChanges(map: Blueprint): Set<string> {
	const direct = new Set<string>();
	for (const diagram of Object.values(map.diagrams)) {
		if (
			diagram.nodes.some(node => node.change !== undefined) ||
			diagram.edges.some(edge => edge.change !== undefined)
		) {
			direct.add(diagram.id);
		}
	}
	const result = new Set<string>(direct);
	// A diagram holds changes when a node's child does: iterate to a fixed point (the graph is small).
	let grew = true;
	while (grew) {
		grew = false;
		for (const diagram of Object.values(map.diagrams)) {
			if (result.has(diagram.id)) continue;
			if (diagram.nodes.some(node => node.child !== undefined && result.has(node.child))) {
				result.add(diagram.id);
				grew = true;
			}
		}
	}
	return result;
}

/**
 * The diagram with only what changed: changed nodes and edges, the nodes that lead to changes in their child
 * diagrams, and the unchanged endpoints of changed edges (kept as context). `null` for a diagram with none of those.
 */
export function onlyChanges(
	diagram: BlueprintDiagram,
	withChanges: ReadonlySet<string>,
): { diagram: BlueprintDiagram; context: ReadonlySet<string> } | null {
	const keep = new Set<string>();
	for (const node of diagram.nodes) {
		if (node.change !== undefined || (node.child !== undefined && withChanges.has(node.child))) keep.add(node.id);
	}
	const edges = diagram.edges.filter(edge => edge.change !== undefined);
	const context = new Set<string>();
	for (const edge of edges) {
		for (const end of [edge.from, edge.to]) {
			if (!keep.has(end)) context.add(end);
		}
	}
	if (keep.size === 0 && edges.length === 0) return null;
	const nodes = diagram.nodes.filter(node => keep.has(node.id) || context.has(node.id));
	return { diagram: { ...diagram, nodes, edges }, context };
}

/** A search hit: a diagram, a node or an edge somewhere in the map. */
export interface SearchHit {
	kind: "diagram" | "node" | "edge";
	diagram: string;
	/** Node or edge id; absent for a diagram. */
	id?: string;
	title: string;
	/** Where it is: the diagram's title, with the node kind or path. */
	sub: string;
	score: number;
}

const MAX_HITS = 40;

function terms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[\s/]+/)
		.filter(term => term !== "");
}

/** Score lower-case `text` for the words of `want`: 0 when one is missing, higher for a prefix of the whole text. */
function score(text: string, want: readonly string[]): number {
	let total = 0;
	for (const term of want) {
		const at = text.indexOf(term);
		if (at < 0) return 0;
		total += at === 0 ? 3 : text[at - 1] === " " || text[at - 1] === "-" || text[at - 1] === "_" ? 2 : 1;
	}
	return total;
}

interface SearchEntry {
	kind: SearchHit["kind"];
	diagram: BlueprintDiagram;
	node?: BlueprintNode;
	edge?: BlueprintEdge;
	/** Lower-case text searched, and the part of it that is the name. */
	text: string;
	name: string;
}

/**
 * A search over the diagrams, nodes and edges of a map, whose title, label, summary or path contain every word of
 * the query, best first. The text of every entry is lower-cased once here, so a keystroke is one pass of
 * `indexOf` over them (a map of a large repository has some 20 000).
 */
export function createSearch(map: Blueprint): (query: string) => SearchHit[] {
	const entries: SearchEntry[] = [];
	for (const diagram of Object.values(map.diagrams)) {
		const title = diagram.title.toLowerCase();
		entries.push({
			kind: "diagram",
			diagram,
			text: `${title} ${(diagram.summary ?? "").toLowerCase()}`,
			name: title,
		});
		for (const node of diagram.nodes) {
			const label = node.label.toLowerCase();
			entries.push({
				kind: "node",
				diagram,
				node,
				text: `${label} ${(node.summary ?? "").toLowerCase()} ${(node.path ?? "").toLowerCase()} ${node.kind.toLowerCase()}`,
				name: label,
			});
		}
		for (const edge of diagram.edges) {
			const label = edge.label.toLowerCase();
			entries.push({ kind: "edge", diagram, edge, text: label, name: label });
		}
	}
	const hitOf = (entry: SearchEntry, points: number): SearchHit => {
		const { diagram, node, edge } = entry;
		if (node !== undefined) {
			return {
				kind: "node",
				diagram: diagram.id,
				id: node.id,
				title: node.label,
				sub: `${diagram.title} · ${node.path ?? node.kind}`,
				score: points,
			};
		}
		if (edge !== undefined) {
			const from = diagram.nodes.find(item => item.id === edge.from)?.label ?? edge.from;
			const to = diagram.nodes.find(item => item.id === edge.to)?.label ?? edge.to;
			return {
				kind: "edge",
				diagram: diagram.id,
				id: edge.id,
				title: edge.label,
				sub: `${diagram.title} · ${from} → ${to}`,
				score: points,
			};
		}
		return {
			kind: "diagram",
			diagram: diagram.id,
			title: diagram.title,
			sub: `${diagram.nodes.length} nodes`,
			score: points,
		};
	};
	return query => {
		const want = terms(query);
		if (want.length === 0) return [];
		const found: { entry: SearchEntry; points: number; order: number }[] = [];
		entries.forEach((entry, order) => {
			const rest = score(entry.text, want);
			if (rest === 0) return;
			const points =
				entry.kind === "node"
					? rest + score(entry.name, want) * 2
					: entry.kind === "edge"
						? rest
						: rest + 1 + (score(entry.name, want) > 0 ? 2 : 0);
			found.push({ entry, points, order });
		});
		// Stable: equal scores keep the map's own order.
		return found
			.sort((a, b) => b.points - a.points || a.order - b.order)
			.slice(0, MAX_HITS)
			.map(({ entry, points }) => hitOf(entry, points));
	};
}

/** Where the viewer is: one diagram, and optionally one node or edge selected in it. */
export interface MapLocation {
	diagram: string;
	node?: string;
	edge?: string;
}

/** `#d=<diagram>&n=<node>` / `&e=<edge>`: the form a location has in the exported page's URL. */
export function formatLocationHash(location: MapLocation): string {
	let hash = `#d=${encodeURIComponent(location.diagram)}`;
	if (location.node !== undefined) hash += `&n=${encodeURIComponent(location.node)}`;
	else if (location.edge !== undefined) hash += `&e=${encodeURIComponent(location.edge)}`;
	return hash;
}

/** The location a URL fragment names, or null when it names none. */
export function parseLocationHash(hash: string): MapLocation | null {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const diagram = params.get("d");
	if (diagram === null || diagram === "") return null;
	const location: MapLocation = { diagram };
	const node = params.get("n");
	const edge = params.get("e");
	if (node !== null && node !== "") location.node = node;
	else if (edge !== null && edge !== "") location.edge = edge;
	return location;
}

/** `text` cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Display line of an edge: "From → To". */
export function edgeEnds(diagram: BlueprintDiagram, edge: BlueprintEdge): { from: string; to: string } {
	const label = (id: string): string => diagram.nodes.find(node => node.id === id)?.label ?? id;
	return { from: label(edge.from), to: label(edge.to) };
}

/** Short commit hash for display. */
export function shortCommit(commit: string): string {
	return commit.slice(0, 8);
}

/** A ref as people read it: the working-tree snapshot is "uncommitted work", not `@worktree`. */
export function refLabel(ref: string | undefined): string {
	return ref === undefined ? "HEAD" : ref === "@worktree" ? "uncommitted work" : ref;
}

/** A file-name stem for the export: letters, digits and dashes. */
export function slug(text: string): string {
	const stem = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return stem === "" ? "architecture-map" : stem.slice(0, 60);
}
