/**
 * The Personal agent's memory and About-you frames (docs/personal-agent.md "Memory", "About you"):
 * `personal-memory-{search,get,retract,pin,unpin,export}` and `personal-about-{get,set,history}`. Every memory call
 * opens its own {@link MemoryAdmin} and closes it again, so no handle outlives a request; searches, reads and
 * exports open the bank read-only, which never creates it. The About frames never open the bank.
 */

import type { AdminMemory, AdminQuery, MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import {
	MAX_ABOUT_BYTES,
	MAX_EXPORT_CHUNK_CHARS,
	MAX_MEMORY_PAGE,
	type PersonalAbout,
	type PersonalChangeKind,
	type PersonalExportChunk,
	type PersonalMemory,
	type PersonalMemoryQuery,
	type PersonalReply,
	type PersonalRequest,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalEvent } from "@oh-my-pi/pi-wire/personal-ipc";
import type { EventDraft } from "./companion-personal-events";
import type { PersonalAboutStore, PersonalPaths } from "./companion-personal-store";

export interface MemoryFramesDeps {
	paths: PersonalPaths;
	about: PersonalAboutStore;
	now(): number;
	openAdmin(options?: { readOnly?: boolean }): MemoryAdmin;
	changed(what: PersonalChangeKind[]): void;
	enqueueOwnerEvent(draft: EventDraft): Promise<PersonalEvent>;
	enabled(): boolean;
}

export interface PersonalMemoryFrames {
	/** The reply to a memory or About-you frame; `undefined` for any other request. Throws an `Error` with a plain message for invalid input. */
	handle(request: PersonalRequest): Promise<PersonalReply | undefined>;
	/** Releases anything kept open. Every call opens and closes its own admin, so there is nothing to release. */
	close(): void;
}

const MEMORY_ID = /^[we]:./;
const ORIGINS = ["owner", "agent", "external"] as const;
const DEFAULT_ABOUT_HISTORY = 50;
/** The admin method behind each write frame. */
const MEMORY_ACTIONS = {
	"personal-memory-retract": "retract",
	"personal-memory-pin": "pin",
	"personal-memory-unpin": "unpin",
} as const;

/** Field for field; `satisfies` makes the compiler flag any drift between the admin's and the wire's memory. */
function toPersonalMemory(memory: AdminMemory): PersonalMemory {
	return {
		id: memory.id,
		store: memory.store,
		content: memory.content,
		createdAt: memory.createdAt,
		...(memory.eventDate === undefined ? {} : { eventDate: memory.eventDate }),
		origin: memory.origin,
		authorId: memory.authorId,
		trustTier: memory.trustTier,
		importance: memory.importance,
		pinned: memory.pinned,
		invalid: memory.invalid,
		...(memory.invalidAt === undefined ? {} : { invalidAt: memory.invalidAt }),
		...(memory.invalidBy === undefined ? {} : { invalidBy: memory.invalidBy }),
		...(memory.replacedBy === undefined ? {} : { replacedBy: memory.replacedBy }),
		...(memory.replacesCount === undefined ? {} : { replacesCount: memory.replacesCount }),
		...(memory.sessionId === undefined ? {} : { sessionId: memory.sessionId }),
		recallCount: memory.recallCount,
	} satisfies PersonalMemory;
}

function memoryId(id: unknown): string {
	if (typeof id !== "string" || !MEMORY_ID.test(id)) throw new Error("Memory id must look like w:<id> or e:<id>");
	return id;
}

function isoDate(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
		throw new Error(`${field} must be an ISO 8601 date`);
	return value;
}

function wholeNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a whole number of 0 or more`);
	}
	return value;
}

function toAdminQuery(query: PersonalMemoryQuery): AdminQuery {
	if (typeof query !== "object" || query === null) throw new Error("Memory query must be an object");
	const admin: AdminQuery = {};
	if (query.q !== undefined) {
		if (typeof query.q !== "string") throw new Error("q must be text");
		if (query.q.trim().length > 0) admin.q = query.q;
	}
	if (query.origin !== undefined) {
		if (!Array.isArray(query.origin) || query.origin.some(origin => !ORIGINS.includes(origin))) {
			throw new Error("origin must list owner, agent or external");
		}
		admin.origin = query.origin;
	}
	for (const flag of ["pinnedOnly", "includeInvalid"] as const) {
		const value: unknown = query[flag];
		if (value === undefined) continue;
		if (typeof value !== "boolean") throw new Error(`${flag} must be true or false`);
		admin[flag] = value;
	}
	const since = isoDate(query.since, "since");
	if (since !== undefined) admin.since = since;
	const until = isoDate(query.until, "until");
	if (until !== undefined) admin.until = until;
	const limit = wholeNumber(query.limit, "limit");
	if (limit !== undefined) admin.limit = Math.min(Math.max(limit, 1), MAX_MEMORY_PAGE);
	const offset = wholeNumber(query.offset, "offset");
	if (offset !== undefined) admin.offset = offset;
	return admin;
}

export function createPersonalMemoryFrames(deps: MemoryFramesDeps): PersonalMemoryFrames {
	/** Run `work` on a fresh admin that is closed afterwards, whatever happens. */
	const withAdmin = async <T>(readOnly: boolean, work: (admin: MemoryAdmin) => T): Promise<T> => {
		const admin = deps.openAdmin({ readOnly });
		try {
			return work(admin);
		} finally {
			admin.close();
		}
	};

	const setAbout = async (text: unknown, baseRev: unknown): Promise<{ about: PersonalAbout; saved: boolean }> => {
		if (typeof text !== "string") throw new Error("About you must be text");
		if (Buffer.byteLength(text) > MAX_ABOUT_BYTES) throw new Error("About you is too long");
		if (typeof baseRev !== "number" || !Number.isInteger(baseRev)) throw new Error("baseRev must be a whole number");
		const current = await deps.about.read();
		if (baseRev !== current.rev) return { about: current, saved: false };
		const about = await deps.about.write(text, "owner");
		deps.changed(["about"]);
		if (deps.enabled()) {
			try {
				await deps.enqueueOwnerEvent({
					source: "owner-answer",
					kind: "about-updated",
					title: "About you changed",
					body: text,
					ref: `about-rev-${about.rev}`,
				});
			} catch (error) {
				console.error(
					`personal about: the session was not told about the change: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { about, saved: true };
	};

	return {
		async handle(request) {
			const { reqId } = request;
			switch (request.t) {
				case "personal-memory-search": {
					const query = toAdminQuery(request.query);
					const { items, total } = await withAdmin(true, admin => admin.search(query));
					return { t: request.t, reqId, items: items.map(toPersonalMemory), total };
				}
				case "personal-memory-get": {
					const id = memoryId(request.id);
					const { memory, replaces } = await withAdmin(true, admin => admin.get(id));
					return {
						t: request.t,
						reqId,
						memory: memory === null ? null : toPersonalMemory(memory),
						replaces: replaces.map(toPersonalMemory),
					};
				}
				case "personal-memory-retract":
				case "personal-memory-pin":
				case "personal-memory-unpin": {
					const id = memoryId(request.id);
					const action = MEMORY_ACTIONS[request.t];
					const memory = await withAdmin(false, admin => admin[action](id));
					deps.changed(["memory"]);
					return { t: request.t, reqId, memory: toPersonalMemory(memory) };
				}
				case "personal-memory-export": {
					if (request.format !== "json" && request.format !== "markdown")
						throw new Error("format must be json or markdown");
					const offset = wholeNumber(request.offset, "offset") ?? 0;
					const chunk: PersonalExportChunk = await withAdmin(true, admin =>
						admin.exportChunk(request.format, offset, MAX_EXPORT_CHUNK_CHARS),
					);
					return { t: request.t, reqId, name: chunk.name, mime: chunk.mime, text: chunk.text, next: chunk.next };
				}
				case "personal-about-get":
					return { t: request.t, reqId, about: await deps.about.read() };
				case "personal-about-set": {
					const { about, saved } = await setAbout(request.text, request.baseRev);
					return { t: request.t, reqId, about, saved };
				}
				case "personal-about-history": {
					const limit = wholeNumber(request.limit, "limit");
					return {
						t: request.t,
						reqId,
						versions: await deps.about.history(limit === undefined ? DEFAULT_ABOUT_HISTORY : Math.max(limit, 1)),
					};
				}
				default:
					return undefined;
			}
		},
		close() {},
	};
}
