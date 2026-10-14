import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdminExportChunk, AdminMemory, AdminQuery, MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import {
	MAX_ABOUT_BYTES,
	MAX_EXPORT_CHUNK_CHARS,
	MAX_MEMORY_PAGE,
	type PersonalChangeKind,
	type PersonalMemory,
	type PersonalReply,
	type PersonalRequest,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalEvent } from "@oh-my-pi/pi-wire/personal-ipc";
import type { EventDraft } from "../scripts/companion-personal-events";
import { createPersonalMemoryFrames } from "../scripts/companion-personal-memory";
import { createAboutStore, personalPaths } from "../scripts/companion-personal-store";

const plain: AdminMemory = {
	id: "w:1",
	store: "working",
	content: "Likes oat milk",
	createdAt: "2026-10-01T08:00:00.000Z",
	origin: "owner",
	authorId: "owner",
	trustTier: "owner",
	importance: 0.5,
	pinned: false,
	invalid: false,
	recallCount: 2,
};
const full: AdminMemory = {
	id: "e:7",
	store: "episodic",
	content: "Lived in Lisbon",
	createdAt: "2026-09-01T08:00:00.000Z",
	eventDate: "2026-08-31T00:00:00.000Z",
	origin: "agent",
	authorId: "agent:personal",
	trustTier: "agent",
	importance: 1,
	pinned: true,
	invalid: true,
	invalidAt: "2026-09-30T00:00:00.000Z",
	invalidBy: "owner",
	replacedBy: "e:9",
	replacesCount: 2,
	sessionId: "s-1",
	recallCount: 0,
};

interface Opened {
	readOnly: boolean | undefined;
	closed: boolean;
}

function setup(options: { enabled?: boolean; failEnqueue?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-memory-"));
	roots.push(root);
	const paths = personalPaths(path.join(root, "config"));
	let clock = Date.UTC(2026, 9, 14, 12);
	const about = createAboutStore(paths, () => clock++);
	const opened: Opened[] = [];
	const queries: AdminQuery[] = [];
	const calls: string[] = [];
	const exports: { format: string; offset: number; maxChars: number }[] = [];
	const changes: PersonalChangeKind[][] = [];
	const events: EventDraft[] = [];
	const bank = {
		items: [plain, full],
		total: 9,
		failWith: undefined as string | undefined,
		chunk: {
			name: "personal-memory-2026-10-14.json",
			mime: "application/json",
			text: "{}",
			next: 1000,
		} as AdminExportChunk,
	};
	const admin = (state: Opened): MemoryAdmin => {
		const write = (name: string, memory: AdminMemory) => (id: string) => {
			calls.push(`${name}:${id}`);
			if (state.readOnly === true) throw new Error("Memory admin is open read-only");
			if (bank.failWith !== undefined) throw new Error(bank.failWith);
			return memory;
		};
		return {
			dbPath: "",
			search(query: AdminQuery) {
				queries.push(query);
				return { items: bank.items, total: bank.total };
			},
			get(id: string) {
				calls.push(`get:${id}`);
				return id === "w:1" ? { memory: plain, replaces: [full] } : { memory: null, replaces: [] };
			},
			retract: write("retract", { ...plain, invalid: true, invalidBy: "owner" }),
			pin: write("pin", { ...plain, pinned: true, importance: 1 }),
			unpin: write("unpin", plain),
			exportChunk(format: "json" | "markdown", offset: number, maxChars: number) {
				exports.push({ format, offset, maxChars });
				return bank.chunk;
			},
			close() {
				state.closed = true;
			},
		} as unknown as MemoryAdmin;
	};
	const frames = createPersonalMemoryFrames({
		paths,
		about,
		now: () => clock,
		openAdmin(opts) {
			const state: Opened = { readOnly: opts?.readOnly, closed: false };
			opened.push(state);
			return admin(state);
		},
		changed: what => {
			changes.push(what);
		},
		enqueueOwnerEvent: async draft => {
			if (options.failEnqueue === true) throw new Error("channel down");
			events.push(draft);
			return { id: "ev-1" } as PersonalEvent;
		},
		enabled: () => options.enabled ?? true,
	});
	return { frames, paths, about, opened, queries, calls, exports, changes, events, bank };
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const revs = (reply: PersonalReply | undefined): number[] => {
	if (reply?.t !== "personal-about-history") throw new Error(`unexpected reply ${reply?.t}`);
	return reply.versions.map(v => v.rev);
};

const fail = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected a rejection");
};

describe("personal-memory-search", () => {
	it("maps every admin field to the wire memory and keeps the total", async () => {
		const t = setup();
		const reply = await t.frames.handle({ t: "personal-memory-search", reqId: 4, query: {} });
		expect(reply).toEqual({ t: "personal-memory-search", reqId: 4, items: [plain, full], total: 9 });
		// optional fields are absent, not undefined
		if (reply?.t !== "personal-memory-search") throw new Error(`unexpected reply ${reply?.t}`);
		const first = reply.items[0] as PersonalMemory;
		expect(Object.keys(first).sort()).toEqual(
			[
				"authorId",
				"content",
				"createdAt",
				"id",
				"importance",
				"invalid",
				"origin",
				"pinned",
				"recallCount",
				"store",
				"trustTier",
			].sort(),
		);
	});

	it("passes the query on, drops an empty q, and clamps the page size", async () => {
		const t = setup();
		await t.frames.handle({
			t: "personal-memory-search",
			reqId: 1,
			query: {
				q: "milk",
				origin: ["owner", "external"],
				pinnedOnly: true,
				includeInvalid: true,
				since: "2026-01-01T00:00:00Z",
				until: "2026-12-31T00:00:00Z",
				limit: 500,
				offset: 20,
			},
		});
		await t.frames.handle({ t: "personal-memory-search", reqId: 2, query: { q: "   ", limit: 0 } });
		expect(t.queries).toEqual([
			{
				q: "milk",
				origin: ["owner", "external"],
				pinnedOnly: true,
				includeInvalid: true,
				since: "2026-01-01T00:00:00Z",
				until: "2026-12-31T00:00:00Z",
				limit: MAX_MEMORY_PAGE,
				offset: 20,
			},
			{ limit: 1 },
		]);
	});

	it("opens the bank read-only and closes it", async () => {
		const t = setup();
		await t.frames.handle({ t: "personal-memory-search", reqId: 1, query: {} });
		expect(t.opened).toEqual([{ readOnly: true, closed: true }]);
		expect(t.changes).toEqual([]);
	});

	it("rejects invalid queries before opening the bank", async () => {
		const t = setup();
		const search = (query: unknown) =>
			fail(t.frames.handle({ t: "personal-memory-search", reqId: 1, query } as PersonalRequest));
		expect(await search(null)).toBe("Memory query must be an object");
		expect(await search({ q: 5 })).toBe("q must be text");
		expect(await search({ origin: ["root"] })).toBe("origin must list owner, agent or external");
		expect(await search({ origin: "owner" })).toBe("origin must list owner, agent or external");
		expect(await search({ pinnedOnly: "yes" })).toBe("pinnedOnly must be true or false");
		expect(await search({ since: "yesterday" })).toBe("since must be an ISO 8601 date");
		expect(await search({ until: 3 })).toBe("until must be an ISO 8601 date");
		expect(await search({ limit: 1.5 })).toBe("limit must be a whole number of 0 or more");
		expect(await search({ offset: -1 })).toBe("offset must be a whole number of 0 or more");
		expect(t.opened).toEqual([]);
	});

	it("closes the admin when the search throws", async () => {
		const t = setup();
		const frames = createPersonalMemoryFrames({
			paths: t.paths,
			about: t.about,
			now: () => 0,
			openAdmin: () => {
				const state: Opened = { readOnly: true, closed: false };
				t.opened.push(state);
				return {
					search() {
						throw new Error("fts broke");
					},
					close() {
						state.closed = true;
					},
				} as unknown as MemoryAdmin;
			},
			changed: () => {},
			enqueueOwnerEvent: async () => ({}) as PersonalEvent,
			enabled: () => true,
		});
		expect(await fail(frames.handle({ t: "personal-memory-search", reqId: 1, query: {} }))).toBe("fts broke");
		expect(t.opened).toEqual([{ readOnly: true, closed: true }]);
	});
});

describe("personal-memory-get", () => {
	it("answers the memory and what it replaces", async () => {
		const t = setup();
		expect(await t.frames.handle({ t: "personal-memory-get", reqId: 2, id: "w:1" })).toEqual({
			t: "personal-memory-get",
			reqId: 2,
			memory: plain,
			replaces: [full],
		});
		expect(t.opened).toEqual([{ readOnly: true, closed: true }]);
	});

	it("answers null for an unknown id", async () => {
		const t = setup();
		expect(await t.frames.handle({ t: "personal-memory-get", reqId: 2, id: "e:404" })).toEqual({
			t: "personal-memory-get",
			reqId: 2,
			memory: null,
			replaces: [],
		});
	});

	it("rejects ids that are not w:<id> or e:<id>", async () => {
		const t = setup();
		for (const id of ["x:1", "w1", "", "w:", 7, undefined]) {
			expect(await fail(t.frames.handle({ t: "personal-memory-get", reqId: 1, id } as PersonalRequest))).toBe(
				"Memory id must look like w:<id> or e:<id>",
			);
		}
		expect(t.opened).toEqual([]);
	});
});

describe("retract, pin and unpin", () => {
	it("each opens a writable admin, closes it and announces a memory change", async () => {
		const t = setup();
		const retract = await t.frames.handle({ t: "personal-memory-retract", reqId: 1, id: "w:1" });
		const pin = await t.frames.handle({ t: "personal-memory-pin", reqId: 2, id: "w:1" });
		const unpin = await t.frames.handle({ t: "personal-memory-unpin", reqId: 3, id: "w:1" });
		expect(retract).toEqual({
			t: "personal-memory-retract",
			reqId: 1,
			memory: { ...plain, invalid: true, invalidBy: "owner" },
		});
		expect(pin).toEqual({ t: "personal-memory-pin", reqId: 2, memory: { ...plain, pinned: true, importance: 1 } });
		expect(unpin).toEqual({ t: "personal-memory-unpin", reqId: 3, memory: plain });
		expect(t.calls).toEqual(["retract:w:1", "pin:w:1", "unpin:w:1"]);
		expect(t.opened).toEqual([
			{ readOnly: false, closed: true },
			{ readOnly: false, closed: true },
			{ readOnly: false, closed: true },
		]);
		expect(t.changes).toEqual([["memory"], ["memory"], ["memory"]]);
	});

	it("validates the id before opening anything", async () => {
		const t = setup();
		expect(await fail(t.frames.handle({ t: "personal-memory-pin", reqId: 1, id: "nope" }))).toBe(
			"Memory id must look like w:<id> or e:<id>",
		);
		expect(t.opened).toEqual([]);
	});

	it("passes the admin's error on, closes it and announces nothing", async () => {
		const t = setup();
		t.bank.failWith = "Unknown memory id";
		expect(await fail(t.frames.handle({ t: "personal-memory-retract", reqId: 1, id: "e:9" }))).toBe(
			"Unknown memory id",
		);
		expect(t.opened).toEqual([{ readOnly: false, closed: true }]);
		expect(t.changes).toEqual([]);
	});
});

describe("personal-memory-export", () => {
	it("passes the chunk through with the chunk size and offset", async () => {
		const t = setup();
		const reply = await t.frames.handle({ t: "personal-memory-export", reqId: 5, format: "json" });
		expect(reply).toEqual({
			t: "personal-memory-export",
			reqId: 5,
			name: "personal-memory-2026-10-14.json",
			mime: "application/json",
			text: "{}",
			next: 1000,
		});
		await t.frames.handle({ t: "personal-memory-export", reqId: 6, format: "markdown", offset: 1000 });
		expect(t.exports).toEqual([
			{ format: "json", offset: 0, maxChars: MAX_EXPORT_CHUNK_CHARS },
			{ format: "markdown", offset: 1000, maxChars: MAX_EXPORT_CHUNK_CHARS },
		]);
		expect(t.opened).toEqual([
			{ readOnly: true, closed: true },
			{ readOnly: true, closed: true },
		]);
	});

	it("keeps next null on the last part", async () => {
		const t = setup();
		t.bank.chunk = { name: "n.md", mime: "text/markdown", text: "# x", next: null };
		expect(await t.frames.handle({ t: "personal-memory-export", reqId: 5, format: "markdown" })).toMatchObject({
			next: null,
			mime: "text/markdown",
		});
	});

	it("rejects an unknown format and a bad offset", async () => {
		const t = setup();
		expect(
			await fail(
				t.frames.handle({ t: "personal-memory-export", reqId: 1, format: "csv" } as unknown as PersonalRequest),
			),
		).toBe("format must be json or markdown");
		expect(await fail(t.frames.handle({ t: "personal-memory-export", reqId: 1, format: "json", offset: -5 }))).toBe(
			"offset must be a whole number of 0 or more",
		);
		expect(t.opened).toEqual([]);
	});
});

describe("About you", () => {
	it("about-get and about-history never open the bank", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		fs.writeFileSync(t.paths.aboutFile, "# me\n");
		await t.about.seed();
		const got = await t.frames.handle({ t: "personal-about-get", reqId: 1 });
		expect(got).toMatchObject({ t: "personal-about-get", reqId: 1, about: { text: "# me\n", rev: 1 } });
		const history = await t.frames.handle({ t: "personal-about-history", reqId: 2, limit: 10 });
		expect(history).toMatchObject({
			t: "personal-about-history",
			reqId: 2,
			versions: [{ rev: 1, by: "setup", text: "# me\n" }],
		});
		expect(t.opened).toEqual([]);
	});

	it("about-history lists newest first and honours the limit", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		await t.about.write("one", "owner");
		await t.about.write("two", "owner");
		await t.about.write("three", "owner");
		expect(revs(await t.frames.handle({ t: "personal-about-history", reqId: 1 }))).toEqual([3, 2, 1]);
		expect(revs(await t.frames.handle({ t: "personal-about-history", reqId: 1, limit: 2 }))).toEqual([3, 2]);
		expect(
			await fail(
				t.frames.handle({ t: "personal-about-history", reqId: 1, limit: "all" } as unknown as PersonalRequest),
			),
		).toBe("limit must be a whole number of 0 or more");
	});

	it("about-set writes AGENTS.md and the history, announces the change and tells the session", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		fs.writeFileSync(t.paths.aboutFile, "# template\n");
		const current = await t.about.seed();
		const reply = await t.frames.handle({
			t: "personal-about-set",
			reqId: 3,
			text: "# Me\nI like tea.\n",
			baseRev: current.rev,
		});
		expect(reply).toMatchObject({
			t: "personal-about-set",
			reqId: 3,
			saved: true,
			about: { text: "# Me\nI like tea.\n", rev: 2 },
		});
		expect(fs.readFileSync(t.paths.aboutFile, "utf8")).toBe("# Me\nI like tea.\n");
		const versions = await t.about.history();
		expect(versions.map(v => [v.rev, v.by, v.text])).toEqual([
			[2, "owner", "# Me\nI like tea.\n"],
			[1, "setup", "# template\n"],
		]);
		expect(t.changes).toEqual([["about"]]);
		expect(t.events).toEqual([
			{
				source: "owner-answer",
				kind: "about-updated",
				title: "About you changed",
				body: "# Me\nI like tea.\n",
				ref: "about-rev-2",
			},
		]);
		expect(t.opened).toEqual([]);
	});

	it("about-set with a stale baseRev answers the current About and writes nothing", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		await t.about.write("first", "owner");
		await t.about.write("second", "owner");
		const reply = await t.frames.handle({ t: "personal-about-set", reqId: 3, text: "stale", baseRev: 1 });
		expect(reply).toMatchObject({
			t: "personal-about-set",
			reqId: 3,
			saved: false,
			about: { text: "second", rev: 2 },
		});
		expect(fs.readFileSync(t.paths.aboutFile, "utf8")).toBe("second");
		expect((await t.about.history()).map(v => v.rev)).toEqual([2, 1]);
		expect(t.changes).toEqual([]);
		expect(t.events).toEqual([]);
	});

	it("about-set does not tell the session while Personal is off", async () => {
		const t = setup({ enabled: false });
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		const reply = await t.frames.handle({ t: "personal-about-set", reqId: 1, text: "hello", baseRev: 0 });
		expect(reply).toMatchObject({ saved: true, about: { rev: 1 } });
		expect(t.changes).toEqual([["about"]]);
		expect(t.events).toEqual([]);
	});

	it("about-set still saves when the event cannot be filed, and says so once", async () => {
		const t = setup({ failEnqueue: true });
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const reply = await t.frames.handle({ t: "personal-about-set", reqId: 1, text: "hello", baseRev: 0 });
			expect(reply).toMatchObject({ saved: true, about: { text: "hello", rev: 1 } });
		} finally {
			console.error = original;
		}
		expect(errors).toHaveLength(1);
		expect(String(errors[0]?.[0])).toContain("channel down");
		expect(fs.readFileSync(t.paths.aboutFile, "utf8")).toBe("hello");
	});

	it("about-set rejects bad input without writing", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		const set = (text: unknown, baseRev: unknown) =>
			fail(t.frames.handle({ t: "personal-about-set", reqId: 1, text, baseRev } as PersonalRequest));
		expect(await set(5, 0)).toBe("About you must be text");
		expect(await set("x".repeat(MAX_ABOUT_BYTES + 1), 0)).toBe("About you is too long");
		expect(await set("é".repeat(MAX_ABOUT_BYTES / 2 + 1), 0)).toBe("About you is too long");
		expect(await set("ok", 1.5)).toBe("baseRev must be a whole number");
		expect(await set("ok", "0")).toBe("baseRev must be a whole number");
		expect(fs.existsSync(t.paths.aboutFile)).toBe(false);
		expect(t.changes).toEqual([]);
		expect(t.events).toEqual([]);
	});

	it("accepts About you of exactly the limit", async () => {
		const t = setup();
		fs.mkdirSync(t.paths.agentDir, { recursive: true });
		const reply = await t.frames.handle({
			t: "personal-about-set",
			reqId: 1,
			text: "x".repeat(MAX_ABOUT_BYTES),
			baseRev: 0,
		});
		expect(reply).toMatchObject({ saved: true });
	});
});

describe("dispatch", () => {
	it("answers undefined to any other request and opens nothing", async () => {
		const t = setup();
		expect(await t.frames.handle({ t: "personal-status", reqId: 1 })).toBeUndefined();
		expect(await t.frames.handle({ t: "personal-inbox", reqId: 1 } as PersonalRequest)).toBeUndefined();
		expect(await t.frames.handle({ t: "personal-proposals", reqId: 1 })).toBeUndefined();
		expect(t.opened).toEqual([]);
		expect(t.changes).toEqual([]);
	});

	it("close holds nothing and can be called any time", async () => {
		const t = setup();
		t.frames.close();
		await t.frames.handle({ t: "personal-memory-search", reqId: 1, query: {} });
		t.frames.close();
		expect(t.opened.every(o => o.closed)).toBe(true);
	});

	it("creates no files from memory frames or from reading About you", async () => {
		const t = setup();
		await t.frames.handle({ t: "personal-memory-search", reqId: 1, query: {} });
		await t.frames.handle({ t: "personal-memory-get", reqId: 1, id: "w:1" });
		await t.frames.handle({ t: "personal-memory-export", reqId: 1, format: "json" });
		expect(fs.existsSync(t.paths.configRoot)).toBe(false);
	});
});
