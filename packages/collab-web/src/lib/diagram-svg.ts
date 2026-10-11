/**
 * Turning a diagram's source into SVG, for the transcript figure and the full-screen viewer. Both engines
 * are loaded on demand; results are cached by (kind, theme, source), so a remounted figure (the transcript
 * re-renders its markup while a reply streams) paints at once instead of rendering again, and a theme switch
 * renders a second copy rather than recolouring the first.
 */

import type { DiagramKind } from "./diagrams";
import { isSafeSvg } from "./svg";
import type { SystemTheme } from "./theme";
import { mermaidThemeVariables, readToken } from "./theme-tokens";

export type DiagramSvg = { ok: true; svg: string } | { ok: false; error: string };

/** Most results kept; the oldest go first. */
const CACHE_LIMIT = 48;

/** Results by key, in insertion order (a hit re-inserts, so the front is the least recently used). */
const results = new Map<string, DiagramSvg>();
const pending = new Map<string, Promise<DiagramSvg>>();

const keyOf = (kind: DiagramKind, theme: SystemTheme, source: string): string => `${kind}\0${theme}\0${source}`;

/** The cached rendering, if there is one. Synchronous: a figure uses it for its first paint. */
export function cachedDiagram(kind: DiagramKind, theme: SystemTheme, source: string): DiagramSvg | undefined {
	const key = keyOf(kind, theme, source);
	const hit = results.get(key);
	if (hit !== undefined) {
		results.delete(key);
		results.set(key, hit);
	}
	return hit;
}

function remember(key: string, result: DiagramSvg): void {
	results.set(key, result);
	if (results.size > CACHE_LIMIT) results.delete(results.keys().next().value!);
}

export function messageOf(error: unknown): string {
	// Mermaid's parse errors are multi-line with a pointer into the source; the first line says what is wrong.
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n")[0]!.trim() || "the diagram could not be rendered";
}

async function renderMermaid(source: string, theme: SystemTheme): Promise<DiagramSvg> {
	// Dynamic: Mermaid is several megabytes and must stay out of the entry bundle.
	const engine = await import("./mermaid-engine");
	try {
		const svg = await engine.renderMermaidSvg(source, mermaidThemeVariables(readToken, theme));
		return isSafeSvg(svg) ? { ok: true, svg } : { ok: false, error: "the diagram contained unsafe markup" };
	} catch (error) {
		return { ok: false, error: messageOf(error) };
	}
}

async function renderExcalidrawScene(source: string, theme: SystemTheme): Promise<DiagramSvg> {
	// Dynamic: the scene validator and Excalidraw loader are only needed once a drawing is shown.
	const { renderExcalidraw } = await import("./excalidraw-svg");
	return renderExcalidraw(source, theme);
}

/**
 * Render `source` as `kind` in `theme`. Resolves with the failure rather than rejecting when the diagram is
 * wrong; rejects only when an engine could not be fetched (offline before first use), which is not cached.
 */
export function renderDiagram(kind: DiagramKind, theme: SystemTheme, source: string): Promise<DiagramSvg> {
	const key = keyOf(kind, theme, source);
	const hit = cachedDiagram(kind, theme, source);
	if (hit !== undefined) return Promise.resolve(hit);
	let inflight = pending.get(key);
	if (inflight === undefined) {
		inflight = (kind === "mermaid" ? renderMermaid(source, theme) : renderExcalidrawScene(source, theme)).then(
			result => {
				pending.delete(key);
				remember(key, result);
				return result;
			},
			(error: unknown) => {
				pending.delete(key);
				throw error;
			},
		);
		pending.set(key, inflight);
	}
	return inflight;
}
