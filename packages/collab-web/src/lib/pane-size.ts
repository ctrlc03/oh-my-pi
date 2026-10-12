/**
 * Pane widths: what each resizable pane may be, where its saved size lives, and how a layout row is shared
 * out when the window is too narrow for everyone's preference. The DOM side is `use-pane-layout.ts`;
 * everything here is a pure function of numbers so the decisions can be tested.
 *
 * A saved size is the user's preference. It is never rewritten because the window shrank: the width on
 * screen is the preference clamped to what fits, and it comes back when the room does.
 */
import { readJson, writeJson } from "./storage";

export type PaneId = "sidebar" | "rail" | "beside" | "editor";

/** Left to right in the layout row. */
export const PANE_IDS: readonly PaneId[] = ["sidebar", "rail", "beside", "editor"];
/** Who gets room first when the row is too narrow for every preference: the sessions and the editor, then the sidebar and the rail. */
export const PANE_PRIORITY: readonly PaneId[] = ["beside", "editor", "sidebar", "rail"];

export interface PaneSpec {
	/** Per-device preference key. */
	storageKey: string;
	/** `px`: a width in pixels. `fraction`: a share of the layout row (stored, clamped and shown as that share). */
	unit: "px" | "fraction";
	default: number;
	min: number;
	max: number;
	/** Fraction panes: the narrowest width in pixels, however small the row is. */
	floorPx?: number;
	/** Which side of the pane its divider is on: dragging toward the pane's far side shrinks it. */
	edge: "start" | "end";
	/** Accessible name of the divider. */
	label: string;
}

export const PANES: Record<PaneId, PaneSpec> = {
	sidebar: {
		storageKey: "omp.collab.pane.sidebar",
		unit: "px",
		default: 272,
		min: 200,
		max: 480,
		edge: "end",
		label: "Resize sessions sidebar",
	},
	rail: {
		storageKey: "omp.collab.pane.rail",
		unit: "px",
		default: 296,
		min: 220,
		max: 520,
		edge: "start",
		label: "Resize agents rail",
	},
	beside: {
		storageKey: "omp.collab.pane.beside",
		unit: "fraction",
		default: 0.36,
		min: 0.25,
		max: 0.75,
		floorPx: 320,
		edge: "start",
		label: "Resize split view",
	},
	editor: {
		storageKey: "omp.collab.pane.editor",
		unit: "fraction",
		default: 0.36,
		min: 0.25,
		max: 0.75,
		floorPx: 320,
		edge: "start",
		label: "Resize editor",
	},
};

/** The conversation never gets narrower than this, whatever the panes around it ask for. */
export const MIN_MAIN = 420;
/** The space between a pane and its neighbour (the panes' own margin in the layout row). */
export const PANE_GAP = 8;
export const KEY_STEP = 16;
export const KEY_STEP_SHIFT = 64;

/** `row` is the layout row's content width in pixels. */
export function minPx(id: PaneId, row: number): number {
	const spec = PANES[id];
	return spec.unit === "px" ? spec.min : Math.max(spec.min * row, spec.floorPx ?? 0);
}

export function maxPx(id: PaneId, row: number): number {
	const spec = PANES[id];
	return spec.unit === "px" ? spec.max : spec.max * row;
}

/** A stored preference (or the default when there is none) as a width in pixels. */
export function storedToPx(id: PaneId, stored: number | null, row: number): number {
	const spec = PANES[id];
	const value = stored ?? spec.default;
	return spec.unit === "px" ? value : value * row;
}

export function pxToStored(id: PaneId, px: number, row: number): number {
	return PANES[id].unit === "px" ? Math.round(px) : px / row;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export interface PaneWant {
	id: PaneId;
	/** The preferred width, in pixels. */
	px: number;
}

export interface PaneSize {
	id: PaneId;
	px: number;
	min: number;
	max: number;
}

/**
 * Shares one layout row out: each pane gets its preference clamped to its own range and to the room that is
 * left once the conversation keeps {@link MIN_MAIN} and every pane still waiting keeps its minimum. The pane
 * being resized (`lead`) is served first, so it can take room from the others; the rest keep the order of
 * `wants`. A row too narrow even for the minimums gets the minimums; the layout's flex rules take it from
 * there. The result is in the order of `wants`.
 */
export function resolvePanes(row: number, wants: readonly PaneWant[], lead: PaneId | null): PaneSize[] {
	const served =
		lead === null ? [...wants] : [...wants.filter(w => w.id === lead), ...wants.filter(w => w.id !== lead)];
	const mins = served.map(w => minPx(w.id, row));
	let room = row - MIN_MAIN - PANE_GAP * served.length;
	let reserved = mins.reduce((sum, min) => sum + min, 0);
	const sized: PaneSize[] = [];
	served.forEach((want, i) => {
		const min = mins[i] ?? 0;
		reserved -= min;
		const max = Math.max(min, Math.min(maxPx(want.id, row), room - reserved));
		const px = clamp(want.px, min, max);
		room -= px;
		sized.push({ id: want.id, px, min, max });
	});
	return wants.map(w => sized.find(s => s.id === w.id)!);
}

/** What a key does to a pane: its new width in pixels, `"reset"` for the default, or null when the key is not for the divider. */
export function keyboardSize(
	key: string,
	shift: boolean,
	edge: PaneSpec["edge"],
	size: PaneSize,
): number | "reset" | null {
	switch (key) {
		case "Home":
			return size.min;
		case "End":
			return size.max;
		case "Enter":
			return "reset";
		case "ArrowLeft":
		case "ArrowRight": {
			// The arrows move the divider: toward the right it widens a pane whose divider is on its right edge, and narrows one whose divider is on its left.
			const toRight = key === "ArrowRight" ? 1 : -1;
			const grow = edge === "end" ? toRight : -toRight;
			return clamp(size.px + grow * (shift ? KEY_STEP_SHIFT : KEY_STEP), size.min, size.max);
		}
		default:
			return null;
	}
}

/** The size a pointer drag reaches: the width at its start, moved by how far the pointer travelled. */
export function dragSize(edge: PaneSpec["edge"], startPx: number, travelled: number): number {
	return startPx + (edge === "end" ? travelled : -travelled);
}

/** A saved preference, or null when it is absent or not a usable number for that pane. */
export function readStored(id: PaneId): number | null {
	const value = readJson(PANES[id].storageKey);
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return PANES[id].unit === "fraction" && value >= 1 ? null : value;
}

const listeners = new Set<() => void>();

export function subscribePaneSizes(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** `null` forgets the saved size, so the pane is back at its default. */
export function writeStored(id: PaneId, stored: number | null): void {
	writeJson(PANES[id].storageKey, stored);
	for (const listener of listeners) listener();
}

export function hasStoredSizes(): boolean {
	return PANE_IDS.some(id => readStored(id) !== null);
}

/** Forget every saved size; open layouts go back to the defaults at once. */
export function resetPaneSizes(): void {
	for (const id of PANE_IDS) writeJson(PANES[id].storageKey, null);
	for (const listener of listeners) listener();
}
