/**
 * Persistent symbol/reference store behind `codemap`: SQLite schema, and the
 * incremental refresh that keeps it in step with the working tree. Only files
 * whose (mtime, size) changed are re-extracted; removed files drop out in the
 * same transaction.
 *
 * ```text
 * files    (id, path UNIQUE, mtime_ms, size, language, parsed)
 * symbols  (id, file_id, idx, name, name_lc, words, kind, start_line, end_line,
 *           signature, doc, parent_id, impl_trait, impl_for)
 * refs     (file_id, name, line, kind, scope_symbol_id, callee)
 * meta     (key, value)             schema version, root, last build stats
 * symbols_fts  FTS5 over (name words, signature, doc, path words), rowid = symbols.id
 * ```
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractSymbolsAsync, type SymbolResult } from "@oh-my-pi/pi-natives";
import { getJudgmentCacheDbPath, openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { listFiles } from "../tools/jfind/tree";
import { splitWords } from "./words";

/** Bumped whenever the tables or the derivation of stored columns change; a mismatch rebuilds from scratch. */
export const SCHEMA_VERSION = "3";

/** Source extensions the native extractor understands. */
const SOURCE_EXTENSIONS: Record<string, true> = {
	".rs": true,
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".sol": true,
	".py": true,
	".go": true,
	".nr": true,
};

/** Files above this size are not indexed (generated bundles, vendored blobs). */
const MAX_FILE_BYTES = 1024 * 1024;

/** Extractions in flight at once. */
const PARALLEL_EXTRACTIONS = 16;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	mtime_ms REAL NOT NULL,
	size INTEGER NOT NULL,
	language TEXT,
	parsed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	idx INTEGER NOT NULL,
	name TEXT NOT NULL,
	name_lc TEXT NOT NULL,
	words TEXT NOT NULL,
	kind TEXT NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	signature TEXT NOT NULL,
	doc TEXT,
	parent_id INTEGER,
	impl_trait TEXT,
	impl_for TEXT
);
CREATE TABLE IF NOT EXISTS refs (
	file_id INTEGER NOT NULL,
	name TEXT NOT NULL,
	line INTEGER NOT NULL,
	kind TEXT NOT NULL,
	scope_symbol_id INTEGER,
	callee TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_name_lc ON symbols(name_lc);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_scope ON refs(scope_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
`;

const DROP_TABLES = `
DROP TABLE IF EXISTS symbols_fts;
DROP TABLE IF EXISTS refs;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS meta;
`;

/** Counts and timing of one {@link refreshIndex}. */
export interface BuildStats {
	/** Indexable source files under the root (supported extension, within the size limit). */
	files: number;
	/** Files re-extracted this run (new or changed). */
	reparsed: number;
	/** Files whose (mtime, size) matched the stored row. */
	unchanged: number;
	/** Files dropped from the index because they disappeared or became ineligible. */
	removed: number;
	/** Supported-extension files skipped for exceeding {@link MAX_FILE_BYTES}. */
	oversized: number;
	/** Re-extracted files the extractor could not parse. */
	unparsed: number;
	/** Symbols and references written this run. */
	symbols: number;
	refs: number;
	/** Wall time of the whole refresh. */
	ms: number;
}

/** An open index: the database plus whether FTS5 backs search. */
export interface CodemapDb {
	db: Database;
	fts: boolean;
	root: string;
	dbPath: string;
}

/** Index location for `root`: `<cache dir>/codemap/<sha256(root) first 16 hex>.sqlite`. */
export function codemapDbPath(root: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 16);
	return path.join(path.dirname(getJudgmentCacheDbPath()), "codemap", `${digest}.sqlite`);
}

function schemaCurrent(db: Database): boolean {
	try {
		const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
		return row?.value === SCHEMA_VERSION;
	} catch {
		return false;
	}
}

/** Create the tables (and FTS5 table when this SQLite build has it); returns whether FTS5 is available. */
function initialize(db: Database, root: string): boolean {
	db.run("PRAGMA journal_mode=WAL");
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA busy_timeout=15000");
	if (!schemaCurrent(db)) db.run(DROP_TABLES);
	db.run(TABLES);
	let fts = true;
	try {
		db.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(words, signature, doc, path, tokenize='porter unicode61')",
		);
	} catch {
		fts = false;
	}
	db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
	db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('root', ?)", [root]);
	return fts;
}

/** Open (creating if needed) the index for `root`, quarantining a corrupt store once. */
export function openIndex(root: string): CodemapDb {
	const dbPath = codemapDbPath(root);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	return openSqliteDatabaseSync(dbPath, db => ({ db, fts: initialize(db, root), root, dbPath }), {
		recoverCorruption: true,
	});
}

interface Extracted {
	rel: string;
	mtimeMs: number;
	size: number;
	result: SymbolResult;
}

interface PreparedWrites {
	findFile: Statement<{ id: number }, [string]>;
	deleteFts: Statement<unknown, [number]>;
	deleteRefs: Statement<unknown, [number]>;
	deleteSymbols: Statement<unknown, [number]>;
	deleteFile: Statement<unknown, [number]>;
	insertFile: Statement<unknown, [number, string, number, number, string | null, number]>;
	insertSymbol: Statement<
		unknown,
		[
			number,
			number,
			number,
			string,
			string,
			string,
			string,
			number,
			number,
			string,
			string | null,
			number | null,
			string | null,
			string | null,
		]
	>;
	insertRef: Statement<unknown, [number, string, number, string, number | null, string | null]>;
	insertFts: Statement<unknown, [number, string, string, string, string]> | undefined;
}

function prepareWrites(index: CodemapDb): PreparedWrites {
	const { db } = index;
	return {
		findFile: db.prepare("SELECT id FROM files WHERE path = ?"),
		deleteFts: db.prepare("DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)"),
		deleteRefs: db.prepare("DELETE FROM refs WHERE file_id = ?"),
		deleteSymbols: db.prepare("DELETE FROM symbols WHERE file_id = ?"),
		deleteFile: db.prepare("DELETE FROM files WHERE id = ?"),
		insertFile: db.prepare(
			"INSERT INTO files (id, path, mtime_ms, size, language, parsed) VALUES (?, ?, ?, ?, ?, ?)",
		),
		insertSymbol: db.prepare(
			`INSERT INTO symbols (id, file_id, idx, name, name_lc, words, kind, start_line, end_line, signature, doc, parent_id, impl_trait, impl_for)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),
		insertRef: db.prepare(
			"INSERT INTO refs (file_id, name, line, kind, scope_symbol_id, callee) VALUES (?, ?, ?, ?, ?, ?)",
		),
		insertFts: index.fts
			? db.prepare("INSERT INTO symbols_fts (rowid, words, signature, doc, path) VALUES (?, ?, ?, ?, ?)")
			: undefined,
	};
}

function dropFile(sql: PreparedWrites, fileId: number, fts: boolean): void {
	if (fts) sql.deleteFts.run(fileId);
	sql.deleteRefs.run(fileId);
	sql.deleteSymbols.run(fileId);
	sql.deleteFile.run(fileId);
}

/**
 * Re-extract changed files and drop vanished ones so the index mirrors the
 * tree under `index.root`. Cheap when nothing changed: one directory walk and
 * one comparison per source file.
 */
export async function refreshIndex(index: CodemapDb, signal?: AbortSignal): Promise<BuildStats> {
	const started = performance.now();
	const { db, root } = index;
	const filesystem = new InternalUrlFilesystem({ context: { cwd: root }, tier: "read" });
	const listed = await listFiles(
		{ path: root, type: "directory" },
		{ includeHidden: false, filesystem: filesystem.shellFilesystem(), signal },
	);

	const stored = new Map<string, { mtime_ms: number; size: number }>();
	for (const row of db
		.query<{ path: string; mtime_ms: number; size: number }, []>("SELECT path, mtime_ms, size FROM files")
		.all()) {
		stored.set(row.path, row);
	}

	let oversized = 0;
	const present = new Set<string>();
	const changed: Array<{ rel: string; abs: string; mtimeMs: number; size: number }> = [];
	for (const entry of listed) {
		if (!Object.hasOwn(SOURCE_EXTENSIONS, path.extname(entry.rel))) continue;
		if (entry.size > MAX_FILE_BYTES) {
			oversized++;
			continue;
		}
		present.add(entry.rel);
		const mtimeMs = entry.mtimeMs ?? (await fs.promises.stat(entry.path)).mtimeMs;
		const prior = stored.get(entry.rel);
		if (prior && prior.mtime_ms === mtimeMs && prior.size === entry.size) continue;
		changed.push({ rel: entry.rel, abs: entry.path, mtimeMs, size: entry.size });
	}
	const removed: string[] = [];
	for (const rel of stored.keys()) if (!present.has(rel)) removed.push(rel);

	const extracted: Extracted[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < changed.length) {
			if (signal?.aborted) return;
			const job = changed[next++]!;
			let result: SymbolResult;
			try {
				const code = await Bun.file(job.abs).text();
				result = await extractSymbolsAsync({ code, path: job.rel });
			} catch {
				result = { parsed: false, symbols: [], refs: [] };
			}
			extracted.push({ rel: job.rel, mtimeMs: job.mtimeMs, size: job.size, result });
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL_EXTRACTIONS, changed.length) }, worker));
	signal?.throwIfAborted();

	let symbols = 0;
	let refs = 0;
	let unparsed = 0;
	for (const item of extracted) if (!item.result.parsed) unparsed++;

	if (removed.length > 0 || extracted.length > 0) {
		const sql = prepareWrites(index);
		const write = db.transaction(() => {
			// Ids are assigned here, inside the write lock, so a concurrent refresh that committed first cannot collide.
			let nextFileId = (db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM files").get()?.id ?? 0) + 1;
			let nextSymbolId =
				(db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM symbols").get()?.id ?? 0) + 1;
			for (const rel of removed) {
				const row = sql.findFile.get(rel);
				if (row) dropFile(sql, row.id, index.fts);
			}
			for (const item of extracted) {
				const existing = sql.findFile.get(item.rel);
				if (existing) dropFile(sql, existing.id, index.fts);
				const fileId = nextFileId++;
				const { result } = item;
				sql.insertFile.run(
					fileId,
					item.rel,
					item.mtimeMs,
					item.size,
					result.language ?? null,
					result.parsed ? 1 : 0,
				);
				const pathWords = splitWords(item.rel).join(" ");
				const baseId = nextSymbolId;
				nextSymbolId += result.symbols.length;
				const count = result.symbols.length;
				for (let i = 0; i < count; i++) {
					const symbol = result.symbols[i]!;
					const words = splitWords(symbol.name).join(" ");
					const parentId = symbol.parent !== undefined && symbol.parent < count ? baseId + symbol.parent : null;
					sql.insertSymbol.run(
						baseId + i,
						fileId,
						i,
						symbol.name,
						symbol.name.toLowerCase(),
						words,
						symbol.kind,
						symbol.startLine,
						symbol.endLine,
						symbol.signature,
						symbol.doc ?? null,
						parentId,
						symbol.implTrait ?? null,
						symbol.implFor ?? null,
					);
					sql.insertFts?.run(baseId + i, words, symbol.signature, symbol.doc ?? "", pathWords);
				}
				for (const ref of result.refs) {
					const scope = ref.scope !== undefined && ref.scope < count ? baseId + ref.scope : null;
					sql.insertRef.run(fileId, ref.name, ref.line, ref.kind, scope, ref.callee ?? null);
				}
				symbols += count;
				refs += result.refs.length;
			}
		});
		write.immediate();
	}

	const stats: BuildStats = {
		files: present.size,
		reparsed: extracted.length,
		unchanged: present.size - changed.length,
		removed: removed.length,
		oversized,
		unparsed,
		symbols,
		refs,
		ms: performance.now() - started,
	};
	db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_build', ?)", [JSON.stringify(stats)]);
	return stats;
}
