/**
 * Where the big panes (the editor, the code map, Settings, …) open. Each kind of pane has a placement the user
 * chose for it, kept per device in `omp.collab.pane-placement`:
 * - `float`: on top of the app, the overlay sheet (a bottom sheet on phones);
 * - `tab`: a tab in the main area next to the conversation;
 * - `beside`: next to the conversation in the side pane, with a draggable divider (`pane-size.ts`, `dock`).
 *
 * What a pane does is its *effective* placement: phones and touch screens keep floating, `beside` needs room for
 * the side pane and only one pane can be there. Everything that decides is a pure function of plain data (the
 * first half of this file) so it can be tested; the second half is the module store and the hooks the app and
 * `Sheet` use.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export const PANE_KINDS = [
	"editor",
	"architecture",
	"codemap",
	"quiz",
	"bakeoff",
	"review-board",
	"diagram",
	"terminal",
	"shell",
	"preview",
	"run",
	"usage",
	"sessions",
	"changes",
	"screens",
	"timeline",
	"github",
	"file",
	"session-details",
	"inbox",
	"agents",
	"schedules",
	"settings",
	"spar",
	"fixit",
	"pr-review",
	"fanout",
] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

export const PLACEMENTS = ["float", "tab", "beside"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** The user's choices; a kind that is absent is `float`. */
export type Placements = Readonly<Partial<Record<PaneKind, Placement>>>;

export const PLACEMENT_KEY = "omp.collab.pane-placement";

/** Where panes can be put at all: a mouse as the main pointer and the wide layout (phones and touch screens keep their bottom sheets). */
export const PLACEABLE_QUERY = "(pointer: fine) and (min-width: 901px)";

/** What the screen allows right now. */
export interface PlacementEnv {
	/** The main area is on screen: there are tabs and a side pane to put panes in. */
	hosted: boolean;
	/** {@link PLACEABLE_QUERY} matches. */
	placeable: boolean;
	/** The split layout is available (a wide desktop window, or a tablet held landscape). */
	split: boolean;
	/** A second session is open beside the conversation. */
	besideSession: boolean;
	/** The window has room for the side pane and a second session at once. */
	twoPanes: boolean;
}

export const NO_ENV: PlacementEnv = {
	hosted: false,
	placeable: false,
	split: false,
	besideSession: false,
	twoPanes: false,
};

/** Whatever was stored, as placements: entries that are not a known kind with a known placement are dropped, and `float` is the default so it is not kept. */
export function parsePlacements(raw: unknown): Placements {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const parsed: Partial<Record<PaneKind, Placement>> = {};
	for (const kind of PANE_KINDS) {
		const value = Object.getOwnPropertyDescriptor(raw, kind)?.value;
		const placement = PLACEMENTS.find(option => option === value);
		if (placement !== undefined && placement !== "float") parsed[kind] = placement;
	}
	return parsed;
}

/** The side pane needs the split layout, and a second session leaves room for it only on a very wide screen. */
export function canBeside(env: PlacementEnv): boolean {
	return env.split && (!env.besideSession || env.twoPanes);
}

/**
 * Where a pane really goes. `owner` says the pane holds the side pane (one pane at most does); a `beside`
 * choice without it, or without the room, is shown as a tab.
 */
export function effectivePlacement(chosen: Placement, env: PlacementEnv, owner: boolean): Placement {
	if (!env.hosted || !env.placeable || chosen === "float") return "float";
	if (chosen === "tab") return "tab";
	return canBeside(env) && owner ? "beside" : "tab";
}

/** What `tab` stands for in the strip for the conversation. */
export type Active = "conversation" | PaneKind;

/** A mounted pane that can be placed. */
export interface PaneEntry {
	kind: PaneKind;
	/** The sheet's accessible label; the tab's title. */
	label: string;
	/** Close the pane (the tab's ×). */
	close(): void;
}

export interface WorkspaceState {
	placements: Placements;
	env: PlacementEnv;
	/** Every mounted placeable pane in the order they were opened, wherever they are shown. */
	entries: readonly PaneEntry[];
	/** The tab the user last brought forward; {@link activeOf} says whether it is on screen. */
	active: Active;
	/** The pane that holds the side pane this page life. A pane that lost it to a later one shows as a tab; its choice stays `beside`. */
	beside: PaneKind | null;
}

export function emptyWorkspace(placements: Placements, env: PlacementEnv = NO_ENV): WorkspaceState {
	return { placements, env, entries: [], active: "conversation", beside: null };
}

export function chosenPlacement(state: WorkspaceState, kind: PaneKind): Placement {
	return state.placements[kind] ?? "float";
}

/** Where `kind` is shown now. A pane that is not mounted yet is judged as the one that is about to take the side pane. */
export function placementOf(state: WorkspaceState, kind: PaneKind): Placement {
	const mounted = state.entries.some(entry => entry.kind === kind);
	return effectivePlacement(chosenPlacement(state, kind), state.env, state.beside === kind || !mounted);
}

/** The panes shown as tabs, in the order they were opened. */
export function tabsOf(state: WorkspaceState): PaneEntry[] {
	return state.entries.filter(entry => placementOf(state, entry.kind) === "tab");
}

/** The pane in the side pane, or null. */
export function besideOf(state: WorkspaceState): PaneEntry | null {
	return state.entries.find(entry => placementOf(state, entry.kind) === "beside") ?? null;
}

/** The tab in front: the one last brought forward if it is still a tab, else the conversation. */
export function activeOf(state: WorkspaceState): Active {
	return state.active !== "conversation" && tabsOf(state).some(tab => tab.kind === state.active)
		? state.active
		: "conversation";
}

/** The tab strip's name for a pane. */
export function tabTitle(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * After a change: if the tab in front stopped being a tab, the one to its left (in the order of `before`) that
 * still is comes forward, else the conversation. A tab that was not in front is left alone.
 */
function settle(before: WorkspaceState, after: WorkspaceState): WorkspaceState {
	if (after.active === "conversation") return after;
	const tabsBefore = tabsOf(before).map(tab => tab.kind);
	const tabsAfter = new Set(tabsOf(after).map(tab => tab.kind));
	if (tabsAfter.has(after.active)) return after;
	const at = tabsBefore.indexOf(after.active);
	if (at < 0) return after;
	const left = tabsBefore.slice(0, at).reverse();
	return { ...after, active: left.find(kind => tabsAfter.has(kind)) ?? "conversation" };
}

/**
 * A pane was mounted (or mounted again: its label and `close` are refreshed in place and it keeps its position).
 * A new one goes last; if it is a tab it comes forward, and one whose choice is `beside` takes the side pane from
 * the pane that held it.
 */
export function mountPane(state: WorkspaceState, entry: PaneEntry): WorkspaceState {
	const at = state.entries.findIndex(held => held.kind === entry.kind);
	const entries = at < 0 ? [...state.entries, entry] : state.entries.map((held, i) => (i === at ? entry : held));
	const beside = at < 0 && chosenPlacement(state, entry.kind) === "beside" ? entry.kind : state.beside;
	const next = { ...state, entries, beside };
	return placementOf(next, entry.kind) === "tab" ? { ...next, active: entry.kind } : next;
}

/** A pane was closed. If its tab was in front, the one to its left comes forward. */
export function unmountPane(state: WorkspaceState, kind: PaneKind): WorkspaceState {
	if (!state.entries.some(entry => entry.kind === kind)) return state;
	const next = {
		...state,
		entries: state.entries.filter(entry => entry.kind !== kind),
		beside: state.beside === kind ? null : state.beside,
	};
	return settle(state, next);
}

/** The user put `kind` somewhere else. A pane that is now a tab comes forward; a tab that left gives way to its left neighbour. */
export function placePane(state: WorkspaceState, kind: PaneKind, placement: Placement): WorkspaceState {
	const placements = { ...state.placements };
	if (placement === "float") delete placements[kind];
	else placements[kind] = placement;
	const beside = placement === "beside" ? kind : state.beside === kind ? null : state.beside;
	const next = { ...state, placements, beside };
	if (!next.entries.some(entry => entry.kind === kind)) return next;
	return placementOf(next, kind) === "tab" ? { ...next, active: kind } : settle(state, next);
}

/**
 * The screen changed. Panes mounted before the main area was there (they floated) come forward when it appears;
 * otherwise nothing is reordered: a tab that cannot show right now (a narrow window) comes back as it was.
 */
export function setEnv(state: WorkspaceState, env: PlacementEnv): WorkspaceState {
	const next = { ...state, env };
	if (state.env.hosted || !env.hosted) return next;
	const tabs = tabsOf(next);
	const last = tabs[tabs.length - 1];
	return last === undefined ? next : { ...next, active: last.kind };
}

/** Brings a tab (or the conversation) forward; anything that is not a tab right now is ignored. */
export function activate(state: WorkspaceState, active: Active): WorkspaceState {
	if (active === state.active) return state;
	if (active !== "conversation" && !tabsOf(state).some(tab => tab.kind === active)) return state;
	return { ...state, active };
}

/** The tab a key moves to from `from` (arrow keys wrap, Home and End jump); null when the key is not for the strip. */
export function tabKeyTarget(key: string, from: number, count: number): number | null {
	if (count === 0) return null;
	switch (key) {
		case "ArrowRight":
			return (from + 1) % count;
		case "ArrowLeft":
			return (from - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

// ---- The module store ----

let store: WorkspaceState | undefined;
const listeners = new Set<() => void>();

function current(): WorkspaceState {
	store ??= emptyWorkspace(parsePlacements(readJson(PLACEMENT_KEY)));
	return store;
}

function commit(next: WorkspaceState): void {
	const before = current();
	if (next === before) return;
	store = next;
	if (next.placements !== before.placements) {
		writeJson(PLACEMENT_KEY, Object.keys(next.placements).length === 0 ? null : next.placements);
	}
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The panes' place on screen, derived once per change. */
export interface WorkspaceView {
	state: WorkspaceState;
	tabs: readonly PaneEntry[];
	active: Active;
	/** The pane in the side pane, or null. */
	beside: PaneEntry | null;
}

/** Tabs, the one in front and the side pane; re-renders when any of it changes. */
export function useWorkspace(): WorkspaceView {
	const snapshot = useSyncExternalStore(subscribe, current);
	return useMemo(
		() => ({ state: snapshot, tabs: tabsOf(snapshot), active: activeOf(snapshot), beside: besideOf(snapshot) }),
		[snapshot],
	);
}

/** Put a kind of pane somewhere; remembered per device. */
export function setPanePlacement(kind: PaneKind, placement: Placement): void {
	commit(placePane(current(), kind, placement));
}

/** Bring a tab, or the conversation, forward. */
export function activatePane(active: Active): void {
	commit(activate(current(), active));
}

/** Opening a pane that is already open shows it: a tab comes forward. */
export function revealPane(kind: PaneKind): void {
	commit(activate(current(), kind));
}

/** Panes closing and opening again in one go (a sheet that swaps its content, a changed label) keep their place. */
const leaving = new Set<PaneKind>();
/** The latest mount of each kind: an older one closing late must not remove the pane it was replaced by. */
const holders = new Map<PaneKind, object>();

/** Registers a mounted pane; the returned function unregisters it. */
export function registerPane(entry: PaneEntry): () => void {
	const holder = {};
	holders.set(entry.kind, holder);
	leaving.delete(entry.kind);
	commit(mountPane(current(), entry));
	return () => {
		if (holders.get(entry.kind) !== holder) return;
		leaving.add(entry.kind);
		queueMicrotask(() => {
			if (!leaving.delete(entry.kind) || holders.get(entry.kind) !== holder) return;
			holders.delete(entry.kind);
			commit(unmountPane(current(), entry.kind));
		});
	};
}

/** What the main area reports about the screen. */
export type WorkspaceHost = Omit<PlacementEnv, "hosted">;

/** The main area is on screen with this room: panes can be tabs and the side pane. */
export function useWorkspaceHost({ placeable, split, besideSession, twoPanes }: WorkspaceHost): void {
	useLayoutEffect(() => {
		commit(setEnv(current(), { hosted: true, placeable, split, besideSession, twoPanes }));
	}, [placeable, split, besideSession, twoPanes]);
	useLayoutEffect(
		() => () => {
			commit(setEnv(current(), NO_ENV));
		},
		[],
	);
}

// ---- Where a pane is drawn ----

/** The element a pane draws into: its own tab, or the one side pane. */
export type SlotId = PaneKind | "beside";

type Slots = Readonly<Partial<Record<SlotId, HTMLElement>>>;
let slots: Slots = {};
const slotRefs = new Map<SlotId, (element: HTMLElement | null) => void>();

/** A stable ref callback for the element that is the slot `id`. */
export function slotRef(id: SlotId): (element: HTMLElement | null) => void {
	let ref = slotRefs.get(id);
	if (ref === undefined) {
		ref = element => {
			if (slots[id] === (element ?? undefined)) return;
			const next = { ...slots };
			if (element === null) delete next[id];
			else next[id] = element;
			slots = next;
			for (const listener of listeners) listener();
		};
		slotRefs.set(id, ref);
	}
	return ref;
}

/** The element for the slot `id`, or null while there is none (or `id` is null). */
export function useSlot(id: SlotId | null): HTMLElement | null {
	const all = useSyncExternalStore(subscribe, () => slots);
	return id === null ? null : (all[id] ?? null);
}

// ---- Context from the pane's sheet ----

/** What a placed sheet tells what it holds, and what the user can do with it. */
export interface SheetPane {
	kind: PaneKind;
	/** Where it is shown now. */
	placement: Placement;
	/** What the user chose for this kind (a choice that cannot be honoured here shows as a tab). */
	chosen: Placement;
	/** The side pane has room right now. */
	besideRoom: boolean;
}

export const SheetPaneContext = createContext<SheetPane | null>(null);

/** Where the enclosing sheet is shown: `float` (on top; also everywhere a sheet is not placeable), `tab` or `beside`. */
export function useSheetPlacement(): Placement {
	return useContext(SheetPaneContext)?.placement ?? "float";
}

/** Where the pane of `kind` is shown now, for the component that renders its `Sheet` (inside the sheet, {@link useSheetPlacement} says the same). */
export function usePanePlacement(kind: PaneKind): Placement {
	return placementOf(useSyncExternalStore(subscribe, current), kind);
}

/** What the sheet of `kind` can tell and offer; null where panes cannot be placed (a phone, a touch screen, outside the main area) and for sheets that are not panes. */
export function useSheetPane(kind: PaneKind | undefined): SheetPane | null {
	const snapshot = useSyncExternalStore(subscribe, current);
	const placeable = snapshot.env.hosted && snapshot.env.placeable;
	const placement = kind === undefined ? "float" : placementOf(snapshot, kind);
	const chosen = kind === undefined ? "float" : chosenPlacement(snapshot, kind);
	const besideRoom = canBeside(snapshot.env);
	return useMemo(
		() => (kind === undefined || !placeable ? null : { kind, placement, chosen, besideRoom }),
		[kind, placeable, placement, chosen, besideRoom],
	);
}

/** Keeps the latest `close` without re-registering the pane for every render of its sheet. */
export function useRegisteredPane(kind: PaneKind | undefined, label: string, close: () => void): void {
	const closeRef = useRef(close);
	closeRef.current = close;
	useLayoutEffect(() => {
		if (kind === undefined) return;
		return registerPane({ kind, label, close: () => closeRef.current() });
	}, [kind, label]);
}
