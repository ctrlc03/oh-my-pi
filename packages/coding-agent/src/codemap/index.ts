/**
 * `codemap`: a persistent, incremental, model-free index of a repository's
 * symbols and references, with derived event/handler edges (see
 * {@link CodemapQuery}) and cross-language bridges (Solidity event → Rust decoder →
 * internal type, Rust → Solidity function, Rust → Noir circuit). Each {@link Codemap.open} brings the on-disk index up
 * to date with the working tree before answering, so results are never stale
 * and a warm call only re-parses what changed.
 */
import * as fs from "node:fs";
import { openIndex, refreshIndex, type BuildStats, type CodemapDb } from "./store";
import { CodemapQuery, type IndexSummary } from "./query";

export { renderFlow, runFlow } from "./flow";
export type { FlowCandidate, FlowOptions, FlowResult, FlowStats, FlowStep } from "./flow";
export { renderSearch, renderTrace } from "./query";
export type {
	FlowEdge,
	FlowNode,
	GraphEdge,
	GraphFile,
	IndexSummary,
	SearchResult,
	Section,
	Site,
	TraceNode,
	TraceResult,
} from "./query";
export type { BuildStats } from "./store";

export interface CodemapOpenOptions {
	/** Directory result paths are made relative to. */
	cwd: string;
	/** Root-relative file or directory restricting every query. */
	scope?: string;
	signal?: AbortSignal;
}

/** An up-to-date index of one repository root. Close it when done. */
export class Codemap {
	readonly #index: CodemapDb;
	readonly query: CodemapQuery;
	readonly root: string;
	/** What the refresh performed by {@link Codemap.open} did. */
	readonly stats: BuildStats;

	private constructor(index: CodemapDb, stats: BuildStats, cwd: string, scope: string | undefined) {
		this.#index = index;
		this.root = index.root;
		this.stats = stats;
		this.query = new CodemapQuery(index, cwd, scope);
	}

	/**
	 * Open (creating if needed) the index for `root` and refresh it against the
	 * tree. `stats` describes that refresh.
	 * @throws when the index database cannot be opened or the walk is aborted.
	 */
	static async open(root: string, options: CodemapOpenOptions): Promise<Codemap> {
		const real = fs.realpathSync(root);
		const index = openIndex(real);
		try {
			const stats = await refreshIndex(index, options.signal);
			return new Codemap(index, stats, options.cwd, options.scope);
		} catch (error) {
			index.db.close();
			throw error;
		}
	}

	/** What the index currently holds, plus the last recorded build. */
	summary(): IndexSummary {
		const dbBytes = fs.statSync(this.#index.dbPath).size;
		return this.query.summary(dbBytes);
	}

	close(): void {
		this.#index.db.close();
	}
}
