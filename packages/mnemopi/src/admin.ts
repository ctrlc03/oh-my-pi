/**
 * Owner-side access to a Mnemopi bank for the collab companion (docs/personal-agent.md): search, inspect,
 * retract, pin, export, build the nightly review's input and take consistent snapshots, all without a
 * session and without ever loading an embedder. Types are in `./admin-types.ts`.
 *
 * Nothing here deletes a row. A session may write the same file concurrently, so every connection uses WAL with
 * a busy timeout and every write is a single statement.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type {
	AdminDayRecord,
	AdminExportChunk,
	AdminMemory,
	AdminOrigin,
	AdminQuery,
	AdminSnapshot,
	AdminStats,
	MemoryAdmin,
	OpenMemoryAdminOptions,
} from "./admin-types";
import { initBeam } from "./core/beam/schema";
import { openDatabase } from "./db";
import { buildFtsQuery } from "./util/regex";

export type { MemoryAdmin, OpenMemoryAdminOptions } from "./admin-types";

/** The bank every session with `mnemopi.scoping: global` writes to; its name is also the rows' `session_id`. */
const BANK = "default";
const DB_FILENAME = "mnemopi.db";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** `recordForDay` shortens external rows to this many characters. */
const EXTERNAL_ROW_CHARS = 600;
const BUSY_TIMEOUT_MS = 5000;

type Row = Record<string, unknown>;
type Binding = string | number | null;

const COLUMNS = `id, content, source, timestamp, created_at, session_id, importance, metadata_json, recall_count,
	valid_until, superseded_by, author_id, author_type, trust_tier, event_date`;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function originOf(authorType: unknown): AdminOrigin {
	return authorType === "owner" || authorType === "external" ? authorType : "agent";
}

/** SQLite `CURRENT_TIMESTAMP` is `YYYY-MM-DD HH:MM:SS` in UTC; everything else Mnemopi writes is ISO 8601. */
function toIso(value: unknown): string | undefined {
	const text = asString(value);
	if (text === undefined) return undefined;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
	const time = Date.parse(normalized);
	return Number.isNaN(time) ? text : new Date(time).toISOString();
}

function splitId(id: string): { store: "working" | "episodic"; raw: string } | null {
	if (id.length < 3 || id[1] !== ":") return null;
	const raw = id.slice(2);
	if (id[0] === "w") return { store: "working", raw };
	if (id[0] === "e") return { store: "episodic", raw };
	return null;
}

function tableOf(store: "working" | "episodic"): string {
	return store === "working" ? "working_memory" : "episodic_memory";
}

function invalidNow(row: Row, nowIso: string): boolean {
	const validUntil = asString(row.valid_until);
	return (validUntil !== undefined && validUntil <= nowIso) || asString(row.superseded_by) !== undefined;
}

/** Fence markers inside untrusted text are defused so the text cannot close its own fence. */
function neutralizeFence(text: string): string {
	return text.replaceAll("<<<", "\u2039\u2039\u2039").replaceAll(">>>", "\u203a\u203a\u203a");
}

/** Same rule as the harness's `escapeHarnessTags`: only `irc` and `system-*` tags are defused. */
function escapeHarnessTags(text: string): string {
	return text.replace(/<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi, "&lt;");
}

function fenceUntrusted(source: string, text: string): string {
	const body = escapeHarnessTags(neutralizeFence(text));
	let nonce = crypto.randomUUID().slice(0, 8);
	while (body.includes(nonce)) nonce = crypto.randomUUID().slice(0, 8);
	const label = escapeHarnessTags(neutralizeFence(source.replaceAll("\n", " ")));
	return `<<<UNTRUSTED ${nonce} (${label})\n${body}\nUNTRUSTED ${nonce}>>>`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function localDayBounds(day: string): { start: string; end: string } {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) throw new RangeError(`Invalid day (expected YYYY-MM-DD): ${day}`);
	const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const start = new Date(year, month - 1, date);
	if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) {
		throw new RangeError(`Invalid day: ${day}`);
	}
	return { start: start.toISOString(), end: new Date(year, month - 1, date + 1).toISOString() };
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function localTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "??:??" : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** First column of the first row as a number (a missing table in an older bank counts as 0). */
function countRows(db: Database, sql: string): number {
	try {
		const value = db.query(sql).values()[0]?.[0];
		return typeof value === "number" ? value : 0;
	} catch {
		return 0;
	}
}

export function memoryDbPath(agentDir: string): string {
	return join(agentDir, "memories", "mnemopi", DB_FILENAME);
}

class SqliteMemoryAdmin implements MemoryAdmin {
	readonly dbPath: string;
	readonly #db: Database;
	readonly #readOnly: boolean;
	#export: { token: string; json: string; markdown: string } | undefined;

	constructor(options: OpenMemoryAdminOptions) {
		this.dbPath = memoryDbPath(options.agentDir);
		this.#readOnly = options.readOnly === true;
		if (this.#readOnly) {
			if (existsSync(this.dbPath)) {
				this.#db = new Database(this.dbPath, { readonly: true, strict: true });
				this.#db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
			} else {
				// No bank yet: an empty in-memory stand-in so every read answers "nothing" without creating files.
				this.#db = openDatabase(":memory:");
				initBeam(this.#db);
			}
		} else {
			this.#db = openDatabase(this.dbPath);
			initBeam(this.#db);
		}
	}

	#requireWritable(): void {
		if (this.#readOnly) throw new Error("Memory admin is open read-only");
	}

	/** Parts of the union that make up the memory list, with the filters of `query` applied to each. */
	#parts(query: AdminQuery): { sql: string; params: Binding[] } {
		const where: string[] = [];
		const filterParams: Binding[] = [];
		if (query.origin && query.origin.length > 0) {
			const clauses: string[] = [];
			for (const origin of new Set(query.origin)) {
				if (origin === "agent")
					clauses.push("(w.author_type IS NULL OR w.author_type NOT IN ('owner', 'external'))");
				else {
					clauses.push("w.author_type = ?");
					filterParams.push(origin);
				}
			}
			where.push(`(${clauses.join(" OR ")})`);
		}
		if (query.pinnedOnly) where.push("json_extract(w.metadata_json, '$.pinned') = 1");
		if (!query.includeInvalid) {
			where.push("w.superseded_by IS NULL AND (w.valid_until IS NULL OR w.valid_until > ?)");
			filterParams.push(new Date().toISOString());
		}
		if (query.since) {
			where.push("COALESCE(w.timestamp, w.created_at) >= ?");
			filterParams.push(new Date(query.since).toISOString());
		}
		if (query.until) {
			where.push("COALESCE(w.timestamp, w.created_at) <= ?");
			filterParams.push(new Date(query.until).toISOString());
		}
		const filter = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
		const text = query.q?.trim() ?? "";
		const fts = text === "" ? "" : buildFtsQuery(text);
		const select = (store: "w" | "e", rank: string) =>
			`SELECT '${store}' AS store, ${COLUMNS.split(",")
				.map(column => `w.${column.trim()}`)
				.join(", ")}, ${rank} AS rnk`;
		const parts: string[] = [];
		const params: Binding[] = [];
		if (text === "") {
			parts.push(`${select("w", "NULL")} FROM working_memory w WHERE 1 = 1${filter}`);
			parts.push(`${select("e", "NULL")} FROM episodic_memory w WHERE 1 = 1${filter}`);
			params.push(...filterParams, ...filterParams);
		} else if (fts === "") {
			const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
			parts.push(`${select("w", "NULL")} FROM working_memory w WHERE w.content LIKE ? ESCAPE '\\'${filter}`);
			parts.push(`${select("e", "NULL")} FROM episodic_memory w WHERE w.content LIKE ? ESCAPE '\\'${filter}`);
			params.push(like, ...filterParams, like, ...filterParams);
		} else {
			parts.push(
				`${select("w", "f.rank")} FROM fts_working f JOIN working_memory w ON w.id = f.id WHERE f.fts_working MATCH ?${filter}`,
			);
			parts.push(
				`${select("e", "f.rank")} FROM fts_episodes f JOIN episodic_memory w ON w.rowid = f.rowid WHERE f.fts_episodes MATCH ?${filter}`,
			);
			params.push(fts, ...filterParams, fts, ...filterParams);
		}
		return { sql: parts.join(" UNION ALL "), params };
	}

	#toMemory(row: Row, nowIso: string): AdminMemory {
		const store = row.store === "e" ? "episodic" : "working";
		const metadata = parseMetadata(row.metadata_json);
		const invalid = invalidNow(row, nowIso);
		const pinned = metadata.pinned === true;
		const memory: AdminMemory = {
			id: `${store === "working" ? "w" : "e"}:${String(row.id)}`,
			store,
			content: String(row.content ?? ""),
			createdAt: toIso(row.timestamp) ?? toIso(row.created_at) ?? new Date(0).toISOString(),
			origin: originOf(row.author_type),
			authorId: asString(row.author_id) ?? "",
			trustTier: asString(row.trust_tier) ?? "STATED",
			importance: typeof row.importance === "number" ? row.importance : 0.5,
			pinned,
			invalid,
			recallCount: typeof row.recall_count === "number" ? row.recall_count : 0,
		};
		const eventDate = asString(row.event_date);
		if (eventDate !== undefined) memory.eventDate = eventDate;
		if (invalid) {
			const invalidAt = toIso(row.valid_until);
			if (invalidAt !== undefined) memory.invalidAt = invalidAt;
			memory.invalidBy = metadata.retracted_by === "owner" ? "owner" : "agent";
		}
		const replacedBy = asString(row.superseded_by);
		if (replacedBy !== undefined) memory.replacedBy = this.#prefixedId(replacedBy);
		const sessionId = asString(row.session_id);
		if (sessionId !== undefined) memory.sessionId = sessionId;
		const replacesCount = this.#replacedCount(String(row.id), memory.id);
		if (replacesCount > 0) memory.replacesCount = replacesCount;
		return memory;
	}

	/** How many memories name this one in `superseded_by` (the column holds a raw or a prefixed id). */
	#replacedCount(raw: string, id: string): number {
		const row = this.#db
			.query(
				"SELECT (SELECT count(*) FROM working_memory WHERE superseded_by IN (?1, ?2)) + (SELECT count(*) FROM episodic_memory WHERE superseded_by IN (?1, ?2)) AS n",
			)
			.get(raw, id) as { n: number } | null;
		return row?.n ?? 0;
	}

	/** `superseded_by` stores a raw id; the admin API speaks `w:`/`e:` ids. */
	#prefixedId(raw: string): string {
		if (splitId(raw) !== null) return raw;
		const inWorking = this.#db.query("SELECT 1 AS hit FROM working_memory WHERE id = ?").get(raw);
		if (inWorking) return `w:${raw}`;
		const inEpisodic = this.#db.query("SELECT 1 AS hit FROM episodic_memory WHERE id = ?").get(raw);
		return inEpisodic ? `e:${raw}` : raw;
	}

	#row(id: string): Row | null {
		const parsed = splitId(id);
		if (parsed === null) return null;
		const row = this.#db
			.query(
				`SELECT '${parsed.store === "working" ? "w" : "e"}' AS store, ${COLUMNS} FROM ${tableOf(parsed.store)} WHERE id = ?`,
			)
			.get(parsed.raw) as Row | null;
		return row ?? null;
	}

	search(query: AdminQuery): { items: AdminMemory[]; total: number } {
		const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));
		const offset = Math.max(0, Math.trunc(query.offset ?? 0));
		const { sql, params } = this.#parts(query);
		const nowIso = new Date().toISOString();
		try {
			const counted = this.#db.query(`SELECT COUNT(*) FROM (${sql})`).values(...params)[0]?.[0];
			const total = typeof counted === "number" ? counted : 0;
			const rows = this.#db
				.query(`SELECT * FROM (${sql}) ORDER BY rnk ASC, timestamp DESC, id ASC LIMIT ? OFFSET ?`)
				.all(...params, limit, offset) as Row[];
			return { items: rows.map(row => this.#toMemory(row, nowIso)), total };
		} catch (error) {
			// An FTS5 syntax error from an odd query is "no match", not a failure of the whole panel.
			if (query.q && error instanceof Error && /fts5|syntax/i.test(error.message)) return { items: [], total: 0 };
			throw error;
		}
	}

	get(id: string): { memory: AdminMemory | null; replaces: AdminMemory[] } {
		const row = this.#row(id);
		if (row === null) return { memory: null, replaces: [] };
		const nowIso = new Date().toISOString();
		const raw = String(row.id);
		const replaces: AdminMemory[] = [];
		for (const store of ["working", "episodic"] as const) {
			const rows = this.#db
				.query(
					`SELECT '${store === "working" ? "w" : "e"}' AS store, ${COLUMNS} FROM ${tableOf(store)} WHERE superseded_by IN (?, ?) ORDER BY timestamp DESC`,
				)
				.all(raw, id) as Row[];
			for (const replaced of rows) replaces.push(this.#toMemory(replaced, nowIso));
		}
		return { memory: this.#toMemory(row, nowIso), replaces };
	}

	#writeMetadata(
		id: string,
		mutate: (metadata: Record<string, unknown>) => void,
		extra?: { importance?: number; invalidate?: boolean },
	): AdminMemory {
		this.#requireWritable();
		const parsed = splitId(id);
		const row = this.#row(id);
		if (parsed === null || row === null) throw new Error(`Unknown memory id: ${id}`);
		const metadata = parseMetadata(row.metadata_json);
		mutate(metadata);
		const sets = ["metadata_json = ?"];
		const params: Binding[] = [JSON.stringify(metadata)];
		if (extra?.importance !== undefined) {
			sets.push("importance = ?");
			params.push(extra.importance);
		}
		if (extra?.invalidate && asString(row.valid_until) === undefined) {
			sets.push("valid_until = ?");
			params.push(new Date().toISOString());
		}
		this.#db.run(
			`UPDATE ${tableOf(parsed.store)} SET ${sets.join(", ")} WHERE id = ? AND (session_id = ? OR scope = 'global')`,
			[...params, parsed.raw, BANK],
		);
		this.#export = undefined;
		const updated = this.#row(id);
		if (updated === null) throw new Error(`Unknown memory id: ${id}`);
		return this.#toMemory(updated, new Date().toISOString());
	}

	retract(id: string): AdminMemory {
		this.#requireWritable();
		const row = this.#row(id);
		if (row === null) throw new Error(`Unknown memory id: ${id}`);
		const current = parseMetadata(row.metadata_json);
		if (current.retracted_by === "owner" && asString(row.valid_until) !== undefined) {
			return this.#toMemory(row, new Date().toISOString());
		}
		return this.#writeMetadata(
			id,
			metadata => {
				metadata.retracted_by = "owner";
				metadata.retracted_at = new Date().toISOString();
			},
			{ invalidate: true },
		);
	}

	pin(id: string): AdminMemory {
		const row = this.#row(id);
		if (row === null) throw new Error(`Unknown memory id: ${id}`);
		this.#requireWritable();
		if (parseMetadata(row.metadata_json).pinned === true) return this.#toMemory(row, new Date().toISOString());
		const previous = typeof row.importance === "number" ? row.importance : 0.5;
		return this.#writeMetadata(
			id,
			metadata => {
				metadata.pinned = true;
				metadata.pinned_at = new Date().toISOString();
				metadata.pre_pin_importance = previous;
			},
			{ importance: 1.0 },
		);
	}

	unpin(id: string): AdminMemory {
		const row = this.#row(id);
		if (row === null) throw new Error(`Unknown memory id: ${id}`);
		this.#requireWritable();
		const current = parseMetadata(row.metadata_json);
		if (current.pinned !== true) return this.#toMemory(row, new Date().toISOString());
		const restored = typeof current.pre_pin_importance === "number" ? current.pre_pin_importance : 0.5;
		return this.#writeMetadata(
			id,
			metadata => {
				delete metadata.pinned;
				delete metadata.pinned_at;
				delete metadata.pre_pin_importance;
			},
			{ importance: restored },
		);
	}

	pinned(): AdminMemory[] {
		const nowIso = new Date().toISOString();
		const rows: Row[] = [];
		for (const store of ["working", "episodic"] as const) {
			rows.push(
				...(this.#db
					.query(
						`SELECT '${store === "working" ? "w" : "e"}' AS store, ${COLUMNS} FROM ${tableOf(store)}
						 WHERE json_extract(metadata_json, '$.pinned') = 1 AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?)`,
					)
					.all(nowIso) as Row[]),
			);
		}
		const pinnedAt = (row: Row): string => String(parseMetadata(row.metadata_json).pinned_at ?? row.timestamp ?? "");
		rows.sort((a, b) => pinnedAt(a).localeCompare(pinnedAt(b)));
		return rows.map(row => this.#toMemory(row, nowIso));
	}

	#allMemories(): AdminMemory[] {
		const nowIso = new Date().toISOString();
		const rows: Row[] = [];
		for (const store of ["working", "episodic"] as const) {
			rows.push(
				...(this.#db
					.query(`SELECT '${store === "working" ? "w" : "e"}' AS store, ${COLUMNS} FROM ${tableOf(store)}`)
					.all() as Row[]),
			);
		}
		const memories = rows.map(row => this.#toMemory(row, nowIso));
		memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
		return memories;
	}

	#exportText(format: "json" | "markdown"): string {
		const version = this.#db.query("PRAGMA data_version").values()[0]?.[0];
		const changes = this.#db.query("SELECT total_changes()").values()[0]?.[0];
		const token = `${String(version)}:${String(changes)}`;
		if (this.#export === undefined || this.#export.token !== token) {
			const memories = this.#allMemories();
			const json = JSON.stringify(
				{ format: "omp-personal-memory", version: 1, count: memories.length, memories },
				null,
				1,
			);
			const lines = ["# Personal agent memory", "", `${memories.length} memories, oldest first.`, ""];
			for (const memory of memories) {
				const flags = [
					memory.origin,
					memory.store,
					memory.pinned ? "pinned" : "",
					memory.invalid ? `invalid (${memory.invalidBy})` : "",
				]
					.filter(Boolean)
					.join(", ");
				lines.push(`## ${memory.id}`, "", `${memory.createdAt} \u00b7 ${flags}`);
				if (memory.replacedBy) lines.push("", `Replaced by ${memory.replacedBy}`);
				lines.push("", ...memory.content.split("\n").map(line => `> ${line}`), "");
			}
			this.#export = { token, json, markdown: lines.join("\n") };
		}
		return format === "json" ? this.#export.json : this.#export.markdown;
	}

	exportChunk(format: "json" | "markdown", offset: number, maxChars: number): AdminExportChunk {
		const text = this.#exportText(format);
		const start = Math.max(0, Math.trunc(offset));
		let end = Math.min(text.length, start + Math.max(2, Math.trunc(maxChars)));
		// Never cut a surrogate pair in two: the chunks travel as JSON strings.
		if (end < text.length && end > start + 1) {
			const last = text.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		}
		return {
			name: format === "json" ? "omp-personal-memory.json" : "omp-personal-memory.md",
			mime: format === "json" ? "application/json" : "text/markdown",
			text: text.slice(start, end),
			next: end >= text.length ? null : end,
		};
	}

	recordForDay(day: string, maxChars: number): AdminDayRecord {
		const { start, end } = localDayBounds(day);
		const nowIso = new Date().toISOString();
		const rows: Row[] = [];
		for (const store of ["working", "episodic"] as const) {
			rows.push(
				...(this.#db
					.query(
						`SELECT '${store === "working" ? "w" : "e"}' AS store, ${COLUMNS} FROM ${tableOf(store)}
						 WHERE COALESCE(timestamp, created_at) >= ? AND COALESCE(timestamp, created_at) < ?
						   AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?)`,
					)
					.all(start, end, nowIso) as Row[]),
			);
		}
		const entries = rows
			.map(row => this.#toMemory(row, nowIso))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.map(memory => {
				const header = `### ${localTime(memory.createdAt)} \u00b7 ${memory.origin} \u00b7 ${memory.id}`;
				const body =
					memory.origin === "external"
						? fenceUntrusted(
								memory.authorId.replace(/^external:/, "") || "external",
								clip(memory.content, EXTERNAL_ROW_CHARS),
							)
						: memory.content;
				return { memory, text: `${header}\n${body}\n\n` };
			});
		const heading = `## ${day}\n\n`;
		let budget = Math.max(0, Math.trunc(maxChars)) - heading.length;
		const kept: typeof entries = [];
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.text.length <= budget) {
				kept.push(entry);
				budget -= entry.text.length;
			} else if (kept.length === 0 && budget > 80) {
				kept.push({ memory: entry.memory, text: `${clip(entry.text, budget - 1)}\n` });
				budget = 0;
			} else break;
		}
		kept.reverse();
		const counts = { owner: 0, agent: 0, external: 0 };
		for (const entry of kept) counts[entry.memory.origin]++;
		const text =
			kept.length === 0
				? ""
				: `${heading}${kept.map(entry => entry.text).join("")}`.slice(0, Math.max(0, Math.trunc(maxChars)));
		return {
			day,
			text,
			memoryIds: kept.map(entry => entry.memory.id),
			counts,
			omitted: entries.length - kept.length,
		};
	}

	stats(): AdminStats {
		const nowIso = new Date().toISOString();
		const invalidSql = (table: string) =>
			`SELECT COUNT(*) AS total FROM ${table} WHERE superseded_by IS NOT NULL OR (valid_until IS NOT NULL AND valid_until <= '${nowIso}')`;
		const pinnedSql = (table: string) =>
			`SELECT COUNT(*) AS total FROM ${table} WHERE json_extract(metadata_json, '$.pinned') = 1 AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > '${nowIso}')`;
		const newest = [
			this.#db.query("SELECT MAX(COALESCE(timestamp, created_at)) FROM working_memory").values()[0]?.[0],
			this.#db.query("SELECT MAX(COALESCE(timestamp, created_at)) FROM episodic_memory").values()[0]?.[0],
		]
			.map(value => toIso(value))
			.filter((value): value is string => value !== undefined)
			.sort()
			.at(-1);
		const stats: AdminStats = {
			working: countRows(this.#db, "SELECT COUNT(*) AS total FROM working_memory"),
			episodic: countRows(this.#db, "SELECT COUNT(*) AS total FROM episodic_memory"),
			invalid:
				countRows(this.#db, invalidSql("working_memory")) + countRows(this.#db, invalidSql("episodic_memory")),
			pinned: countRows(this.#db, pinnedSql("working_memory")) + countRows(this.#db, pinnedSql("episodic_memory")),
		};
		if (newest !== undefined) stats.newestAt = newest;
		return stats;
	}

	async snapshot(destDir: string): Promise<AdminSnapshot> {
		mkdirSync(destDir, { recursive: true });
		const sources: { name: string; db: Database; owned: boolean }[] = [];
		if (existsSync(this.dbPath)) sources.push({ name: DB_FILENAME, db: this.#db, owned: false });
		const banksDir = join(dirname(this.dbPath), "banks");
		if (existsSync(banksDir)) {
			for (const entry of readdirSync(banksDir, { withFileTypes: true })) {
				const path = join(banksDir, entry.name, DB_FILENAME);
				if (!entry.isDirectory() || !existsSync(path)) continue;
				const db = new Database(path, { readonly: true, strict: true });
				db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
				sources.push({ name: relative(dirname(this.dbPath), path), db, owned: true });
			}
		}
		const files: AdminSnapshot["files"] = [];
		const rows = { working: 0, episodic: 0, invalid: 0 };
		try {
			for (const source of sources) {
				const target = join(destDir, source.name);
				mkdirSync(dirname(target), { recursive: true });
				rmSync(target, { force: true });
				source.db.run("VACUUM INTO ?", [target]);
				const copy = new Database(target, { readonly: true, strict: true });
				try {
					const nowIso = new Date().toISOString();
					rows.working += countRows(copy, "SELECT COUNT(*) AS total FROM working_memory");
					rows.episodic += countRows(copy, "SELECT COUNT(*) AS total FROM episodic_memory");
					for (const table of ["working_memory", "episodic_memory"]) {
						rows.invalid += countRows(
							copy,
							`SELECT COUNT(*) AS total FROM ${table} WHERE superseded_by IS NOT NULL OR (valid_until IS NOT NULL AND valid_until <= '${nowIso}')`,
						);
					}
				} finally {
					copy.close();
				}
				files.push({ name: source.name, bytes: Bun.file(target).size, sha256: await sha256File(target) });
			}
		} finally {
			for (const source of sources) if (source.owned) source.db.close();
		}
		return { files, rows };
	}

	close(): void {
		this.#db.close();
	}
}

/** Open the Personal agent's bank (`<agentDir>/memories/mnemopi/mnemopi.db`, bank `default`) for the owner. */
export function openMemoryAdmin(options: OpenMemoryAdminOptions): MemoryAdmin {
	return new SqliteMemoryAdmin(options);
}
