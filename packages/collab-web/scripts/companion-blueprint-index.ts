/**
 * The lower levels of an architecture map, built from omp's code index with no model: one diagram for the
 * whole repository (its packages and the imports between them), one per package and per folder below it
 * (its modules and files), and for the most connected files one showing their main symbols and the calls
 * between them. Pure over an {@link IndexSource}, so the rules are testable without an index.
 *
 * Every arrow carries the code behind it: for an import, the import line that names the other file; for a call,
 * the line inside the caller that names the callee. Arrows without a findable line are not drawn (and counted
 * in a warning), so what is drawn is what the code says. Ids are derived from paths, so rebuilding the same
 * commit gives the same map.
 *
 * In a diff map the source marks files, imports and symbols `added`, `modified` or `removed`; that rolls up to
 * folder nodes and aggregated arrows, and removed things (which exist only at the base commit) cite base lines.
 */

import * as path from "node:path";
import type {
	BlueprintChange,
	BlueprintDiagram,
	BlueprintEdge,
	BlueprintNode,
	BlueprintRef,
} from "@oh-my-pi/pi-wire/blueprint";
import type { Side } from "./companion-citations";
import { INDEX_REPO_DIAGRAM } from "./companion-blueprint-verify";

export interface IndexFile {
	/** Repository-relative path, "/" separators. */
	rel: string;
	lang: string;
	symbols: number;
	change?: BlueprintChange;
}

/** `from` depends on `to`. */
export interface IndexEdge {
	from: string;
	to: string;
	weight: number;
	/** `references` for an import, else a cross-language bridge (`decodes`, `calls contract`, `proves with`). */
	label: string;
	change?: BlueprintChange;
}

export interface IndexSymbol {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature: string;
	doc?: string;
	change?: BlueprintChange;
	/** `base` for a symbol that exists only at the base commit (removed). */
	side: Side;
}

/** A symbol seen from outside its file: the far end of a call. */
export interface SymbolRef {
	rel: string;
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
}

export interface IndexCall {
	from: SymbolRef;
	to: SymbolRef;
	label: string;
}

/** What the builder reads: the dependency graph, symbols and calls from the index, and file text. */
export interface IndexSource {
	files: IndexFile[];
	edges: IndexEdge[];
	/** Paths of build manifests (`package.json`, `Cargo.toml` …) in the repository; their folders are the packages. */
	manifests: string[];
	/** Lines of a file at the head or, for something removed, base commit; null when unreadable. */
	lines(rel: string, side: Side): Promise<string[] | null>;
	/** Top-level symbols of a file in source order; in a diff map with `change`, and removed ones with `side: "base"`. */
	symbols(rel: string): Promise<IndexSymbol[]>;
	/** Calls to and from the symbols of a file (head side only). */
	calls(rel: string): Promise<IndexCall[]>;
}

export interface IndexOptions {
	repoName: string;
	/** Diagrams the index levels may add up to. */
	maxDiagrams?: number;
	/** Of those, files with their own diagram. */
	maxFileDiagrams?: number;
	/** Nodes of the folder's own children in a diagram; the rest are one "N more" node. */
	maxNodes?: number;
	/** Neighbours outside the folder drawn in a diagram. */
	maxOutside?: number;
	maxEdges?: number;
	/** How many folders below a package get a diagram. */
	maxDepth?: number;
}

/** A package or top-level folder, for the agent's brief and the viewer's overview. */
export interface UnitSummary {
	/** Repository-relative folder; "" for files at the repository root. */
	path: string;
	label: string;
	manifest: boolean;
	files: number;
	symbols: number;
	languages: string[];
	/** Diagram that shows it. */
	diagram: string | undefined;
	/** Best-connected files. */
	topFiles: string[];
}

export interface IndexResult {
	diagrams: Record<string, BlueprintDiagram>;
	root: string;
	/** Folder or file path → the diagram that shows it (a folder inside a collapsed chain maps to the chain's diagram). */
	byPath: Map<string, string>;
	units: UnitSummary[];
	/** Imports between units, strongest first. */
	unitEdges: { from: string; to: string; files: number }[];
	warnings: string[];
}

const MANIFEST_NAMES: Record<string, true> = {
	"package.json": true,
	"Cargo.toml": true,
	"go.mod": true,
	"pyproject.toml": true,
	"setup.py": true,
	"foundry.toml": true,
	"Nargo.toml": true,
	"pom.xml": true,
	"build.gradle": true,
	"build.gradle.kts": true,
	"Package.swift": true,
	"mix.exs": true,
	Gemfile: true,
	"composer.json": true,
	"deno.json": true,
};

/** A build manifest (`package.json`, `Cargo.toml` …) marks its folder as a package. */
export function isManifest(rel: string): boolean {
	return Object.hasOwn(MANIFEST_NAMES, path.posix.basename(rel));
}
const LANGUAGE_NAMES: Record<string, string> = {
	ts: "TypeScript",
	js: "JavaScript",
	rust: "Rust",
	sol: "Solidity",
	noir: "Noir",
	py: "Python",
	go: "Go",
	other: "other languages",
};
/** File names that stand for their folder in an import (`./foo/index`, `crate::foo` for `foo/mod.rs`). */
const FOLDER_FILES: Record<string, true> = { index: true, mod: true, __init__: true, lib: true, main: true };
const IMPORT_WORDS = /\b(?:import|from|require|use|mod|include|extern|export)\b|#include/;

/** Entries listed in a folder's overflow diagram. */
const MAX_OVERFLOW_NODES = 150;

const DEFAULTS = {
	maxDiagrams: 600,
	maxFileDiagrams: 80,
	maxNodes: 24,
	maxOutside: 8,
	maxEdges: 60,
	maxDepth: 5,
	maxSymbols: 24,
	maxExternalSymbols: 10,
	refsPerEdge: 3,
	refAttempts: 10,
};

function languageName(lang: string): string {
	return Object.hasOwn(LANGUAGE_NAMES, lang) ? LANGUAGE_NAMES[lang]! : lang;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `token` as a whole identifier. */
function wordRegex(token: string): RegExp {
	return new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegex(token)}(?![A-Za-z0-9_$])`);
}

/** A line of a file and the token on it; the file is whoever cites it. */
export interface LineRef {
	line: number;
	token: string;
}

/** What an import of `rel` would name: the file's stem, or its folder's name for `index`/`mod`-style files. */
export function importStems(rel: string): string[] {
	const parsed = path.posix.parse(rel);
	const folder = path.posix.basename(parsed.dir);
	if (Object.hasOwn(FOLDER_FILES, parsed.name) && folder !== "") return [folder, parsed.name];
	// A Go import names the package folder, not a file.
	if (parsed.ext === ".go" && folder !== "") return [folder];
	return [parsed.name];
}

/**
 * The line of `from` (as lines of text) that imports `to`: an import-like line naming the target's stem; failing
 * that, the first line using a symbol the target defines. Undefined when neither is there.
 */
export function findImportRef(
	fromLines: readonly string[],
	toRel: string,
	toSymbols: readonly string[],
): LineRef | undefined {
	for (const stem of importStems(toRel)) {
		const word = wordRegex(stem);
		const found = fromLines.findIndex(line => IMPORT_WORDS.test(line) && word.test(line));
		if (found >= 0) return { line: found + 1, token: stem };
	}
	for (const name of toSymbols) {
		if (name.length < 3) continue;
		const word = wordRegex(name);
		const found = fromLines.findIndex(line => word.test(line));
		if (found >= 0) return { line: found + 1, token: name };
	}
	return undefined;
}

/** The line within `[start, end]` of `lines` that mentions `callee`'s bare name, preferring one after the declaration line. */
export function findCallRef(lines: readonly string[], start: number, end: number, callee: string): LineRef | undefined {
	const bare = callee.split(/::|\./).pop() ?? callee;
	if (bare.length === 0) return undefined;
	const word = wordRegex(bare);
	const last = Math.min(end, lines.length, start + 3000);
	for (let line = start + 1; line <= last; line++) if (word.test(lines[line - 1]!)) return { line, token: bare };
	if (start >= 1 && start <= lines.length && word.test(lines[start - 1]!)) return { line: start, token: bare };
	return undefined;
}

// ── folder tree ──────────────────────────────────────────────────────────────

interface Dir {
	/** Repository-relative path. */
	path: string;
	files: IndexFile[];
	dirs: Map<string, Dir>;
	stats?: Stats;
}

interface Stats {
	files: number;
	symbols: number;
	langs: Map<string, number>;
	added: number;
	removed: number;
	modified: number;
}

function newDir(p: string): Dir {
	return { path: p, files: [], dirs: new Map() };
}

function statsOf(dir: Dir): Stats {
	if (dir.stats) return dir.stats;
	const stats: Stats = { files: 0, symbols: 0, langs: new Map(), added: 0, removed: 0, modified: 0 };
	const take = (file: IndexFile): void => {
		stats.files++;
		stats.symbols += file.symbols;
		stats.langs.set(file.lang, (stats.langs.get(file.lang) ?? 0) + 1);
		if (file.change) stats[file.change]++;
	};
	for (const file of dir.files) take(file);
	for (const child of dir.dirs.values()) {
		const sub = statsOf(child);
		stats.files += sub.files;
		stats.symbols += sub.symbols;
		for (const [lang, count] of sub.langs) stats.langs.set(lang, (stats.langs.get(lang) ?? 0) + count);
		stats.added += sub.added;
		stats.removed += sub.removed;
		stats.modified += sub.modified;
	}
	dir.stats = stats;
	return stats;
}

/** How a group of files changed: all added, all removed, or some mix. */
function rollup(counts: {
	total: number;
	added: number;
	removed: number;
	modified: number;
}): BlueprintChange | undefined {
	if (counts.added === 0 && counts.removed === 0 && counts.modified === 0) return undefined;
	if (counts.added === counts.total) return "added";
	if (counts.removed === counts.total) return "removed";
	return "modified";
}

function dirChange(dir: Dir): BlueprintChange | undefined {
	const stats = statsOf(dir);
	return rollup({ total: stats.files, ...stats });
}

function topLanguages(stats: Stats): string[] {
	return [...stats.langs.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 2)
		.map(([lang]) => languageName(lang));
}

function dirSummary(stats: Stats): string {
	const langs = topLanguages(stats);
	return `${plural(stats.files, "file")}, ${plural(stats.symbols, "symbol")}${langs.length > 0 ? `, mostly ${langs.join(" and ")}` : ""}.`;
}

/** The folder a chain of single-child folders without files of their own ends in. */
function effective(dir: Dir): Dir {
	let current = dir;
	while (current.files.length === 0 && current.dirs.size === 1) current = [...current.dirs.values()][0]!;
	return current;
}

/** Folders that are packages: the outermost folder (not the root) holding a manifest above at least one source file. */
function packageRoots(files: readonly IndexFile[], manifests: readonly string[]): Set<string> {
	const candidates = new Set<string>();
	for (const manifest of manifests) {
		const name = path.posix.basename(manifest);
		const dir = path.posix.dirname(manifest);
		if (Object.hasOwn(MANIFEST_NAMES, name) && dir !== ".") candidates.add(dir);
	}
	const roots = new Set<string>();
	for (const file of files) {
		const segments = file.rel.split("/");
		for (let i = 1; i < segments.length; i++) {
			const dir = segments.slice(0, i).join("/");
			if (candidates.has(dir)) {
				roots.add(dir);
				break;
			}
		}
	}
	return roots;
}

function unitOf(rel: string, packages: ReadonlySet<string>): string {
	const segments = rel.split("/");
	for (let i = 1; i < segments.length; i++) {
		const dir = segments.slice(0, i).join("/");
		if (packages.has(dir)) return dir;
	}
	return segments.length > 1 ? segments[0]! : "";
}

interface Unit {
	path: string;
	manifest: boolean;
	root: Dir;
	files: IndexFile[];
}

function buildUnits(files: readonly IndexFile[], manifests: readonly string[]): Unit[] {
	const packages = packageRoots(files, manifests);
	const byUnit = new Map<string, Unit>();
	for (const file of files) {
		const key = unitOf(file.rel, packages);
		let unit = byUnit.get(key);
		if (!unit) {
			unit = { path: key, manifest: packages.has(key), root: newDir(key), files: [] };
			byUnit.set(key, unit);
		}
		unit.files.push(file);
		let dir = unit.root;
		const segments = file.rel.split("/");
		for (let i = key === "" ? 0 : key.split("/").length; i < segments.length - 1; i++) {
			const sub = segments.slice(0, i + 1).join("/");
			let next = dir.dirs.get(sub);
			if (!next) {
				next = newDir(sub);
				dir.dirs.set(sub, next);
			}
			dir = next;
		}
		dir.files.push(file);
	}
	return [...byUnit.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ── building diagrams ────────────────────────────────────────────────────────

/** One node of a diagram before it is turned into a {@link BlueprintNode}. */
interface Entry {
	key: string;
	label: string;
	node: Omit<BlueprintNode, "id">;
	/** Files below it; membership of an edge end. */
	degree: number;
}

interface Group {
	from: string;
	to: string;
	edges: IndexEdge[];
}

class IndexBuilder {
	readonly diagrams: Record<string, BlueprintDiagram> = {};
	readonly byPath = new Map<string, string>();
	readonly #o: typeof DEFAULTS & { repoName: string };
	readonly #source: IndexSource;
	readonly #units: Unit[];
	readonly #fileUnit = new Map<string, Unit>();
	readonly #files = new Map<string, IndexFile>();
	readonly #edgesOf = new Map<string, IndexEdge[]>();
	readonly #degree = new Map<string, number>();
	readonly #lineCache = new Map<string, Promise<string[] | null>>();
	readonly #symbolCache = new Map<string, Promise<string[]>>();
	/** `d:<path>` → the diagram of that (effective) folder; filled as diagrams are created. */
	readonly #dirDiagram = new Map<string, string>();
	/** File nodes drawn in some diagram, candidates for their own diagram. */
	readonly #fileNodes = new Map<string, BlueprintNode[]>();
	#noRef = 0;
	#budget: number;

	constructor(source: IndexSource, options: IndexOptions) {
		this.#source = source;
		this.#o = { ...DEFAULTS, ...stripUndefined(options), repoName: options.repoName };
		this.#budget = this.#o.maxDiagrams;
		this.#units = buildUnits(source.files, source.manifests);
		for (const unit of this.#units) for (const file of unit.files) this.#fileUnit.set(file.rel, unit);
		for (const file of source.files) this.#files.set(file.rel, file);
		for (const edge of source.edges) {
			if (!this.#files.has(edge.from) || !this.#files.has(edge.to) || edge.from === edge.to) continue;
			for (const end of [edge.from, edge.to]) {
				let list = this.#edgesOf.get(end);
				if (!list) {
					list = [];
					this.#edgesOf.set(end, list);
				}
				list.push(edge);
				this.#degree.set(end, (this.#degree.get(end) ?? 0) + edge.weight);
			}
		}
	}

	#lines(rel: string, side: Side): Promise<string[] | null> {
		const key = `${side}\0${rel}`;
		let cached = this.#lineCache.get(key);
		if (!cached) {
			cached = this.#source.lines(rel, side);
			this.#lineCache.set(key, cached);
		}
		return cached;
	}

	/** Names of a file's top-level symbols, for finding uses when no import line names it. */
	#symbolNames(rel: string): Promise<string[]> {
		let cached = this.#symbolCache.get(rel);
		if (!cached) {
			cached = this.#source.symbols(rel).then(symbols => symbols.filter(s => s.side === "head").map(s => s.name));
			this.#symbolCache.set(rel, cached);
		}
		return cached;
	}

	/** Up to a few import citations for the file edges behind one drawn arrow, strongest first. */
	async #importRefs(edges: IndexEdge[]): Promise<BlueprintRef[]> {
		const refs: BlueprintRef[] = [];
		const ranked = [...edges].sort(
			(a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
		);
		for (const edge of ranked.slice(0, this.#o.refAttempts)) {
			const side: Side = edge.change === "removed" ? "base" : "head";
			const lines = await this.#lines(edge.from, side);
			if (!lines) continue;
			const found = findImportRef(lines, edge.to, side === "head" ? await this.#symbolNames(edge.to) : []);
			if (!found) continue;
			refs.push({ ...found, path: edge.from, ...(side === "base" ? { side } : {}) });
			if (refs.length >= this.#o.refsPerEdge) break;
		}
		return refs;
	}

	/** Diagram edges for aggregated file edges; arrows with no citation are skipped. */
	async #drawEdges(groups: Iterable<Group>): Promise<BlueprintEdge[]> {
		const drawn: BlueprintEdge[] = [];
		const weight = (g: Group): number => g.edges.reduce((n, e) => n + e.weight, 0);
		const changed = (g: Group): number => Number(g.edges.some(e => e.change !== undefined));
		// Within the edge budget the changed arrows of a diff map come first.
		const ranked = [...groups].sort(
			(a, b) =>
				changed(b) - changed(a) ||
				weight(b) - weight(a) ||
				a.from.localeCompare(b.from) ||
				a.to.localeCompare(b.to),
		);
		for (const group of ranked) {
			if (drawn.length >= this.#o.maxEdges) break;
			const refs = await this.#importRefs(group.edges);
			if (refs.length === 0) {
				this.#noRef++;
				continue;
			}
			const labels = new Set(group.edges.map(edge => edge.label));
			const bridge = !labels.has("references");
			const only = labels.size === 1 ? [...labels][0]! : undefined;
			const label =
				group.edges.length === 1
					? only === "references"
						? "imports"
						: only!
					: only === "references"
						? `${group.edges.length} imports`
						: only !== undefined
							? `${only} ×${group.edges.length}`
							: `${group.edges.length} dependencies`;
			const change = rollup({
				total: group.edges.length,
				added: group.edges.filter(e => e.change === "added").length,
				removed: group.edges.filter(e => e.change === "removed").length,
				modified: group.edges.filter(e => e.change === "modified").length,
			});
			drawn.push({
				id: `${group.from}>${group.to}`,
				from: group.from,
				to: group.to,
				label,
				kind: bridge ? "call" : "import",
				refs,
				...(change ? { change } : {}),
			});
		}
		return drawn;
	}

	#add(diagram: BlueprintDiagram): void {
		this.diagrams[diagram.id] = diagram;
		this.#budget--;
	}

	/** Node and edge pieces of one folder's diagram. */
	async #folderDiagram(
		unit: Unit,
		dir: Dir,
		depth: number,
	): Promise<{ diagram: BlueprintDiagram; children: Dir[]; overflow?: BlueprintDiagram }> {
		const inside = new Map<string, Entry>();
		const owner = new Map<string, string>();
		const children: Dir[] = [];
		const prefix = dir.path === "" ? "" : `${dir.path}/`;
		const relativeLabel = (p: string): string => p.slice(prefix.length);
		for (const sub of [...dir.dirs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
			const eff = effective(sub);
			const key = `d:${eff.path}`;
			const stats = statsOf(eff);
			const deeper = depth < this.#o.maxDepth;
			const entry: Entry = {
				key,
				label: relativeLabel(eff.path),
				degree: 0,
				node: {
					label: relativeLabel(eff.path),
					kind: "module",
					summary: dirSummary(stats),
					path: eff.path,
					...(dirChange(eff) ? { change: dirChange(eff) } : {}),
				},
			};
			inside.set(key, entry);
			if (deeper && (eff.dirs.size > 0 || eff.files.length > 1)) children.push(eff);
			for (const file of this.#collect(eff)) owner.set(file.rel, key);
			// Folders inside a collapsed chain are shown by the chain's diagram.
			if (sub !== eff)
				for (let d: Dir = sub; d !== eff; d = [...d.dirs.values()][0]!)
					this.byPath.set(d.path, `index:dir:${eff.path}`);
		}
		for (const file of [...dir.files].sort((a, b) => a.rel.localeCompare(b.rel))) {
			const key = `f:${file.rel}`;
			inside.set(key, {
				key,
				label: path.posix.basename(file.rel),
				degree: 0,
				node: {
					label: path.posix.basename(file.rel),
					kind: "file",
					summary: `${languageName(file.lang)}, ${plural(file.symbols, "symbol")}.`,
					path: file.rel,
					...(file.change ? { change: file.change } : {}),
				},
			});
			owner.set(file.rel, key);
		}

		// Arrows between entries, and to what lies outside the folder.
		const groups = new Map<string, Group>();
		const outsideNodes = new Map<string, Entry>();
		const seenEdges = new Set<IndexEdge>();
		const outsideKey = (rel: string): string | undefined => {
			const target = this.#fileUnit.get(rel);
			const file = this.#files.get(rel);
			if (!target || !file) return undefined;
			let key: string;
			if (target !== unit) {
				key = `o:${target.path}`;
				const shownRoot = effective(target.root);
				if (!outsideNodes.has(key))
					outsideNodes.set(key, {
						key,
						label: target.path === "" ? `${this.#o.repoName} root files` : target.path,
						degree: 0,
						node: {
							label: target.path === "" ? "(root files)" : target.path,
							kind: "package",
							summary: `${dirSummary(statsOf(target.root))} Outside this folder.`,
							...(target.path !== "" ? { path: shownRoot.path } : {}),
							...(dirChange(target.root) ? { change: dirChange(target.root) } : {}),
						},
					});
				return key;
			}
			// Same unit: the first folder (or file) below the closest common ancestor.
			const segments = rel.split("/");
			const own = dir.path === "" ? [] : dir.path.split("/");
			let common = 0;
			while (common < own.length && common < segments.length - 1 && own[common] === segments[common]) common++;
			const shown = segments.slice(0, common + 1).join("/");
			const isFile = common + 1 === segments.length;
			key = `${isFile ? "of" : "od"}:${shown}`;
			if (!outsideNodes.has(key)) {
				if (isFile) {
					outsideNodes.set(key, {
						key,
						label: shown,
						degree: 0,
						node: {
							label: path.posix.basename(shown),
							kind: "file",
							summary: `${languageName(file.lang)}, ${plural(file.symbols, "symbol")}. Outside this folder.`,
							path: shown,
							...(file.change ? { change: file.change } : {}),
						},
					});
				} else {
					const found = this.#findDir(unit.root, shown);
					const eff = found ? effective(found) : undefined;
					outsideNodes.set(key, {
						key,
						label: shown,
						degree: 0,
						node: {
							label: shown.slice(unit.path === "" ? 0 : unit.path.length + 1),
							kind: "module",
							summary: `${eff ? dirSummary(statsOf(eff)) : ""} Outside this folder.`.trim(),
							path: eff?.path ?? shown,
							...(eff && dirChange(eff) ? { change: dirChange(eff) } : {}),
						},
					});
				}
			}
			return key;
		};
		const group = (from: string, to: string, edge: IndexEdge): void => {
			const key = `${from}\0${to}`;
			let g = groups.get(key);
			if (!g) {
				g = { from, to, edges: [] };
				groups.set(key, g);
			}
			g.edges.push(edge);
		};
		for (const rel of owner.keys()) {
			for (const edge of this.#edgesOf.get(rel) ?? []) {
				if (seenEdges.has(edge)) continue;
				seenEdges.add(edge);
				const fromKey = owner.get(edge.from) ?? outsideKey(edge.from);
				const toKey = owner.get(edge.to) ?? outsideKey(edge.to);
				if (fromKey === undefined || toKey === undefined || fromKey === toKey) continue;
				group(fromKey, toKey, edge);
				if (owner.has(edge.from)) inside.get(fromKey)!.degree += edge.weight;
				if (owner.has(edge.to)) inside.get(toKey)!.degree += edge.weight;
			}
		}

		// The best-connected children are drawn, changed ones first in a diff map; the rest are one node.
		const ordered = [...inside.values()].sort(
			(a, b) =>
				Number(b.node.change !== undefined) - Number(a.node.change !== undefined) ||
				b.degree - a.degree ||
				a.key.localeCompare(b.key),
		);
		const kept = new Set(ordered.slice(0, this.#o.maxNodes).map(entry => entry.key));
		const hidden = ordered.slice(this.#o.maxNodes);
		const moreKey = "more";
		const regroup = (key: string): string => (inside.has(key) && !kept.has(key) ? moreKey : key);
		const merged = new Map<string, Group>();
		for (const g of groups.values()) {
			const from = regroup(g.from);
			const to = regroup(g.to);
			if (from === to) continue;
			const key = `${from}\0${to}`;
			const existing = merged.get(key);
			if (existing) existing.edges.push(...g.edges);
			else merged.set(key, { from, to, edges: [...g.edges] });
		}
		// Only the strongest outside neighbours stay.
		const outsideWeight = new Map<string, number>();
		for (const g of merged.values())
			for (const end of [g.from, g.to])
				if (outsideNodes.has(end))
					outsideWeight.set(end, (outsideWeight.get(end) ?? 0) + g.edges.reduce((n, e) => n + e.weight, 0));
		const outsideKept = new Set(
			[...outsideWeight.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, this.#o.maxOutside)
				.map(([key]) => key),
		);
		const finalGroups = [...merged.values()].filter(
			g =>
				(!outsideNodes.has(g.from) || outsideKept.has(g.from)) &&
				(!outsideNodes.has(g.to) || outsideKept.has(g.to)),
		);
		const edges = await this.#drawEdges(finalGroups);

		const dirId = dir.path === "" ? "." : dir.path;
		const title =
			dir.path === ""
				? `${this.#o.repoName} root files`
				: depth === 0
					? unit.path
					: relativeUnitPath(unit.path, dir.path);
		const stats = statsOf(dir);
		// The entries the folder's diagram has no room for get a diagram of their own, so they stay reachable.
		let overflow: BlueprintDiagram | undefined;
		if (hidden.length > 0) {
			const listed = hidden.slice(0, MAX_OVERFLOW_NODES);
			const listedKeys = new Set(listed.map(entry => entry.key));
			const weight = (g: Group): number => g.edges.reduce((n, e) => n + e.weight, 0);
			const inner = [...groups.values()]
				.filter(g => listedKeys.has(g.from) && listedKeys.has(g.to))
				.sort((a, b) => weight(b) - weight(a))
				.slice(0, this.#o.maxEdges);
			const innerEdges = await this.#drawEdges(inner);
			overflow = {
				id: `index:more:${dirId}`,
				title: `${title} · ${hidden.length} more`,
				summary: `The ${hidden.length} less connected folders and files of ${dir.path === "" ? "the repository root" : dir.path}${hidden.length > listed.length ? `; the ${listed.length} best connected are listed` : ""}.`,
				origin: "index",
				nodes: listed.map(entry => ({ id: entry.key, ...entry.node })),
				edges: innerEdges,
			};
		}

		const nodes: BlueprintNode[] = [];
		for (const entry of ordered.slice(0, this.#o.maxNodes)) nodes.push({ id: entry.key, ...entry.node });
		if (hidden.length > 0) {
			const hiddenFiles = hidden.reduce(
				(n, e) => n + (e.key.startsWith("f:") ? 1 : this.#countFiles(e.node.path)),
				0,
			);
			nodes.push({
				id: moreKey,
				label: `${hidden.length} more`,
				kind: "module",
				summary: `${hidden.length} more folders and files (${plural(hiddenFiles, "file")}): ${hidden
					.slice(0, 6)
					.map(e => e.label)
					.join(", ")}${hidden.length > 6 ? ", …" : ""}.`,
				child: `index:more:${dirId}`,
			});
		}
		for (const key of [...outsideKept].sort()) nodes.push({ id: key, ...outsideNodes.get(key)!.node });
		const usedNodes = new Set(nodes.map(node => node.id));
		const usable = edges.filter(edge => usedNodes.has(edge.from) && usedNodes.has(edge.to));
		for (const node of [...nodes, ...(overflow?.nodes ?? [])])
			if (node.kind === "file" && node.path !== undefined && node.id.startsWith("f:")) this.#rememberFileNode(node);
		return {
			diagram: {
				id: `index:dir:${dirId}`,
				title,
				summary: dirSummary(stats),
				origin: "index",
				nodes,
				edges: usable,
			},
			children,
			overflow,
		};
	}

	#rememberFileNode(node: BlueprintNode): void {
		const list = this.#fileNodes.get(node.path!) ?? [];
		list.push(node);
		this.#fileNodes.set(node.path!, list);
	}

	#collect(dir: Dir): IndexFile[] {
		const out = [...dir.files];
		for (const child of dir.dirs.values()) out.push(...this.#collect(child));
		return out;
	}

	#countFiles(p: string | undefined): number {
		if (p === undefined) return 0;
		for (const unit of this.#units) {
			const dir = this.#findDir(unit.root, p);
			if (dir) return statsOf(dir).files;
		}
		return 0;
	}

	#findDir(root: Dir, p: string): Dir | undefined {
		if (root.path === p) return root;
		if (!p.startsWith(root.path === "" ? "" : `${root.path}/`)) return undefined;
		for (const child of root.dirs.values()) {
			const found = this.#findDir(child, p);
			if (found) return found;
		}
		return undefined;
	}

	async #fileDiagram(rel: string): Promise<BlueprintDiagram | undefined> {
		const symbols = await this.#source.symbols(rel);
		if (symbols.length < 2) return undefined;
		const file = this.#files.get(rel)!;
		const lines = await this.#lines(rel, "head");
		const sizeOf = (s: IndexSymbol): number => s.endLine - s.startLine;
		const shown = [...symbols]
			.sort((a, b) => (b.change ? 1 : 0) - (a.change ? 1 : 0) || sizeOf(b) - sizeOf(a) || a.startLine - b.startLine)
			.slice(0, this.#o.maxSymbols)
			.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
		const ids = new Map<string, string>();
		const nodes: BlueprintNode[] = [];
		const refsOf = async (s: IndexSymbol): Promise<BlueprintRef[]> => {
			const sourceLines = await this.#lines(rel, s.side);
			if (!sourceLines) return [];
			const bare = s.name.split(/::|\./).pop() ?? s.name;
			for (let line = s.startLine; line <= Math.min(s.endLine, sourceLines.length, s.startLine + 20); line++)
				if (sourceLines[line - 1]!.includes(bare))
					return [{ path: rel, line, token: bare, ...(s.side === "base" ? { side: "base" as const } : {}) }];
			return [];
		};
		for (const symbol of shown) {
			const id = `s:${symbol.name}@${symbol.startLine}${symbol.side === "base" ? ":base" : ""}`;
			ids.set(`${symbol.name}@${symbol.startLine}`, id);
			const refs = await refsOf(symbol);
			nodes.push({
				id,
				label: symbol.name,
				kind: "symbol",
				summary: symbol.doc ?? (symbol.signature ? `${symbol.kind}: ${symbol.signature}` : symbol.kind),
				path: rel,
				...(refs.length > 0 ? { refs } : {}),
				...(symbol.change ? { change: symbol.change } : {}),
			});
		}
		const calls = lines ? await this.#source.calls(rel) : [];
		const outside = new Map<string, BlueprintNode>();
		const groups = new Map<
			string,
			{ from: string; to: string; label: string; refs: BlueprintRef[]; count: number }
		>();
		const nodeFor = (ref: SymbolRef): string | undefined => {
			if (ref.rel === rel) {
				const own =
					shown.find(s => s.startLine === ref.startLine && s.name === ref.name) ??
					shown.find(s => s.startLine <= ref.startLine && s.endLine >= ref.endLine);
				return own ? ids.get(`${own.name}@${own.startLine}`) : undefined;
			}
			const id = `x:${ref.rel}#${ref.name}`;
			if (!outside.has(id) && outside.size < this.#o.maxExternalSymbols)
				outside.set(id, {
					id,
					label: ref.name,
					kind: "symbol",
					summary: `${ref.kind} in ${ref.rel}`,
					path: ref.rel,
				});
			return outside.has(id) ? id : undefined;
		};
		for (const call of calls) {
			const from = nodeFor(call.from);
			const to = nodeFor(call.to);
			if (from === undefined || to === undefined || from === to) continue;
			const callerLines = call.from.rel === rel ? lines : await this.#lines(call.from.rel, "head");
			if (!callerLines) continue;
			const found = findCallRef(callerLines, call.from.startLine, call.from.endLine, call.to.name);
			if (!found) continue;
			const key = `${from}\0${to}`;
			const group = groups.get(key) ?? { from, to, label: "calls", refs: [], count: 0 };
			group.count++;
			if (group.refs.length < this.#o.refsPerEdge) group.refs.push({ ...found, path: call.from.rel });
			groups.set(key, group);
		}
		const edges: BlueprintEdge[] = [...groups.values()]
			.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
			.slice(0, this.#o.maxEdges)
			.map(g => ({
				id: `${g.from}>${g.to}`,
				from: g.from,
				to: g.to,
				label: g.count > 1 ? `calls ×${g.count}` : g.label,
				kind: "call",
				refs: g.refs,
			}));
		const linked = new Set(edges.flatMap(e => [e.from, e.to]));
		for (const [id, node] of outside) if (linked.has(id)) nodes.push(node);
		return {
			id: `index:file:${rel}`,
			title: path.posix.basename(rel),
			summary: `${rel}: ${languageName(file.lang)}, ${plural(file.symbols, "symbol")}${symbols.length > shown.length ? `; the ${shown.length} largest are shown` : ""}.`,
			origin: "index",
			nodes,
			edges,
		};
	}

	async build(): Promise<IndexResult> {
		const { repoName } = this.#o;
		const rootDiagram: BlueprintDiagram = {
			id: INDEX_REPO_DIAGRAM,
			title: repoName,
			summary: `${plural(this.#units.length, "package or top-level folder")} and the imports between them, from the code index.`,
			origin: "index",
			nodes: [],
			edges: [],
		};
		this.#add(rootDiagram);

		// Unit nodes, with the imports between units.
		const unitGroups = new Map<string, Group>();
		for (const edge of this.#source.edges) {
			const a = this.#fileUnit.get(edge.from);
			const b = this.#fileUnit.get(edge.to);
			if (!a || !b || a === b) continue;
			const key = `${a.path}\0${b.path}`;
			let group = unitGroups.get(key);
			if (!group) {
				group = { from: unitNodeId(a), to: unitNodeId(b), edges: [] };
				unitGroups.set(key, group);
			}
			group.edges.push(edge);
		}
		const unitDegree = new Map<string, number>();
		for (const group of unitGroups.values())
			for (const end of [group.from, group.to]) unitDegree.set(end, (unitDegree.get(end) ?? 0) + group.edges.length);
		const rankedUnits = [...this.#units].sort(
			(a, b) =>
				(unitDegree.get(unitNodeId(b)) ?? 0) - (unitDegree.get(unitNodeId(a)) ?? 0) || a.path.localeCompare(b.path),
		);
		const keptUnits = new Set(rankedUnits.slice(0, this.#o.maxNodes * 2).map(unitNodeId));

		// Folder diagrams, shallow first within the budget; files get diagrams afterwards from what is left.
		const dirBudget = this.#budget - 1 - Math.min(this.#o.maxFileDiagrams, Math.floor(this.#o.maxDiagrams * 0.25));
		const unitDiagrams = new Map<Unit, string>();
		const queue: { unit: Unit; dir: Dir; depth: number }[] = [];
		for (const unit of this.#units) {
			if (!keptUnits.has(unitNodeId(unit))) continue;
			const dir = unit.path === "" ? unit.root : effective(unit.root);
			// The root-level files unit has no subfolders to chain through.
			if (statsOf(dir).files > 0) queue.push({ unit, dir, depth: 0 });
		}
		let created = 0;
		for (let i = 0; i < queue.length; i++) {
			if (created >= dirBudget) break;
			const { unit, dir, depth } = queue[i]!;
			const { diagram, children, overflow } = await this.#folderDiagram(unit, dir, depth);
			this.#add(diagram);
			created++;
			if (overflow) {
				this.#add(overflow);
				created++;
			}
			this.#dirDiagram.set(`d:${dir.path}`, diagram.id);
			this.byPath.set(dir.path, diagram.id);
			if (depth === 0) unitDiagrams.set(unit, diagram.id);
			for (const child of children) queue.push({ unit, dir: child, depth: depth + 1 });
			// A unit folder whose own chain collapsed maps its outer folders to this diagram.
			if (depth === 0)
				for (let d = unit.root; d !== dir; d = [...d.dirs.values()][0]!) this.byPath.set(d.path, diagram.id);
		}

		// Link folder nodes (inside and outside) to the diagrams of their folders.
		for (const diagram of Object.values(this.diagrams)) {
			for (const node of diagram.nodes) {
				if (node.kind === "file" || node.kind === "symbol" || node.path === undefined) continue;
				const target = this.#dirDiagram.get(`d:${node.path}`);
				if (target !== undefined && target !== diagram.id) node.child = target;
			}
		}

		// Files with their own diagram: the best-connected of those drawn, with enough symbols to be worth one.
		const fileRoom = Math.min(this.#o.maxFileDiagrams, this.#budget);
		const candidates = [...this.#fileNodes.keys()]
			.filter(rel => (this.#files.get(rel)?.symbols ?? 0) >= 2)
			.sort((a, b) => (this.#degree.get(b) ?? 0) - (this.#degree.get(a) ?? 0) || a.localeCompare(b));
		let filesDone = 0;
		for (const rel of candidates) {
			if (filesDone >= fileRoom) break;
			const diagram = await this.#fileDiagram(rel);
			if (!diagram) continue;
			this.#add(diagram);
			filesDone++;
			this.byPath.set(rel, diagram.id);
			for (const node of this.#fileNodes.get(rel) ?? []) node.child = diagram.id;
		}

		// The overview: every unit, imports between them.
		for (const unit of rankedUnits.slice(0, this.#o.maxNodes * 2)) {
			const stats = statsOf(unit.root);
			const child = unitDiagrams.get(unit);
			rootDiagram.nodes.push({
				id: unitNodeId(unit),
				label: unit.path === "" ? "(root files)" : unit.path,
				kind: unit.manifest ? "package" : "module",
				summary: dirSummary(stats),
				...(unit.path !== "" ? { path: unit.path } : {}),
				...(child ? { child } : {}),
				...(dirChange(unit.root) ? { change: dirChange(unit.root) } : {}),
			});
		}
		const shown = new Set(rootDiagram.nodes.map(node => node.id));
		rootDiagram.edges = await this.#drawEdges(
			[...unitGroups.values()].filter(g => shown.has(g.from) && shown.has(g.to)),
		);
		const hiddenUnits = this.#units.length - rootDiagram.nodes.length;

		const warnings: string[] = [];
		if (this.#noRef > 0)
			warnings.push(
				`${this.#noRef} file ${this.#noRef === 1 ? "dependency" : "dependencies"} had no import line to cite and ${this.#noRef === 1 ? "was" : "were"} left out of the code-index diagrams.`,
			);
		if (hiddenUnits > 0)
			warnings.push(
				`${plural(hiddenUnits, "package or folder")} were left out of the overview diagram (it shows the ${rootDiagram.nodes.length} best connected).`,
			);

		const units: UnitSummary[] = this.#units.map(unit => {
			const stats = statsOf(unit.root);
			const top = [...unit.files]
				.sort(
					(a, b) => (this.#degree.get(b.rel) ?? 0) - (this.#degree.get(a.rel) ?? 0) || a.rel.localeCompare(b.rel),
				)
				.slice(0, 5)
				.map(file => file.rel);
			return {
				path: unit.path,
				label: unit.path === "" ? "(root files)" : unit.path,
				manifest: unit.manifest,
				files: stats.files,
				symbols: stats.symbols,
				languages: topLanguages(stats),
				diagram: unitDiagrams.get(unit),
				topFiles: top,
			};
		});
		const unitEdges = [...unitGroups.values()]
			.map(g => ({ from: g.from.slice(2), to: g.to.slice(2), files: g.edges.length }))
			.sort((a, b) => b.files - a.files || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
		return { diagrams: this.diagrams, root: INDEX_REPO_DIAGRAM, byPath: this.byPath, units, unitEdges, warnings };
	}
}

function unitNodeId(unit: Unit): string {
	return `u:${unit.path}`;
}

function relativeUnitPath(unitPath: string, dir: string): string {
	return unitPath === "" ? dir : dir.slice(unitPath.length + 1);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Build the code-index diagrams of a repository (or of the union of two commits, in a diff map). */
export async function buildIndexDiagrams(source: IndexSource, options: IndexOptions): Promise<IndexResult> {
	return await new IndexBuilder(source, options).build();
}
