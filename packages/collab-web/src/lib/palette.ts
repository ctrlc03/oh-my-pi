/**
 * The command palette's registry: sheets and actions announce themselves here, and ⌘K lists whatever is
 * registered. Nothing in the palette is hard-wired to a feature, so a feature that is only sometimes
 * available (a sheet needing the paired computer, a view needing a host capability) registers its entry
 * while it is available and the entry leaves with it.
 *
 * ```ts
 * usePaletteEntries(
 *   useMemo(
 *     () => (canInspect ? [{ id: "inspector:open", title: "Open the inspector", section: "View", run: openInspector }] : []),
 *     [canInspect, openInspector],
 *   ),
 * );
 * ```
 *
 * Also here: the open/closed state (so a header button or a shortcut can open it from anywhere), the
 * `>` `/` `@` `#` scope prefixes, the recently-used list, and the ranking that merges them with fuzzy
 * matching.
 */

import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { fuzzyMatch, substringMatch } from "./fuzzy";
import type { ShortcutId } from "./shortcuts";
import { readJson, writeJson } from "./storage";

export interface PaletteEntry {
	/** Stable and unique across the app, namespaced by feature (`github:open`). A later registration with the same id replaces the earlier one. */
	id: string;
	title: string;
	/** Group label shown beside the title and used to find the entry (`Git`, `View`); defaults to `Actions`. */
	section?: string;
	/** Extra words that find the entry without being shown (`pr`, `issues`). */
	keywords?: readonly string[];
	icon?: LucideIcon;
	/** Listed only once something is typed: for long families (one entry per model) that would bury the rest of the empty palette. */
	searchOnly?: true;
	/** A shortcut that does the same: its current keys (after any remapping) are shown beside the entry. */
	shortcut?: ShortcutId;
	/** Runs after the palette has closed. */
	run(): void;
}

export const DEFAULT_SECTION = "Actions";

const sources = new Map<symbol, readonly PaletteEntry[]>();
const registryListeners = new Set<() => void>();
let registrySnapshot: readonly PaletteEntry[] = [];

function recompute(): void {
	const byId = new Map<string, PaletteEntry>();
	for (const entries of sources.values()) for (const entry of entries) byId.set(entry.id, entry);
	registrySnapshot = [...byId.values()];
	for (const listener of registryListeners) listener();
}

/** Set what `owner` offers (replacing what it offered before); an empty list withdraws it. Returns the withdrawal. */
export function setPaletteEntries(owner: symbol, entries: readonly PaletteEntry[]): () => void {
	if (entries.length === 0) sources.delete(owner);
	else sources.set(owner, entries);
	recompute();
	return () => {
		if (sources.delete(owner)) recompute();
	};
}

/** Every registered entry, in registration order. The same array until something changes. */
export function paletteEntries(): readonly PaletteEntry[] {
	return registrySnapshot;
}

function subscribeRegistry(listener: () => void): () => void {
	registryListeners.add(listener);
	return () => registryListeners.delete(listener);
}

/** Offer `entries` for as long as the calling component is mounted and `entries` is the latest array; memoize it. */
export function usePaletteEntries(entries: readonly PaletteEntry[]): void {
	const owner = useRef<symbol>(Symbol("palette"));
	useEffect(() => setPaletteEntries(owner.current, entries), [entries]);
}

/** The registered entries, re-rendering when they change. */
export function usePaletteRegistry(): readonly PaletteEntry[] {
	return useSyncExternalStore(subscribeRegistry, paletteEntries);
}

// --- open state ---

/** `null` while closed; otherwise the text the palette opened with. */
let openWith: string | null = null;
const openListeners = new Set<() => void>();

function setOpen(next: string | null): void {
	if (next === openWith) return;
	openWith = next;
	for (const listener of openListeners) listener();
}

/** Open the palette, optionally with a query (a scope prefix included) already typed. */
export function openPalette(query = ""): void {
	setOpen(query);
}

export function closePalette(): void {
	setOpen(null);
}

export function togglePalette(): void {
	setOpen(openWith === null ? "" : null);
}

function subscribeOpen(listener: () => void): () => void {
	openListeners.add(listener);
	return () => openListeners.delete(listener);
}

/** The text the open palette started with, or null while it is closed. */
export function usePaletteOpen(): string | null {
	return useSyncExternalStore(subscribeOpen, () => openWith);
}

// --- scopes ---

export type PaletteScope = "actions" | "commands" | "sessions" | "messages";

/** The prefix character that narrows the palette to one kind of result. */
export const SCOPE_PREFIX: Record<PaletteScope, string> = {
	actions: ">",
	commands: "/",
	sessions: "@",
	messages: "#",
};

/** `>deploy` is the query `deploy` among actions only; a query without a prefix searches everything. */
export function parseQuery(raw: string): { scope: PaletteScope | null; text: string } {
	const first = raw.trimStart()[0];
	for (const scope of Object.keys(SCOPE_PREFIX) as PaletteScope[]) {
		if (SCOPE_PREFIX[scope] === first) return { scope, text: raw.trimStart().slice(1).trim() };
	}
	return { scope: null, text: raw.trim() };
}

// --- recents ---

const RECENT_KEY = "omp.collab.palette.recent";
export const MAX_RECENTS = 12;

/** Keys of the picks the palette remembers, newest first; anything unreadable is dropped. */
export function parseRecents(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const keys: string[] = [];
	for (const item of raw) if (typeof item === "string" && item !== "" && !keys.includes(item)) keys.push(item);
	return keys.slice(0, MAX_RECENTS);
}

/** `recents` with `key` moved to the front. */
export function bumpRecent(recents: readonly string[], key: string): string[] {
	return [key, ...recents.filter(existing => existing !== key)].slice(0, MAX_RECENTS);
}

export function loadRecents(): string[] {
	return parseRecents(readJson(RECENT_KEY));
}

/** Remember that `key` was picked; returns the new list. */
export function rememberPick(key: string): string[] {
	const next = bumpRecent(loadRecents(), key);
	writeJson(RECENT_KEY, next);
	return next;
}

// --- ranking ---

/** Anything the palette can list. `key` is unique across kinds (`action:github:open`, `command:model`, `session:<id>`). */
export interface PaletteItem {
	key: string;
	title: string;
	/** Words that find the item without being shown. */
	keywords?: readonly string[];
}

export interface Ranked<T> {
	item: T;
	score: number;
	/** Matched characters of the title, for highlighting; empty when only a keyword matched or nothing was typed. */
	positions: number[];
}

/** A keyword hit counts for less than the same hit in the title. */
const KEYWORD_WEIGHT = 0.8;
/** What being the newest pick is worth; each older pick is worth a bit less. Large enough to settle near-ties, too small to beat a better match. */
const RECENT_BONUS = 12;
const RECENT_STEP = 1;

/**
 * `items` matching `query`, best first. With nothing typed the recent picks come first (newest first),
 * then the rest in the order given. With a query, matches rank by fuzzy score with recency settling
 * near-ties, and equal scores keep the order given.
 */
export function rankItems<T extends PaletteItem>(
	items: readonly T[],
	query: string,
	recents: readonly string[],
): Ranked<T>[] {
	const recency = (item: T): number => {
		const at = recents.indexOf(item.key);
		return at < 0 ? 0 : Math.max(RECENT_STEP, RECENT_BONUS - at * RECENT_STEP);
	};
	if (query.trim() === "") {
		const order = (item: T): number => {
			const at = recents.indexOf(item.key);
			return at < 0 ? recents.length : at;
		};
		return items
			.map((item, index) => ({ item, index }))
			.sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
			.map(({ item }) => ({ item, score: 0, positions: [] }));
	}
	const ranked: { ranked: Ranked<T>; index: number }[] = [];
	items.forEach((item, index) => {
		const title = fuzzyMatch(query, item.title);
		let best: Ranked<T> | null = title === null ? null : { item, score: title.score, positions: title.positions };
		for (const keyword of item.keywords ?? []) {
			const found = substringMatch(query, keyword);
			if (found === null) continue;
			const score = found.score * KEYWORD_WEIGHT;
			if (best === null || score > best.score) best = { item, score, positions: [] };
		}
		if (best !== null) {
			best.score += recency(item);
			ranked.push({ ranked: best, index });
		}
	});
	ranked.sort((a, b) => b.ranked.score - a.ranked.score || a.index - b.index);
	return ranked.map(entry => entry.ranked);
}
