/**
 * How the user sorts their sessions: pinned to the top, snoozed until a time,
 * settled out of the way. One entry per session (companion sessions by session
 * id, recent rooms as `room:<roomId>`); absent means active. Every entry
 * carries the time of the action that wrote it, and two copies of the document
 * (this device, the companion, another device) merge entry by entry, the newer
 * action winning, so any number of devices converge without coordination.
 * Everything here is pure over an explicit clock.
 *
 * Besides the status an entry keeps two optional per-session choices that ride
 * along with it: `rank`, the user's place among the active sessions, and
 * `autoSettle: false`, the opt-out from the automatic settle rules. A computer
 * or app that predates them drops them when it reads a document and keeps the
 * rest intact.
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
	/**
	 * Not settled: the user's place among the active sessions, ascending. Sessions without one sit above those
	 * that have, newest first, so a session that just started is not buried. Settling clears it; pinning and
	 * snoozing keep it.
	 */
	rank?: number;
	/** `false`: the idle and pull request rules never settle this session (settling it by hand still works). Absent: they may. */
	autoSettle?: false;
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
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

interface EntryFields {
	order?: number;
	until?: number;
	reason?: SettleReason;
	rank?: number;
	autoSettle?: false;
}

/** An entry with its keys in one fixed order, so equal entries encode alike on every device. */
function build(at: number, status: OrgStatus, fields: EntryFields): OrgEntry {
	const entry: OrgEntry = { at, status };
	if (fields.order !== undefined) entry.order = fields.order;
	if (fields.until !== undefined) entry.until = fields.until;
	if (fields.reason !== undefined) entry.reason = fields.reason;
	if (fields.rank !== undefined) entry.rank = fields.rank;
	if (fields.autoSettle !== undefined) entry.autoSettle = fields.autoSettle;
	return entry;
}

/** What an entry keeps through a change of status (settling also drops the rank). */
function kept(entry: OrgEntry | null): EntryFields {
	return { rank: entry?.rank, autoSettle: entry?.autoSettle };
}

function parseEntry(raw: unknown): OrgEntry | null {
	const e = raw as Record<string, unknown> | null;
	if (typeof e !== "object" || e === null || !isTime(e.at)) return null;
	const autoSettle = e.autoSettle === false ? false : undefined;
	const rank = isNumber(e.rank) ? e.rank : undefined;
	switch (e.status) {
		case "active":
			return build(e.at, "active", { rank, autoSettle });
		case "pinned":
			return build(e.at, "pinned", { order: isNumber(e.order) ? e.order : 0, rank, autoSettle });
		case "snoozed":
			return isTime(e.until) ? build(e.at, "snoozed", { until: e.until, rank, autoSettle }) : null;
		case "settled":
			return build(e.at, "settled", {
				reason: e.reason === "idle" || e.reason === "pr" ? e.reason : "user",
				autoSettle,
			});
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

/**
 * Whether `a` wins over `b` in a merge: the later action; for the same instant the copy that kept more fields
 * (a computer that predates a field returns the entry without it, and that must not undo it here); then the
 * larger encoding. Every device picks the same one.
 */
function newer<T extends { at: number }>(a: T, b: T): boolean {
	if (a.at !== b.at) return a.at > b.at;
	const fields = Object.keys(a).length - Object.keys(b).length;
	if (fields !== 0) return fields > 0;
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

/** An active entry that says nothing but "back at default". */
function isTombstone(entry: OrgEntry, now: number): boolean {
	return (
		entry.status === "active" &&
		entry.rank === undefined &&
		entry.autoSettle === undefined &&
		now - entry.at > TOMBSTONE_MS
	);
}

/** Drop default entries nobody can still be racing against, and the oldest entries past the cap. */
export function pruneOrg(doc: OrgDoc, now: number): OrgDoc {
	let entries = Object.entries(doc.entries).filter(([, e]) => !isTombstone(e, now));
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

/** Whether the idle and pull request rules may settle the session (the default). */
export function autoSettles(doc: OrgDoc, key: string): boolean {
	return !Object.hasOwn(doc.entries, key) || doc.entries[key].autoSettle !== false;
}

// ── transitions ──────────────────────────────────────────────────────────────

export type OrgAction =
	/** Pin at the end, or between the pinned keys `before` and `after` when given (either may be null at an end). */
	| { type: "pin"; before?: string | null; after?: string | null }
	| { type: "unpin" }
	| { type: "settle"; reason?: SettleReason }
	| { type: "unsettle" }
	| { type: "snooze"; until: number }
	| { type: "wake" }
	/** Put a pinned session between its neighbours; `before`/`after` are the keys now adjacent (either may be null at an end). */
	| { type: "move"; before: string | null; after: string | null }
	/** Allow or forbid the idle and pull request rules to settle the session. */
	| { type: "autosettle"; on: boolean }
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

/** The pin order that puts a session between two pinned neighbours; `"renumber"` when halving ran out of precision, null with no neighbour. */
function orderBetween(doc: OrgDoc, before: string | null, after: string | null): number | "renumber" | null {
	const lo = orderOf(doc, before);
	const hi = orderOf(doc, after);
	if (lo === null && hi === null) return null;
	if (lo !== null && hi !== null) {
		const order = (lo + hi) / 2;
		return order <= lo || order >= hi ? "renumber" : order;
	}
	return lo !== null ? lo + 1 : (hi as number) - 1;
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
			const end = orders.length === 0 ? 0 : Math.max(...orders) + 1;
			const between = "before" in action ? orderBetween(doc, action.before ?? null, action.after ?? null) : null;
			if (between === "renumber")
				return renumber(doc, key, { before: action.before ?? null, after: action.after ?? null }, now);
			entry = build(at, "pinned", { order: between ?? end, ...kept(current) });
			break;
		}
		case "unpin":
			if (current?.status !== "pinned") return doc;
			entry = build(at, "active", kept(current));
			break;
		case "settle":
			if (current?.status === "settled") return doc;
			entry = build(at, "settled", { reason: action.reason ?? "user", autoSettle: current?.autoSettle });
			break;
		case "unsettle":
			if (current?.status !== "settled") return doc;
			entry = build(at, "active", { autoSettle: current.autoSettle });
			break;
		case "snooze":
			if (action.until <= now) return doc;
			entry = build(at, "snoozed", { until: action.until, ...kept(current) });
			break;
		case "wake":
			if (current?.status !== "snoozed") return doc;
			entry = build(at, "active", kept(current));
			break;
		case "move": {
			if (current?.status !== "pinned") return doc;
			const order = orderBetween(doc, action.before, action.after);
			if (order === null) return doc;
			// Repeated halving runs out of precision: renumber then.
			if (order === "renumber") return renumber(doc, key, action, now);
			entry = build(at, "pinned", { order, ...kept(current) });
			break;
		}
		case "autosettle":
			if ((current?.autoSettle !== false) === action.on) return doc;
			entry = build(at, current?.status ?? "active", {
				order: current?.order,
				until: current?.until,
				reason: current?.reason,
				rank: current?.rank,
				autoSettle: action.on ? undefined : false,
			});
			break;
		case "restore":
			entry = action.entry === null ? { at, status: "active" } : { ...action.entry, at };
			break;
	}
	return { entries: { ...doc.entries, [key]: entry }, settings: doc.settings };
}

/** Rewrite every pinned order as 0..n-1 with `key` between its neighbours (`key` becomes pinned if it was not). */
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
		const current = Object.hasOwn(doc.entries, k) ? doc.entries[k] : null;
		entries[k] = build(nextAt(doc, k, now), "pinned", { order: i, ...kept(current) });
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

/** `keys` without `key`, then with it at `index` (clamped). */
export function placeKey(keys: readonly string[], key: string, index: number): string[] {
	const rest = keys.filter(k => k !== key);
	rest.splice(Math.max(0, Math.min(index, rest.length)), 0, key);
	return rest;
}

/**
 * Give the active sessions in `order` (top first) the ranks 0..n-1. Only entries whose rank changes are
 * rewritten; settled ones are left alone. The same object when nothing changes.
 */
export function arrangeActive(doc: OrgDoc, order: readonly string[], now: number): OrgDoc {
	let entries: Record<string, OrgEntry> | null = null;
	order.forEach((key, rank) => {
		const current = Object.hasOwn(doc.entries, key) ? doc.entries[key] : null;
		if (current?.status === "settled" || current?.rank === rank) return;
		entries ??= { ...doc.entries };
		entries[key] = build(nextAt(doc, key, now), current?.status ?? "active", {
			order: current?.order,
			until: current?.until,
			rank,
			autoSettle: current?.autoSettle,
		});
	});
	return entries === null ? doc : { entries, settings: doc.settings };
}

/** `action` on each of `keys`, in order: one document, however many sessions it changed. */
export function applyMany(doc: OrgDoc, keys: readonly string[], action: OrgAction, now: number): OrgDoc {
	let next = doc;
	for (const key of keys) next = applyOrg(next, key, action, now);
	return next;
}

/** The entries `after` changed against `before`, as they were in `before` (null: there was none): what an undo needs to put back. */
export function changedEntries(before: OrgDoc, after: OrgDoc): Record<string, OrgEntry | null> {
	const prev: Record<string, OrgEntry | null> = {};
	for (const [key, entry] of Object.entries(after.entries)) {
		const old = Object.hasOwn(before.entries, key) ? before.entries[key] : null;
		if (old !== entry) prev[key] = old;
	}
	return prev;
}

/** Put every entry of `prev` (from {@link changedEntries}) back, newer than the changes it undoes. */
export function restoreEntries(doc: OrgDoc, prev: Readonly<Record<string, OrgEntry | null>>, now: number): OrgDoc {
	let next = doc;
	for (const [key, entry] of Object.entries(prev)) next = applyOrg(next, key, { type: "restore", entry }, now);
	return next;
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
	/** Not yet arranged ones first (callers pass newest first), then the arranged ones in their rank order. */
	active: T[];
	/** Soonest wake first. */
	snoozed: T[];
	/** Most recently settled first. */
	settled: T[];
}

export type OrgSection = keyof OrgSections<unknown>;

/**
 * Sort `items` into sections. Within Working the input order is kept (callers
 * pass newest first); Active puts sessions without a rank above those with one,
 * ranked ones by rank; Pinned follows pin order.
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
	const rank = (item: T): number | undefined =>
		Object.hasOwn(doc.entries, keyOf(item)) ? entry(item).rank : undefined;
	out.pinned.sort((a, b) => (entry(a).order ?? 0) - (entry(b).order ?? 0));
	out.snoozed.sort((a, b) => (entry(a).until ?? 0) - (entry(b).until ?? 0));
	out.settled.sort((a, b) => entry(b).at - entry(a).at);
	const arranged = out.active.filter(item => rank(item) !== undefined);
	arranged.sort((a, b) => (rank(a) as number) - (rank(b) as number));
	out.active = [...out.active.filter(item => rank(item) === undefined), ...arranged];
	return out;
}

// ── dragging between sections ────────────────────────────────────────────────

/** The sections a row can be dropped into; nothing is dropped into Snoozed (it needs a wake time) or Working (it is not a choice). */
export type DropZone = "pinned" | "active" | "settled";
/** What dropping does to the dragged row; `reorder` only moves it within its section. */
export type DropIntent = "reorder" | "pin" | "unpin" | "settle" | "unsettle" | "wake";

/**
 * What dropping a row of section `from` into `zone` does; null when nothing would change.
 * `ordered`: the active order can be kept (see `canOrderSessions`); without it a row cannot be reordered within Active.
 */
export function dropIntent(from: OrgSection, zone: DropZone, ordered: boolean): DropIntent | null {
	switch (zone) {
		case "pinned":
			return from === "pinned" ? "reorder" : "pin";
		case "settled":
			return from === "settled" ? null : "settle";
		case "active":
			switch (from) {
				case "pinned":
					return "unpin";
				case "snoozed":
					return "wake";
				case "settled":
					return "unsettle";
				case "active":
					return ordered ? "reorder" : null;
				default:
					return null;
			}
	}
}

/** The keys as displayed in the two sections a row can land in, each without Working ones. `active: null`: the order is not kept. */
export interface DropLayout {
	pinned: readonly string[];
	active: readonly string[] | null;
}

/**
 * The document after dropping `key` (shown in section `from`) into `zone` at `index` of that section's rows
 * without it. The same object when nothing changes.
 */
export function dropSession(
	doc: OrgDoc,
	key: string,
	from: OrgSection,
	zone: DropZone,
	index: number,
	layout: DropLayout,
	now: number,
): OrgDoc {
	const intent = dropIntent(from, zone, layout.active !== null);
	if (intent === null) return doc;
	const arrange = (next: OrgDoc): OrgDoc =>
		layout.active === null ? next : arrangeActive(next, placeKey(layout.active, key, index), now);
	switch (intent) {
		case "reorder":
			if (zone === "pinned") {
				const at = layout.pinned.indexOf(key);
				return at === -1 ? doc : applyOrg(doc, key, moveTarget(layout.pinned, at, index), now);
			}
			return arrange(doc);
		case "pin": {
			const rest = layout.pinned.filter(k => k !== key);
			return applyOrg(doc, key, { type: "pin", before: rest[index - 1] ?? null, after: rest[index] ?? null }, now);
		}
		case "unpin":
			return arrange(applyOrg(doc, key, { type: "unpin" }, now));
		case "wake":
			return arrange(applyOrg(doc, key, { type: "wake" }, now));
		case "unsettle":
			return arrange(applyOrg(doc, key, { type: "unsettle" }, now));
		case "settle":
			return applyOrg(doc, key, { type: "settle" }, now);
	}
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
 * pinned and snoozed ones are the user's own choice, and so is switching
 * auto-settle off for a session. The user un-settling or un-snoozing a session
 * counts as activity (its entry time), so it is not settled again at once.
 */
export function autoSettleIdle(doc: OrgDoc, candidates: readonly IdleCandidate[], now: number): OrgDoc {
	const days = doc.settings.idleDays;
	if (days === null) return doc;
	let next = doc;
	for (const c of candidates) {
		if (c.working || statusOf(next, c.key, now) !== "active" || !autoSettles(next, c.key)) continue;
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

/** Settle sessions whose pull request merged or closed, unless the user touched the session since or switched auto-settle off for it. */
export function autoSettlePr(doc: OrgDoc, candidates: readonly PrDoneCandidate[], now: number): OrgDoc {
	if (!doc.settings.settleOnPr) return doc;
	let next = doc;
	for (const c of candidates) {
		if (c.working || statusOf(next, c.key, now) !== "active" || !autoSettles(next, c.key) || c.doneAt < c.startedAt)
			continue;
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
