/**
 * Types for the codemap index the companion queries (tsconfig `paths` maps
 * `@oh-my-pi/pi-coding-agent/codemap/index` here). This project type-checks with the browser's DOM lib,
 * and the real module graph only type-checks against the workspace's non-DOM lib. bun still resolves the
 * real module at runtime. Keep in sync with packages/coding-agent/src/codemap.
 */

/** A symbol as a step of a flow. */
export interface FlowNode {
	id: number;
	/** Path usable from the `cwd` the index was opened with. */
	path: string;
	/** Root-relative path. */
	rel: string;
	lang: string;
	kind: string;
	/** `Owner::name` (Rust) / `Owner.name` for members, else the bare name. */
	name: string;
	signature: string;
	/** First sentence of the doc comment. */
	doc?: string;
	startLine: number;
	endLine: number;
}

/** One hop from a {@link FlowNode}; `label` reads from the source node to `to`. */
export interface FlowEdge {
	to: FlowNode;
	label: string;
	/** 0 cross-language bridges and event edges lead; 1 handlers/publishers; 2 plain calls. */
	rank: number;
}

/** A source file of the dependency graph. */
export interface GraphFile {
	rel: string;
	lang: string;
	symbols: number;
}

/** `from` depends on `to`; `bridge` marks cross-language edges. */
export interface GraphEdge {
	from: string;
	to: string;
	weight: number;
	label: string;
	bridge: boolean;
}

/** Counts and timing of one index refresh. */
export interface BuildStats {
	files: number;
	reparsed: number;
	unchanged: number;
	removed: number;
	oversized: number;
	unparsed: number;
	symbols: number;
	refs: number;
	ms: number;
}

export class Codemap {
	static open(root: string, options: { cwd: string; scope?: string; signal?: AbortSignal }): Promise<Codemap>;
	readonly root: string;
	readonly stats: BuildStats;
	readonly query: {
		flowSearch(words: string, limit: number): FlowNode[];
		flowDefinitions(symbol: string): FlowNode[];
		flowOverlapping(rel: string, start: number, end: number, limit: number): FlowNode[];
		flowNeighbors(node: FlowNode): FlowEdge[];
		graphFiles(): GraphFile[];
		graphEdges(): GraphEdge[];
		fileSymbols(rel: string, limit: number): FlowNode[];
		symbolMembers(node: FlowNode, limit: number): FlowNode[];
	};
	close(): void;
}
