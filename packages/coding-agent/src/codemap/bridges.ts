/**
 * Cross-language edges derived per query from `symbols`/`refs`, never stored.
 * They connect the steps of a flow where names and languages change:
 *
 * - decodes     Solidity `event E` → Rust refs (type/path/construct) named E
 *               inside `.rs` files; the site is the enclosing symbol. Scopes
 *               that also call `decode_log_data`/`decode_log`/`decode_raw_log`
 *               or name `SIGNATURE_HASH` are the actual decoders and lead.
 * - becomes     event E → the internal Rust type T it turns into:
 *               (i) a struct W whose span holds a `type` ref E, and
 *               `impl From<W> for T` or a method of `impl W` returning T;
 *               (ii) a `construct` in the decoder scope after an E ref and
 *               before the next ref to a different Solidity event (the wrapper
 *               itself is skipped; enums rank below structs).
 * - converts    any `impl From<A> for B`: A → B.
 * - calls-contract  Rust `call` refs named like a Solidity `function`, when the
 *               name has an uppercase letter or ≥ 8 chars and is not generic.
 * - proves-with  Rust `string` refs equal to a Noir package name (the
 *               `Nargo.toml` `name`, else the directory name) → the package's
 *               `main`; a `path`/`type` ref on the same line as that string
 *               (`CircuitName::ThresholdShareDecryption => "share_decryption"`)
 *               names the circuit too.
 *
 * Linking is by name only: wrappers, variables, and renamed re-exports are
 * invisible, so these are leads to read, not proof.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	groupByScope,
	placeholders,
	REF_SELECT,
	type RefGroup,
	type RefRow,
	SYMBOL_SELECT,
	type SymbolRow,
	testPathSql,
} from "./rows";

/** Solidity function names that are never a contract-call target on their own. */
const GENERIC_CONTRACT_NAMES: Record<string, true> = {
	new: true,
	get: true,
	set: true,
	call: true,
	send: true,
	transfer: true,
	approve: true,
	balanceOf: true,
	owner: true,
	initialize: true,
	init: true,
	deploy: true,
	address: true,
	decode: true,
	encode: true,
	receive: true,
	fallback: true,
};

/** Calls and constants that mark a Rust scope as the decoder of a Solidity event. */
const DECODER_MARKERS: Record<string, true> = {
	decode_log_data: true,
	decode_log: true,
	decode_raw_log: true,
	SIGNATURE_HASH: true,
};
const DECODER_MARKER_NAMES = Object.keys(DECODER_MARKERS);

/** Identifiers in a return type that are containers or markers, never the converted type. */
const RETURN_NOISE: Record<string, true> = {
	Result: true,
	Option: true,
	Self: true,
	anyhow: true,
	Vec: true,
	Box: true,
	Arc: true,
	Rc: true,
	Error: true,
	impl: true,
};

/** SQL ordering key sorting test files last. */
const TEST_SQL = testPathSql("f.path");

/** Methods that consume a wrapper to produce the internal type (`try_into_e3_requested`, `to_x`). */
const CONVERSION_METHOD_RE = /^(try_)?into(_|$)|^to_/;

const TARGETS_CAP = 3;
/** Solidity events converting into one type past which the type is treated as a hub and reports none. */
const HUB_SOURCES = 4;
const WRAPPER_CAP = 12;
const CONSTRUCT_CAP = 100;
/** Rows read when listing the Rust sites that name a Solidity event. */
const SITE_FETCH_LIMIT = 200;

/** `From<&'a a::W<T>>` → `W`; undefined for any other trait. */
const FROM_SOURCE_RE = /^From<\s*&?\s*(?:'\w+\s+)?(?:\w+::)*(\w+)\s*(?:<.*>)?\s*>$/s;

/** A wrapper method that turns the decoded event into the internal type: a conversion by name, or a wrapper named for the event. */
function isConversion(method: string, wrapper: string, event: string): boolean {
	return CONVERSION_METHOD_RE.test(method) || wrapper.includes(event);
}

/** Last type name of Rust type text: `&a::B<T>` → `B`. */
export function lastTypeName(text: string): string {
	return text
		.replace(/<.*$/s, "")
		.replace(/^[&\s]+/, "")
		.split("::")
		.pop()!
		.trim();
}

/** The `A` of `From<A>`, or undefined when `implTrait` is another trait. */
export function fromSource(implTrait: string | null): string | undefined {
	return implTrait ? FROM_SOURCE_RE.exec(implTrait)?.[1] : undefined;
}

/** Row access the bridges borrow from the query layer. */
export interface BridgeSource {
	root: string;
	rows<T>(sql: string, params?: Array<string | number>): T[];
	/** ` AND (…)` limiting `f.path` to the query scope, with its bind parameters. */
	scopeClause(): { sql: string; params: Array<string | number> };
}

/** Rust sites naming a Solidity event, grouped by enclosing symbol. */
export interface DecodeGroup extends RefGroup {
	/** The scope decodes logs (`decode_log_data`, `SIGNATURE_HASH`, …) rather than merely mentioning the event. */
	decoder: boolean;
}

/** Internal Rust type an event turns into, and how. */
export interface BecomeHit {
	target: SymbolRow;
	via: string;
}

/** One `impl From<A> for B`; `def` is the definition of the other end when indexed. */
export interface ConvertHit {
	name: string;
	impl: SymbolRow;
	def: SymbolRow | undefined;
}

/** A Noir binary package: its directory, the names Rust may call it by, and its `main`. */
export interface Circuit {
	dir: string;
	names: string[];
	main: SymbolRow | undefined;
}

/** Rust site naming a circuit and the circuit it names. */
export interface CircuitUse {
	circuit: Circuit;
	row: RefRow;
}

export class Bridges {
	readonly #src: BridgeSource;
	#events: Set<string> | undefined;
	#contractFunctions: Set<string> | undefined;
	#circuits: Circuit[] | undefined;
	#variants: Set<string> | undefined;

	constructor(src: BridgeSource) {
		this.#src = src;
	}

	#rows<T>(sql: string, params: Array<string | number> = []): T[] {
		return this.#src.rows<T>(sql, params);
	}

	/** Names of Solidity `event` declarations anywhere in the index. */
	#eventNames(): Set<string> {
		this.#events ??= new Set(
			this.#rows<{ name: string }>("SELECT DISTINCT name FROM symbols WHERE kind = 'event'").map(r => r.name),
		);
		return this.#events;
	}

	isEvent(name: string): boolean {
		return this.#eventNames().has(name);
	}

	/** Definitions of the Solidity event `name`. */
	eventDefs(name: string): SymbolRow[] {
		const scope = this.#src.scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.name = ? AND s.kind = 'event'${scope.sql} ORDER BY f.path, s.start_line LIMIT ${TARGETS_CAP}`,
			[name, ...scope.params],
		);
	}

	/** Rust struct/enum definitions named `name`, structs first. */
	typeDefs(name: string): SymbolRow[] {
		const scope = this.#src.scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.name = ? AND s.kind IN ('struct', 'enum') AND f.path LIKE '%.rs'${scope.sql}
			ORDER BY ${TEST_SQL}, (s.kind = 'enum'), f.path, s.start_line LIMIT ${TARGETS_CAP}`,
			[name, ...scope.params],
		);
	}

	// decodes

	/** Rust sites naming Solidity event `event`, grouped by enclosing symbol, decoders first. */
	decodeSites(event: string): DecodeGroup[] {
		if (!this.isEvent(event)) return [];
		const scope = this.#src.scopeClause();
		const rows = this.#rows<RefRow>(
			`${REF_SELECT} WHERE r.name = ? AND r.kind IN ('type', 'path', 'construct') AND f.path LIKE '%.rs'
				AND COALESCE(s.kind, '') NOT IN ('struct', 'enum', 'impl')
				AND NOT (COALESCE(p.kind, '') = 'impl' AND p.name = r.name)${scope.sql}
			ORDER BY ${TEST_SQL}, f.path, r.line LIMIT ${SITE_FETCH_LIMIT}`,
			[event, ...scope.params],
		);
		const groups = groupByScope(rows);
		const ids = groups.flatMap(group => (group.row.sid === null ? [] : [group.row.sid]));
		const decoders = new Set<number>();
		if (ids.length > 0) {
			for (const row of this.#rows<{ id: number }>(
				`SELECT DISTINCT scope_symbol_id AS id FROM refs WHERE scope_symbol_id IN (${placeholders(ids.length)})
					AND name IN (${placeholders(DECODER_MARKER_NAMES.length)})`,
				[...ids, ...DECODER_MARKER_NAMES],
			)) {
				decoders.add(row.id);
			}
		}
		const sites = groups.map<DecodeGroup>(group => ({
			...group,
			decoder: group.row.sid !== null && decoders.has(group.row.sid),
		}));
		return [...sites.filter(site => site.decoder), ...sites.filter(site => !site.decoder)];
	}

	/** Solidity events a decoder scope (one that decodes logs or names `SIGNATURE_HASH`) refers to. */
	decodedEvents(scopeId: number): string[] {
		const refs = this.#rows<{ name: string; kind: string }>("SELECT name, kind FROM refs WHERE scope_symbol_id = ?", [
			scopeId,
		]);
		if (!refs.some(ref => Object.hasOwn(DECODER_MARKERS, ref.name))) return [];
		return [...new Set(refs.filter(ref => ref.kind !== "import" && this.isEvent(ref.name)).map(ref => ref.name))];
	}

	// becomes

	/** Rust structs whose span holds a `type` ref to event `event`: the wrappers decoded logs are put in. */
	#wrappers(event: string): SymbolRow[] {
		const scope = this.#src.scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind = 'struct' AND f.path LIKE '%.rs'
				AND s.id IN (SELECT scope_symbol_id FROM refs WHERE name = ? AND kind = 'type')${scope.sql}
			ORDER BY ${TEST_SQL}, f.path, s.start_line LIMIT ${WRAPPER_CAP}`,
			[event, ...scope.params],
		).filter(wrapper => this.#eventsOfWrapper(wrapper.name).length === 1);
	}

	/** `impl From<…W…> for T` blocks whose source type is exactly `wrapper`. */
	#fromImpls(wrapper: string): SymbolRow[] {
		const scope = this.#src.scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind = 'impl' AND s.impl_trait LIKE ?${scope.sql} ORDER BY f.path, s.start_line`,
			[`From<%${wrapper}%`, ...scope.params],
		).filter(impl => fromSource(impl.implTrait) === wrapper);
	}

	/** Struct/enum definitions named in the return type of `impl wrapper` methods (`try_into_x(self) -> Result<X>`). */
	#returnTargets(wrapper: SymbolRow, event: string): Array<{ method: SymbolRow; def: SymbolRow }> {
		const scope = this.#src.scopeClause();
		const methods = this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind IN ('function', 'method') AND p.kind = 'impl' AND p.name = ? AND s.signature LIKE '%->%'${scope.sql}
			ORDER BY f.path, s.start_line`,
			[wrapper.name, ...scope.params],
		);
		const out: Array<{ method: SymbolRow; def: SymbolRow }> = [];
		for (const method of methods) {
			if (!isConversion(method.name, wrapper.name, event)) continue;
			const returned = method.signature.slice(method.signature.indexOf("->") + 2);
			const names = [...returned.matchAll(/\b[A-Za-z_]\w*\b/g)]
				.map(match => match[0])
				.filter(name => !Object.hasOwn(RETURN_NOISE, name) && name !== wrapper.name);
			for (const name of [...new Set(names)].slice(0, 2)) {
				const def = this.typeDefs(name)[0];
				if (def && def.id !== wrapper.id) out.push({ method, def });
			}
		}
		return out;
	}

	/** `construct` names in `scopeId` after a ref to `event` (at one of `lines`) and before the next ref to a different event. */
	#constructedAfter(scopeId: number, event: string, lines: number[]): string[] {
		const refs = this.#rows<{ name: string; kind: string; line: number }>(
			"SELECT name, kind, line FROM refs WHERE scope_symbol_id = ? ORDER BY line, rowid",
			[scopeId],
		);
		const events = this.#eventNames();
		const names: string[] = [];
		for (const start of lines) {
			let end = Number.POSITIVE_INFINITY;
			for (const ref of refs) {
				if (ref.line > start && ref.name !== event && events.has(ref.name) && ref.kind !== "import") {
					end = ref.line;
					break;
				}
			}
			for (const ref of refs) {
				if (ref.kind === "construct" && ref.line >= start && ref.line < end) names.push(ref.name);
			}
		}
		return [...new Set(names)];
	}

	/** Internal Rust types Solidity event `event` turns into, structs before enums. */
	becomes(event: string): BecomeHit[] {
		if (!this.isEvent(event)) return [];
		const hits = new Map<number, BecomeHit>();
		const add = (def: SymbolRow, via: string): void => {
			if (!hits.has(def.id)) hits.set(def.id, { target: def, via });
		};
		const wrappers = this.#wrappers(event);
		const wrapperNames = new Set(wrappers.map(wrapper => wrapper.name));
		for (const wrapper of wrappers) {
			for (const impl of this.#fromImpls(wrapper.name)) {
				const target = lastTypeName(impl.implFor ?? "");
				if (target === "" || target === wrapper.name) continue;
				for (const def of this.typeDefs(target)) add(def, `From<${wrapper.name}>`);
			}
			for (const { method, def } of this.#returnTargets(wrapper, event)) add(def, `${wrapper.name}::${method.name}`);
		}
		for (const group of this.decodeSites(event)) {
			if (!group.decoder || group.row.sid === null) continue;
			for (const name of this.#constructedAfter(group.row.sid, event, group.lines)) {
				if (wrapperNames.has(name)) continue;
				for (const def of this.typeDefs(name)) add(def, "built in the decoder");
			}
		}
		return [...hits.values()].sort((a, b) => Number(a.target.kind === "enum") - Number(b.target.kind === "enum"));
	}

	/** Solidity events of the wrapper struct named `wrapper`. */
	#eventsOfWrapper(wrapper: string): SymbolRow[] {
		const refs = this.#rows<{ name: string }>(
			`SELECT DISTINCT r.name FROM refs r JOIN symbols s ON s.id = r.scope_symbol_id
			WHERE s.kind = 'struct' AND s.name = ? AND r.kind = 'type'`,
			[wrapper],
		).filter(row => this.isEvent(row.name));
		// A struct holding several events is state, not the wrapper of any one decode.
		return refs.length === 1 ? refs.flatMap(row => this.eventDefs(row.name)) : [];
	}

	/** Solidity events that turn into Rust type `type`, the reverse of {@link becomes}. */
	becomesFrom(type: string): Array<{ event: SymbolRow; via: string }> {
		const hits = new Map<number, { event: SymbolRow; via: string }>();
		const add = (event: SymbolRow, via: string): void => {
			if (!hits.has(event.id)) hits.set(event.id, { event, via });
		};
		for (const impl of this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind = 'impl' AND s.name = ? AND s.impl_trait LIKE 'From<%'`,
			[type],
		)) {
			const wrapper = fromSource(impl.implTrait);
			if (wrapper === undefined) continue;
			for (const event of this.#eventsOfWrapper(wrapper)) add(event, `From<${wrapper}>`);
		}
		for (const method of this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind IN ('function', 'method') AND p.kind = 'impl' AND s.signature LIKE ?`,
			[`%->%${type}%`],
		)) {
			const returned = method.signature.slice(method.signature.indexOf("->") + 2);
			if (!new RegExp(`\\b${type}\\b`).test(returned) || method.parentName === null) continue;
			for (const event of this.#eventsOfWrapper(method.parentName)) {
				if (isConversion(method.name, method.parentName, event.name))
					add(event, `${method.parentName}::${method.name}`);
			}
		}
		const scopes = this.#rows<{ sid: number | null }>(
			`SELECT DISTINCT r.scope_symbol_id AS sid FROM refs r JOIN files f ON f.id = r.file_id
			WHERE r.name = ? AND r.kind = 'construct' AND f.path LIKE '%.rs' AND r.scope_symbol_id IS NOT NULL LIMIT ${CONSTRUCT_CAP}`,
			[type],
		).flatMap(row => (row.sid === null ? [] : [row.sid]));
		if (scopes.length > 0) {
			const refs = this.#rows<{ sid: number; name: string; kind: string; line: number }>(
				`SELECT scope_symbol_id AS sid, name, kind, line FROM refs WHERE scope_symbol_id IN (${placeholders(scopes.length)})
				ORDER BY sid, line, rowid`,
				scopes,
			);
			// Only decoder scopes (those that decode logs) turn an event into a type by building it.
			const decoderScopes = new Set(
				refs.filter(ref => Object.hasOwn(DECODER_MARKERS, ref.name)).map(ref => ref.sid),
			);
			const latest = new Map<number, string>();
			const built = new Set<number>();
			for (const ref of refs) {
				if (!decoderScopes.has(ref.sid) || built.has(ref.sid) || ref.kind === "import") continue;
				if (ref.name === type && ref.kind === "construct") built.add(ref.sid);
				else if (this.isEvent(ref.name)) latest.set(ref.sid, ref.name);
			}
			for (const event of new Set(latest.values())) {
				for (const def of this.eventDefs(event)) add(def, "built in the decoder");
			}
		}
		// A type that nearly every event converts into (the broad event enum) is a hub, not a step.
		if (hits.size > HUB_SOURCES) return [];
		return [...hits.values()];
	}

	// converts

	/** `impl From<name> for B` blocks: what `name` converts to. */
	convertsTo(name: string): ConvertHit[] {
		return this.#fromImpls(name).map(impl => {
			const target = lastTypeName(impl.implFor ?? "");
			return { name: target, impl, def: this.typeDefs(target)[0] };
		});
	}

	/** `impl From<A> for name` blocks: what converts into `name`. */
	convertedFrom(name: string): ConvertHit[] {
		const scope = this.#src.scopeClause();
		const impls = this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.kind = 'impl' AND s.name = ? AND s.impl_trait LIKE 'From<%'${scope.sql} ORDER BY f.path, s.start_line`,
			[name, ...scope.params],
		);
		const hits: ConvertHit[] = [];
		for (const impl of impls) {
			const source = fromSource(impl.implTrait);
			if (source !== undefined) hits.push({ name: source, impl, def: this.typeDefs(source)[0] });
		}
		return hits;
	}

	// calls-contract

	/** Names of Solidity functions a Rust call can plausibly target (see the file header for the rule). */
	#contractFunctionNames(): Set<string> {
		if (this.#contractFunctions) return this.#contractFunctions;
		// Names Rust defines itself (`validate`, `register`) are ordinary calls, not contract calls.
		const rustDefined = new Set(
			this.#rows<{ name: string }>(
				`SELECT DISTINCT s.name FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind IN ('function', 'method') AND f.path LIKE '%.rs'`,
			).map(row => row.name),
		);
		this.#contractFunctions = new Set(
			this.#rows<{ name: string }>(
				`SELECT DISTINCT s.name FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind = 'function' AND s.name != 'constructor' AND f.path LIKE '%.sol'`,
			)
				.map(row => row.name)
				.filter(
					name =>
						(/[A-Z]/.test(name) || name.length >= 8) &&
						!Object.hasOwn(GENERIC_CONTRACT_NAMES, name) &&
						!rustDefined.has(name),
				),
		);
		return this.#contractFunctions;
	}

	isContractFunction(name: string): boolean {
		return this.#contractFunctionNames().has(name);
	}

	/** Solidity function definitions named `name`, implementations before interface declarations. */
	contractDefs(name: string): SymbolRow[] {
		if (!this.isContractFunction(name)) return [];
		const scope = this.#src.scopeClause();
		return this.#rows<SymbolRow>(
			`${SYMBOL_SELECT} WHERE s.name = ? AND s.kind = 'function' AND f.path LIKE '%.sol'${scope.sql}
			ORDER BY (COALESCE(p.kind, '') = 'interface'), ${TEST_SQL}, f.path, s.start_line LIMIT ${TARGETS_CAP}`,
			[name, ...scope.params],
		);
	}

	/** Rust `call` refs to the Solidity function `name`. */
	contractCallers(name: string): RefRow[] {
		if (!this.isContractFunction(name)) return [];
		const scope = this.#src.scopeClause();
		return this.#rows<RefRow>(
			`${REF_SELECT} WHERE r.name = ? AND r.kind = 'call' AND f.path LIKE '%.rs'${scope.sql}
			ORDER BY ${TEST_SQL}, f.path, r.line LIMIT ${SITE_FETCH_LIMIT}`,
			[name, ...scope.params],
		);
	}

	/** Distinct contract-function names called from within any of `scopeIds`, most-called first. */
	contractCalleeNames(scopeIds: number[]): string[] {
		if (scopeIds.length === 0) return [];
		return this.#rows<{ name: string }>(
			`SELECT name FROM refs r WHERE r.scope_symbol_id IN (${placeholders(scopeIds.length)}) AND r.kind = 'call'
				AND r.file_id IN (SELECT id FROM files WHERE path LIKE '%.rs')
			GROUP BY name ORDER BY COUNT(*) DESC, name`,
			scopeIds,
		)
			.map(row => row.name)
			.filter(name => this.isContractFunction(name));
	}

	// proves-with

	/** Noir binary packages (`<pkg>/src/main.nr`), named by `Nargo.toml` and directory. */
	circuits(): Circuit[] {
		if (this.#circuits) return this.#circuits;
		const files = this.#rows<{ path: string }>(
			"SELECT path FROM files WHERE path LIKE '%.nr' AND (path LIKE '%/src/main.nr' OR path = 'src/main.nr') ORDER BY path",
		);
		const circuits: Circuit[] = [];
		for (const file of files) {
			const dir = path.posix.dirname(path.posix.dirname(file.path));
			const names = new Set<string>([path.posix.basename(dir === "." ? this.#src.root : dir)]);
			try {
				const manifest = fs.readFileSync(path.join(this.#src.root, dir, "Nargo.toml"), "utf8");
				const section = manifest.split(/^\s*\[package\]\s*$/m)[1]?.split(/^\s*\[/m)[0] ?? "";
				const declared = /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1];
				if (declared) names.add(declared);
			} catch {
				// No readable manifest: the directory name stands in.
			}
			const main = this.#rows<SymbolRow>(
				`${SYMBOL_SELECT} WHERE f.path = ? AND s.name = 'main' AND s.kind = 'function'`,
				[file.path],
			)[0];
			circuits.push({ dir, names: [...names], main });
		}
		this.#circuits = circuits;
		return circuits;
	}

	/** Circuits Rust may call `name` (package name, directory name, or the `Nargo.toml` name). */
	circuitsNamed(name: string): Circuit[] {
		return this.circuits().filter(circuit => circuit.names.includes(name));
	}

	/** Rust `string` refs naming one of `circuit`'s names, each a place Rust refers to the circuit. */
	circuitUses(circuit: Circuit): RefRow[] {
		const scope = this.#src.scopeClause();
		return this.#rows<RefRow>(
			`${REF_SELECT} WHERE r.kind = 'string' AND r.name IN (${placeholders(circuit.names.length)}) AND f.path LIKE '%.rs'${scope.sql}
			ORDER BY ${TEST_SQL}, f.path, r.line LIMIT ${SITE_FETCH_LIMIT}`,
			[...circuit.names, ...scope.params],
		);
	}

	/** Circuits named by the string literal on the same line as a ref named `name` (`Variant => "share_decryption"`). */
	circuitsByAlias(name: string): CircuitUse[] {
		if (this.circuits().length === 0) return [];
		const scope = this.#src.scopeClause();
		const rows = this.#rows<RefRow & { strName: string }>(
			`${REF_SELECT.replace("SELECT ", "SELECT str.name AS strName, ")} JOIN refs str ON str.file_id = r.file_id AND str.line = r.line AND str.kind = 'string'
			WHERE r.name = ? AND r.kind IN ('path', 'type', 'construct') AND f.path LIKE '%.rs'${scope.sql} ORDER BY f.path, r.line LIMIT ${SITE_FETCH_LIMIT}`,
			[name, ...scope.params],
		);
		// A group string on another line of the same file (`ThresholdShareDecryption => "threshold"`) picks between
		// circuits sharing a package name by their parent directory (`circuits/bin/threshold/share_decryption`).
		const strings = new Map<string, Set<string>>();
		for (const row of rows) {
			let names = strings.get(row.refPath);
			if (!names) strings.set(row.refPath, (names = new Set()));
			names.add(row.strName);
		}
		const uses: CircuitUse[] = [];
		for (const row of rows) {
			let candidates = this.circuitsNamed(row.strName);
			if (candidates.length > 1) {
				const grouped = candidates.filter(circuit =>
					strings.get(row.refPath)?.has(path.posix.basename(path.posix.dirname(circuit.dir))),
				);
				if (grouped.length > 0) candidates = grouped;
			}
			for (const circuit of candidates) uses.push({ circuit, row });
		}
		return uses;
	}

	/** Enum-variant names that sit on the same line as a string naming a circuit (`Variant => "share_decryption"`). */
	#aliasVariants(): Set<string> {
		if (!this.#variants) {
			const names = this.circuits().flatMap(circuit => circuit.names);
			this.#variants = new Set(
				names.length === 0
					? []
					: this.#rows<{ name: string }>(
							`SELECT DISTINCT r.name FROM refs r JOIN refs str ON str.file_id = r.file_id AND str.line = r.line
							WHERE r.kind = 'path' AND str.kind = 'string' AND str.name IN (${placeholders(names.length)})`,
							names,
						).map(row => row.name),
			);
		}
		return this.#variants;
	}

	/** Circuits named within any of `scopeIds`: by a string literal of the package name, or by its enum variant. */
	circuitsUsedIn(scopeIds: number[]): Circuit[] {
		if (scopeIds.length === 0 || this.circuits().length === 0) return [];
		const refs = this.#rows<{ name: string; kind: string }>(
			`SELECT DISTINCT name, kind FROM refs WHERE scope_symbol_id IN (${placeholders(scopeIds.length)}) AND kind IN ('string', 'path')`,
			scopeIds,
		);
		const strings = new Set(refs.filter(ref => ref.kind === "string").map(ref => ref.name));
		const used = new Set(this.circuits().filter(circuit => circuit.names.some(name => strings.has(name))));
		const variants = this.#aliasVariants();
		for (const ref of refs) {
			if (ref.kind !== "path" || !variants.has(ref.name)) continue;
			for (const use of this.circuitsByAlias(ref.name)) used.add(use.circuit);
		}
		return [...used];
	}

	/** The circuit whose `main` is symbol `id`, if any. */
	circuitOfMain(id: number): Circuit | undefined {
		return this.circuits().find(circuit => circuit.main?.id === id);
	}
}
