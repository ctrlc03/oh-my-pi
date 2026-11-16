/**
 * Per-device choices for the code editor, kept together in `omp.collab.editor` as `{engine, theme}`:
 * - the engine: `auto` picks Monaco where there is room and a mouse (a desktop browser at least as wide as the
 *   editor's wide layout) and CodeMirror elsewhere; the other two force one;
 * - the colour theme: `app` follows the app's own theme, anything else is a VS Code style theme (`editor-themes.ts`).
 * A field left out (or not one of the options) is its default, so values stored before the theme existed keep working.
 */
import { useSyncExternalStore } from "react";
import type { EditorThemePref } from "./editor-themes";
import { EDITOR_THEME_IDS } from "./editor-themes";
import { readJson, writeJson } from "./storage";

export const EDITOR_ENGINES = ["auto", "monaco", "codemirror"] as const;
export type EditorEnginePref = (typeof EDITOR_ENGINES)[number];

export const EDITOR_KEY = "omp.collab.editor";

let engine: EditorEnginePref | undefined;
let theme: EditorThemePref | undefined;
const listeners = new Set<() => void>();

function field(raw: unknown, key: string): unknown {
	return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
}

/** Whatever was stored, as an engine preference: anything that is not one of the options is `auto`. */
export function parseEnginePref(raw: unknown): EditorEnginePref {
	const stored = field(raw, "engine");
	return EDITOR_ENGINES.find(option => option === stored) ?? "auto";
}

/** Whatever was stored, as a theme preference: anything that is not a theme is `app`. */
export function parseThemePref(raw: unknown): EditorThemePref {
	const stored = field(raw, "theme");
	return EDITOR_THEME_IDS.find(option => option === stored) ?? "app";
}

function load(): void {
	if (engine !== undefined && theme !== undefined) return;
	const raw = readJson(EDITOR_KEY);
	engine = parseEnginePref(raw);
	theme = parseThemePref(raw);
}

function save(): void {
	const stored: { engine?: EditorEnginePref; theme?: EditorThemePref } = {};
	if (engine !== undefined && engine !== "auto") stored.engine = engine;
	if (theme !== undefined && theme !== "app") stored.theme = theme;
	writeJson(EDITOR_KEY, Object.keys(stored).length === 0 ? null : stored);
	for (const listener of listeners) listener();
}

export function editorEnginePref(): EditorEnginePref {
	load();
	return engine!;
}

export function editorThemePref(): EditorThemePref {
	load();
	return theme!;
}

export function setEditorEnginePref(next: EditorEnginePref): void {
	load();
	engine = next;
	save();
}

export function setEditorThemePref(next: EditorThemePref): void {
	load();
	theme = next;
	save();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The engine preference; re-renders when it changes. */
export function useEditorEnginePref(): EditorEnginePref {
	return useSyncExternalStore(subscribe, editorEnginePref, () => "auto");
}

/** The theme preference; re-renders when it changes. */
export function useEditorThemePref(): EditorThemePref {
	return useSyncExternalStore(subscribe, editorThemePref, () => "app");
}
