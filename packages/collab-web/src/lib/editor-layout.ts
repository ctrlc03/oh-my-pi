/**
 * How the code editor is laid out on this device, kept together in `omp.collab.editor-layout`:
 * - the toggles of the ⚙ Layout menu: the explorer's activity rail, the tab strip, Monaco's minimap, line numbers,
 *   the status bar and the gutter bars on lines an agent wrote (also shown in the diffs);
 * - the editor's font size in pixels (`null`: follow the app's code font size);
 * - the bottom panel's height and whether it is open;
 * - the size of the definitions popup (`null`: its automatic size).
 * Only what differs from the defaults is stored, so a field left out (or not valid) is its default and values
 * stored before a field existed keep working.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export const EDITOR_LAYOUT_KEY = "omp.collab.editor-layout";

/** Range of the editor font size, in pixels. */
export const FONT_MIN = 9;
export const FONT_MAX = 28;
/** What A−/A+ and Cmd/Ctrl +/− move the size by. */
export const FONT_STEP = 1;

/** The bottom panel is never shorter than this; and never taller than this share of the editor column. */
export const PANEL_MIN = 80;
export const PANEL_MAX_RATIO = 0.7;
export const PANEL_DEFAULT = 220;
/** What an arrow key moves the panel's top edge by (with Shift, the larger step). */
export const PANEL_KEY_STEP = 16;
export const PANEL_KEY_STEP_SHIFT = 64;

/** With the minimap left to automatic: a pane at least this wide (CSS pixels) shows it, and so does a tab. */
export const MINIMAP_MIN_WIDTH = 800;

/** The definitions popup keeps at least this much, and at most the editor area less a margin. */
export const DEFS_MIN_WIDTH = 260;
export const DEFS_MIN_HEIGHT = 120;
export const DEFS_MARGIN = 24;
export const DEFS_KEY_STEP = 16;
export const DEFS_KEY_STEP_SHIFT = 64;

/** Larger than any real value: stored numbers beyond it are junk, not a size to honour. */
const ABSOLUTE_MAX = 8000;

export interface DefsSize {
	width: number;
	height: number;
}

export interface EditorLayout {
	/** The explorer's view switcher (Files, Changes, Search). */
	rail: boolean;
	/** The open files' tab strip. */
	tabs: boolean;
	/** Monaco's minimap: `null` follows the pane's width (and whether it is a tab). */
	minimap: boolean | null;
	lineNumbers: boolean;
	status: boolean;
	/** Gutter bars on the lines agents wrote, with a hover on who wrote them (needs a companion that answers `file-attribution`). */
	attribution: boolean;
	/** Pixels; `null` follows the app's code font size. */
	fontSize: number | null;
	/** Pixels, not yet limited by the editor column (see {@link clampPanelHeight}). */
	panelHeight: number;
	panelOpen: boolean;
	defsSize: DefsSize | null;
}

export const DEFAULT_LAYOUT: EditorLayout = {
	rail: true,
	tabs: true,
	minimap: null,
	lineNumbers: true,
	status: true,
	attribution: true,
	fontSize: null,
	panelHeight: PANEL_DEFAULT,
	panelOpen: false,
	defsSize: null,
};

/** The toggles of the layout menu. */
export type LayoutToggle = "rail" | "tabs" | "minimap" | "lineNumbers" | "status" | "attribution";

function field(raw: unknown, key: string): unknown {
	return typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;
}

function bool(raw: unknown, fallback: boolean): boolean {
	return typeof raw === "boolean" ? raw : fallback;
}

function finite(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** A font size inside its range, whole pixels. */
export function clampFontSize(px: number): number {
	return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

/** Whether Monaco shows its minimap: the user's choice when there is one, else when the pane is a tab or wide. */
export function minimapShown(pref: boolean | null, roomy: boolean, paneWidth: number): boolean {
	return pref ?? (roomy || paneWidth >= MINIMAP_MIN_WIDTH);
}

/** The size one step away from `current` (which may be fractional: the app's own size), within the range. */
export function stepFontSize(current: number, direction: 1 | -1): number {
	return clampFontSize(Math.round(current) + direction * FONT_STEP);
}

/** A font size as the status bar shows it: `13px`, `13.8px` for the app's own fractional sizes. */
export function formatFontSize(px: number): string {
	return `${Number(px.toFixed(1))}px`;
}

/**
 * How much of the editor's header fits, by the editor's own width (not the window's: a pane beside the conversation is
 * narrow on a wide screen). `compact` moves the font size buttons into the Layout menu; `tight` moves the code actions
 * there too, so the file finder, Save, the menu, placement and Close are what is left.
 */
export type HeadTier = "full" | "compact" | "tight";
export const HEAD_COMPACT_BELOW = 780;
export const HEAD_TIGHT_BELOW = 600;

/** The header's tier for an editor `width` CSS pixels wide; `null` (not measured yet) is full. */
export function headTierFor(width: number | null): HeadTier {
	if (width === null || width >= HEAD_COMPACT_BELOW) return "full";
	return width >= HEAD_TIGHT_BELOW ? "compact" : "tight";
}

/** The tallest the bottom panel may be in an editor column `columnHeight` tall. */
export function panelMaxHeight(columnHeight: number): number {
	return Math.max(PANEL_MIN, Math.floor(columnHeight * PANEL_MAX_RATIO));
}

/** A panel height inside its limits: at least 80px, at most 70% of the editor column. */
export function clampPanelHeight(px: number, columnHeight: number): number {
	return Math.round(Math.min(panelMaxHeight(columnHeight), Math.max(PANEL_MIN, px)));
}

/** The definitions popup's size inside its limits; `area` is the editor area it floats over. */
export function clampDefsSize(size: DefsSize, area: { width: number; height: number }): DefsSize {
	const clamp = (px: number, min: number, available: number): number =>
		Math.round(Math.min(Math.max(min, available - DEFS_MARGIN), Math.max(min, px)));
	return {
		width: clamp(size.width, DEFS_MIN_WIDTH, area.width),
		height: clamp(size.height, DEFS_MIN_HEIGHT, area.height),
	};
}

function parsePanelHeight(raw: unknown): number {
	const px = finite(raw);
	return px === null || px > ABSOLUTE_MAX ? PANEL_DEFAULT : Math.max(PANEL_MIN, Math.round(px));
}

function parseDefsSize(raw: unknown): DefsSize | null {
	const width = finite(field(raw, "width"));
	const height = finite(field(raw, "height"));
	if (width === null || height === null || width > ABSOLUTE_MAX || height > ABSOLUTE_MAX) return null;
	return {
		width: Math.max(DEFS_MIN_WIDTH, Math.round(width)),
		height: Math.max(DEFS_MIN_HEIGHT, Math.round(height)),
	};
}

/** Whatever was stored, as a layout: each field that is not valid is its default. */
export function parseEditorLayout(raw: unknown): EditorLayout {
	const minimap = field(raw, "minimap");
	const fontSize = finite(field(raw, "fontSize"));
	const panel = field(raw, "panel");
	return {
		rail: bool(field(raw, "rail"), DEFAULT_LAYOUT.rail),
		tabs: bool(field(raw, "tabs"), DEFAULT_LAYOUT.tabs),
		minimap: typeof minimap === "boolean" ? minimap : null,
		lineNumbers: bool(field(raw, "lineNumbers"), DEFAULT_LAYOUT.lineNumbers),
		status: bool(field(raw, "status"), DEFAULT_LAYOUT.status),
		attribution: bool(field(raw, "attribution"), DEFAULT_LAYOUT.attribution),
		fontSize: fontSize === null ? null : clampFontSize(fontSize),
		panelHeight: parsePanelHeight(field(panel, "height")),
		panelOpen: bool(field(panel, "open"), DEFAULT_LAYOUT.panelOpen),
		defsSize: parseDefsSize(field(raw, "defs")),
	};
}

/** What is stored for `layout`: only the fields that differ from the defaults; `null` when none does. */
export function serializeEditorLayout(layout: EditorLayout): Record<string, unknown> | null {
	const stored: Record<string, unknown> = {};
	if (layout.rail !== DEFAULT_LAYOUT.rail) stored.rail = layout.rail;
	if (layout.tabs !== DEFAULT_LAYOUT.tabs) stored.tabs = layout.tabs;
	if (layout.minimap !== null) stored.minimap = layout.minimap;
	if (layout.lineNumbers !== DEFAULT_LAYOUT.lineNumbers) stored.lineNumbers = layout.lineNumbers;
	if (layout.status !== DEFAULT_LAYOUT.status) stored.status = layout.status;
	if (layout.attribution !== DEFAULT_LAYOUT.attribution) stored.attribution = layout.attribution;
	if (layout.fontSize !== null) stored.fontSize = layout.fontSize;
	const panel: Record<string, unknown> = {};
	if (layout.panelHeight !== PANEL_DEFAULT) panel.height = layout.panelHeight;
	if (layout.panelOpen) panel.open = true;
	if (Object.keys(panel).length > 0) stored.panel = panel;
	if (layout.defsSize !== null) stored.defs = { width: layout.defsSize.width, height: layout.defsSize.height };
	return Object.keys(stored).length === 0 ? null : stored;
}

/** A font-size key chord: Cmd (Mac) or Ctrl with `+`/`=`, `-` or `0`, on the main row or the number pad. */
export type FontShortcut = "bigger" | "smaller" | "reset";

export function fontShortcut(event: {
	key: string;
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}): FontShortcut | null {
	if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
	if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "bigger";
	if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "smaller";
	if (event.key === "0" || event.code === "Numpad0") return "reset";
	return null;
}

let layout: EditorLayout | undefined;
const listeners = new Set<() => void>();

export function editorLayout(): EditorLayout {
	layout ??= parseEditorLayout(readJson(EDITOR_LAYOUT_KEY));
	return layout;
}

function commit(next: EditorLayout): void {
	layout = next;
	writeJson(EDITOR_LAYOUT_KEY, serializeEditorLayout(next));
	for (const listener of listeners) listener();
}

/** Change some fields; values are limited to their ranges as when read back. */
export function updateEditorLayout(patch: Partial<EditorLayout>): void {
	const current = editorLayout();
	const next: EditorLayout = { ...current, ...patch };
	if (next.fontSize !== null) next.fontSize = clampFontSize(next.fontSize);
	next.panelHeight = parsePanelHeight(next.panelHeight);
	if (next.defsSize !== null) next.defsSize = parseDefsSize(next.defsSize);
	commit(next);
}

/** Every toggle, the font size, the panel and the popup back to their defaults. */
export function resetEditorLayout(): void {
	commit({ ...DEFAULT_LAYOUT });
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The layout; re-renders when it changes. */
export function useEditorLayout(): EditorLayout {
	return useSyncExternalStore(subscribe, editorLayout, () => DEFAULT_LAYOUT);
}
