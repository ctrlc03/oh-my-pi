/**
 * Session transcripts saved on this device, so reopening the app shows the
 * last-known transcript at once and the host sends only what followed it (a
 * delta resume) instead of the whole session.
 *
 * IndexedDB, three stores: `rooms` (roomId → sessionId), `sessions` (header and
 * entry count per session) and `entries` (keyed `[sessionId, index]`). Rooms
 * point at sessions, so following a session into a new room moves one row.
 * Same trust boundary as the room links in localStorage, which hold the keys.
 */

import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-wire";

const DB_NAME = "omp-collab-replicas";
const DB_VERSION = 1;
/** Sessions kept; the least recently saved beyond this are dropped. */
const MAX_SESSIONS = 8;
/** WebKit can leave `indexedDB.open` pending on a cold launch: join without the cache rather than wait. */
const LOAD_TIMEOUT_MS = 1500;

export interface CachedReplica {
	header: SessionHeader;
	entries: SessionEntry[];
}

interface RoomRow {
	roomId: string;
	sessionId: string;
}

interface SessionRow {
	sessionId: string;
	header: SessionHeader;
	count: number;
	savedAt: number;
}

export interface ReplicaStore {
	/** The room's saved transcript, or null when there is none (or it cannot be read in time). */
	load(roomId: string): Promise<CachedReplica | null>;
	/** Replace the session's saved transcript and point the room at it. */
	replace(roomId: string, header: SessionHeader, entries: readonly SessionEntry[]): Promise<void>;
	/** Add `entries` after the first `from` saved entries of the session. */
	append(roomId: string, header: SessionHeader, from: number, entries: readonly SessionEntry[]): Promise<void>;
	/** Point room `to` at the session room `from` showed; `from` is forgotten. */
	move(from: string, to: string): Promise<void>;
	/** Forget the room; its session goes once no room points at it. */
	forget(roomId: string): Promise<void>;
}

function done(request: IDBRequest): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	request.onsuccess = () => resolve();
	request.onerror = () => reject(request.error);
	return promise;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
	return promise;
}

function committed(tx: IDBTransaction): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	tx.oncomplete = () => resolve();
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
	return promise;
}

function entryRange(sessionId: string): IDBKeyRange {
	return IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
}

function openDb(): Promise<IDBDatabase> {
	const request = indexedDB.open(DB_NAME, DB_VERSION);
	request.onupgradeneeded = () => {
		const db = request.result;
		db.createObjectStore("rooms", { keyPath: "roomId" });
		db.createObjectStore("sessions", { keyPath: "sessionId" });
		db.createObjectStore("entries");
	};
	return result(request);
}

/** Drops sessions no room points at, then the least recently saved beyond {@link MAX_SESSIONS}. */
async function evict(db: IDBDatabase): Promise<void> {
	const tx = db.transaction(["rooms", "sessions", "entries"], "readwrite");
	const rooms = tx.objectStore("rooms");
	const sessions = tx.objectStore("sessions");
	const entries = tx.objectStore("entries");
	const [roomRows, sessionRows] = await Promise.all([
		result(rooms.getAll() as IDBRequest<RoomRow[]>),
		result(sessions.getAll() as IDBRequest<SessionRow[]>),
	]);
	const referenced = new Set(roomRows.map(row => row.sessionId));
	const kept = sessionRows.filter(row => referenced.has(row.sessionId)).sort((a, b) => b.savedAt - a.savedAt);
	const keep = new Set(kept.slice(0, MAX_SESSIONS).map(row => row.sessionId));
	for (const row of sessionRows) {
		if (keep.has(row.sessionId)) continue;
		sessions.delete(row.sessionId);
		entries.delete(entryRange(row.sessionId));
	}
	for (const row of roomRows) if (!keep.has(row.sessionId)) rooms.delete(row.roomId);
	await committed(tx);
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	const timer = setTimeout(() => resolve(fallback), ms);
	work.then(
		value => {
			clearTimeout(timer);
			resolve(value);
		},
		() => {
			clearTimeout(timer);
			resolve(fallback);
		},
	);
	return promise;
}

function createStore(): ReplicaStore {
	let db: Promise<IDBDatabase> | null = null;
	const database = (): Promise<IDBDatabase> => {
		db ??= openDb().catch(err => {
			db = null;
			throw err;
		});
		return db;
	};

	const read = async (roomId: string): Promise<CachedReplica | null> => {
		const tx = (await database()).transaction(["rooms", "sessions", "entries"], "readonly");
		const room = (await result(tx.objectStore("rooms").get(roomId))) as RoomRow | undefined;
		if (!room) return null;
		const [session, entries] = await Promise.all([
			result(tx.objectStore("sessions").get(room.sessionId)) as Promise<SessionRow | undefined>,
			result(tx.objectStore("entries").getAll(entryRange(room.sessionId))) as Promise<SessionEntry[]>,
		]);
		// A count mismatch is a write that never finished: rejoin for a full snapshot.
		if (!session || entries.length !== session.count) return null;
		return { header: session.header, entries };
	};

	const write = async (
		roomId: string,
		header: SessionHeader,
		from: number,
		rows: readonly SessionEntry[],
		replace: boolean,
	): Promise<void> => {
		const handle = await database();
		const tx = handle.transaction(["rooms", "sessions", "entries"], "readwrite");
		const entries = tx.objectStore("entries");
		if (replace) entries.delete(entryRange(header.id));
		for (let i = 0; i < rows.length; i++) entries.put(rows[i], [header.id, from + i]);
		const row: SessionRow = { sessionId: header.id, header, count: from + rows.length, savedAt: Date.now() };
		tx.objectStore("sessions").put(row);
		tx.objectStore("rooms").put({ roomId, sessionId: header.id } satisfies RoomRow);
		await committed(tx);
		if (replace) await evict(handle);
	};

	return {
		load: roomId => withTimeout(read(roomId), LOAD_TIMEOUT_MS, null),
		replace: (roomId, header, rows) => write(roomId, header, 0, rows, true),
		append: (roomId, header, from, rows) => write(roomId, header, from, rows, false),
		async move(from, to) {
			const tx = (await database()).transaction("rooms", "readwrite");
			const rooms = tx.objectStore("rooms");
			const room = (await result(rooms.get(from))) as RoomRow | undefined;
			if (room) {
				rooms.put({ roomId: to, sessionId: room.sessionId } satisfies RoomRow);
				rooms.delete(from);
			}
			await committed(tx);
		},
		async forget(roomId) {
			const handle = await database();
			const tx = handle.transaction("rooms", "readwrite");
			await done(tx.objectStore("rooms").delete(roomId));
			await committed(tx);
			await evict(handle);
		},
	};
}

let shared: ReplicaStore | null | undefined;

/** This device's transcript store; null where IndexedDB is unavailable (tests, some private modes). */
export function replicaStore(): ReplicaStore | null {
	if (shared === undefined) shared = typeof indexedDB === "undefined" ? null : createStore();
	return shared;
}
