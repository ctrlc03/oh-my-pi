/**
 * Picking and loading the editor engine. CodeMirror is part of the editor chunk; Monaco is not: it is its
 * own standalone bundle that the page imports on first use (see `monaco.ts`), so phones, and desktops that
 * never choose it, do not download it.
 */
import type { EditorEnginePref } from "../../../lib/editor-prefs";
import { importChunk } from "../../../lib/stale-build";
import { codemirrorEngine } from "./codemirror";
import type * as MonacoModule from "./monaco";
import type { EditorEngine, EngineName } from "./types";

/** What decides `auto`: a mouse and the room the editor's wide layout needs. */
export interface EngineEnvironment {
	finePointer: boolean;
	wide: boolean;
}

export function chooseEngine(pref: EditorEnginePref, env: EngineEnvironment): EngineName {
	if (pref !== "auto") return pref;
	return env.finePointer && env.wide ? "monaco" : "codemirror";
}

/** Where the build puts Monaco's bundle, stylesheet and worker, relative to the page. */
export const MONACO_ASSET_DIR = "monaco-assets/";

let monaco: Promise<EditorEngine> | undefined;
let monacoReady: EditorEngine | undefined;

/** Add the stylesheet once; resolves when it has applied. A failure rejects: Monaco without its CSS is unusable. */
function loadStylesheet(href: string): Promise<void> {
	if (document.head.querySelector("link[data-monaco-css]") !== null) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	link.dataset.monacoCss = "";
	link.onload = () => resolve();
	link.onerror = () => {
		link.remove();
		reject(new Error("Monaco's stylesheet could not be loaded"));
	};
	document.head.append(link);
	return promise;
}

/**
 * Monaco, fetched on first use and shared after that; a failed fetch is retried next time. Built, it is the
 * standalone `monaco-assets/monaco.js` next to the page (relative, so a path prefix works). The dev server
 * builds no such folder: there the module is bundled on the fly with its own stylesheet.
 */
export function loadMonaco(): Promise<EditorEngine> {
	monaco ??= importChunk(async () => {
		if (process.env.NODE_ENV !== "production") return (await import("./monaco")).monacoEngine;
		const base = new URL(MONACO_ASSET_DIR, document.baseURI).href;
		const [mod] = await Promise.all([
			import(`${base}monaco.js`) as Promise<typeof MonacoModule>,
			loadStylesheet(`${base}monaco.css`),
		]);
		return mod.monacoEngine;
	}).then(
		engine => {
			monacoReady = engine;
			return engine;
		},
		(error: unknown) => {
			monaco = undefined;
			throw error;
		},
	);
	return monaco;
}

export async function loadEngine(name: EngineName): Promise<EditorEngine> {
	return name === "monaco" ? loadMonaco() : codemirrorEngine;
}

/** The engine when it needs no fetching (CodeMirror always; Monaco once loaded), so a reopened sheet shows at once. */
export function readyEngine(name: EngineName): EditorEngine | null {
	return name === "monaco" ? (monacoReady ?? null) : codemirrorEngine;
}

export type { EditorDoc, EditorEngine, EditorView, EditorViewHooks, EngineName, HoverAnswer, Pos } from "./types";
