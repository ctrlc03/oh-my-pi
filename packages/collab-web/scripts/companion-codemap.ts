/**
 * Code map for the companion's `codemap` and `codemap-search` requests: folder, file and symbol
 * neighbourhoods of a session's repository, read from omp's codemap index (packages/coding-agent/src/codemap).
 *
 * The view builders are pure functions over the dependency graph (`GraphFile[]` / `GraphEdge[]`, folded into
 * a {@link GraphIndex}) and the symbol queries they are handed; only {@link codemapView} and
 * {@link codemapSearch} touch the index. Opening an index re-walks the tree to refresh it, so a repository's
 * handle is kept for a few seconds and its graph survives refreshes that changed no file.
 */

import * as fs from "node:fs/promises";
import type { Codemap, FlowEdge, FlowNode, GraphEdge, GraphFile } from "@oh-my-pi/pi-coding-agent/codemap/index";
import type {
	CodemapEdge,
	CodemapFlowDirection,
	CodemapFlowStep,
	CodemapFocus,
	CodemapLink,
	CodemapMap,
	CodemapNode,
	CodemapView,
} from "../src/lib/companion";
import { repoRoot } from "./companion-git";

/** A handle opened less than this long ago answers without re-walking the tree. */
const FRESH_MS = 10_000;
/** A handle nobody asked for this long is closed. */
const IDLE_MS = 10 * 60_000;
/** Folder and file links per side. */
const MAX_LINKS = 40;
const MAX_MAP_NODES = 250;
const MAX_MAP_EDGES = 1500;
const MAX_FILE_SYMBOLS = 300;
const MAX_MEMBERS = 100;
const MAX_FLOW_HOPS = 5;
const MAX_FLOW_STEPS = 40;
/** Edges followed out of one flow step: led by bridges and handlers, then at most this many plain calls. */
const MAX_FLOW_EDGES = 6;
const MAX_FLOW_CALLS = 3;
const MAX_SEARCH_FILES = 8;
const MAX_SEARCH_SYMBOLS = 20;
const MAX_SIGNATURE_CHARS = 140;
const MAX_DOC_CHARS = 200;
const MAX_PATH_CHARS = 4096;
const MAX_NAME_CHARS = 512;
const MAX_QUERY_CHARS = 200;

/** What the focus uses or leads to, read from the focus symbol. */
const DOWNSTREAM_FLOW: Record<string, true> = {
	calls: true,
	"calls contract": true,
	"proves with": true,
	emits: true,
	"decoded by": true,
	becomes: true,
	"converts to": true,
	publishes: true,
	"handled by": true,
};
/** What uses or feeds the focus symbol. */
const UPSTREAM_FLOW: Record<string, true> = {
	"called by": true,
	"called from Rust": true,
	"emitted by": true,
	decodes: true,
	"decoded from": true,
	"converted from": true,
	"published by": true,
	handles: true,
	"proved from Rust": true,
};
/** File edge labels read from the other end. */
const INVERSE_LABEL: Record<string, string> = {
	references: "referenced by",
	decodes: "decoded by",
	"calls contract": "called from Rust",
	"proves with": "proved from Rust",
};

/** The symbol queries the views use; `Codemap.query` provides them. */
export interface CodemapSource {
	flowSearch(words: string, limit: number): FlowNode[];
	flowDefinitions(symbol: string): FlowNode[];
	flowOverlapping(rel: string, start: number, end: number, limit: number): FlowNode[];
	flowNeighbors(node: FlowNode): FlowEdge[];
	fileSymbols(rel: string, limit: number): FlowNode[];
	symbolMembers(node: FlowNode, limit: number): FlowNode[];
}

interface DirInfo {
	files: number;
	symbols: number;
	langs: Record<string, number>;
	/** Paths of the folders directly inside. */
	subdirs: string[];
	/** Paths of the files directly inside. */
	direct: string[];
}

/** The dependency graph with the folder tree and lookups derived from it. */
export interface GraphIndex {
	files: GraphFile[];
	edges: GraphEdge[];
	byRel: Map<string, GraphFile>;
	/** Every folder holding source files below it, and the root `""`. */
	dirs: Map<string, DirInfo>;
	symbols: number;
}

function parentOf(rel: string): string {
	const slash = rel.lastIndexOf("/");
	return slash < 0 ? "" : rel.slice(0, slash);
}

function baseName(rel: string): string {
	return rel.slice(rel.lastIndexOf("/") + 1);
}

function byName(a: string, b: string): number {
	const x = baseName(a);
	const y = baseName(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** `rel` is `dir` or lies below it; the root `""` contains everything. */
function contains(dir: string, rel: string): boolean {
	return dir === "" || rel === dir || rel.startsWith(`${dir}/`);
}

/** Folders from the root down to `dir`, both included; `[""]` for the root. */
function ancestorDirs(dir: string): string[] {
	const dirs = [""];
	for (let slash = dir.indexOf("/"); slash >= 0; slash = dir.indexOf("/", slash + 1)) dirs.push(dir.slice(0, slash));
	if (dir !== "") dirs.push(dir);
	return dirs;
}

function ensureDir(dirs: Map<string, DirInfo>, dir: string): DirInfo {
	let info = dirs.get(dir);
	if (!info) {
		info = { files: 0, symbols: 0, langs: {}, subdirs: [], direct: [] };
		dirs.set(dir, info);
		if (dir !== "") ensureDir(dirs, parentOf(dir)).subdirs.push(dir);
	}
	return info;
}

/** Fold the graph into the lookups the views read; folders are the ancestors of the files. */
export function buildGraphIndex(files: GraphFile[], edges: GraphEdge[]): GraphIndex {
	const dirs = new Map<string, DirInfo>();
	ensureDir(dirs, "");
	let symbols = 0;
	for (const file of files) {
		symbols += file.symbols;
		const parent = parentOf(file.rel);
		ensureDir(dirs, parent).direct.push(file.rel);
		for (const dir of ancestorDirs(parent)) {
			const info = ensureDir(dirs, dir);
			info.files++;
			info.symbols += file.symbols;
			info.langs[file.lang] = (info.langs[file.lang] ?? 0) + 1;
		}
	}
	for (const info of dirs.values()) {
		info.subdirs.sort(byName);
		info.direct.sort(byName);
	}
	return { files, edges, byRel: new Map(files.map(file => [file.rel, file])), dirs, symbols };
}

function dirNode(graph: GraphIndex, repo: string, dir: string): CodemapNode {
	const info = graph.dirs.get(dir);
	let lang = "other";
	let best = 0;
	for (const [name, count] of Object.entries(info?.langs ?? {})) {
		if (count > best || (count === best && name < lang)) {
			lang = name;
			best = count;
		}
	}
	return {
		kind: "dir",
		path: dir,
		label: dir === "" ? repo : baseName(dir),
		lang,
		files: info?.files ?? 0,
		symbols: info?.symbols ?? 0,
	};
}

function fileNode(graph: GraphIndex, rel: string): CodemapNode {
	const file = graph.byRel.get(rel);
	return { kind: "file", path: rel, label: baseName(rel), lang: file?.lang ?? "other", symbols: file?.symbols ?? 0 };
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Wire form of an indexed symbol; the signature and doc are shortened to keep payloads small. */
export function symbolNode(node: FlowNode): CodemapNode {
	const out: CodemapNode = {
		kind: "symbol",
		path: node.rel,
		label: node.name,
		lang: node.lang,
		symbolKind: node.kind,
		line: node.startLine,
		endLine: node.endLine,
		signature: clip(node.signature, MAX_SIGNATURE_CHARS),
	};
	if (node.doc) out.doc = clip(node.doc, MAX_DOC_CHARS);
	return out;
}

function crumbs(graph: GraphIndex, repo: string, dir: string): CodemapNode[] {
	return ancestorDirs(dir).map(path => dirNode(graph, repo, path));
}

/** Heaviest first; bridges lead among equals, then path order keeps the cut deterministic. */
function heaviest(a: CodemapLink, b: CodemapLink): number {
	if (a.weight !== b.weight) return b.weight - a.weight;
	if (a.bridge !== b.bridge) return a.bridge ? -1 : 1;
	return a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0;
}

function capLinks(links: Map<string, CodemapLink>): { links: CodemapLink[]; more: number } {
	const sorted = [...links.values()].sort(heaviest);
	return { links: sorted.slice(0, MAX_LINKS), more: Math.max(0, sorted.length - MAX_LINKS) };
}

/** Where an edge touching the focus leads on the far side: the node it is shown as. */
interface Touch {
	upstream: boolean;
	kind: "dir" | "file";
	path: string;
}

type LinkSets = Pick<CodemapView, "upstream" | "downstream" | "moreUpstream" | "moreDownstream">;

/** Aggregate the edges touching the focus into capped links per side, one per (far node, label). */
function collectLinks(graph: GraphIndex, repo: string, touch: (edge: GraphEdge) => Touch | null): LinkSets {
	const up = new Map<string, CodemapLink>();
	const down = new Map<string, CodemapLink>();
	for (const edge of graph.edges) {
		const hit = touch(edge);
		if (!hit) continue;
		const side = hit.upstream ? up : down;
		const label = hit.upstream ? (INVERSE_LABEL[edge.label] ?? edge.label) : edge.label;
		const key = `${hit.kind}\0${hit.path}\0${label}`;
		const link = side.get(key);
		if (link) {
			link.weight += edge.weight;
			link.bridge ||= edge.bridge;
		} else {
			const node = hit.kind === "dir" ? dirNode(graph, repo, hit.path) : fileNode(graph, hit.path);
			side.set(key, { node, label, weight: edge.weight, bridge: edge.bridge });
		}
	}
	const upstream = capLinks(up);
	const downstream = capLinks(down);
	return {
		upstream: upstream.links,
		downstream: downstream.links,
		moreUpstream: upstream.more,
		moreDownstream: downstream.more,
	};
}

/**
 * How an outside file `other` shows up in the links of folder `dir`: the child of the deepest folder
 * they share that lies on `other`'s side. A file directly in that folder stays a file.
 */
function rollup(dir: string, other: string): { kind: "dir" | "file"; path: string } {
	const mine = dir === "" ? [] : dir.split("/");
	const theirs = other.split("/");
	let shared = 0;
	// The last segment of `theirs` is the file itself, never a shared folder.
	while (shared < mine.length && shared < theirs.length - 1 && mine[shared] === theirs[shared]) shared++;
	if (theirs.length - shared === 1) return { kind: "file", path: other };
	return { kind: "dir", path: theirs.slice(0, shared + 1).join("/") };
}

/** Child of `dir` that `rel` (inside it) belongs to, as a path. */
function childOf(dir: string, rel: string): string {
	const rest = dir === "" ? rel : rel.slice(dir.length + 1);
	const slash = rest.indexOf("/");
	const name = slash < 0 ? rest : rest.slice(0, slash);
	return dir === "" ? name : `${dir}/${name}`;
}

function dirMap(graph: GraphIndex, repo: string, dir: string, children: CodemapNode[]): CodemapMap {
	const slot = new Map(children.map((child, index) => [child.path, index]));
	const pairs = new Map<number, CodemapEdge>();
	for (const edge of graph.edges) {
		if (!contains(dir, edge.from) || !contains(dir, edge.to)) continue;
		const from = slot.get(childOf(dir, edge.from));
		const to = slot.get(childOf(dir, edge.to));
		if (from === undefined || to === undefined || from === to) continue;
		const key = from * children.length + to;
		const found = pairs.get(key);
		if (found) {
			found.weight += edge.weight;
			found.bridge ||= edge.bridge;
		} else {
			pairs.set(key, { from, to, weight: edge.weight, bridge: edge.bridge });
		}
	}
	const edges = [...pairs.values()];
	let kept = children.map((_, index) => index);
	if (children.length > MAX_MAP_NODES) {
		const degree = Array.from({ length: children.length }, () => 0);
		for (const edge of edges) {
			degree[edge.from] += edge.weight;
			degree[edge.to] += edge.weight;
		}
		// Array.sort is stable: equally connected children keep folders-first name order.
		kept = kept
			.sort((a, b) => degree[b] - degree[a])
			.slice(0, MAX_MAP_NODES)
			.sort((a, b) => a - b);
	}
	const renumber = new Map(kept.map((old, index) => [old, index]));
	const mapEdges: CodemapEdge[] = [];
	for (const edge of edges) {
		const from = renumber.get(edge.from);
		const to = renumber.get(edge.to);
		if (from !== undefined && to !== undefined) mapEdges.push({ ...edge, from, to });
	}
	mapEdges.sort((a, b) => b.weight - a.weight || a.from - b.from || a.to - b.to);
	return {
		nodes: kept.map(index => children[index]),
		edges: mapEdges.slice(0, MAX_MAP_EDGES),
		omitted: children.length - kept.length,
	};
}

function indexTotals(graph: GraphIndex, refreshMs: number): CodemapView["index"] {
	return { files: graph.files.length, symbols: graph.symbols, refreshMs };
}

/** A folder: its dependency links (rolled up, none for the root), contents, and the map among them. */
export function dirView(graph: GraphIndex, repo: string, dir: string, refreshMs: number): CodemapView {
	const info = graph.dirs.get(dir);
	if (!info) throw new Error("folder not found in the code map; it may have moved");
	const links: LinkSets =
		dir === ""
			? { upstream: [], downstream: [], moreUpstream: 0, moreDownstream: 0 }
			: collectLinks(graph, repo, edge => {
					const from = contains(dir, edge.from);
					if (from === contains(dir, edge.to)) return null;
					const other = rollup(dir, from ? edge.to : edge.from);
					return { upstream: !from, ...other };
				});
	const children = [
		...info.subdirs.map(path => dirNode(graph, repo, path)),
		...info.direct.map(rel => fileNode(graph, rel)),
	];
	return {
		repo,
		focus: dirNode(graph, repo, dir),
		crumbs: dir === "" ? [] : crumbs(graph, repo, parentOf(dir)),
		...links,
		children,
		map: dirMap(graph, repo, dir, children),
		index: indexTotals(graph, refreshMs),
	};
}

/** A source file: the exact files it depends on and that depend on it, and its symbols. */
export function fileView(
	graph: GraphIndex,
	repo: string,
	rel: string,
	source: Pick<CodemapSource, "fileSymbols">,
	refreshMs: number,
): CodemapView {
	if (!graph.byRel.has(rel)) throw new Error("file not found in the code map (tests and fixtures are left out)");
	const links = collectLinks(graph, repo, edge => {
		if (edge.from === edge.to) return null;
		if (edge.from === rel) return { upstream: false, kind: "file", path: edge.to };
		if (edge.to === rel) return { upstream: true, kind: "file", path: edge.from };
		return null;
	});
	return {
		repo,
		focus: fileNode(graph, rel),
		crumbs: crumbs(graph, repo, parentOf(rel)),
		...links,
		children: source.fileSymbols(rel, MAX_FILE_SYMBOLS).map(symbolNode),
		index: indexTotals(graph, refreshMs),
	};
}

/**
 * The symbol a focus names: the definition at its line with that name, else with that name, else at that
 * line, else the first definition of the name anywhere (the file may have been edited since).
 */
export function resolveSymbol(
	source: Pick<CodemapSource, "flowOverlapping" | "flowDefinitions">,
	focus: Extract<CodemapFocus, { kind: "symbol" }>,
): FlowNode {
	const here = source.flowOverlapping(focus.path, focus.line, focus.line, 20);
	const found =
		here.find(node => node.name === focus.name && node.startLine === focus.line) ??
		here.find(node => node.name === focus.name) ??
		here.find(node => node.startLine === focus.line) ??
		source.flowDefinitions(focus.name)[0];
	if (!found) throw new Error("symbol not found; it may have moved, search for it");
	return found;
}

/**
 * Walk breadth-first from `focus` along edges of one direction. Each symbol follows at most six edges
 * (bridges and handlers first, then at most three plain calls) to symbols not yet reached, up to five hops
 * and 40 steps. The focus is step 0.
 */
export function flowWalk(
	neighbors: (node: FlowNode) => FlowEdge[],
	focus: FlowNode,
	direction: CodemapFlowDirection,
): CodemapFlowStep[] {
	const labels = direction === "down" ? DOWNSTREAM_FLOW : UPSTREAM_FLOW;
	const steps: CodemapFlowStep[] = [{ node: symbolNode(focus), hop: 0, from: null, label: null, bridge: false }];
	const nodes = [focus];
	const seen = new Set([focus.id]);
	for (let at = 0; at < steps.length && steps[at].hop < MAX_FLOW_HOPS; at++) {
		let picked = 0;
		let calls = 0;
		// Stable sort: edges of one rank keep the index's order.
		const edges = neighbors(nodes[at])
			.filter(edge => labels[edge.label] === true)
			.sort((a, b) => a.rank - b.rank);
		for (const edge of edges) {
			if (picked === MAX_FLOW_EDGES) break;
			if (seen.has(edge.to.id)) continue;
			if (edge.rank >= 2) {
				if (calls === MAX_FLOW_CALLS) continue;
				calls++;
			}
			picked++;
			seen.add(edge.to.id);
			nodes.push(edge.to);
			steps.push({
				node: symbolNode(edge.to),
				hop: steps[at].hop + 1,
				from: at,
				label: edge.label,
				bridge: edge.rank === 0,
			});
			if (steps.length === MAX_FLOW_STEPS) return steps;
		}
	}
	return steps;
}

function symbolLinks(neighbors: FlowEdge[]): LinkSets {
	const up = new Map<string, CodemapLink>();
	const down = new Map<string, CodemapLink>();
	// Stable sort: bridges first, then handlers, then plain calls, each in the index's order.
	for (const edge of [...neighbors].sort((a, b) => a.rank - b.rank)) {
		const side = UPSTREAM_FLOW[edge.label] === true ? up : DOWNSTREAM_FLOW[edge.label] === true ? down : null;
		if (!side) continue;
		const key = `${edge.to.id}\0${edge.label}`;
		if (!side.has(key)) {
			side.set(key, { node: symbolNode(edge.to), label: edge.label, weight: 1, bridge: edge.rank === 0 });
		}
	}
	return {
		upstream: [...up.values()].slice(0, MAX_LINKS),
		downstream: [...down.values()].slice(0, MAX_LINKS),
		moreUpstream: Math.max(0, up.size - MAX_LINKS),
		moreDownstream: Math.max(0, down.size - MAX_LINKS),
	};
}

/** A symbol: callers, callees and cross-language links, its members, and with `flow` a walk from it. */
export function symbolView(
	graph: GraphIndex,
	repo: string,
	focus: Extract<CodemapFocus, { kind: "symbol" }>,
	source: Pick<CodemapSource, "flowOverlapping" | "flowDefinitions" | "flowNeighbors" | "symbolMembers">,
	flow: CodemapFlowDirection | undefined,
	refreshMs: number,
): CodemapView {
	const node = resolveSymbol(source, focus);
	const view: CodemapView = {
		repo,
		focus: symbolNode(node),
		crumbs: crumbs(graph, repo, parentOf(node.rel)),
		...symbolLinks(source.flowNeighbors(node)),
		children: source.symbolMembers(node, MAX_MEMBERS).map(symbolNode),
		index: indexTotals(graph, refreshMs),
	};
	if (flow) view.flow = flowWalk(next => source.flowNeighbors(next), node, flow);
	return view;
}

/** Files whose path contains `q` (shorter paths first), then symbols matching its words. */
export function searchHits(graph: GraphIndex, source: Pick<CodemapSource, "flowSearch">, q: string): CodemapNode[] {
	const needle = q.toLowerCase();
	const files = graph.files
		.filter(file => file.rel.toLowerCase().includes(needle))
		.sort((a, b) => a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
		.slice(0, MAX_SEARCH_FILES);
	return [
		...files.map(file => fileNode(graph, file.rel)),
		...source.flowSearch(q, MAX_SEARCH_SYMBOLS).map(symbolNode),
	];
}

function checkPath(value: unknown, allowRoot: boolean): string {
	if (typeof value !== "string" || value.length > MAX_PATH_CHARS || value.includes("\0")) {
		throw new Error("invalid path");
	}
	if (value === "" ? !allowRoot : value.startsWith("/") || value.split("/").includes("..")) {
		throw new Error("invalid path");
	}
	return value;
}

/** Validate a device-supplied focus: a repository-relative path (`""` only for folders), a sane symbol and line. */
export function checkFocus(value: unknown): CodemapFocus {
	if (typeof value !== "object" || value === null) throw new Error("invalid focus");
	const focus = value as Record<string, unknown>;
	switch (focus.kind) {
		case "dir":
			return { kind: "dir", path: checkPath(focus.path, true) };
		case "file":
			return { kind: "file", path: checkPath(focus.path, false) };
		case "symbol": {
			const { name, line } = focus;
			if (typeof name !== "string" || name === "" || name.length > MAX_NAME_CHARS) {
				throw new Error("invalid symbol");
			}
			if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new Error("invalid symbol");
			return { kind: "symbol", path: checkPath(focus.path, false), name, line };
		}
		default:
			throw new Error("invalid focus");
	}
}

/** Validate a device-supplied flow direction; absent means no walk. */
export function checkFlow(value: unknown): CodemapFlowDirection | undefined {
	if (value === undefined || value === "down" || value === "up") return value;
	throw new Error("invalid flow direction");
}

/** Validate a device-supplied search text. */
export function checkSearch(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > MAX_QUERY_CHARS) {
		throw new Error("invalid search");
	}
	return value.trim();
}

interface OpenIndex {
	codemap: Codemap;
	graph: GraphIndex;
	openedAt: number;
}

/** One repository's handle; `tail` serializes the work on it. */
interface RepoEntry {
	tail: Promise<void>;
	open: OpenIndex | null;
	idle: Timer | undefined;
}

const repos = new Map<string, RepoEntry>();
let codemapClass: typeof Codemap | null = null;
let loading: Promise<boolean> | null = null;
let unavailable = "";

/**
 * Load the codemap module once; false when this checkout cannot (reason logged once, kept for the
 * error requests get). Resolves immediately after the first call.
 */
export function loadCodemap(): Promise<boolean> {
	// Dynamic on purpose: the module pulls in the native extractor and a large module graph, and a checkout
	// without them must leave the rest of the companion working.
	loading ??= import("@oh-my-pi/pi-coding-agent/codemap/index").then(
		module => {
			codemapClass = module.Codemap;
			return true;
		},
		(err: unknown) => {
			unavailable = err instanceof Error ? err.message : String(err);
			console.error(`companion: code map unavailable: ${unavailable}`);
			return false;
		},
	);
	return loading;
}

interface RepoContext {
	query: CodemapSource;
	graph: GraphIndex;
	repo: string;
	refreshMs: number;
}

/** Run `work` against the repository containing `cwd`, refreshing its index unless opened moments ago. */
async function withRepo<T>(cwd: string, work: (context: RepoContext) => T): Promise<T> {
	if (!(await loadCodemap()) || codemapClass === null) {
		throw new Error(`code map unavailable on this computer: ${unavailable}`);
	}
	const root = (await repoRoot(cwd)) ?? (await fs.realpath(cwd));
	let entry = repos.get(root);
	if (!entry) {
		entry = { tail: Promise.resolve(), open: null, idle: undefined };
		repos.set(root, entry);
	}
	const mine = entry;
	const run = mine.tail.then(async () => {
		let refreshMs = 0;
		let open = mine.open;
		if (!open || Date.now() - open.openedAt >= FRESH_MS) {
			const previous = open;
			const codemap = await codemapClass!.open(root, { cwd: root });
			try {
				refreshMs = codemap.stats.ms;
				// A refresh that changed no file leaves the graph as it was.
				const same = previous !== null && codemap.stats.reparsed === 0 && codemap.stats.removed === 0;
				const graph = same
					? previous.graph
					: buildGraphIndex(codemap.query.graphFiles(), codemap.query.graphEdges());
				open = { codemap, graph, openedAt: Date.now() };
			} catch (err) {
				codemap.close();
				throw err;
			}
			previous?.codemap.close();
			mine.open = open;
		}
		clearTimeout(mine.idle);
		mine.idle = setTimeout(() => {
			mine.tail = mine.tail.then(() => {
				mine.open?.codemap.close();
				mine.open = null;
			});
		}, IDLE_MS);
		mine.idle.unref();
		return work({ query: open.codemap.query, graph: open.graph, repo: baseName(root), refreshMs });
	});
	mine.tail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** The code map view of the repository containing `cwd` around `focus`; `flow` adds a walk for symbol foci. */
export function codemapView(cwd: string, focus: CodemapFocus, flow?: CodemapFlowDirection): Promise<CodemapView> {
	return withRepo(cwd, ({ query, graph, repo, refreshMs }) => {
		switch (focus.kind) {
			case "dir":
				return dirView(graph, repo, focus.path, refreshMs);
			case "file":
				return fileView(graph, repo, focus.path, query, refreshMs);
			case "symbol":
				return symbolView(graph, repo, focus, query, flow, refreshMs);
		}
	});
}

/** Files whose path matches `q`, then symbols matching its words, in the repository containing `cwd`. */
export function codemapSearch(cwd: string, q: string): Promise<CodemapNode[]> {
	return withRepo(cwd, ({ query, graph }) => searchHits(graph, query, q));
}
