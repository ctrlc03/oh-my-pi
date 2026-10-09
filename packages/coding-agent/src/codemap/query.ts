/**
 * Read side of `codemap`: definitions, derived event/handler edges, callers,
 * callees, and ranked search over the index {@link refreshIndex} maintains.
 * Edges are derived per query from `symbols`/`refs`, never stored:
 *
 * - handles    Rust `impl Handler<…X…> for Actor` (every identifier type
 *              argument counts), plus `path` refs to a variant inside the
 *              `handle` method of an impl handling a broad enum
 * - publishes  construct/path/type refs inside the arguments of a
 *              {@link PUBLISH_CALLEES} call, credited to the enclosing symbol
 * - emits      Solidity `emit X(…)`
 * - calls, implements, contains   straight from `refs` / `impl_trait` / `parent_id`
 *
 * Cross-language edges (derived in `./bridges`, name-based, see its header):
 *
 * - decodes        Solidity event E → the Rust sites naming E (the decoder)
 * - becomes        E → the internal Rust type T it is turned into, through a
 *                  wrapper struct plus `impl From<W> for T`, a wrapper method
 *                  returning T, or a construct in the decoder scope
 * - converts       any `impl From<A> for B`
 * - calls-contract Rust `call` of a Solidity function name (filtered for
 *                  generic names), shown as the Solidity function
 * - proves-with    Rust string literal (or the enum variant on its line)
 *                  naming a Noir package → the circuit's `main`
 *
 * `trace` renders them as sections ("Decoded by", "Becomes", "Becomes from",
 * "Converts to", "Called from Rust", "Calls contract", "Circuit") and in the
 * depth event chain; {@link CodemapQuery.flowNeighbors} walks all edges both
 * ways for the `flow` tool.
 */
import * as path from "node:path";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { Bridges, lastTypeName } from "./bridges";
import {
	firstSentence,
	groupByScope,
	placeholders,
	type RefRow,
	REF_SELECT,
	SIGNATURE_CHARS,
	SYMBOL_SELECT,
	type SymbolRow,
	testPathSql,
	truncate,
	isTestPath,
} from "./rows";
import type { CodemapDb } from "./store";
import { queryWords } from "./words";

/** Method/function names whose argument lists carry events being sent. */
const PUBLISH_CALLEES = [
	"publish",
	"publish_local",
	"dispatch",
	"do_send",
	"send",
	"try_send",
	"notify",
	"emit",
	"broadcast",
] as const;
const PUBLISH_PLACEHOLDERS = PUBLISH_CALLEES.map(() => "?").join(", ");

/** Matches `Handler<…>` and `actix::Handler<…>`; group 1 is the argument list. */
const HANDLER_RE = /^(?:\w+::)*Handler<(.*)>$/s;
/** Identifier type arguments, skipping path qualifiers (`a::B` yields `B`). */
const IDENT_RE = /\b[A-Za-z_]\w*\b(?!\s*::)/g;

const CALLABLE_KINDS: Record<string, true> = { function: true, method: true, macro: true, modifier: true };
const CONTAINER_KINDS: Record<string, true> = {
	struct: true,
	enum: true,
	union: true,
	trait: true,
	class: true,
	interface: true,
	contract: true,
	library: true,
	module: true,
};
/**
 * Ref kinds that count as the payload of a publish call. `path` refs are
 * always qualified (`A::B`), i.e. an enum variant passed as a field value
 * (`E3Failed { stage: E3Stage::CommitteeFinalized }`), not the event itself.
 */
const PUBLISH_KINDS = "('construct', 'type')";
/** Wrapper types around a published event (`TypedEvent::new(E { .. })`); they are never the event itself. */
const WRAPPER_TYPES: Record<string, true> = {
	TypedEvent: true,
	Box: true,
	Arc: true,
	Rc: true,
	Some: true,
	Ok: true,
	Err: true,
};

/** SQL ordering key sorting test files last. */
const TEST_SQL = testPathSql("f.path");

const DEFINITIONS_CAP = 10;
const LIST_CAP = 12;
const CALLERS_CAP = 15;
const NESTED_CAP = 8;
const REFS_CAP = 10;
const MEMBERS_CAP = 30;
const GROUP_NAMES_CAP = 14;
const SEARCH_LIMIT = 20;
/** Rows fetched per ref query before grouping; totals past this are reported as lower bounds. */
const REF_FETCH_LIMIT = 400;
/** Rendered output ceiling, in bytes, so one call never floods the context. */
const OUTPUT_BYTES = 8000;

/** One located symbol or reference site, ready to print as `path:start-end  kind  name  — signature`. */
export interface Site {
	/** Path usable from the caller's cwd (`read path:start-end`). */
	path: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	signature: string;
	/** First sentence of the doc comment. */
	doc?: string;
	note?: string;
}

/** A titled group of sites (and/or summary lines); `total` exceeds `items.length` when capped. */
export interface Section {
	heading: string;
	items: Site[];
	lines: string[];
	total: number;
}

/** A node of an event chain or caller tree. */
export interface TraceNode {
	text: string;
	site?: Site;
	children: TraceNode[];
	/** Children omitted by the fan-out cap. */
	more: number;
}

export interface TraceResult {
	symbol: string;
	depth: number;
	/** The index knows this name; otherwise {@link fallback} holds search hits. */
	found: boolean;
	sections: Section[];
	tree?: { heading: string; roots: TraceNode[] };
	fallback?: Site[];
}

export interface SearchResult {
	query: string;
	hits: Site[];
}

/** Aggregate numbers behind `omp codemap stats`. */
export interface IndexSummary {
	root: string;
	dbPath: string;
	dbBytes: number;
	fts: boolean;
	files: number;
	unparsedFiles: number;
	languages: Record<string, number>;
	symbols: number;
	symbolKinds: Record<string, number>;
	refs: number;
	refKinds: Record<string, number>;
	lastBuild?: unknown;
}

interface HandlerHit {
	actor: string;
	impl: SymbolRow;
	method: SymbolRow | undefined;
	/** Broad enum whose `handle` match arm names the event, when not a direct type argument. */
	via?: string;
}

/** Parse `Handler<…>` into the identifier type arguments it mentions; undefined for any other trait. */
function handlerArgs(implTrait: string | null): string[] | undefined {
	const match = implTrait ? HANDLER_RE.exec(implTrait) : null;
	return match ? [...match[1]!.matchAll(IDENT_RE)].map(m => m[0]) : undefined;
}

/** Bare trait/base names of an `impl_trait` text: `Handler<A, B>` → `Handler`; `A, B<C>` → `A`, `B`. */
function traitBases(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if (ch === "<") depth++;
		else if (ch === ">") depth--;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts.map(part => part.trim().replace(/<.*$/s, "").split("::").pop()!.trim()).filter(Boolean);
}

/** A symbol as a step of a flow: where it is, what it looks like, and its language. */
export interface FlowNode {
	id: number;
	/** Path usable from the caller's cwd. */
	path: string;
	/** Root-relative path, as stored in the index. */
	rel: string;
	/** Short language label from the file extension: `rust`, `sol`, `noir`, `ts`, `js`, `py`, `go`. */
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

/** One hop from a {@link FlowNode}; `label` reads from the source node to `to` (`decoded by`, `calls contract`, …). */
export interface FlowEdge {
	to: FlowNode;
	label: string;
	/** 0 cross-language bridges and event edges lead; 1 handlers/publishers; 2 plain calls. */
	rank: number;
}

/** A source file of the dependency graph. */
export interface GraphFile {
	/** Root-relative path, as stored in the index. */
	rel: string;
	/** Short language label, as {@link FlowNode.lang}. */
	lang: string;
	/** Symbols defined in the file, impl blocks excluded. */
	symbols: number;
}

/** `from` depends on `to`; `rel` paths as in {@link GraphFile}. */
export interface GraphEdge {
	from: string;
	to: string;
	/** References behind the edge (summed per label). */
	weight: number;
	/** `references` for same-language, name-resolved references; else the cross-language bridge: `decodes`, `calls contract` or `proves with`. */
	label: string;
	/** Whether the edge crosses languages, i.e. `label` is not `references`. */
	bridge: boolean;
}

const LANG_BY_EXT: Record<string, string> = {
	".rs": "rust",
	".sol": "sol",
	".nr": "noir",
	".ts": "ts",
	".tsx": "ts",
	".js": "js",
	".jsx": "js",
	".mjs": "js",
	".cjs": "js",
	".py": "py",
	".go": "go",
};

/** Callees too common to name a step: std/trait plumbing that would link unrelated code. */
const COMMON_CALLS: Record<string, true> = {
	new: true,
	clone: true,
	into: true,
	from: true,
	try_from: true,
	try_into: true,
	default: true,
	unwrap: true,
	expect: true,
	map: true,
	ok: true,
	err: true,
	iter: true,
	collect: true,
	to_string: true,
	len: true,
	push: true,
	get: true,
	set: true,
	insert: true,
	remove: true,
	contains: true,
	is_empty: true,
	as_ref: true,
	as_str: true,
	to_vec: true,
	to_owned: true,
	send: true,
	publish: true,
	handle: true,
	run: true,
	main: true,
	fmt: true,
	drop: true,
	join: true,
	lock: true,
	read: true,
	write: true,
	build: true,
	name: true,
	id: true,
};

/** Type kinds a published or handled event name resolves to. */
const EVENT_TYPE_KINDS = "('struct', 'enum', 'event', 'class')";
/** Ref kinds that make a file depend on the file defining the referenced name. */
const GRAPH_REF_KINDS = "('call', 'type', 'construct', 'path', 'emit', 'macro')";
/** Definition kinds a name-resolved reference can land on (never variables, impls or modules). */
const GRAPH_DEF_KINDS =
	"('function', 'method', 'struct', 'enum', 'union', 'trait', 'class', 'interface', 'type', 'contract', 'library', 'event', 'modifier', 'error', 'macro', 'const', 'static')";
/** Solidity declarations other files can name without an explicit import list (`import "./X.sol"` brings in all of them). */
const SOLIDITY_TYPE_KINDS: Record<string, true> = {
	contract: true,
	interface: true,
	library: true,
	struct: true,
	enum: true,
	event: true,
	error: true,
};
/** Ref kinds through which Rust names a Solidity event (the decoder's sites). */
const DECODE_REF_KINDS: Record<string, true> = { type: true, path: true, construct: true };
/** Edges per kind a flow node contributes, so one hub symbol cannot flood the frontier. */
const FLOW_BRIDGE_CAP = 6;
const FLOW_CALL_CAP = 8;
/** Most events a decoder may name and still count as decoding each of them. */
const FLOW_DECODED_MAX = 3;

/** Queries over one open index; `scope` (root-relative path or directory) restricts every file-bearing lookup. */
export class CodemapQuery {
	readonly #db: CodemapDb;
	readonly #cwd: string;
	readonly #scope: string | undefined;
	readonly #displayPaths = new Map<string, string>();
	#enumNames: Set<string> | undefined;
	readonly #bridges: Bridges;

	constructor(index: CodemapDb, cwd: string, scope?: string) {
		this.#db = index;
		this.#cwd = cwd;
		this.#scope = scope;
		this.#bridges = new Bridges({
			root: index.root,
			rows: (sql, params) => this.#rows(sql, params),
			scopeClause: () => this.#scopeClause(),
		});
	}

	#rows<T>(sql: string, params: Array<string | number> = []): T[] {
		return this.#db.db.query<T, Array<string | number>>(sql).all(...params);
	}

	/** ` AND (…)` limiting `f.path` to the scope, with its bind parameters. */
	#scopeClause(): { sql: string; params: Array<string | number> } {
		if (this.#scope === undefined) return { sql: "", params: [] };
		const prefix = `${this.#scope}/`;
		return { sql: " AND (f.path = ? OR substr(f.path, 1, ?) = ?)", params: [this.#scope, prefix.length, prefix] };
	}

	/**
	 * ` AND …` limiting `column` (a file id) to files that define or mention `qualifier`;
	 * how `Owner::name` queries avoid matching every same-named call in the repo.
	 */
	#qualifierClause(column: string, qualifier: string | undefined): { sql: string; params: string[] } {
		if (qualifier === undefined) return { sql: "", params: [] };
		return {
			sql: ` AND ${column} IN (SELECT file_id FROM symbols WHERE name = ? UNION SELECT file_id FROM refs WHERE name = ?)`,
			params: [qualifier, qualifier],
		};
	}

	#display(rel: string): string {
		let shown = this.#displayPaths.get(rel);
		if (shown === undefined) {
			shown = formatPathRelativeToCwd(path.join(this.#db.root, rel), this.#cwd);
			this.#displayPaths.set(rel, shown);
		}
		return shown;
	}

	/** `Parent::name` (Rust) or `Parent.name` for members; the bare name otherwise. */
	#qualified(name: string, kind: string, parentName: string | null, rel: string): string {
		if (!parentName || !Object.hasOwn(CALLABLE_KINDS, kind)) return name;
		return `${parentName}${rel.endsWith(".rs") ? "::" : "."}${name}`;
	}

	#symbolSite(row: SymbolRow, note?: string): Site {
		return {
			path: this.#display(row.path),
			startLine: row.startLine,
			endLine: row.endLine,
			kind: row.kind,
			name: this.#qualified(row.name, row.kind, row.parentName, row.path),
			signature: truncate(row.signature, SIGNATURE_CHARS),
			doc: firstSentence(row.doc),
			note,
		};
	}

	/** Site of the symbol enclosing a ref, or the ref's own line when it sits outside every symbol. */
	#refSite(row: RefRow, note?: string): Site {
		if (row.sid === null) {
			return {
				path: this.#display(row.refPath),
				startLine: row.refLine,
				endLine: row.refLine,
				kind: row.refKind,
				name: "(file scope)",
				signature: "",
				note,
			};
		}
		return {
			path: this.#display(row.refPath),
			startLine: row.sstart!,
			endLine: row.send!,
			kind: row.skind!,
			name: this.#qualified(row.sname!, row.skind!, row.pname, row.refPath),
			signature: truncate(row.ssig ?? "", SIGNATURE_CHARS),
			doc: firstSentence(row.sdoc),
			note,
		};
	}

	#enums(): Set<string> {
		this.#enumNames ??= new Set(
			this.#rows<{ name: string }>("SELECT DISTINCT name FROM symbols WHERE kind = 'enum'").map(r => r.name),
		);
		return this.#enumNames;
	}

	/** Symbols named exactly `name` (falling back to a case-insensitive match), impls included. */
	#symbolsNamed(name: string): SymbolRow[] {
		const scope = this.#scopeClause();
		const order = " ORDER BY f.path, s.start_line";
		const exact = this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE s.name = ?${scope.sql}${order}`, [
			name,
			...scope.params,
		]);
		if (exact.length > 0) return exact;
		return this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE s.name_lc = ?${scope.sql}${order}`, [
			name.toLowerCase(),
			...scope.params,
		]);
	}

	#refRows(where: string, params: Array<string | number>, limit = REF_FETCH_LIMIT, qualifier?: string): RefRow[] {
		const scope = this.#scopeClause();
		const within = this.#qualifierClause("r.file_id", qualifier);
		return this.#rows<RefRow>(
			`${REF_SELECT} WHERE ${where}${scope.sql}${within.sql} ORDER BY ${TEST_SQL}, f.path, r.line LIMIT ${limit}`,
			[...params, ...scope.params, ...within.params],
		);
	}

	#handleMethod(implId: number): SymbolRow | undefined {
		return this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE s.parent_id = ? AND s.name = 'handle' LIMIT 1`, [implId])[0];
	}

	/** Impl blocks handling `name`: direct `Handler<…name…>` type arguments, then match arms on a broad enum. */
	#handlersOf(name: string, qualifier?: string): HandlerHit[] {
		const scope = this.#scopeClause();
		const within = this.#qualifierClause("f.id", qualifier);
		const direct = this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind = 'impl' AND s.impl_trait LIKE ?${scope.sql}${within.sql} ORDER BY f.path, s.start_line`,
			[`%Handler<%${name}%`, ...scope.params, ...within.params],
		).filter(row => handlerArgs(row.implTrait)?.includes(name));
		const hits: HandlerHit[] = direct.map(impl => ({
			actor: impl.name,
			impl,
			method: this.#handleMethod(impl.id),
		}));
		const seen = new Set(direct.map(row => row.id));
		const enums = this.#enums();
		const arms = this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.name = 'handle' AND p.kind = 'impl' AND p.impl_trait LIKE '%Handler<%'
				AND s.id IN (SELECT r.scope_symbol_id FROM refs r WHERE r.name = ? AND r.kind = 'path')${scope.sql}${within.sql}
			ORDER BY f.path, s.start_line`,
			[name, ...scope.params, ...within.params],
		);
		for (const method of arms) {
			if (method.parentId === null || seen.has(method.parentId)) continue;
			const via = handlerArgs(method.parentTrait)?.find(arg => enums.has(arg));
			if (via === undefined) continue;
			const impl = this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE s.id = ?`, [method.parentId])[0];
			if (!impl) continue;
			seen.add(impl.id);
			hits.push({ actor: impl.name, impl, method, via });
		}
		return hits;
	}

	#handlerSite(hit: HandlerHit): Site {
		const target = hit.method ?? hit.impl;
		return {
			path: this.#display(target.path),
			startLine: target.startLine,
			endLine: target.endLine,
			kind: "handler",
			name: `${hit.actor}::handle`,
			signature: truncate(hit.impl.signature, SIGNATURE_CHARS),
			note: hit.via ? `match on ${hit.via}` : undefined,
		};
	}

	/** Distinct event-like names published (construct/path/type in publish arguments) from within `scopeIds`, most-handled first. */
	#publishedFrom(scopeIds: number[]): string[] {
		if (scopeIds.length === 0) return [];
		const rows = this.#rows<{ name: string; kind: string }>(
			`SELECT DISTINCT name, kind FROM refs WHERE scope_symbol_id IN (${placeholders(scopeIds.length)})
				AND kind IN ${PUBLISH_KINDS} AND callee IN (${PUBLISH_PLACEHOLDERS})`,
			[...scopeIds, ...PUBLISH_CALLEES],
		);
		const enums = this.#enums();
		const names = [
			...new Set(
				rows
					.filter(r => !(r.kind === "type" && (enums.has(r.name) || Object.hasOwn(WRAPPER_TYPES, r.name))))
					.map(r => r.name),
			),
		];
		return names.sort();
	}

	/** Scope ids of a handler: its `handle` method plus same-actor helper methods it calls. */
	#handlerScopes(hit: HandlerHit): number[] {
		if (!hit.method) return [hit.impl.id];
		const called = this.#rows<{ name: string }>(
			"SELECT DISTINCT name FROM refs WHERE scope_symbol_id = ? AND kind = 'call' AND name != 'handle'",
			[hit.method.id],
		).map(r => r.name);
		const ids = [hit.method.id];
		if (called.length === 0) return ids;
		const implIds = this.#rows<{ id: number }>("SELECT id FROM symbols WHERE kind = 'impl' AND name = ?", [
			hit.actor,
		]).map(r => r.id);
		if (implIds.length === 0) return ids;
		const helpers = this.#rows<{ id: number }>(
			`SELECT id FROM symbols WHERE parent_id IN (${placeholders(implIds.length)}) AND name IN (${placeholders(called.length)})`,
			[...implIds, ...called],
		);
		for (const helper of helpers) ids.push(helper.id);
		return ids;
	}

	/** `emitted by` nodes for Solidity `emit name`, each with the Rust callers of the emitting function beneath it. */
	#emitterNodes(name: string, cap: number, qualifier?: string): TraceNode[] {
		const groups = groupByScope(this.#refRows("r.name = ? AND r.kind = 'emit'", [name], 200, qualifier));
		return groups.slice(0, cap).map(group => {
			const site = this.#refSite(group.row, `emit at line ${group.lines[0]}`);
			const node: TraceNode = { text: `emitted by ${site.name}`, site, children: [], more: 0 };
			if (group.row.sname !== null) {
				const callers = groupByScope(this.#bridges.contractCallers(group.row.sname));
				node.more = Math.max(0, callers.length - NESTED_CAP);
				for (const caller of callers.slice(0, NESTED_CAP)) {
					const callerSite = this.#refSite(caller.row, `call at line ${caller.lines[0]}`);
					node.children.push({
						text: `called from Rust ${callerSite.name}`,
						site: callerSite,
						children: [],
						more: 0,
					});
				}
			}
			return node;
		});
	}

	/**
	 * Cross-language steps of event `name`: the Solidity emitters (and the Rust code calling them), the Rust
	 * decoders with the internal types the event becomes, and the Solidity events a Rust type was decoded from.
	 */
	#bridgeNodes(name: string, hops: number, visited: Set<string>, qualifier?: string): TraceNode[] {
		const nodes = this.#emitterNodes(name, NESTED_CAP, qualifier);
		const decoders = this.#bridges.decodeSites(name);
		const decoderNodes = decoders
			.filter(group => group.decoder)
			.slice(0, 3)
			.map<TraceNode>(group => {
				const site = this.#refSite(group.row, `${group.decoder ? "decoder, " : ""}line ${group.lines[0]}`);
				return { text: `decoded by ${site.name}`, site, children: [], more: 0 };
			});
		const becomeNodes: TraceNode[] = [];
		for (const hit of this.#bridges.becomes(name).slice(0, NESTED_CAP)) {
			const site = this.#symbolSite(hit.target, hit.via);
			const label = `becomes ${hit.target.name} (${hit.via})`;
			// A same-named Rust type is already expanded through this node's own handlers.
			if (hops > 0 && hit.target.name !== name && hit.target.kind !== "enum") {
				const next = this.#eventChain(hit.target.name, hops - 1, visited, NESTED_CAP);
				next.text = next.text.endsWith("(expanded above)") ? `${label} (expanded above)` : label;
				next.site = site;
				becomeNodes.push(next);
			} else {
				becomeNodes.push({ text: label, site, children: [], more: 0 });
			}
		}
		// The decoder leads to what the event becomes; without an indexed decoder the types hang off the event itself.
		if (decoderNodes.length > 0) decoderNodes[0]!.children.push(...becomeNodes);
		else nodes.push(...becomeNodes);
		nodes.push(...decoderNodes);
		if (!this.#bridges.isEvent(name)) {
			for (const { event, via } of this.#bridges.becomesFrom(name).slice(0, 2)) {
				nodes.push({
					text: `decoded from ${event.name} (${via})`,
					site: this.#symbolSite(event),
					children: this.#emitterNodes(event.name, 3),
					more: 0,
				});
			}
		}
		return nodes;
	}

	#eventChain(name: string, hops: number, visited: Set<string>, cap: number, qualifier?: string): TraceNode {
		const node: TraceNode = { text: name, children: [], more: 0 };
		if (visited.has(name)) {
			node.text = `${name} (expanded above)`;
			return node;
		}
		visited.add(name);
		node.children.push(...this.#bridgeNodes(name, hops, visited, qualifier));
		const handlers = this.#handlersOf(name, qualifier);
		node.more = Math.max(0, handlers.length - cap);
		for (const hit of handlers.slice(0, cap)) {
			const child: TraceNode = {
				text: `handled by ${hit.actor}`,
				site: this.#handlerSite(hit),
				children: [],
				more: 0,
			};
			if (hops > 0) {
				const published = this.#publishedFrom(this.#handlerScopes(hit)).filter(event => event !== name);
				// Events with handlers first: they continue the chain.
				const ranked = published
					.map(event => ({ event, handled: this.#handlersOf(event).length }))
					.sort((a, b) => Number(b.handled > 0) - Number(a.handled > 0));
				child.more = Math.max(0, ranked.length - NESTED_CAP);
				for (const { event } of ranked.slice(0, NESTED_CAP)) {
					const next = this.#eventChain(event, hops - 1, visited, NESTED_CAP);
					next.text = `publishes ${next.text}`;
					child.children.push(next);
				}
			}
			node.children.push(child);
		}
		return node;
	}

	#callerTree(
		name: string,
		hops: number,
		visited: Set<number>,
		cap: number,
		qualifier?: string,
	): { nodes: TraceNode[]; more: number } {
		const groups = groupByScope(this.#refRows("r.name = ? AND r.kind = 'call'", [name], 200, qualifier)).filter(
			group => group.row.sid === null || !visited.has(group.row.sid),
		);
		const nodes: TraceNode[] = [];
		for (const group of groups.slice(0, cap)) {
			const site = this.#refSite(
				group.row,
				`${group.lines.length > 1 ? `${group.lines.length} calls, from ` : "call at "}line ${group.lines[0]}`,
			);
			const node: TraceNode = { text: site.name, site, children: [], more: 0 };
			if (hops > 0 && group.row.sid !== null) {
				visited.add(group.row.sid);
				const up = this.#callerTree(group.row.sname!, hops - 1, visited, NESTED_CAP);
				node.children = up.nodes;
				node.more = up.more;
			}
			nodes.push(node);
		}
		return { nodes, more: Math.max(0, groups.length - cap) };
	}

	/** Compact `calls (n): a, b×2, …` lines for what the symbol `id` does, derived from refs inside its span. */
	#calleeLines(id: number): string[] {
		const rows = this.#rows<{ name: string; kind: string; callee: string | null; n: number }>(
			"SELECT name, kind, callee, COUNT(*) AS n FROM refs WHERE scope_symbol_id = ? GROUP BY name, kind, callee",
			[id],
		);
		const groups: Record<string, Map<string, number>> = {};
		const add = (group: string, name: string, n: number): void => {
			const names = (groups[group] ??= new Map());
			names.set(name, (names.get(name) ?? 0) + n);
		};
		const enums = this.#enums();
		const publishing = PUBLISH_CALLEES as readonly string[];
		const circuitNames = new Set(this.#bridges.circuits().flatMap(circuit => circuit.names));
		for (const row of rows) {
			if (row.kind === "call") add("calls", row.name, row.n);
			else if (row.kind === "emit") add("emits", row.name, row.n);
			else if (row.kind === "macro") add("macros", row.name, row.n);
			else if (row.kind === "import") continue;
			else if (row.kind === "string") {
				// Only literals naming a Noir circuit are steps; other name-like strings are noise here.
				if (circuitNames.has(row.name)) add("circuits", row.name, row.n);
			} else if (row.kind !== "path" && row.callee && publishing.includes(row.callee)) {
				if (!(row.kind === "type" && (enums.has(row.name) || Object.hasOwn(WRAPPER_TYPES, row.name))))
					add("publishes", row.name, row.n);
			} else if (row.kind === "construct") add("constructs", row.name, row.n);
			else if (row.kind === "type") add("types", row.name, row.n);
			else add("paths", row.name, row.n);
		}
		const lines: string[] = [];
		for (const group of ["publishes", "emits", "calls", "circuits", "constructs", "macros", "types", "paths"]) {
			const names = groups[group];
			if (!names) continue;
			const ordered = [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
			const shown = ordered.slice(0, GROUP_NAMES_CAP).map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
			const rest = ordered.length - shown.length;
			lines.push(`${group} (${ordered.length}): ${shown.join(", ")}${rest > 0 ? `, … +${rest} more` : ""}`);
		}
		return lines;
	}

	/** Sections describing `name` as a type/event/trait/actor/function; empty when nothing about it is indexed. */
	trace(symbol: string, depth: number): TraceResult {
		const parts = symbol.split(/::|\./).filter(Boolean);
		const name = parts.pop() ?? symbol;
		const qualifier = parts.pop();
		const result: TraceResult = { symbol, depth, found: true, sections: [] };
		const section = (heading: string, items: Site[] = [], total = items.length, lines: string[] = []): Section => {
			const entry: Section = { heading, items, lines, total };
			result.sections.push(entry);
			return entry;
		};

		let named = this.#symbolsNamed(name);
		// The qualifier counts only when it owns a definition of `name`; otherwise it is a module path and the bare name is traced.
		let owner: string | undefined;
		if (qualifier !== undefined) {
			const owned = named.filter(
				row =>
					row.parentName === qualifier ||
					row.implFor?.replace(/<.*$/s, "").split("::").pop()?.trim() === qualifier,
			);
			if (owned.length > 0) {
				named = owned;
				owner = qualifier;
			}
		}
		const impls = named.filter(row => row.kind === "impl");
		const defs = named.filter(row => row.kind !== "impl");

		const countScope = this.#scopeClause();
		const countWithin = this.#qualifierClause("r.file_id", owner);
		const refCounts = this.#rows<{ kind: string; n: number }>(
			`SELECT r.kind, COUNT(*) AS n FROM refs r JOIN files f ON f.id = r.file_id WHERE r.name = ?${countScope.sql}${countWithin.sql} GROUP BY r.kind`,
			[name, ...countScope.params, ...countWithin.params],
		);
		const handlers = this.#handlersOf(name, owner);
		const circuits = this.#bridges.circuitsNamed(name);
		const circuitAliases = this.#bridges.circuitsByAlias(name);
		if (
			named.length === 0 &&
			refCounts.length === 0 &&
			handlers.length === 0 &&
			circuits.length === 0 &&
			circuitAliases.length === 0
		) {
			result.found = false;
			result.fallback = this.search(symbol).hits;
			return result;
		}

		if (defs.length > 0) {
			section(
				"Definitions",
				defs.slice(0, DEFINITIONS_CAP).map(row => this.#symbolSite(row)),
				defs.length,
			);
			const containers = defs.filter(row => Object.hasOwn(CONTAINER_KINDS, row.kind)).slice(0, 3);
			for (const container of containers) {
				const members = this.#rows<{ name: string; kind: string }>(
					"SELECT name, kind FROM symbols WHERE parent_id = ? ORDER BY start_line",
					[container.id],
				);
				if (members.length === 0) continue;
				const shown = members
					.slice(0, MEMBERS_CAP)
					.map(m => (m.kind === "method" || m.kind === "function" ? `${m.name}()` : m.name));
				const rest = members.length - shown.length;
				section(`Members of ${container.name}`, [], 0, [
					`${members.length}: ${shown.join(", ")}${rest > 0 ? `, … +${rest} more` : ""}`,
				]);
			}
		}

		// Actor view: how impls of this type implement traits, which events it handles and publishes.
		if (impls.length > 0) {
			const handled = impls.filter(row => handlerArgs(row.implTrait) !== undefined);
			const traitImpls = impls.filter(row => row.implTrait !== null && handlerArgs(row.implTrait) === undefined);
			const inherent = impls.filter(row => row.implTrait === null);
			if (handled.length > 0) {
				const sites = handled
					.slice(0, LIST_CAP * 2)
					.map(impl => this.#handlerSite({ actor: impl.name, impl, method: this.#handleMethod(impl.id) }));
				section("Handles", sites, handled.length);
			}
			const published = this.#publishedFrom(
				this.#rows<{ id: number }>(
					`SELECT id FROM symbols WHERE id IN (${placeholders(impls.length)}) OR parent_id IN (${placeholders(impls.length)})`,
					[...impls.map(r => r.id), ...impls.map(r => r.id)],
				).map(r => r.id),
			);
			if (published.length > 0) {
				const shown = published.slice(0, LIST_CAP * 2);
				const rest = published.length - shown.length;
				section("Publishes", [], 0, [
					`${published.length}: ${shown.join(", ")}${rest > 0 ? `, … +${rest} more` : ""}`,
				]);
			}
			if (traitImpls.length > 0) {
				section(
					"Implements",
					traitImpls.slice(0, LIST_CAP).map(row => this.#symbolSite(row)),
					traitImpls.length,
				);
			}
			if (inherent.length > 0) {
				section(
					"Inherent impls",
					inherent.slice(0, LIST_CAP).map(row => this.#symbolSite(row)),
					inherent.length,
				);
			}
		}

		if (owner !== undefined) {
			section("Scope", [], 0, [
				`${owner}::${name}: handlers, publishers, callers and references below are limited to files that define or mention ${owner}; same-named symbols elsewhere are excluded`,
			]);
		}

		if (handlers.length > 0) {
			section(
				"Handled by",
				handlers.slice(0, LIST_CAP).map(hit => this.#handlerSite(hit)),
				handlers.length,
			);
		}

		const scope = this.#scopeClause();
		const within = this.#qualifierClause("f.id", owner);
		const publishKinds = Object.hasOwn(WRAPPER_TYPES, name) ? "('construct')" : PUBLISH_KINDS;
		const publisherRows = this.#refRows(
			`r.name = ? AND r.kind IN ${publishKinds} AND r.callee IN (${PUBLISH_PLACEHOLDERS})`,
			[name, ...PUBLISH_CALLEES],
			REF_FETCH_LIMIT,
			owner,
		);
		if (publisherRows.length > 0) {
			// Struct-literal publications are unambiguous, so they lead.
			const groups = groupByScope(publisherRows).sort(
				(x, y) => Number(y.row.refKind === "construct") - Number(x.row.refKind === "construct"),
			);
			const items = groups.slice(0, LIST_CAP).map(group => {
				const parts = [`${group.callees.join("/")} at line ${group.lines[0]}`];
				if (group.row.refKind === "construct") parts.push("struct literal");
				if (group.row.ptrait && handlerArgs(group.row.ptrait)) parts.push(`in ${group.row.ptrait}`);
				return this.#refSite(group.row, parts.join(", "));
			});
			section("Published by", items, groups.length);
		}
		const emitRows = this.#refRows("r.name = ? AND r.kind = 'emit'", [name], REF_FETCH_LIMIT, owner);
		if (emitRows.length > 0) {
			const groups = groupByScope(emitRows);
			section(
				"Emitted by",
				groups.slice(0, LIST_CAP).map(g => this.#refSite(g.row, `emit at line ${g.lines[0]}`)),
				groups.length,
			);
		}

		// Cross-language bridges: Solidity event → Rust decoder → internal type, Rust ↔ Solidity calls, Rust → Noir circuit.
		const decodeGroups = this.#bridges.decodeSites(name);
		if (decodeGroups.length > 0) {
			section(
				"Decoded by",
				decodeGroups
					.slice(0, LIST_CAP)
					.map(g => this.#refSite(g.row, `${g.decoder ? "decoder, " : ""}line ${g.lines[0]}`)),
				decodeGroups.length,
			);
		}
		const becomesList = this.#bridges.becomes(name);
		if (becomesList.length > 0) {
			section(
				"Becomes",
				becomesList.slice(0, LIST_CAP).map(hit => this.#symbolSite(hit.target, hit.via)),
				becomesList.length,
			);
		}
		const becomesFromList = this.#bridges.isEvent(name) ? [] : this.#bridges.becomesFrom(name);
		if (becomesFromList.length > 0) {
			section(
				"Decoded from",
				becomesFromList.slice(0, LIST_CAP).map(hit => this.#symbolSite(hit.event, hit.via)),
				becomesFromList.length,
			);
		}
		const convertsTo = this.#bridges.convertsTo(name);
		if (convertsTo.length > 0) {
			section(
				"Converts to",
				convertsTo.slice(0, LIST_CAP).map(hit => this.#symbolSite(hit.impl)),
				convertsTo.length,
			);
		}
		const convertedFrom = this.#bridges.convertedFrom(name);
		if (convertedFrom.length > 0) {
			section(
				"Converted from",
				convertedFrom.slice(0, LIST_CAP).map(hit => this.#symbolSite(hit.impl)),
				convertedFrom.length,
			);
		}
		const rustDefined = defs.some(row => row.path.endsWith(".rs"));
		const contractCallers = rustDefined ? [] : groupByScope(this.#bridges.contractCallers(name));
		if (contractCallers.length > 0) {
			section(
				"Called from Rust",
				contractCallers
					.slice(0, CALLERS_CAP)
					.map(g => this.#refSite(g.row, g.lines.length > 1 ? `${g.lines.length} calls` : `line ${g.lines[0]}`)),
				contractCallers.length,
			);
		}
		const circuitSites = [...circuits, ...circuitAliases.map(use => use.circuit)].filter(
			(circuit, i, all) => all.indexOf(circuit) === i,
		);
		if (circuitSites.length > 0) {
			section(
				"Circuit",
				circuitSites.flatMap(circuit =>
					circuit.main ? [this.#symbolSite(circuit.main, `Noir package ${circuit.names.join(" / ")}`)] : [],
				),
				circuitSites.length,
				circuitSites.filter(circuit => !circuit.main).map(circuit => `${circuit.dir}: no \`main\` indexed`),
			);
			const uses = [
				...circuits.flatMap(circuit => this.#bridges.circuitUses(circuit)),
				...circuitAliases.map(use => use.row),
			];
			const groups = groupByScope(uses);
			if (groups.length > 0) {
				section(
					"Named in Rust",
					groups.slice(0, LIST_CAP).map(g => this.#refSite(g.row, `line ${g.lines[0]}`)),
					groups.length,
				);
			}
		}
		for (const def of defs.slice(0, 3)) {
			const circuit = this.#bridges.circuitOfMain(def.id);
			if (!circuit) continue;
			const groups = groupByScope(this.#bridges.circuitUses(circuit));
			if (groups.length > 0) {
				section(
					`Proved from Rust (${circuit.names.join(" / ")})`,
					groups.slice(0, LIST_CAP).map(g => this.#refSite(g.row, `"${g.row.refName}" at line ${g.lines[0]}`)),
					groups.length,
				);
			}
		}

		// Implementors: impls and classes/contracts whose trait or base list names this symbol.
		const implementors = this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.impl_trait LIKE ?${scope.sql}${within.sql} ORDER BY f.path, s.start_line`,
			[`%${name}%`, ...scope.params, ...within.params],
		).filter(row => row.implTrait !== null && traitBases(row.implTrait).includes(name));
		if (implementors.length > 0) {
			section(
				"Implemented / extended by",
				implementors.slice(0, LIST_CAP).map(row => this.#symbolSite(row)),
				implementors.length,
			);
		}

		const callCount = refCounts.find(c => c.kind === "call");
		if (callCount) {
			// Rust calls of a Solidity function are already listed under "Called from Rust".
			const callerRows = this.#refRows("r.name = ? AND r.kind = 'call'", [name], REF_FETCH_LIMIT, owner).filter(
				row => contractCallers.length === 0 || !row.refPath.endsWith(".rs"),
			);
			const groups = groupByScope(callerRows);
			const lowerBound = callerRows.length >= REF_FETCH_LIMIT;
			if (groups.length > 0) {
				const callers = section(
					"Callers",
					groups
						.slice(0, CALLERS_CAP)
						.map(g =>
							this.#refSite(g.row, g.lines.length > 1 ? `${g.lines.length} calls` : `line ${g.lines[0]}`),
						),
					lowerBound ? groups.length + 1 : groups.length,
				);
				callers.lines.push(`${callCount.n} call sites${lowerBound ? " (list is a lower bound)" : ""}`);
			}
		}

		const callable = defs.filter(row => Object.hasOwn(CALLABLE_KINDS, row.kind));
		if (callable.length > 0 && callable.length <= 3) {
			for (const def of callable) {
				const lines = this.#calleeLines(def.id);
				if (lines.length > 0)
					section(
						`Inside ${this.#qualified(def.name, def.kind, def.parentName, def.path)} (${this.#display(def.path)}:${def.startLine}-${def.endLine})`,
						[],
						0,
						lines,
					);
			}
		}
		if (callable.length > 0 && callable.length <= 3) {
			const called: Site[] = [];
			for (const def of callable.filter(row => row.path.endsWith(".rs"))) {
				const from = this.#qualified(def.name, def.kind, def.parentName, def.path);
				for (const callee of this.#bridges.contractCalleeNames([def.id])) {
					const target = this.#bridges.contractDefs(callee)[0];
					if (target) called.push(this.#symbolSite(target, `called from ${from}`));
				}
			}
			if (called.length > 0) section("Calls contract", called.slice(0, LIST_CAP), called.length);
		}

		const mentions = this.#refRows(
			`r.name = ? AND r.kind IN ('type', 'construct', 'path', 'import', 'macro') AND NOT (r.kind IN ${publishKinds} AND COALESCE(r.callee, '') IN (${PUBLISH_PLACEHOLDERS}))`,
			[name, ...PUBLISH_CALLEES],
			REF_FETCH_LIMIT,
			owner,
		);
		const summary = refCounts.map(c => `${c.n} ${c.kind}`).join(", ");
		const others = mentions.slice(0, REFS_CAP).map(row => {
			const site = this.#refSite(row);
			return {
				...site,
				startLine: row.refLine,
				endLine: row.refLine,
				kind: row.refKind,
				name: `in ${site.name}`,
				signature: "",
				doc: undefined,
			};
		});
		if (refCounts.length > 0) {
			const references = section(
				"References",
				others,
				mentions.length >= REF_FETCH_LIMIT ? mentions.length + 1 : mentions.length,
			);
			references.lines.push(summary);
		}

		if (depth >= 2) {
			const bridged =
				emitRows.length > 0 || decodeGroups.length > 0 || becomesList.length > 0 || becomesFromList.length > 0;
			if (handlers.length > 0 || publisherRows.length > 0 || bridged) {
				const root = this.#eventChain(name, depth - 1, new Set(), LIST_CAP, owner);
				result.tree = { heading: `Event chain (depth ${depth})`, roots: [root] };
			} else if (callable.length > 0) {
				const visited = new Set<number>(callable.map(row => row.id));
				const up = this.#callerTree(name, depth - 1, visited, LIST_CAP, owner);
				if (up.nodes.length > 0) {
					result.tree = { heading: `Caller chain (depth ${depth})`, roots: up.nodes };
					if (up.more > 0) result.tree.roots.push({ text: `… +${up.more} more callers`, children: [], more: 0 });
				}
			}
		}
		return result;
	}

	/** Symbols matching free-text `words`: all-terms matches first, then any-term matches, ranked by BM25. */
	#searchRows(words: string, limit: number): SymbolRow[] {
		const terms = queryWords(words);
		const found: SymbolRow[] = [];
		if (terms.length === 0) return found;
		const scope = this.#scopeClause();
		const seen = new Set<number>();
		const take = (rows: SymbolRow[]): void => {
			for (const row of rows) {
				if (found.length >= limit) return;
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				found.push(row);
			}
		};
		if (this.#db.fts) {
			const match = (joiner: string): string => terms.map(term => `"${term}"`).join(joiner);
			const ranked = (query: string): SymbolRow[] =>
				this.#rows<SymbolRow>(
					`${SYMBOL_SELECT} JOIN symbols_fts ON symbols_fts.rowid = s.id
					WHERE symbols_fts MATCH ? AND s.kind != 'impl'${scope.sql}
					ORDER BY bm25(symbols_fts, 8.0, 2.0, 1.0, 1.5) LIMIT ${limit * 2}`,
					[query, ...scope.params],
				);
			take(ranked(match(" AND ")));
			if (found.length < limit && terms.length > 1) take(ranked(match(" OR ")));
		} else {
			// No FTS5 in this SQLite build: rank by how many terms the name words, signature, or path contain.
			const score = terms.map(() => "(s.words LIKE ? OR s.signature LIKE ? OR f.path LIKE ?)").join(" + ");
			const patterns = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
			take(
				this.#rows<SymbolRow>(
					`${SYMBOL_SELECT} WHERE (${score}) > 0 AND s.kind != 'impl'${scope.sql} ORDER BY (${score}) DESC, f.path LIMIT ${limit * 2}`,
					[...patterns, ...scope.params, ...patterns],
				),
			);
		}
		return found;
	}

	/** Top symbols for free-text `words`. */
	search(words: string): SearchResult {
		return { query: words, hits: this.#searchRows(words, SEARCH_LIMIT).map(row => this.#symbolSite(row)) };
	}

	// Flow graph: every derived edge as symbol-to-symbol hops, walked in both directions by `flow`.

	#flowNode(row: SymbolRow): FlowNode {
		return {
			id: row.id,
			path: this.#display(row.path),
			rel: row.path,
			lang: LANG_BY_EXT[path.extname(row.path)] ?? "other",
			kind: row.kind,
			name: this.#qualified(row.name, row.kind, row.parentName, row.path),
			signature: truncate(row.signature, SIGNATURE_CHARS),
			doc: firstSentence(row.doc),
			startLine: row.startLine,
			endLine: row.endLine,
		};
	}

	/** Symbols with the given ids, in the order given. */
	#symbolsByIds(ids: number[]): SymbolRow[] {
		if (ids.length === 0) return [];
		const byId = new Map(
			this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE s.id IN (${placeholders(ids.length)})`, ids).map(row => [
				row.id,
				row,
			]),
		);
		// Callers pass ids in the ref queries' path order (tests last); keep it so the per-edge caps take the best sites.
		return [...new Set(ids)].flatMap(id => byId.get(id) ?? []);
	}

	/** Definitions named `name` of one of `kinds` (a SQL tuple), tests last. */
	#definitionsOf(name: string, kinds: string, limit: number): SymbolRow[] {
		const scope = this.#scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.name = ? AND s.kind IN ${kinds}${scope.sql}
			ORDER BY ${TEST_SQL}, f.path, s.start_line LIMIT ${limit}`,
			[name, ...scope.params],
		);
	}

	/** Free-text search hits as flow nodes. */
	flowSearch(words: string, limit: number): FlowNode[] {
		return this.#searchRows(words, limit).map(row => this.#flowNode(row));
	}

	/** Definitions of `symbol` (`name` or `Owner::name`) as flow nodes; impl blocks only when nothing else matches. */
	flowDefinitions(symbol: string): FlowNode[] {
		const parts = symbol.split(/::|\./).filter(Boolean);
		const name = parts.pop() ?? symbol;
		const qualifier = parts.pop();
		let named = this.#symbolsNamed(name);
		if (qualifier !== undefined) {
			const owned = named.filter(
				row => row.parentName === qualifier || (row.implFor && lastTypeName(row.implFor) === qualifier),
			);
			if (owned.length > 0) named = owned;
		}
		const defs = named.filter(row => row.kind !== "impl");
		return (defs.length > 0 ? defs : named).map(row => this.#flowNode(row));
	}

	/** Innermost non-impl symbols of `rel` (root-relative) overlapping lines `start`..`end`. */
	flowOverlapping(rel: string, start: number, end: number, limit: number): FlowNode[] {
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE f.path = ? AND s.start_line <= ? AND s.end_line >= ? AND s.kind != 'impl'
			ORDER BY (s.end_line - s.start_line), s.start_line LIMIT ${limit}`,
			[rel, end, start],
		).map(row => this.#flowNode(row));
	}

	// Dependency graph: file-level edges and the symbol listings drill-down needs. Like `flowOverlapping`, these see the whole index, not the scope.

	/** Every parsed source file except test and fixture code, ordered by path. */
	graphFiles(): GraphFile[] {
		return this.#rows<{ path: string; symbols: number }>(
			`SELECT f.path, (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id AND s.kind != 'impl') AS symbols
			FROM files f WHERE f.parsed = 1 ORDER BY f.path`,
		)
			.filter(row => !isTestPath(row.path))
			.map(row => ({ rel: row.path, lang: LANG_BY_EXT[path.extname(row.path)] ?? "other", symbols: row.symbols }));
	}

	/**
	 * File-to-file dependencies among {@link graphFiles}, aggregated per (from, to, label), ordered by path.
	 * A `references` edge resolves a ref by exact name to the one file of the referencing language family that
	 * defines it; names defined in several files, in the referencing file, or in no file of the family make none.
	 * Names alone over-link (`x.filter()` hits any user-defined `filter`), so the referencing file must also reach
	 * the definer: it imports the name (`import`/`use` refs), the ref is a qualified `path`, the family is Solidity
	 * and the definer declares a contract/interface/library/struct/enum/event/error of that name (whole-file
	 * imports name nothing), or the family is Go/Python and both files share a directory.
	 * Bridge edges stay name-based and run from Rust: `decodes` (names a Solidity event), `calls contract` (calls a
	 * Solidity function), `proves with` (names a Noir circuit in a string literal).
	 */
	graphEdges(): GraphEdge[] {
		const files = new Map<number, { rel: string; family: string }>();
		for (const row of this.#rows<{ id: number; path: string }>("SELECT id, path FROM files WHERE parsed = 1")) {
			if (isTestPath(row.path)) continue;
			const lang = LANG_BY_EXT[path.extname(row.path)] ?? "other";
			// TypeScript and JavaScript import each other; one family.
			files.set(row.id, { rel: row.path, family: lang === "ts" ? "js" : lang });
		}
		const rels = new Set([...files.values()].map(file => file.rel));

		/** `family:name` → the one file defining it, or -1 when several do. */
		const definer = new Map<string, number>();
		/** `fileId\0name` of Solidity type-like definitions, which other files see without naming them in an import. */
		const soliditySymbols = new Set<string>();
		for (const row of this.#rows<{ name: string; fileId: number; kind: string }>(
			`SELECT DISTINCT name, file_id AS fileId, kind FROM symbols WHERE kind IN ${GRAPH_DEF_KINDS}`,
		)) {
			const file = files.get(row.fileId);
			if (!file) continue;
			if (file.family === "sol" && Object.hasOwn(SOLIDITY_TYPE_KINDS, row.kind)) {
				soliditySymbols.add(`${row.fileId}\0${row.name}`);
			}
			const key = `${file.family}:${row.name}`;
			const known = definer.get(key);
			if (known === undefined) definer.set(key, row.fileId);
			else if (known !== row.fileId) definer.set(key, -1);
		}

		/** `fileId\0name` of every import ref: what each file names from elsewhere. */
		const imported = new Set(
			this.#rows<{ fileId: number; name: string }>(
				"SELECT DISTINCT file_id AS fileId, name FROM refs WHERE kind = 'import'",
			).map(row => `${row.fileId}\0${row.name}`),
		);
		const edges = new Map<string, GraphEdge>();
		const link = (from: string, to: string, label: string, weight: number): void => {
			const key = `${from}\0${to}\0${label}`;
			const edge = edges.get(key);
			if (edge) edge.weight += weight;
			else edges.set(key, { from, to, weight, label, bridge: label !== "references" });
		};
		const bridgeTargets = new Map<string, string | undefined>();
		/** File of the first definition of Solidity event/function `name` outside tests. */
		const bridgeTarget = (label: string, name: string): string | undefined => {
			const key = `${label}\0${name}`;
			if (!bridgeTargets.has(key)) {
				const defs = label === "decodes" ? this.#bridges.eventDefs(name) : this.#bridges.contractDefs(name);
				bridgeTargets.set(key, defs.find(def => rels.has(def.path))?.path);
			}
			return bridgeTargets.get(key);
		};

		for (const row of this.#rows<{ fileId: number; name: string; kind: string; n: number }>(
			`SELECT file_id AS fileId, name, kind, COUNT(*) AS n FROM refs WHERE kind IN ${GRAPH_REF_KINDS} GROUP BY file_id, name, kind`,
		)) {
			const from = files.get(row.fileId);
			if (!from || from.family === "other" || Object.hasOwn(COMMON_CALLS, row.name)) continue;
			const target = definer.get(`${from.family}:${row.name}`);
			if (target !== undefined && target !== -1 && target !== row.fileId) {
				const to = files.get(target)!;
				// A bare name only counts when the file visibly reaches the definer; otherwise `x.filter()` links to any `filter`.
				const reaches =
					row.kind === "path" ||
					imported.has(`${row.fileId}\0${row.name}`) ||
					(from.family === "sol" && soliditySymbols.has(`${target}\0${row.name}`)) ||
					((from.family === "go" || from.family === "py") &&
						path.posix.dirname(from.rel) === path.posix.dirname(to.rel));
				if (reaches) link(from.rel, to.rel, "references", row.n);
			}
			if (from.family !== "rust") continue;
			let label: string | undefined;
			if (Object.hasOwn(DECODE_REF_KINDS, row.kind) && this.#bridges.isEvent(row.name)) label = "decodes";
			else if (row.kind === "call" && this.#bridges.isContractFunction(row.name)) label = "calls contract";
			const to = label && bridgeTarget(label, row.name);
			if (label && to) link(from.rel, to, label, row.n);
		}

		const circuitNames = this.#bridges.circuits().flatMap(circuit => circuit.names);
		if (circuitNames.length > 0) {
			for (const row of this.#rows<{ fileId: number; name: string; n: number }>(
				`SELECT file_id AS fileId, name, COUNT(*) AS n FROM refs
				WHERE kind = 'string' AND name IN (${placeholders(circuitNames.length)}) GROUP BY file_id, name`,
				circuitNames,
			)) {
				const from = files.get(row.fileId);
				if (from?.family !== "rust") continue;
				for (const circuit of this.#bridges.circuitsNamed(row.name)) {
					const main = path.posix.join(circuit.dir, "src/main.nr");
					if (rels.has(main)) link(from.rel, main, "proves with", row.n);
				}
			}
		}

		return [...edges.values()].sort(
			(a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label),
		);
	}

	/** Non-impl symbols defined in `rel` (root-relative), in source order. */
	fileSymbols(rel: string, limit: number): FlowNode[] {
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE f.path = ? AND s.kind != 'impl' ORDER BY s.start_line, s.idx LIMIT ${limit}`,
			[rel],
		).map(row => this.#flowNode(row));
	}

	/**
	 * What `node` contains, in source order: symbols nested in it, plus the methods of impl blocks in its file
	 * whose self type is its name (`impl Foo` members belong to the struct `Foo`, not to the impl).
	 */
	symbolMembers(node: FlowNode, limit: number): FlowNode[] {
		const bare = node.name.split(/::|\./).pop()!;
		const owners = [node.id];
		for (const impl of this.#rows<SymbolRow>(`${SYMBOL_SELECT} WHERE f.path = ? AND s.kind = 'impl'`, [node.rel])) {
			if (impl.name === bare || lastTypeName(impl.implFor ?? impl.name) === bare) owners.push(impl.id);
		}
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.parent_id IN (${placeholders(owners.length)}) AND s.id != ? AND s.kind != 'impl'
			ORDER BY s.start_line, s.idx LIMIT ${limit}`,
			[...owners, node.id],
		).map(row => this.#flowNode(row));
	}

	/**
	 * Every edge of one symbol, both directions, cross-language bridges first. Labels read from `node` to the
	 * target (`node` is "decoded by" the target). Plain callers/callees are capped at {@link FLOW_CALL_CAP}.
	 */
	flowNeighbors(node: FlowNode): FlowEdge[] {
		const row = this.#symbolsByIds([node.id])[0];
		if (!row) return [];
		const edges: FlowEdge[] = [];
		const seen = new Set<number>([row.id]);
		const add = (label: string, rank: number, targets: SymbolRow[], cap: number): void => {
			let taken = 0;
			for (const target of targets) {
				if (taken >= cap) break;
				if (seen.has(target.id)) continue;
				seen.add(target.id);
				edges.push({ to: this.#flowNode(target), label, rank });
				taken++;
			}
		};
		/** Distinct scope symbols of ref groups, test files last (already ordered so by the ref queries). */
		const scopes = (rows: RefRow[]): SymbolRow[] =>
			this.#symbolsByIds(groupByScope(rows).flatMap(group => (group.row.sid === null ? [] : [group.row.sid])));
		const typeDefs = (names: string[]): SymbolRow[] =>
			names.flatMap(name => this.#definitionsOf(name, EVENT_TYPE_KINDS, 2));
		const isRust = row.path.endsWith(".rs");

		if (Object.hasOwn(CALLABLE_KINDS, row.kind)) {
			const circuit = this.#bridges.circuitOfMain(row.id);
			const handlerImpl =
				row.name === "handle" && row.parentId !== null && handlerArgs(row.parentTrait) !== undefined
					? this.#symbolsByIds([row.parentId])[0]
					: undefined;
			const scopeIds = handlerImpl
				? this.#handlerScopes({ actor: handlerImpl.name, impl: handlerImpl, method: row })
				: [row.id];

			if (row.path.endsWith(".sol")) {
				add("called from Rust", 0, scopes(this.#bridges.contractCallers(row.name)), FLOW_BRIDGE_CAP);
			}
			if (isRust) {
				const contracts = this.#bridges
					.contractCalleeNames(scopeIds)
					.flatMap(name => this.#bridges.contractDefs(name).slice(0, 1));
				add("calls contract", 0, contracts, FLOW_BRIDGE_CAP);
				add(
					"proves with",
					0,
					this.#bridges.circuitsUsedIn(scopeIds).flatMap(used => (used.main ? [used.main] : [])),
					FLOW_BRIDGE_CAP,
				);
				// A dispatcher decoding many events (`extractor`) is not a step toward any one of them.
				const decoded = [...new Set(scopeIds.flatMap(id => this.#bridges.decodedEvents(id)))];
				if (decoded.length <= FLOW_DECODED_MAX) {
					add(
						"decodes",
						0,
						decoded.flatMap(event => this.#bridges.eventDefs(event).slice(0, 1)),
						FLOW_BRIDGE_CAP,
					);
				}
			}
			if (circuit) add("proved from Rust", 0, scopes(this.#bridges.circuitUses(circuit)), FLOW_BRIDGE_CAP);
			const emitted = this.#rows<{ name: string }>(
				`SELECT DISTINCT name FROM refs WHERE scope_symbol_id = ? AND kind = 'emit' ORDER BY name`,
				[row.id],
			);
			add(
				"emits",
				0,
				emitted.flatMap(emit => this.#bridges.eventDefs(emit.name).slice(0, 1)),
				FLOW_BRIDGE_CAP,
			);
			add("publishes", 1, typeDefs(this.#publishedFrom(scopeIds)), FLOW_BRIDGE_CAP);
			if (handlerImpl) {
				const args = (handlerArgs(row.parentTrait) ?? []).filter(
					arg => !Object.hasOwn(WRAPPER_TYPES, arg) && arg !== "Self",
				);
				add("handles", 1, typeDefs(args), FLOW_BRIDGE_CAP);
			}

			const called = this.#rows<{ name: string }>(
				`SELECT name FROM refs WHERE scope_symbol_id = ? AND kind = 'call' GROUP BY name ORDER BY COUNT(*) DESC, MIN(line)`,
				[row.id],
			);
			const callees: SymbolRow[] = [];
			for (const { name } of called) {
				if (Object.hasOwn(COMMON_CALLS, name) || name === row.name) continue;
				const defs = this.#rows<SymbolRow>(
					`${SYMBOL_SELECT} WHERE s.name = ? AND s.kind IN ('function', 'method', 'modifier')${this.#scopeClause().sql}
					ORDER BY (f.path != ?), ${TEST_SQL}, f.path, s.start_line LIMIT 4`,
					[name, ...this.#scopeClause().params, row.path],
				);
				// A name defined in many places is not a link; the same-file definition is.
				const local = defs.filter(def => def.path === row.path);
				callees.push(...(local.length > 0 ? local.slice(0, 1) : defs.length <= 3 ? defs : []));
			}
			add("calls", 2, callees, FLOW_CALL_CAP);
			if (!Object.hasOwn(COMMON_CALLS, row.name)) {
				const owner =
					row.parentKind === "impl" || row.parentKind === "contract" ? (row.parentName ?? undefined) : undefined;
				const callerRows = this.#refRows("r.name = ? AND r.kind = 'call'", [row.name], 100, owner).filter(
					caller => !isTestPath(caller.refPath),
				);
				add("called by", 2, scopes(callerRows), FLOW_CALL_CAP);
			}
		} else if (row.kind === "event") {
			const emitters = this.#refRows("r.name = ? AND r.kind = 'emit'", [row.name], 100);
			add("emitted by", 0, scopes(emitters), FLOW_BRIDGE_CAP);
			const decoders = this.#bridges.decodeSites(row.name).filter(site => site.decoder);
			add(
				"decoded by",
				0,
				this.#symbolsByIds(decoders.flatMap(site => (site.row.sid === null ? [] : [site.row.sid]))),
				4,
			);
			add(
				"becomes",
				0,
				this.#bridges.becomes(row.name).map(hit => hit.target),
				4,
			);
		} else if (row.kind === "struct" || row.kind === "enum" || row.kind === "class") {
			if (isRust) {
				add(
					"decoded from",
					0,
					this.#bridges
						.becomesFrom(row.name)
						.map(hit => hit.event)
						.slice(0, 3),
					3,
				);
				add(
					"converts to",
					0,
					this.#bridges.convertsTo(row.name).flatMap(hit => (hit.def ? [hit.def] : [])),
					4,
				);
			}
			const handlers = this.#handlersOf(row.name).map(hit => hit.method ?? hit.impl);
			add("handled by", 1, handlers, FLOW_BRIDGE_CAP);
			const publishers = this.#refRows(
				`r.name = ? AND r.kind IN ${Object.hasOwn(WRAPPER_TYPES, row.name) ? "('construct')" : PUBLISH_KINDS} AND r.callee IN (${PUBLISH_PLACEHOLDERS})`,
				[row.name, ...PUBLISH_CALLEES],
				100,
			);
			add("published by", 1, scopes(publishers), FLOW_BRIDGE_CAP);
			if (isRust) {
				add(
					"converted from",
					1,
					this.#bridges.convertedFrom(row.name).flatMap(hit => (hit.def ? [hit.def] : [])),
					4,
				);
			}
		}
		return edges.sort((a, b) => a.rank - b.rank);
	}

	/** Counts of what the index holds. */
	summary(dbBytes: number): IndexSummary {
		const count = (table: string, column?: string): Record<string, number> => {
			const rows = this.#rows<{ k: string | null; n: number }>(
				column
					? `SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`
					: `SELECT '' AS k, COUNT(*) AS n FROM ${table}`,
			);
			return Object.fromEntries(rows.map(r => [r.k ?? "unknown", r.n]));
		};
		const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);
		const languages = count("files", "language");
		const symbolKinds = count("symbols", "kind");
		const refKinds = count("refs", "kind");
		const unparsed = this.#rows<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE parsed = 0")[0]!.n;
		const lastBuild = this.#rows<{ value: string }>("SELECT value FROM meta WHERE key = 'last_build'")[0];
		return {
			root: this.#db.root,
			dbPath: this.#db.dbPath,
			dbBytes,
			fts: this.#db.fts,
			files: sum(languages),
			unparsedFiles: unparsed,
			languages,
			symbols: sum(symbolKinds),
			symbolKinds,
			refs: sum(refKinds),
			refKinds,
			lastBuild: lastBuild ? JSON.parse(lastBuild.value) : undefined,
		};
	}
}

function siteRef(site: Site): string {
	return `${site.path}:${site.startLine === site.endLine ? site.startLine : `${site.startLine}-${site.endLine}`}`;
}

function siteLine(site: Site): string {
	const tail = site.signature ? `  — ${site.signature}` : "";
	const note = site.note ? `  [${site.note}]` : "";
	return `${siteRef(site)}  ${site.kind}  ${site.name}${tail}${note}`;
}

function renderNode(node: TraceNode, indent: number, out: string[]): void {
	const pad = "  ".repeat(indent);
	const where = node.site ? `  ${siteRef(node.site)}${node.site.note ? `  [${node.site.note}]` : ""}` : "";
	out.push(`${pad}${node.text}${where}`);
	for (const child of node.children) renderNode(child, indent + 1, out);
	if (node.more > 0) out.push(`${pad}  … +${node.more} more`);
}

/** Clip `lines` to {@link OUTPUT_BYTES}, appending a count of what was dropped. */
function clip(lines: string[]): string {
	let bytes = 0;
	for (let i = 0; i < lines.length; i++) {
		bytes += Buffer.byteLength(lines[i]!) + 1;
		if (bytes > OUTPUT_BYTES) {
			return `${lines.slice(0, i).join("\n")}\n… output truncated: ${lines.length - i} more lines (narrow with \`path\` or a more specific symbol)`;
		}
	}
	return lines.join("\n");
}

export function renderSearch(result: SearchResult): string {
	if (result.hits.length === 0) return `no symbols match "${result.query}"`;
	const lines = [`${result.hits.length} symbols for "${result.query}", best first:`];
	for (const hit of result.hits) {
		lines.push(siteLine(hit));
		if (hit.doc) lines.push(`    ${hit.doc}`);
	}
	return clip(lines);
}

export function renderTrace(result: TraceResult): string {
	if (!result.found) {
		const hits = result.fallback ?? [];
		return renderSearch({ query: result.symbol, hits }).replace(
			/^\d+ symbols for/,
			`no symbol named "${result.symbol}"; closest search matches for`,
		);
	}
	const lines: string[] = [`trace ${result.symbol}${result.depth > 1 ? ` (depth ${result.depth})` : ""}`];
	for (const section of result.sections) {
		lines.push("", `${section.total > 0 ? `${section.heading} (${section.total})` : section.heading}:`);
		for (const item of section.items) {
			lines.push(siteLine(item));
			if (item.doc && section.heading === "Definitions") lines.push(`    ${item.doc}`);
		}
		for (const line of section.lines) lines.push(`  ${line}`);
		if (section.total > section.items.length) lines.push(`  … +${section.total - section.items.length} more`);
	}
	if (result.tree) {
		lines.push("", `${result.tree.heading}:`);
		for (const root of result.tree.roots) renderNode(root, 1, lines);
	}
	return clip(lines);
}
