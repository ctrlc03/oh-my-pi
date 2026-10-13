/**
 * Checks an architecture map before it is stored (see ./companion-blueprint): the agent's JSON is parsed into the
 * wire shape with unknown fields stripped, every citation is checked against the commit it names, and links
 * between diagrams are repaired. Pure over a file reader, so the rules are testable without git.
 *
 * A citation `path@line@token` holds when `token` is on that line of `path` at the commit. When it is not, but the
 * token occurs on exactly one line of the file, the citation moves there; otherwise it is dropped with a warning.
 * An edge left without a citation is dropped, so a stored map never cites code that is not there.
 */

import {
	type Blueprint,
	type BlueprintChange,
	type BlueprintDiagram,
	type BlueprintEdge,
	type BlueprintNode,
	type BlueprintRef,
	MAX_BLUEPRINT_DIAGRAMS,
} from "@oh-my-pi/pi-wire/blueprint";
import { isRecord } from "../src/tool-render/util";

/** Prefix of every diagram generated from the code index; the agent may not use it for its own. */
export const INDEX_DIAGRAM_PREFIX = "index:";
/** The diagram showing every package and folder, linked from the root so nothing generated is unreachable. */
export const INDEX_REPO_DIAGRAM = "index:repo";

const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_SUMMARY_CHARS = 600;
const MAX_KIND_CHARS = 40;
const MAX_TOKEN_CHARS = 200;
const MAX_PATH_CHARS = 1024;
const MAX_REFS_PER_ITEM = 6;
const MAX_NODES_PER_DIAGRAM = 80;
const MAX_EDGES_PER_DIAGRAM = 200;
/** A citation whose line is wrong moves to the one place its token appears within this many lines of it. */
const NEAR_LINES = 20;
/** Warnings of one kind listed before the rest are only counted. */
const WARNINGS_PER_KIND = 12;

export type Side = "head" | "base";

/** How verification reads the repository at the map's commits. */
export interface VerifyIo {
	/** Lines of a file at the head or base commit; null when it is missing, binary or too large. */
	lines(side: Side, path: string): Promise<string[] | null>;
	/** A file or folder exists at the commit. */
	hasPath(side: Side, path: string): boolean;
	/** The index diagram that shows a folder or file path, so an agent node can link to it by path. */
	diagramForPath?(path: string): string | undefined;
}

export interface VerifyStats {
	refsVerified: number;
	refsMoved: number;
	refsDropped: number;
	edgesDropped: number;
	nodesUnlinked: number;
	diagramsDropped: number;
}

/** Collects warnings in plain words, listing a few per kind and counting the rest. */
class Warnings {
	readonly #kinds = new Map<string, { shown: string[]; more: number; summary: (more: number) => string }>();

	add(kind: string, message: string, summary: (more: number) => string): void {
		let entry = this.#kinds.get(kind);
		if (!entry) {
			entry = { shown: [], more: 0, summary };
			this.#kinds.set(kind, entry);
		}
		if (entry.shown.length < WARNINGS_PER_KIND) entry.shown.push(message);
		else entry.more++;
	}

	list(): string[] {
		return [...this.#kinds.values()].flatMap(entry => [
			...entry.shown,
			...(entry.more > 0 ? [entry.summary(entry.more)] : []),
		]);
	}
}

// ── parsing what the agent wrote ─────────────────────────────────────────────

function str(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A repository-relative path with "/" separators; undefined for an absolute path, one that leaves the repository, or the root itself. */
export function normalizeRepoPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_PATH_CHARS || value.includes("\0")) return undefined;
	const segments: string[] = [];
	for (const segment of value.replaceAll("\\", "/").split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return undefined;
		segments.push(segment);
	}
	if (value.startsWith("/") || segments.length === 0) return undefined;
	return segments.join("/");
}

/**
 * `path@line@token`, or `base:path@line@token` for the base commit of a diff map: the path ends at the first
 * `@<digits>@`; the token is the rest (it may contain `@`, as a decorator does).
 */
export function parseRefText(text: string): BlueprintRef | undefined {
	const trimmed = text.trim();
	const side = trimmed.startsWith("base:") ? "base" : undefined;
	const match = /^(.+?)@(\d+)@(.+)$/s.exec(side ? trimmed.slice("base:".length) : trimmed);
	if (!match) return undefined;
	const path = normalizeRepoPath(match[1]);
	const token = match[3]!.trim();
	const line = Number(match[2]);
	if (path === undefined || token === "" || token.length > MAX_TOKEN_CHARS || !Number.isSafeInteger(line) || line < 1)
		return undefined;
	return { path, line, token, ...(side ? { side } : {}) };
}

function parseRef(value: unknown): BlueprintRef | undefined {
	if (typeof value === "string") return parseRefText(value);
	if (!isRecord(value)) return undefined;
	const path = normalizeRepoPath(value.path);
	const token = typeof value.token === "string" ? value.token.trim() : "";
	const line = typeof value.line === "number" ? value.line : Number(value.line);
	if (path === undefined || token === "" || token.length > MAX_TOKEN_CHARS || token.includes("\n")) return undefined;
	if (!Number.isSafeInteger(line) || line < 1) return undefined;
	return { path, line, token, ...(value.side === "base" ? { side: "base" as const } : {}) };
}

function parseRefs(value: unknown): BlueprintRef[] {
	if (!Array.isArray(value)) return [];
	const refs: BlueprintRef[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		const ref = parseRef(raw);
		if (!ref) continue;
		const key = `${ref.side ?? "head"}\0${ref.path}\0${ref.line}\0${ref.token}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push(ref);
		if (refs.length >= MAX_REFS_PER_ITEM) break;
	}
	return refs;
}

function parseChange(value: unknown): BlueprintChange | undefined {
	return value === "added" || value === "modified" || value === "removed" ? value : undefined;
}

export interface AgentOutput {
	root: string | undefined;
	diagrams: Record<string, BlueprintDiagram>;
}

/**
 * The diagrams in the agent's JSON, in the wire shape: unknown fields stripped, strings and lists capped,
 * `origin` forced to "agent". Accepts `diagrams` as a list or as an object keyed by id, and a citation as an
 * object or as `path@line@token`. Problems that lose content are reported in the warnings.
 */
export function parseAgentOutput(raw: unknown, warnings: string[]): AgentOutput {
	if (!isRecord(raw)) throw new Error("The agent's file is not a JSON object.");
	const rawDiagrams: [string | undefined, unknown][] = Array.isArray(raw.diagrams)
		? raw.diagrams.map(value => [undefined, value])
		: isRecord(raw.diagrams)
			? Object.entries(raw.diagrams)
			: [];
	if (rawDiagrams.length === 0) throw new Error("The agent's file has no diagrams.");
	const log = new Warnings();
	const diagrams: Record<string, BlueprintDiagram> = {};
	for (const [key, value] of rawDiagrams) {
		if (!isRecord(value)) continue;
		const id = str(value.id ?? key, MAX_ID_CHARS);
		const title = str(value.title, MAX_LABEL_CHARS);
		if (id === undefined || title === undefined) {
			log.add(
				"diagram-shape",
				"Skipped a diagram without an id or title.",
				n => `Skipped ${n} more malformed diagrams.`,
			);
			continue;
		}
		if (id.startsWith(INDEX_DIAGRAM_PREFIX) || Object.hasOwn(diagrams, id)) {
			log.add(
				"diagram-id",
				`Skipped agent diagram "${id}": its id is reserved or repeated.`,
				n => `Skipped ${n} more diagrams with bad ids.`,
			);
			continue;
		}
		const nodes: BlueprintNode[] = [];
		const nodeIds = new Set<string>();
		for (const rawNode of Array.isArray(value.nodes) ? value.nodes : []) {
			if (!isRecord(rawNode)) continue;
			const nodeId = str(rawNode.id, MAX_ID_CHARS);
			const label = str(rawNode.label, MAX_LABEL_CHARS);
			if (nodeId === undefined || label === undefined || nodeIds.has(nodeId)) continue;
			if (nodes.length >= MAX_NODES_PER_DIAGRAM) {
				log.add(
					"nodes-cap",
					`Diagram "${id}" has more than ${MAX_NODES_PER_DIAGRAM} nodes; the rest were cut.`,
					n => `${n} more diagrams were cut to ${MAX_NODES_PER_DIAGRAM} nodes.`,
				);
				break;
			}
			nodeIds.add(nodeId);
			const refs = parseRefs(rawNode.refs);
			nodes.push({
				id: nodeId,
				label,
				kind: str(rawNode.kind, MAX_KIND_CHARS) ?? "component",
				...(str(rawNode.summary, MAX_SUMMARY_CHARS) ? { summary: str(rawNode.summary, MAX_SUMMARY_CHARS) } : {}),
				...(str(rawNode.child, MAX_ID_CHARS) ? { child: str(rawNode.child, MAX_ID_CHARS) } : {}),
				...(typeof rawNode.path === "string" ? { path: rawNode.path } : {}),
				...(refs.length > 0 ? { refs } : {}),
				...(parseChange(rawNode.change) ? { change: parseChange(rawNode.change) } : {}),
			});
		}
		const edges: BlueprintEdge[] = [];
		for (const rawEdge of Array.isArray(value.edges) ? value.edges : []) {
			if (!isRecord(rawEdge)) continue;
			const from = str(rawEdge.from, MAX_ID_CHARS);
			const to = str(rawEdge.to, MAX_ID_CHARS);
			if (from === undefined || to === undefined) continue;
			if (edges.length >= MAX_EDGES_PER_DIAGRAM) {
				log.add(
					"edges-cap",
					`Diagram "${id}" has more than ${MAX_EDGES_PER_DIAGRAM} edges; the rest were cut.`,
					n => `${n} more diagrams were cut to ${MAX_EDGES_PER_DIAGRAM} edges.`,
				);
				break;
			}
			edges.push({
				id: str(rawEdge.id, MAX_ID_CHARS) ?? `${from}->${to}`,
				from,
				to,
				label: str(rawEdge.label, MAX_LABEL_CHARS) ?? "",
				...(str(rawEdge.kind, MAX_KIND_CHARS) ? { kind: str(rawEdge.kind, MAX_KIND_CHARS) } : {}),
				refs: parseRefs(rawEdge.refs),
				...(parseChange(rawEdge.change) ? { change: parseChange(rawEdge.change) } : {}),
			});
		}
		diagrams[id] = {
			id,
			title,
			...(str(value.summary, MAX_SUMMARY_CHARS) ? { summary: str(value.summary, MAX_SUMMARY_CHARS) } : {}),
			origin: "agent",
			nodes,
			edges,
		};
	}
	warnings.push(...log.list());
	const root = str(raw.root, MAX_ID_CHARS);
	return { root: root !== undefined && Object.hasOwn(diagrams, root) ? root : undefined, diagrams };
}

// ── verifying a map ──────────────────────────────────────────────────────────

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await work(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Verify and repair a draft map. Reads each cited file once.
 * @param draft the map with diagrams of both origins; its `warnings` are kept and extended.
 * @returns the cleaned map (a copy) and what was changed.
 * @throws Error when the root is missing or the map has too many diagrams.
 */
export async function verifyBlueprint(
	draft: Blueprint,
	io: VerifyIo,
	options: { readConcurrency?: number } = {},
): Promise<{ map: Blueprint; stats: VerifyStats }> {
	const isDiff = draft.base !== undefined;
	const log = new Warnings();
	const stats: VerifyStats = {
		refsVerified: 0,
		refsMoved: 0,
		refsDropped: 0,
		edgesDropped: 0,
		nodesUnlinked: 0,
		diagramsDropped: 0,
	};
	const diagrams: Record<string, BlueprintDiagram> = {};
	for (const [id, diagram] of Object.entries(draft.diagrams)) {
		diagrams[id] = {
			...diagram,
			id,
			nodes: diagram.nodes.map(node => ({ ...node })),
			edges: diagram.edges.map(edge => ({ ...edge })),
		};
	}
	if (!Object.hasOwn(diagrams, draft.root)) throw new Error("The map has no root diagram.");

	// Read every cited file once, a few at a time.
	const wanted = new Map<string, { side: Side; path: string }>();
	const sideOf = (ref: BlueprintRef, change: BlueprintChange | undefined): Side =>
		ref.side ?? (isDiff && change === "removed" ? "base" : "head");
	for (const diagram of Object.values(diagrams)) {
		for (const item of [...diagram.nodes, ...diagram.edges])
			for (const ref of item.refs ?? []) {
				const side = sideOf(ref, item.change);
				wanted.set(`${side}\0${ref.path}`, { side, path: ref.path });
			}
	}
	const files = new Map<string, string[] | null>();
	await pool([...wanted.entries()], options.readConcurrency ?? 8, async ([key, { side, path }]) => {
		files.set(key, await io.lines(side, path));
	});

	const checkRefs = (where: string, item: BlueprintNode | BlueprintEdge): BlueprintRef[] => {
		const kept: BlueprintRef[] = [];
		const seen = new Set<string>();
		for (const ref of item.refs ?? []) {
			const side = sideOf(ref, item.change);
			const lines = files.get(`${side}\0${ref.path}`);
			const cite = `${ref.path}@${ref.line}@${ref.token}`;
			const dropped = (why: string): void => {
				stats.refsDropped++;
				log.add("ref", `Dropped citation ${cite} (${where}): ${why}.`, n => `${n} more citations were dropped.`);
			};
			if (!lines) {
				dropped("the file is not readable at that commit");
				continue;
			}
			let line = ref.line;
			if (lines[line - 1]?.includes(ref.token)) {
				stats.refsVerified++;
			} else {
				const hits: number[] = [];
				for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(ref.token)) hits.push(i + 1);
				const near = hits.filter(hit => Math.abs(hit - line) <= NEAR_LINES);
				const target = hits.length === 1 ? hits[0] : near.length === 1 ? near[0] : undefined;
				if (target !== undefined) {
					line = target;
					stats.refsMoved++;
				} else {
					dropped(
						hits.length === 0
							? "the token is not in the file"
							: `the token is not on that line and appears on ${hits.length} lines, none clearly the one meant`,
					);
					continue;
				}
			}
			const fixed: BlueprintRef = { path: ref.path, line, token: ref.token, ...(side === "base" ? { side } : {}) };
			const key = `${side}\0${ref.path}\0${line}\0${ref.token}`;
			if (seen.has(key)) continue;
			seen.add(key);
			kept.push(fixed);
		}
		return kept;
	};

	for (const diagram of Object.values(diagrams)) {
		const where = `diagram "${diagram.title}"`;
		for (const node of diagram.nodes) {
			if (!isDiff) delete node.change;
			const refs = checkRefs(`${where}, node "${node.label}"`, node);
			if (refs.length > 0) node.refs = refs;
			else delete node.refs;
			if (node.path !== undefined) {
				const cleaned = normalizeRepoPath(node.path);
				const side: Side = isDiff && node.change === "removed" ? "base" : "head";
				if (cleaned !== undefined && io.hasPath(side, cleaned)) {
					node.path = cleaned;
				} else {
					log.add(
						"path",
						`Dropped the path "${node.path}" of node "${node.label}": it is not in the repository at that commit.`,
						n => `${n} more node paths were dropped.`,
					);
					delete node.path;
				}
			}
		}
		const nodeIds = new Set(diagram.nodes.map(node => node.id));
		const edgeIds = new Set<string>();
		const edges: BlueprintEdge[] = [];
		for (const edge of diagram.edges) {
			if (!isDiff) delete edge.change;
			if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
				stats.edgesDropped++;
				log.add(
					"edge-dangling",
					`Dropped an edge in ${where}: "${edge.from}" → "${edge.to}" names a node that is not there.`,
					n => `${n} more edges were dropped for naming missing nodes.`,
				);
				continue;
			}
			edge.refs = checkRefs(`${where}, edge "${edge.label || `${edge.from} → ${edge.to}`}"`, edge);
			if (edge.refs.length === 0) {
				stats.edgesDropped++;
				log.add(
					"edge-uncited",
					`Dropped edge "${edge.label || `${edge.from} → ${edge.to}`}" in ${where}: no citation survived.`,
					n => `${n} more edges were dropped for lack of a citation.`,
				);
				continue;
			}
			let id = edge.id;
			for (let n = 2; edgeIds.has(id); n++) id = `${edge.id}~${n}`;
			edgeIds.add(id);
			edges.push({ ...edge, id });
		}
		diagram.edges = edges;
	}

	// Links between diagrams: a node's `child` is a diagram id, or the path of a folder or file the index shows.
	for (const diagram of Object.values(diagrams)) {
		for (const node of diagram.nodes) {
			if (node.child === undefined) continue;
			let target: string | undefined = Object.hasOwn(diagrams, node.child) ? node.child : undefined;
			if (target === undefined) {
				const asPath = normalizeRepoPath(node.child);
				const byPath = asPath === undefined ? undefined : io.diagramForPath?.(asPath);
				if (byPath !== undefined && Object.hasOwn(diagrams, byPath)) target = byPath;
			}
			if (target === undefined || target === diagram.id) {
				stats.nodesUnlinked++;
				log.add(
					"child",
					`Unlinked node "${node.label}" in diagram "${diagram.title}": it opens "${node.child}", which does not exist.`,
					n => `${n} more nodes were unlinked.`,
				);
				delete node.child;
			} else {
				node.child = target;
			}
		}
	}

	// Everything generated stays reachable: the root links to the overview of the whole repository.
	const root = diagrams[draft.root]!;
	if (root.origin === "agent" && Object.hasOwn(diagrams, INDEX_REPO_DIAGRAM)) {
		let id = "all-code";
		for (let n = 2; root.nodes.some(node => node.id === id); n++) id = `all-code-${n}`;
		root.nodes.push({
			id,
			label: "All code",
			kind: "module",
			summary: "Every package and folder of the repository, from the code index, with the imports between them.",
			child: INDEX_REPO_DIAGRAM,
		});
	}

	// Parents from the links; an agent diagram nothing opens is dropped, an index one stays only below the root's tree.
	const parents = new Map<string, string>();
	const queue = [draft.root];
	const reached = new Set(queue);
	for (let head = 0; head < queue.length; head++) {
		const diagram = diagrams[queue[head]!]!;
		for (const node of diagram.nodes) {
			if (node.child === undefined || reached.has(node.child)) continue;
			reached.add(node.child);
			parents.set(node.child, diagram.id);
			queue.push(node.child);
		}
	}
	const result: Record<string, BlueprintDiagram> = {};
	for (const id of queue) {
		const { parent: _old, ...diagram } = diagrams[id]!;
		result[id] = parents.has(id) ? { ...diagram, parent: parents.get(id) } : diagram;
	}
	for (const id of Object.keys(diagrams)) {
		if (reached.has(id)) continue;
		stats.diagramsDropped++;
		log.add(
			"unreachable",
			`Dropped diagram "${diagrams[id]!.title}": no other diagram opens it.`,
			n => `${n} more diagrams nothing opens were dropped.`,
		);
	}
	if (Object.keys(result).length > MAX_BLUEPRINT_DIAGRAMS)
		throw new Error(`The map has more than ${MAX_BLUEPRINT_DIAGRAMS} diagrams.`);

	const warnings = [...draft.warnings, ...log.list()];
	if (stats.refsMoved > 0 || stats.refsDropped > 0)
		warnings.push(
			`Citations checked against the commit: ${stats.refsVerified} correct, ${stats.refsMoved} moved to the right line, ${stats.refsDropped} dropped.`,
		);
	return { map: { ...draft, diagrams: result, warnings }, stats };
}
