/**
 * The owner-side view of a Mnemopi bank: what the collab companion needs to show, correct, export, review and
 * back up the Personal agent's memory without running an agent session (docs/personal-agent.md).
 * Types only; the implementation is `./admin.ts` (exported as `@oh-my-pi/pi-mnemopi/admin`).
 *
 * `AdminMemory`, `AdminQuery` and `AdminExportChunk` carry the same fields with the same meaning as
 * `PersonalMemory`, `PersonalMemoryQuery` and `PersonalExportChunk` in `@oh-my-pi/pi-wire/personal`
 * (this package does not depend on the wire package); the companion maps one to the other and the
 * compiler flags drift. Row ids are `w:<id>` (working memory) and `e:<id>` (episodic).
 */

export type AdminOrigin = "owner" | "agent" | "external";

export interface AdminMemory {
	id: string;
	store: "working" | "episodic";
	content: string;
	/** ISO 8601. */
	createdAt: string;
	eventDate?: string;
	/** From `author_type`; rows without one (older banks) read as `agent`. */
	origin: AdminOrigin;
	authorId: string;
	trustTier: string;
	importance: number;
	/** `metadata.pinned === true`. */
	pinned: boolean;
	/** `valid_until` is set. */
	invalid: boolean;
	invalidAt?: string;
	/** `metadata.retracted_by === "owner"` → `owner`; otherwise an invalid row was invalidated by the agent. */
	invalidBy?: "owner" | "agent";
	/** `superseded_by`. */
	replacedBy?: string;
	/** How many memories this one replaced (they name it in `superseded_by`); absent when none. */
	replacesCount?: number;
	sessionId?: string;
	recallCount: number;
}

export interface AdminQuery {
	/** Keywords, full-text (FTS5); no embedder is loaded. Omitted = newest first. */
	q?: string;
	origin?: AdminOrigin[];
	pinnedOnly?: boolean;
	includeInvalid?: boolean;
	/** ISO 8601 bounds on `createdAt`. */
	since?: string;
	until?: string;
	/** Default 50, at most 100. */
	limit?: number;
	offset?: number;
}

export interface AdminExportChunk {
	name: string;
	mime: string;
	text: string;
	/** Offset for the next call; null = last part. */
	next: number | null;
}

/** The day's record, as text for the nightly review's prompt, with what it was made of. */
export interface AdminDayRecord {
	/** `YYYY-MM-DD`, local. */
	day: string;
	/**
	 * Markdown, at most `maxChars` characters: owner and agent rows verbatim (newest last), `external` rows
	 * shortened and fenced (`<<<UNTRUSTED nonce (source) … UNTRUSTED nonce>>>`).
	 */
	text: string;
	memoryIds: string[];
	counts: { owner: number; agent: number; external: number };
	/** Rows left out to fit `maxChars`. */
	omitted: number;
}

export interface AdminSnapshot {
	/** Files written under `destDir` (relative names), each a consistent copy made with SQLite's online backup. */
	files: { name: string; bytes: number; sha256: string }[];
	rows: { working: number; episodic: number; invalid: number };
}

export interface AdminStats {
	working: number;
	episodic: number;
	invalid: number;
	pinned: number;
	/** ISO 8601 of the newest row, if any. */
	newestAt?: string;
}

export interface MemoryAdmin {
	/** Absolute path of the bank file this opened. */
	readonly dbPath: string;
	search(query: AdminQuery): { items: AdminMemory[]; total: number };
	get(id: string): { memory: AdminMemory | null; replaces: AdminMemory[] };
	/** Invalidate (never delete) and record `retracted_by: "owner"`. Throws for an unknown id; idempotent. Not available read-only. */
	retract(id: string): AdminMemory;
	/** Importance 1.0 and `pinned: true` (the previous importance is kept in metadata for `unpin`). */
	pin(id: string): AdminMemory;
	unpin(id: string): AdminMemory;
	/** Pinned, valid memories, oldest pin first, for the per-turn injection and the app's pin list. */
	pinned(): AdminMemory[];
	exportChunk(format: "json" | "markdown", offset: number, maxChars: number): AdminExportChunk;
	recordForDay(day: string, maxChars: number): AdminDayRecord;
	stats(): AdminStats;
	/** Consistent copy of every bank file of this agent dir into `destDir` (created). Works while a session writes. */
	snapshot(destDir: string): Promise<AdminSnapshot>;
	close(): void;
}

export interface OpenMemoryAdminOptions {
	/** The profile's agent dir (`~/.omp/profiles/personal/agent`). The bank is located the way a session with `mnemopi.scoping: global` locates it. */
	agentDir: string;
	/** Default false. `search`, `get`, `exportChunk`, `recordForDay`, `stats` and `snapshot` need only read access. */
	readOnly?: boolean;
}
