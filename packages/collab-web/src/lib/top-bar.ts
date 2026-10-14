/**
 * Which action buttons the session's top bar shows, and in what order: a per-device choice made in Settings →
 * Appearance → *Top bar*. The bar keeps its fixed parts (sessions toggle, name, status, ⋯); the buttons here are
 * the optional ones. Every action stays in the ⋯ sheet and the command palette, shown or not.
 *
 * The saved choice is the full order plus the hidden ids. Anything unknown in it (a button a later build removed,
 * a hand-edited entry) is ignored, and a button the saved choice does not mention (one a later build added) shows
 * up at the end, on only if it is on by default. Whether a button can appear at all (a code map needs a paired
 * computer) is the bar's business, not the choice's: the choice is kept while its button is unavailable.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export const TOP_BAR_KEY = "omp.collab.top-bar";

export interface TopBarButton {
	id: string;
	/** What Settings calls it. */
	label: string;
	/** Shown in the default bar. */
	on: boolean;
	/** May stand in the compact bar of a phone (at most {@link PHONE_SLOTS} do). The rest stay in ⋯ there, whatever the choice. */
	phone: boolean;
}

/**
 * Every optional button. The first eight are today's bar, in today's order, and the default; the rest are
 * actions that otherwise live only in the ⋯ sheet, off until chosen.
 */
export const TOP_BAR_BUTTONS = [
	{ id: "settings", label: "Settings", on: true, phone: false },
	{ id: "find", label: "Find in session", on: true, phone: true },
	{ id: "editor", label: "Editor", on: true, phone: true },
	{ id: "codemap", label: "Code map", on: true, phone: true },
	{ id: "quizzes", label: "Quizzes", on: true, phone: false },
	{ id: "github", label: "GitHub", on: true, phone: false },
	{ id: "agents", label: "Agents", on: true, phone: true },
	{ id: "leave", label: "Leave session", on: true, phone: false },
	{ id: "changes", label: "Changes", on: false, phone: true },
	{ id: "architecture", label: "Architecture", on: false, phone: true },
	{ id: "mapchanges", label: "Map of what changed", on: false, phone: true },
	{ id: "terminal", label: "Terminal", on: false, phone: true },
	{ id: "preview", label: "Preview", on: false, phone: true },
	{ id: "run", label: "Run", on: false, phone: true },
	{ id: "timeline", label: "Timeline", on: false, phone: true },
	{ id: "usage", label: "Usage", on: false, phone: true },
	{ id: "sessions", label: "All sessions", on: false, phone: true },
	{ id: "sparring", label: "Sparring", on: false, phone: true },
	{ id: "bakeoff", label: "Bake-off", on: false, phone: true },
] as const satisfies readonly TopBarButton[];

export type TopBarId = (typeof TOP_BAR_BUTTONS)[number]["id"];

/** A button in the chosen order; `shown: false` keeps its place for when it is switched back on. */
export interface TopBarItem {
	id: TopBarId;
	shown: boolean;
}

export const DEFAULT_TOP_BAR: readonly TopBarItem[] = TOP_BAR_BUTTONS.map(button => ({
	id: button.id,
	shown: button.on,
}));

const IDS: readonly string[] = TOP_BAR_BUTTONS.map(button => button.id);

function isId(value: unknown): value is TopBarId {
	return typeof value === "string" && IDS.includes(value);
}

function ids(value: unknown): TopBarId[] {
	return Array.isArray(value) ? value.filter(isId) : [];
}

export function topBarButton(id: TopBarId): TopBarButton {
	return TOP_BAR_BUTTONS.find(button => button.id === id)!;
}

/**
 * Whatever was stored, as a complete choice: every button exactly once. A button the stored order does not list
 * (one added after the choice was made) goes last and is shown only if it is on by default, so an old choice
 * never grows buttons by itself.
 */
export function parseTopBar(raw: unknown): TopBarItem[] {
	const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const listed = new Set(ids(o.order));
	const order = [...new Set([...listed, ...(IDS as TopBarId[])])];
	const hidden = new Set(ids(o.hidden));
	return order.map(id => ({ id, shown: !hidden.has(id) && (listed.has(id) || topBarButton(id).on) }));
}

export function isDefaultTopBar(items: readonly TopBarItem[]): boolean {
	return items.every((item, i) => item.id === DEFAULT_TOP_BAR[i]?.id && item.shown === DEFAULT_TOP_BAR[i]?.shown);
}

/** `id` one place earlier (`-1`) or later (`1`); the ends stay put. */
export function moveTopBarItem(items: readonly TopBarItem[], id: TopBarId, delta: -1 | 1): TopBarItem[] {
	const from = items.findIndex(item => item.id === id);
	const to = from + delta;
	if (from < 0 || to < 0 || to >= items.length) return [...items];
	const next = [...items];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}

export function showTopBarItem(items: readonly TopBarItem[], id: TopBarId, shown: boolean): TopBarItem[] {
	return items.map(item => (item.id === id ? { ...item, shown } : item));
}

/** The buttons to draw, in order: the shown ones whose action exists (`available`). */
export function visibleTopBar(items: readonly TopBarItem[], available: (id: TopBarId) => boolean): TopBarId[] {
	return items.filter(item => item.shown && available(item.id)).map(item => item.id);
}

/** What a phone's compact bar has room for. */
export const PHONE_SLOTS = 4;

/**
 * `visible` as a phone's bar draws it: only the buttons that may stand in the compact bar, and no more than
 * {@link PHONE_SLOTS} of them, first ones first. The rest stay in ⋯.
 */
export function phoneTopBar(visible: readonly TopBarId[]): TopBarId[] {
	return visible.filter(id => topBarButton(id).phone).slice(0, PHONE_SLOTS);
}

function serialize(items: readonly TopBarItem[]): { order: TopBarId[]; hidden: TopBarId[] } {
	return {
		order: items.map(item => item.id),
		hidden: items.filter(item => !item.shown).map(item => item.id),
	};
}

let current: readonly TopBarItem[] = parseTopBar(readJson(TOP_BAR_KEY));
const listeners = new Set<() => void>();

function commit(next: readonly TopBarItem[]): void {
	current = next;
	writeJson(TOP_BAR_KEY, isDefaultTopBar(next) ? null : serialize(next));
	for (const listener of listeners) listener();
}

export function setTopBar(items: readonly TopBarItem[]): void {
	commit(items);
}

export function resetTopBar(): void {
	commit(DEFAULT_TOP_BAR);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function currentTopBar(): readonly TopBarItem[] {
	return current;
}

export function useTopBar(): readonly TopBarItem[] {
	return useSyncExternalStore(subscribe, currentTopBar, () => DEFAULT_TOP_BAR);
}
