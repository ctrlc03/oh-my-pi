/**
 * Feeds {@link buildIndexDiagrams} from omp's code index: the head checkout's dependency graph and symbols
 * and, for a diff map, the base checkout's, so files, imports and symbols can be marked added, modified or
 * removed. Files that exist only at base appear as removed; their text is read from the base checkout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Codemap, FlowNode } from "@oh-my-pi/pi-coding-agent/codemap/index";
import type { BlueprintChange } from "@oh-my-pi/pi-wire/blueprint";
import type { ChangedFile, FileHunks } from "./companion-blueprint-git";
import type { IndexCall, IndexEdge, IndexFile, IndexSource, IndexSymbol, SymbolRef } from "./companion-blueprint-index";
import type { Side } from "./companion-citations";

/** Largest source file read for citations. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Top-level symbols per file whose calls are looked up (the largest ones); members per symbol. */
const CALL_SYMBOLS = 24;
const CALL_MEMBERS = 8;
const MAX_SYMBOLS_READ = 500;

export interface DiffInput {
	base: Codemap;
	baseDir: string;
	changed: ChangedFile[];
	hunks: Map<string, FileHunks>;
}

export interface SourceInput {
	head: Codemap;
	headDir: string;
	/** Paths of build manifests at head. */
	manifests: string[];
	diff?: DiffInput;
}

function edgeKey(edge: { from: string; to: string; label: string }): string {
	return `${edge.from}\0${edge.to}\0${edge.label}`;
}

/** A member is named `Owner.name` or `Owner::name`. */
function isTopLevel(node: FlowNode): boolean {
	return !/::|\./.test(node.name);
}

function symbolRef(node: FlowNode): SymbolRef {
	return { rel: node.rel, name: node.name, kind: node.kind, startLine: node.startLine, endLine: node.endLine };
}

function overlaps(ranges: readonly [number, number][], start: number, end: number): boolean {
	return ranges.some(([a, b]) => a <= end && b >= start);
}

async function readLines(root: string, rel: string): Promise<string[] | null> {
	try {
		const file = path.join(root, rel);
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		const bytes = await fs.readFile(file);
		if (bytes.subarray(0, 8192).includes(0)) return null;
		return bytes.toString("utf8").split(/\r?\n/);
	} catch {
		return null;
	}
}

export function createIndexSource(input: SourceInput): IndexSource {
	const { head, diff } = input;
	const changeOf = new Map<string, ChangedFile>(diff?.changed.map(file => [file.path, file]));

	const files: IndexFile[] = head.query.graphFiles().map(file => ({
		...file,
		...(diff && changeOf.has(file.rel) ? { change: changeOf.get(file.rel)!.change } : {}),
	}));
	if (diff) {
		const present = new Set(files.map(file => file.rel));
		for (const file of diff.base.query.graphFiles())
			if (changeOf.get(file.rel)?.change === "removed" && !present.has(file.rel))
				files.push({ ...file, change: "removed" });
	}
	const known = new Set(files.map(file => file.rel));

	const headEdges = head.query.graphEdges();
	const baseEdges = diff ? diff.base.query.graphEdges() : [];
	const headKeys = new Set(headEdges.map(edgeKey));
	const baseKeys = new Set(baseEdges.map(edgeKey));
	const edges: IndexEdge[] = headEdges.map(edge => ({
		from: edge.from,
		to: edge.to,
		weight: edge.weight,
		label: edge.label,
		...(diff && !baseKeys.has(edgeKey(edge)) ? { change: "added" as const } : {}),
	}));
	for (const edge of baseEdges) {
		if (headKeys.has(edgeKey(edge)) || !known.has(edge.from) || !known.has(edge.to)) continue;
		edges.push({ from: edge.from, to: edge.to, weight: edge.weight, label: edge.label, change: "removed" });
	}

	const topLevel = (codemap: Codemap, rel: string): FlowNode[] =>
		codemap.query.fileSymbols(rel, MAX_SYMBOLS_READ).filter(isTopLevel);

	const toSymbol = (node: FlowNode, side: Side, change?: BlueprintChange): IndexSymbol => ({
		name: node.name,
		kind: node.kind,
		startLine: node.startLine,
		endLine: node.endLine,
		signature: node.signature,
		...(node.doc ? { doc: node.doc } : {}),
		side,
		...(change ? { change } : {}),
	});

	return {
		files,
		edges,
		manifests: input.manifests,
		lines: (rel, side) => readLines(side === "base" && diff ? diff.baseDir : input.headDir, rel),
		async symbols(rel) {
			const file = changeOf.get(rel);
			if (diff && file?.change === "removed")
				return topLevel(diff.base, rel).map(node => toSymbol(node, "base", "removed"));
			const current = topLevel(head, rel);
			if (!diff || !file) return current.map(node => toSymbol(node, "head"));
			if (file.change === "added") return current.map(node => toSymbol(node, "head", "added"));
			const before = topLevel(diff.base, file.oldPath ?? rel);
			const beforeKeys = new Set(before.map(node => `${node.kind}\0${node.name}`));
			const ranges = diff.hunks.get(rel)?.head ?? [];
			const symbols = current.map(node => {
				const change: BlueprintChange | undefined = !beforeKeys.has(`${node.kind}\0${node.name}`)
					? "added"
					: overlaps(ranges, node.startLine, node.endLine)
						? "modified"
						: undefined;
				return toSymbol(node, "head", change);
			});
			const currentKeys = new Set(current.map(node => `${node.kind}\0${node.name}`));
			for (const node of before)
				if (!currentKeys.has(`${node.kind}\0${node.name}`)) symbols.push(toSymbol(node, "base", "removed"));
			return symbols.sort((a, b) => a.startLine - b.startLine);
		},
		async calls(rel) {
			const tops = topLevel(head, rel)
				.sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
				.slice(0, CALL_SYMBOLS);
			const calls: IndexCall[] = [];
			const seen = new Set<string>();
			const push = (from: SymbolRef, to: SymbolRef): void => {
				const key = `${from.rel}#${from.name}@${from.startLine}\0${to.rel}#${to.name}@${to.startLine}`;
				if (seen.has(key)) return;
				seen.add(key);
				calls.push({ from, to, label: "calls" });
			};
			for (const top of tops) {
				for (const source of [top, ...head.query.symbolMembers(top, CALL_MEMBERS)]) {
					for (const edge of head.query.flowNeighbors(source)) {
						if (edge.label === "calls") push(symbolRef(top), symbolRef(edge.to));
						else if (edge.label === "called by") push(symbolRef(edge.to), symbolRef(top));
					}
				}
			}
			return calls;
		},
	};
}
