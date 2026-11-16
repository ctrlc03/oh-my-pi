/**
 * Per-device choice of the code editor's engine: `auto` picks Monaco where there is room and a mouse (a desktop
 * browser at least as wide as the editor's wide layout) and CodeMirror elsewhere; the other two force one.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export const EDITOR_ENGINES = ["auto", "monaco", "codemirror"] as const;
export type EditorEnginePref = (typeof EDITOR_ENGINES)[number];

export const EDITOR_KEY = "omp.collab.editor";

let current: EditorEnginePref | undefined;
const listeners = new Set<() => void>();

/** Whatever was stored, as a preference: anything that is not one of the options is `auto`. */
export function parseEnginePref(raw: unknown): EditorEnginePref {
	const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).engine : undefined;
	return EDITOR_ENGINES.find(option => option === stored) ?? "auto";
}

export function editorEnginePref(): EditorEnginePref {
	current ??= parseEnginePref(readJson(EDITOR_KEY));
	return current;
}

export function setEditorEnginePref(next: EditorEnginePref): void {
	current = next;
	writeJson(EDITOR_KEY, next === "auto" ? null : { engine: next });
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The preference; re-renders when it changes. */
export function useEditorEnginePref(): EditorEnginePref {
	return useSyncExternalStore(subscribe, editorEnginePref, () => "auto");
}
