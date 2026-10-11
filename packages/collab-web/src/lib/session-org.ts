/**
 * How the user sorts their sessions: pinned to the top, snoozed until a time,
 * settled out of the way. One entry per session (companion sessions by session
 * id, recent rooms as `room:<roomId>`); absent means active. Every entry
 * carries the time of the action that wrote it, and two copies of the document
 * (this device, the companion, another device) merge entry by entry, the newer
 * action winning, so any number of devices converge without coordination.
 * Everything here is pure over an explicit clock.
 */

export type OrgStatus = "active" | "pinned" | "snoozed" | "settled";
/** Who settled a session: the user, or an auto-settle rule. */
export type SettleReason = "user" | "idle" | "pr";

export interface OrgEntry {
	/** Time (ms) of the action that wrote this entry; the newer entry wins a merge. */
	at: number;
	status: OrgStatus;
	/** `pinned`: position among the pinned, ascending. */
	order?: number;
	/** `snoozed`: when it wakes (ms). */
	until?: number;
	/** `settled`. */
	reason?: SettleReason;
}

export interface OrgSettings {
	/** Time (ms) of the change; settings merge as one unit. 0: never changed. */
	at: number;
	/** Settle sessions idle this many days; null: off. */
	idleDays: number | null;
	/** Settle sessions whose pull request merged or closed. */
	settleOnPr: boolean;
}

export interface OrgDoc {
	entries: Record<string, OrgEntry>;
	settings: OrgSettings;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Entries kept in one document; the oldest settled-or-default ones go first. */
export const MAX_ORG_ENTRIES = 2000;
export const MAX_IDLE_DAYS = 365;
/** Entries back at default (active) are only tombstones for merging; they are dropped after this. */
const TOMBSTONE_MS = 30 * DAY_MS;

const KEY_RE = /^[\w:.-]{1,160}$/;

export function emptyOrg(): OrgDoc {
	return { entries: {}, settings: { at: 0, idleDays: null, settleOnPr: false } };
}

export function roomOrgKey(roomId: string): string {
	return `room:${roomId}`;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseEntry(raw: unknown): OrgEntry | null {
	const e = raw as Record<string, unknown> | null;
	if (typeof e !== "object" || e === null || !isTime(e.at)) return null;
	switch (e.status) {
		case "active":
			return { at: e.at, status: "active" };
		case "pinned":
			return {
				at: e.at,
				status: "pinned",
				order: typeof e.order === "number" && Number.isFinite(e.order) ? e.order : 0,
			};
		case "snoozed":
			return isTime(e.until) ? { at: e.at, status: "snoozed", until: e.until } : null;
		case "settled":
			return {
				at: e.at,
				status: "settled",
				reason: e.reason === "idle" || e.reason === "pr" ? e.reason : "user",
			};
		default:
			return null;
	}
}

export function parseSettings(raw: unknown): OrgSettings {
	const s = raw as Record<string, unknown> | null;
	const fallback = emptyOrg().settings;
	if (typeof s !== "object" || s === null || !isTime(s.at)) return fallback;
	const days = s.idleDays;
	return {
		at: s.at,
		idleDays: typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_IDLE_DAYS ? days : null,
		settleOnPr: s.settleOnPr === true,
	};
}

/** A document from untrusted JSON (storage, the wire, the companion's file): damaged parts are dropped, never thrown. */
export function parseOrg(raw: unknown): OrgDoc {
	const doc = raw as { entries?: unknown; settings?: unknown } | null;
	const entries: Record<string, OrgEntry> = {};
	const stored = typeof doc === "object" && doc !== null ? doc.entries : null;
	if (typeof stored === "object" && stored !== null) {
		let count = 0;
		for (const [key, value] of Object.entries(stored)) {
			if (!KEY_RE.test(key) || key === "__proto__") continue;
			const entry = parseEntry(value);
			if (entry === null) continue;
			entries[key] = entry;
			if (++count >= MAX_ORG_ENTRIES) break;
		}
	}
	return { entries, settings: parseSettings(typeof doc === "object" && doc !== null ? doc.settings : null) };
}

/** Whether `a` wins over `b` in a merge: the later action, and for the same instant the larger encoding, so every device picks the same one. */
function newer<T extends { at: number }>(a: T, b: T): boolean {
	if (a.at !== b.at) return a.at > b.at;
	return JSON.stringify(a) > JSON.stringify(b);
}

/** Entry-wise last-writer-wins merge; commutative, associative and idempotent. */
export function mergeOrg(a: OrgDoc, b: OrgDoc): OrgDoc {
	const entries: Record<string, OrgEntry> = { ...a.entries };
	for (const [key, entry] of Object.entries(b.entries)) {
		if (!Object.hasOwn(entries, key) || newer(entry, entries[key])) entries[key] = entry;
	}
	return { entries, settings: newer(b.settings, a.settings) ? b.settings : a.settings };
}

export function sameOrg(a: OrgDoc, b: OrgDoc): boolean {
	const canonical = (doc: OrgDoc): string =>
		JSON.stringify([doc.settings, Object.entries(doc.entries).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]);
	return canonical(a) === canonical(b);
}

/** Drop default entries nobody can still be racing against, and the oldest entries past the cap. */
export function pruneOrg(doc: OrgDoc, now: number): OrgDoc {
	let entries = Object.entries(doc.entries).filter(([, e]) => !(e.status === "active" && now - e.at > TOMBSTONE_MS));
	if (entries.length > MAX_ORG_ENTRIES) {
		entries = entries.sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_ORG_ENTRIES);
	}
	if (entries.length === Object.keys(doc.entries).length) return doc;
	return { entries: Object.fromEntries(entries), settings: doc.settings };
}

/** The entry's status as of `now`: a snooze past its time is active again. */
export function statusOf(doc: OrgDoc, key: string, now: number): OrgStatus {
	if (!Object.hasOwn(doc.entries, key)) return "active";
	const entry = doc.entries[key];
	if (entry.status === "snoozed" && (entry.until ?? 0) <= now) return "active";
	return entry.status;
}

// ── transitions ──────────────────────────────────────────────────────────────

export type OrgAction =
	| { type: "pin" }
	| { type: "unpin" }
	| { type: "settle"; reason?: SettleReason }
	| { type: "unsettle" }
	| { type: "snooze"; until: number }
	| { type: "wake" }
	/** Put a pinned session between its neighbours; `before`/`after` are the keys now adjacent (either may be null at an end). */
	| { type: "move"; before: string | null; after: string | null }
	/** Back to the entry as it was (undo). */
	| { type: "restore"; entry: OrgEntry | null };

function nextAt(doc: OrgDoc, key: string, now: number): number {
	return Object.hasOwn(doc.entries, key) ? Math.max(now, doc.entries[key].at + 1) : now;
}

function pinnedOrders(doc: OrgDoc): number[] {
	return Object.values(doc.entries)
		.filter(e => e.status === "pinned")
		.map(e => e.order ?? 0);
}

function orderOf(doc: OrgDoc, key: string | null): number | null {
	if (key === null || !Object.hasOwn(doc.entries, key)) return null;
	const entry = doc.entries[key];
	return entry.status === "pinned" ? (entry.order ?? 0) : null;
}

/** The document after `action` on `key`; the same object when nothing changes. Pin, snooze and settle exclude one another. */
export function applyOrg(doc: OrgDoc, key: string, action: OrgAction, now: number): OrgDoc {
	const at = nextAt(doc, key, now);
	const current = Object.hasOwn(doc.entries, key) ? doc.entries[key] : null;
	let entry: OrgEntry;
	switch (action.type) {
		case "pin": {
			if (current?.status === "pinned") return doc;
			const orders = pinnedOrders(doc);
			entry = { at, status: "pinned", order: orders.length === 0 ? 0 : Math.max(...orders) + 1 };
			break;
		}
		case "unpin":
			if (current?.status !== "pinned") return doc;
			entry = { at, status: "active" };
			break;
		case "settle":
			entry = { at, status: "settled", reason: action.reason ?? "user" };
			break;
		case "unsettle":
			if (current?.status !== "settled") return doc;
			entry = { at, status: "active" };
			break;
		case "snooze":
			if (action.until <= now) return doc;
			entry = { at, status: "snoozed", until: action.until };
			break;
		case "wake":
			if (current?.status !== "snoozed") return doc;
			entry = { at, status: "active" };
			break;
		case "move": {
			if (current?.status !== "pinned") return doc;
			const lo = orderOf(doc, action.before);
			const hi = orderOf(doc, action.after);
			let order: number;
			if (lo !== null && hi !== null) order = (lo + hi) / 2;
			else if (lo !== null) order = lo + 1;
			else if (hi !== null) order = hi - 1;
			else return doc;
			// Repeated halving runs out of precision: renumber then.
			if (lo !== null && hi !== null && (order <= lo || order >= hi)) return renumber(doc, key, action, now);
			entry = { at, status: "pinned", order };
			break;
		}
		case "restore":
			entry = action.entry === null ? { at, status: "active" } : { ...action.entry, at };
			break;
	}
	return { entries: { ...doc.entries, [key]: entry }, settings: doc.settings };
}

/** Rewrite every pinned order as 0..n-1 with `key` between its neighbours. */
function renumber(
	doc: OrgDoc,
	key: string,
	action: { before: string | null; after: string | null },
	now: number,
): OrgDoc {
	const keys = pinnedKeys(doc).filter(k => k !== key);
	const index = action.after === null ? -1 : keys.indexOf(action.after);
	keys.splice(index === -1 ? keys.length : index, 0, key);
	const entries = { ...doc.entries };
	keys.forEach((k, i) => {
		entries[k] = { at: nextAt(doc, k, now), status: "pinned", order: i };
	});
	return { entries, settings: doc.settings };
}

/** Keys of pinned entries in display order. */
export function pinnedKeys(doc: OrgDoc): string[] {
	return Object.entries(doc.entries)
		.filter(([, e]) => e.status === "pinned")
		.sort(([ka, a], [kb, b]) => (a.order ?? 0) - (b.order ?? 0) || (ka < kb ? -1 : 1))
		.map(([key]) => key);
}

export function withSettings(
	doc: OrgDoc,
	patch: Partial<Pick<OrgSettings, "idleDays" | "settleOnPr">>,
	now: number,
): OrgDoc {
	const settings: OrgSettings = {
		at: Math.max(now, doc.settings.at + 1),
		idleDays: patch.idleDays === undefined ? doc.settings.idleDays : patch.idleDays,
		settleOnPr: patch.settleOnPr ?? doc.settings.settleOnPr,
	};
	if (settings.idleDays === doc.settings.idleDays && settings.settleOnPr === doc.settings.settleOnPr) return doc;
	return { entries: doc.entries, settings };
}

/** The `move` that puts the pinned key at `from` into position `to` of the list without it (so `to` ranges 0..length-1; dropping on row `t` is `to = t`). */
export function moveTarget(keys: readonly string[], from: number, to: number): OrgAction {
	const rest = keys.filter((_, i) => i !== from);
	return { type: "move", before: rest[to - 1] ?? null, after: rest[to] ?? null };
}

/** "in 3h", "in 2d": how long until a snooze wakes. */
export function wakeLabel(until: number, now: number): string {
	const min = Math.max(1, Math.ceil((until - now) / 60_000));
	if (min < 60) return `in ${min}m`;
	const h = Math.round(min / 60);
	return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

// ── sections ─────────────────────────────────────────────────────────────────

export interface OrgSections<T> {
	pinned: T[];
	/** Running now (and not pinned, snoozed or settled). */
	working: T[];
	active: T[];
	/** Soonest wake first. */
	snoozed: T[];
	/** Most recently settled first. */
	settled: T[];
}

/**
 * Sort `items` into sections. Within Working and Active the input order is kept
 * (callers pass newest first); Pinned follows pin order.
 */
export function sectionize<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	isWorking: (item: T) => boolean,
	doc: OrgDoc,
	now: number,
): OrgSections<T> {
	const out: OrgSections<T> = { pinned: [], working: [], active: [], snoozed: [], settled: [] };
	for (const item of items) {
		switch (statusOf(doc, keyOf(item), now)) {
			case "pinned":
				out.pinned.push(item);
				break;
			case "snoozed":
				out.snoozed.push(item);
				break;
			case "settled":
				out.settled.push(item);
				break;
			default:
				(isWorking(item) ? out.working : out.active).push(item);
		}
	}
	const entry = (item: T): OrgEntry => doc.entries[keyOf(item)];
	out.pinned.sort((a, b) => (entry(a).order ?? 0) - (entry(b).order ?? 0));
	out.snoozed.sort((a, b) => (entry(a).until ?? 0) - (entry(b).until ?? 0));
	out.settled.sort((a, b) => entry(b).at - entry(a).at);
	return out;
}

// ── auto-settle ──────────────────────────────────────────────────────────────

export interface IdleCandidate {
	key: string;
	/** Last time the session did something (ms). */
	lastActive: number;
	working: boolean;
}

/**
 * Settle sessions idle for `settings.idleDays`. Only active sessions are touched:
 * pinned and snoozed ones are the user's own choice. The user un-settling or
 * un-snoozing a session counts as activity (its entry time), so it is not
 * settled again at once.
 */
export function autoSettleIdle(doc: OrgDoc, candidates: readonly IdleCandidate[], now: number): OrgDoc {
	const days = doc.settings.idleDays;
	if (days === null) return doc;
	let next = doc;
	for (const c of candidates) {
		if (c.working || statusOf(next, c.key, now) !== "active") continue;
		const touched = Object.hasOwn(next.entries, c.key) ? next.entries[c.key].at : 0;
		if (now - Math.max(c.lastActive, touched) < days * DAY_MS) continue;
		next = applyOrg(next, c.key, { type: "settle", reason: "idle" }, now);
	}
	return next;
}

export interface PrDoneCandidate {
	key: string;
	/** When the session's pull request merged or closed (ms). */
	doneAt: number;
	/** The session (this run of omp) started at; a pull request that finished before it is old news. */
	startedAt: number;
	working: boolean;
}

/** Settle sessions whose pull request merged or closed, unless the user touched the session since. */
export function autoSettlePr(doc: OrgDoc, candidates: readonly PrDoneCandidate[], now: number): OrgDoc {
	if (!doc.settings.settleOnPr) return doc;
	let next = doc;
	for (const c of candidates) {
		if (c.working || statusOf(next, c.key, now) !== "active" || c.doneAt < c.startedAt) continue;
		const touched = Object.hasOwn(next.entries, c.key) ? next.entries[c.key].at : 0;
		if (touched >= c.doneAt) continue;
		next = applyOrg(next, c.key, { type: "settle", reason: "pr" }, now);
	}
	return next;
}

// ── snooze choices ───────────────────────────────────────────────────────────

export interface SnoozeChoice {
	id: string;
	label: string;
	until: number;
}

/** The snooze durations a menu offers; `limitResetAt` adds "Until the limit resets" when the open session knows it. */
export function snoozeChoices(now: number, limitResetAt: number | null): SnoozeChoice[] {
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	const choices: SnoozeChoice[] = [
		{ id: "1h", label: "1 hour", until: now + 60 * 60 * 1000 },
		{ id: "4h", label: "4 hours", until: now + 4 * 60 * 60 * 1000 },
		{ id: "tomorrow", label: "Tomorrow 9:00", until: tomorrow.getTime() },
		{ id: "week", label: "Next week", until: now + 7 * DAY_MS },
	];
	if (limitResetAt !== null && limitResetAt > now) {
		choices.unshift({ id: "limit", label: "Until the limit resets", until: limitResetAt });
	}
	return choices;
}
