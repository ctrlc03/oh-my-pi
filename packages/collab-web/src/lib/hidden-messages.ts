/**
 * Hiding messages from the chat. Hide only changes what this app shows: the session file and the agent's
 * context are untouched, and nothing is sent to the host. A message is named by the id the transcript gives it:
 * a prompt by its session entry id, a reply by `<entry id>:<index of its text>` ({@link replyId}), a tool run by
 * the id of each of its calls. Entry ids are written into the session file, so they hold across reconnects,
 * resumes, compaction and `/clear`; they are unique only inside one session, so the document is kept per session id.
 *
 * One document per session maps message id → `{ at, hidden }`. Unhiding writes `hidden: false` instead of deleting,
 * so two copies of the document (this device, the computer, another device) merge entry by entry, the later
 * action winning, and converge without coordination. Everything here is pure over an explicit clock.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { type Block, replyId } from "./blocks";
import { isPrompt } from "./trim";

export interface HiddenEntry {
	/** Time (ms) of the action that wrote this entry; the newer entry wins a merge. */
	at: number;
	hidden: boolean;
}

/** The hidden messages of one session. */
export interface HiddenDoc {
	entries: Record<string, HiddenEntry>;
}

/** Entries kept in one document; the oldest go first. */
export const MAX_HIDDEN_ENTRIES = 5000;
/** Sessions kept on this device and on a computer; the ones changed longest ago go first. */
export const MAX_HIDDEN_SESSIONS = 200;
/** Unhidden entries are only tombstones for merging; they are dropped after this. */
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 256;

export function emptyHidden(): HiddenDoc {
	return { entries: {} };
}

/** A usable message id. Tool call ids come from the model provider, so only the length and a few names are restricted. */
export function isHiddenKey(key: unknown): key is string {
	return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH && key !== "__proto__";
}

function parseEntry(raw: unknown): HiddenEntry | null {
	const e = raw as Record<string, unknown> | null;
	if (typeof e !== "object" || e === null) return null;
	if (typeof e.at !== "number" || !Number.isFinite(e.at) || e.at < 0 || typeof e.hidden !== "boolean") return null;
	return { at: e.at, hidden: e.hidden };
}

/** A document from untrusted JSON (storage, the wire, the computer's file): damaged parts are dropped, never thrown. */
export function parseHidden(raw: unknown): HiddenDoc {
	const stored = (raw as { entries?: unknown } | null)?.entries;
	const entries: Record<string, HiddenEntry> = {};
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { entries };
	let count = 0;
	for (const [key, value] of Object.entries(stored)) {
		if (!isHiddenKey(key)) continue;
		const entry = parseEntry(value);
		if (entry === null) continue;
		entries[key] = entry;
		if (++count >= MAX_HIDDEN_ENTRIES) break;
	}
	return { entries };
}

/** Whether `a` wins over `b`: the later action; for the same instant, hidden (so every device picks the same one). */
function newer(a: HiddenEntry, b: HiddenEntry): boolean {
	if (a.at !== b.at) return a.at > b.at;
	return a.hidden && !b.hidden;
}

/** Entry-wise last-writer-wins merge; commutative, associative and idempotent. */
export function mergeHidden(a: HiddenDoc, b: HiddenDoc): HiddenDoc {
	const entries: Record<string, HiddenEntry> = { ...a.entries };
	for (const [key, entry] of Object.entries(b.entries)) {
		if (!Object.hasOwn(entries, key) || newer(entry, entries[key]!)) entries[key] = entry;
	}
	return { entries };
}

export function sameHidden(a: HiddenDoc, b: HiddenDoc): boolean {
	const keys = Object.keys(a.entries);
	if (keys.length !== Object.keys(b.entries).length) return false;
	return keys.every(key => {
		if (!Object.hasOwn(b.entries, key)) return false;
		const x = a.entries[key]!;
		const y = b.entries[key]!;
		return x.at === y.at && x.hidden === y.hidden;
	});
}

/** Drop tombstones nobody can still be racing against, and the oldest entries past the cap. */
export function pruneHidden(doc: HiddenDoc, now: number): HiddenDoc {
	let entries = Object.entries(doc.entries).filter(([, e]) => e.hidden || now - e.at <= TOMBSTONE_MS);
	if (entries.length > MAX_HIDDEN_ENTRIES) {
		entries = entries.sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_HIDDEN_ENTRIES);
	}
	if (entries.length === Object.keys(doc.entries).length) return doc;
	return { entries: Object.fromEntries(entries) };
}

/** The ids currently hidden. */
export function hiddenIds(doc: HiddenDoc): Set<string> {
	const ids = new Set<string>();
	for (const [key, entry] of Object.entries(doc.entries)) if (entry.hidden) ids.add(key);
	return ids;
}

/** The ids of `ids` that `hidden: value` would change, each once. */
export function changingIds(doc: HiddenDoc, ids: readonly string[], value: boolean): string[] {
	const out: string[] = [];
	for (const id of new Set(ids)) {
		if (!isHiddenKey(id)) continue;
		const current = Object.hasOwn(doc.entries, id) && doc.entries[id]!.hidden;
		if (current !== value) out.push(id);
	}
	return out;
}

/** The document with `ids` hidden (or shown again); the same object when nothing changes. */
export function applyHidden(doc: HiddenDoc, ids: readonly string[], hidden: boolean, now: number): HiddenDoc {
	const changing = changingIds(doc, ids, hidden);
	if (changing.length === 0) return doc;
	const entries = { ...doc.entries };
	for (const id of changing) {
		const at = Object.hasOwn(entries, id) ? Math.max(now, entries[id]!.at + 1) : now;
		entries[id] = { at, hidden };
	}
	return { entries };
}

// ── the documents of every session ───────────────────────────────────────────

/** Documents by session id, as one device keeps them. */
export type HiddenStore = Record<string, HiddenDoc>;

/** The newest action in a document: how recently the session's hiding changed. */
export function lastChange(doc: HiddenDoc): number {
	let at = 0;
	for (const entry of Object.values(doc.entries)) at = Math.max(at, entry.at);
	return at;
}

/** Stored documents from untrusted JSON; empty documents and sessions past the cap (the least recently changed) are dropped. */
export function parseStore(raw: unknown): HiddenStore {
	const sessions = (raw as { sessions?: unknown } | null)?.sessions;
	if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return {};
	const docs: [string, HiddenDoc][] = [];
	for (const [sessionId, value] of Object.entries(sessions)) {
		if (!isHiddenKey(sessionId)) continue;
		const doc = parseHidden(value);
		if (Object.keys(doc.entries).length > 0) docs.push([sessionId, doc]);
	}
	return limitStore(Object.fromEntries(docs));
}

/** At most {@link MAX_HIDDEN_SESSIONS} sessions, keeping the ones changed most recently. */
export function limitStore(store: HiddenStore): HiddenStore {
	const sessions = Object.entries(store);
	if (sessions.length <= MAX_HIDDEN_SESSIONS) return store;
	return Object.fromEntries(
		sessions.sort(([, a], [, b]) => lastChange(b) - lastChange(a)).slice(0, MAX_HIDDEN_SESSIONS),
	);
}

// ── what a transcript is given ───────────────────────────────────────────────

/** The hidden messages of the open session, and what changes them. */
export interface HideControl {
	/** Message ids that are hidden. */
	hidden: ReadonlySet<string>;
	/** *Show hidden messages*: every hidden message shows in place, dimmed (this session only, never stored). */
	showing: boolean;
	/** Hide `ids` (`count` blocks' worth, for the Undo line). */
	hide(ids: readonly string[], count: number): void;
	unhide(ids: readonly string[]): void;
}

// ── blocks ───────────────────────────────────────────────────────────────────

/** The message ids a block stands for: itself, or every call of a folded tool run. */
export function memberIds(block: Block): string[] {
	return block.kind === "run" ? block.tools.map(tool => tool.id) : [block.id];
}

/** Whether every message of the block is hidden. */
export function isBlockHidden(block: Block, hidden: ReadonlySet<string>): boolean {
	return memberIds(block).every(id => hidden.has(id));
}

/** Where a hidden block sits in a run of adjacent hidden blocks. */
export interface HiddenSlot {
	/** The id of the run's first block: names the run. */
	group: string;
	/** This block opens the run (the marker goes here). */
	start: boolean;
	/** Blocks in the run. */
	size: number;
}

/**
 * Hidden blocks grouped into runs of blocks next to each other in `blocks` (transcript order), so a run
 * shows one marker. A block that is not hidden ends the run; blocks that are not hidden have no slot.
 */
export function hiddenSlots(blocks: readonly Block[], hidden: ReadonlySet<string>): Map<string, HiddenSlot> {
	const slots = new Map<string, HiddenSlot>();
	let run: { first: string; ids: string[] } | null = null;
	const close = (): void => {
		if (run === null) return;
		const { first, ids } = run;
		ids.forEach((id, i) => slots.set(id, { group: first, start: i === 0, size: ids.length }));
		run = null;
	};
	for (const block of blocks) {
		if (!isBlockHidden(block, hidden)) {
			close();
			continue;
		}
		if (run === null) run = { first: block.id, ids: [] };
		run.ids.push(block.id);
	}
	close();
	return slots;
}

/** The prompt `promptId` and every block after it up to the next prompt: one exchange. Empty when `promptId` is not a prompt in `blocks`. */
export function exchangeBlocks(blocks: readonly Block[], promptId: string): Block[] {
	const from = blocks.findIndex(block => block.kind === "prompt" && block.id === promptId);
	if (from < 0) return [];
	let to = blocks.length;
	for (let i = from + 1; i < blocks.length; i++) {
		if (blocks[i]!.kind === "prompt") {
			to = i;
			break;
		}
	}
	return blocks.slice(from, to);
}

/** The message ids of `blocks`, each once. */
export function blocksMemberIds(blocks: readonly Block[]): string[] {
	return [...new Set(blocks.flatMap(memberIds))];
}

/** Blocks that are not hidden, as a selection counts them for *Hide N messages*. */
export function visibleBlocks(blocks: readonly Block[], hidden: ReadonlySet<string>): Block[] {
	return blocks.filter(block => !isBlockHidden(block, hidden));
}

// ── exports ──────────────────────────────────────────────────────────────────

/**
 * The entries without the hidden messages, for Copy, Export and Share of a conversation: a hidden prompt goes, a hidden reply
 * or tool call is dropped from its message, and a message left with no text and no calls goes with its tool results.
 */
export function withoutHidden(entries: readonly SessionEntry[], hidden: ReadonlySet<string>): readonly SessionEntry[] {
	if (hidden.size === 0) return entries;
	const out: SessionEntry[] = [];
	for (const entry of entries) {
		if (isPrompt(entry)) {
			if (!hidden.has(entry.id)) out.push(entry);
			continue;
		}
		if (entry.type !== "message") {
			out.push(entry);
			continue;
		}
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!hidden.has(message.toolCallId)) out.push(entry);
			continue;
		}
		if (message.role !== "assistant") {
			out.push(entry);
			continue;
		}
		const content = message.content.filter((block, i) =>
			block.type === "text"
				? !hidden.has(replyId(entry.id, i))
				: block.type === "toolCall"
					? !hidden.has(block.id)
					: true,
		);
		if (content.length === message.content.length) {
			out.push(entry);
		} else if (content.some(block => block.type === "text" || block.type === "toolCall")) {
			out.push({ ...entry, message: { ...message, content } });
		}
	}
	return out;
}
