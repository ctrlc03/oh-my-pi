/**
 * Full-text search over what was said in every omp session on the computer: prompts (typed
 * or sent by a collab guest) and the assistant's reply text. Tool output and thinking are
 * left out; they are most of a session file and never what someone remembers.
 *
 * Session files are streamed line by line, newest file first. The searchable text of each
 * file is kept in memory, keyed by mtime and size and bounded, so a repeated search reads
 * nothing from disk. A scan that runs out of time reports `truncated`; the files it did
 * finish stay cached, so the next search gets further.
 */

import * as fs from "node:fs/promises";
import type { SessionSearchHit } from "../src/lib/companion";
import { isRecord } from "../src/tool-render/util";
import { recentSessionFiles } from "./companion-sessions";

export const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 200;
const MAX_TERMS = 8;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const DEFAULT_BUDGET_MS = 1500;
/** Files kept searchable in memory. */
export const DEFAULT_MAX_FILES = 200;
/** Characters of text kept searchable in memory (about 100 MB of UTF-16 at worst). */
export const DEFAULT_MAX_CHARS = 50_000_000;
const SNIPPET_CHARS = 160;
/** Characters of context shown before the first hit. */
const SNIPPET_LEAD = 50;
/** The clock is read this often while scanning one file. */
const LINES_PER_CLOCK_READ = 256;
/** More session files than this are never listed: the newest ones are what people search. */
const MAX_LISTED_FILES = 10_000;

/** A searchable entry: the text a person wrote or the agent replied. */
interface Passage {
	entryId: string;
	role: "user" | "assistant";
	text: string;
	/** Unix ms; 0 when the entry has no readable timestamp. */
	time: number;
}

interface FileIndex {
	sessionId: string;
	cwd: string;
	title: string | null;
	passages: Passage[];
	/** Rough memory cost in characters, for the cache bound. */
	chars: number;
}

interface CachedIndex {
	mtimeMs: number;
	size: number;
	index: FileIndex;
}

export type SearchHit = Omit<SessionSearchHit, "instanceId" | "live">;

export interface SearchOutcome {
	results: SearchHit[];
	/** More matches may exist: the limit, the time budget, or a file still unscanned stopped the search. */
	truncated: boolean;
}

/**
 * The lowercase terms of a query: whitespace-separated, each of which must appear in an entry.
 * @throws Error when the query is shorter than {@link MIN_QUERY_CHARS} characters.
 */
export function parseQuery(raw: unknown): string[] {
	if (typeof raw !== "string") throw new Error("invalid query");
	const query = raw.trim().slice(0, MAX_QUERY_CHARS);
	if ([...query].length < MIN_QUERY_CHARS) throw new Error(`type at least ${MIN_QUERY_CHARS} characters`);
	const terms: string[] = [];
	for (const term of query.toLowerCase().split(/\s+/)) {
		if (term !== "" && !terms.includes(term)) terms.push(term);
		if (terms.length >= MAX_TERMS) break;
	}
	return terms;
}

/** Text of a message `content`: the string itself, or the `text` blocks of a block array. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function timeOf(entry: Record<string, unknown>, message: Record<string, unknown> | null): number {
	const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (!Number.isNaN(stamp)) return stamp;
	return typeof message?.timestamp === "number" ? message.timestamp : 0;
}

/** The searchable passage of a session entry; null for tool output, thinking, and everything that is not speech. */
export function passageOf(entry: Record<string, unknown>): Passage | null {
	if (typeof entry.id !== "string") return null;
	let role: Passage["role"];
	let text: string;
	let message: Record<string, unknown> | null = null;
	if (entry.type === "message" && isRecord(entry.message)) {
		message = entry.message;
		// `agent` attribution marks prompts the harness wrote itself, not the user.
		if (message.role === "user" && message.attribution !== "agent") role = "user";
		else if (message.role === "assistant") role = "assistant";
		else return null;
		text = textOf(message.content);
	} else if (entry.type === "custom_message" && entry.customType === "collab-prompt") {
		role = "user";
		text = textOf(entry.content);
	} else return null;
	if (text.trim() === "") return null;
	return { entryId: entry.id, role, text, time: timeOf(entry, message) };
}

/** Lines that can matter, told from their start: parsing the rest (tool output is most of a file) would waste the budget. */
const WANTED_LINE = /"type":"(message|custom_message|session|title|title_change)"/;

async function* readLines(file: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let carry = "";
	for await (const chunk of Bun.file(file).stream()) {
		carry += decoder.decode(chunk, { stream: true });
		let from = 0;
		for (let at = carry.indexOf("\n", from); at >= 0; at = carry.indexOf("\n", from)) {
			yield carry.slice(from, at);
			from = at + 1;
		}
		carry = carry.slice(from);
	}
	carry += decoder.decode();
	if (carry !== "") yield carry;
}

/**
 * Stream one session file into its searchable passages. `complete` is false when `expired()`
 * ended the scan early: what was read is still searchable, but must not be cached.
 */
async function indexFile(
	file: string,
	expired: () => boolean,
): Promise<{ index: FileIndex | null; complete: boolean }> {
	let sessionId: string | null = null;
	let cwd = "";
	let headerTitle: string | null = null;
	let slotTitle: string | null | undefined;
	let changedTitle: string | null = null;
	const passages: Passage[] = [];
	let chars = 0;
	let lines = 0;
	let complete = true;
	for await (const line of readLines(file)) {
		if (++lines % LINES_PER_CLOCK_READ === 0 && expired()) {
			complete = false;
			break;
		}
		if (line.charCodeAt(0) !== 123 || !WANTED_LINE.test(line.slice(0, 80))) continue;
		// Tool results are most of a file and never searchable: skip them before parsing.
		if (line.slice(0, 300).includes('"role":"toolResult"')) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a line still being written, or foreign
		}
		if (!isRecord(entry)) continue;
		switch (entry.type) {
			case "session":
				if (sessionId === null && typeof entry.id === "string") {
					sessionId = entry.id;
					cwd = typeof entry.cwd === "string" ? entry.cwd : "";
					headerTitle = typeof entry.title === "string" ? entry.title : null;
				}
				break;
			case "title":
				if (slotTitle === undefined) slotTitle = typeof entry.title === "string" ? entry.title : null;
				break;
			case "title_change":
				if (typeof entry.title === "string") changedTitle = entry.title;
				break;
			default: {
				const passage = passageOf(entry);
				if (passage === null) break;
				passages.push(passage);
				chars += passage.text.length + passage.entryId.length;
			}
		}
	}
	if (sessionId === null) return { index: null, complete };
	// Same precedence as the session list: the title slot, else the header's name overridden by the last rename.
	const title = (slotTitle !== undefined ? slotTitle : (changedTitle ?? headerTitle))?.trim() || null;
	return { index: { sessionId, cwd, title, passages, chars }, complete };
}

/** True when `at` is the second half of a surrogate pair (a window must not start inside one). */
function splitsPair(text: string, at: number): boolean {
	const code = text.charCodeAt(at);
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * About {@link SNIPPET_CHARS} characters of `text` around `at`, whitespace collapsed, with an
 * ellipsis where it was cut.
 */
export function snippetAround(text: string, at: number): string {
	let start = Math.max(0, at - SNIPPET_LEAD);
	let end = Math.min(text.length, start + SNIPPET_CHARS);
	if (start > 0 && splitsPair(text, start)) start++;
	if (end < text.length && splitsPair(text, end)) end--;
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Snippet for `passage` when every term appears in it; null otherwise. */
function matchPassage(passage: Passage, terms: readonly string[]): string | null {
	const lower = passage.text.toLowerCase();
	let first = Number.POSITIVE_INFINITY;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at < 0) return null;
		if (at < first) first = at;
	}
	// A few characters change length when lowercased; then offsets only fit the lowercased text.
	return snippetAround(lower.length === passage.text.length ? passage.text : lower, first);
}

export interface SessionSearchOptions {
	/** `<config>/agent/sessions`. */
	sessionsDir: string;
	budgetMs?: number;
	maxFiles?: number;
	maxChars?: number;
	/** Clock in ms; injectable so budgets are testable. */
	now?(): number;
}

export interface SessionSearch {
	search(query: unknown, limit?: unknown): Promise<SearchOutcome>;
	/** Forget every cached file. */
	clear(): void;
}

export function createSessionSearch(options: SessionSearchOptions): SessionSearch {
	const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const now = options.now ?? Date.now;
	/** Insertion order is recency of use: the first key is evicted first. */
	const cache = new Map<string, CachedIndex>();
	let cachedChars = 0;

	const forget = (file: string): void => {
		const old = cache.get(file);
		if (!old) return;
		cachedChars -= old.index.chars;
		cache.delete(file);
	};
	const remember = (file: string, entry: CachedIndex): void => {
		forget(file);
		// One file over the whole bound would evict everything else for nothing.
		if (entry.index.chars > maxChars) return;
		cache.set(file, entry);
		cachedChars += entry.index.chars;
		for (const key of cache.keys()) {
			if (cache.size <= maxFiles && cachedChars <= maxChars) break;
			if (key !== file) forget(key);
		}
	};

	return {
		clear() {
			cache.clear();
			cachedChars = 0;
		},
		async search(rawQuery, rawLimit) {
			const terms = parseQuery(rawQuery);
			const limit =
				typeof rawLimit === "number" && Number.isFinite(rawLimit)
					? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
					: DEFAULT_LIMIT;
			const deadline = now() + budgetMs;
			const expired = (): boolean => now() > deadline;
			const results: SearchHit[] = [];
			let truncated = false;

			for (const { file } of await recentSessionFiles(options.sessionsDir, MAX_LISTED_FILES)) {
				if (expired()) {
					truncated = true;
					break;
				}
				let stat: { mtimeMs: number; size: number };
				try {
					stat = await fs.stat(file);
				} catch {
					continue;
				}
				let index: FileIndex | null;
				const cached = cache.get(file);
				if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
					index = cached.index;
					// Re-insert: most recently used last.
					cache.delete(file);
					cache.set(file, cached);
				} else {
					forget(file);
					let complete: boolean;
					try {
						({ index, complete } = await indexFile(file, expired));
					} catch {
						continue; // unreadable or vanished
					}
					if (index !== null && complete) remember(file, { mtimeMs: stat.mtimeMs, size: stat.size, index });
					if (!complete) truncated = true;
				}
				if (index === null) continue;
				for (let i = index.passages.length - 1; i >= 0; i--) {
					const passage = index.passages[i]!;
					const snippet = matchPassage(passage, terms);
					if (snippet === null) continue;
					if (results.length >= limit) return { results, truncated: true };
					results.push({
						sessionId: index.sessionId,
						title: index.title,
						cwd: index.cwd,
						entryId: passage.entryId,
						role: passage.role,
						snippet,
						time: passage.time,
					});
				}
				if (truncated) break;
			}
			return { results, truncated };
		},
	};
}

/** Mark hits of sessions that are hosting collab (`host`) or running without it (`idle`) right now; a host wins over an idle listing. */
export function withLiveness(
	hits: readonly SearchHit[],
	live: {
		hosts: readonly { sessionId: string; instanceId: string }[];
		idle: readonly { sessionId: string; instanceId: string }[];
	},
): SessionSearchHit[] {
	const instances = new Map<string, { instanceId: string; live: "host" | "idle" }>();
	for (const idle of live.idle) instances.set(idle.sessionId, { instanceId: idle.instanceId, live: "idle" });
	for (const host of live.hosts) instances.set(host.sessionId, { instanceId: host.instanceId, live: "host" });
	return hits.map(hit => {
		const instance = instances.get(hit.sessionId);
		return instance ? { ...hit, ...instance } : hit;
	});
}
