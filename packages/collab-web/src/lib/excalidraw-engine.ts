/**
 * The Excalidraw library, re-exported for the canvas and the read-only renderer. Imported only through
 * `import("./excalidraw-engine")` (see excalidraw-load.ts): it is the largest dependency of the app and must
 * stay out of the entry bundle until a canvas or an `excalidraw` block needs it.
 */

import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Scene } from "./excalidraw-scene";
import { importChunk } from "./stale-build";

export {
	convertToExcalidrawElements,
	Excalidraw,
	exportToBlob,
	exportToSvg,
	getSceneVersion,
	MainMenu,
	serializeAsJSON,
} from "@excalidraw/excalidraw";

/** Elements and embedded images in the form Excalidraw loads. */
export interface LoadedScene {
	elements: readonly ExcalidrawElement[];
	files: BinaryFiles;
}

/**
 * A validated scene as Excalidraw's own elements: its restore supplies the fields the allow-list leaves out
 * (seed, version, …). Agent-written scenes often omit text sizes, and text without a width draws nothing, so
 * text is measured again and bindings repaired.
 */
export function loadScene(scene: Scene): LoadedScene {
	// `validateScene` already checked every field it keeps; the library's types also demand the ones restore fills in.
	const partial = scene.elements as unknown as readonly ExcalidrawElement[];
	const files = scene.files as unknown as BinaryFiles;
	return { elements: restoreElements(partial, null, { refreshDimensions: true, repairBindings: true }), files };
}

/** Convert a Mermaid diagram to editable elements with `@excalidraw/mermaid-to-excalidraw`. */
export async function mermaidToElements(source: string): Promise<LoadedScene> {
	// Dynamic: the converter brings its own copy of the Mermaid parser, needed only to edit a Mermaid diagram.
	const { parseMermaidToExcalidraw } = await importChunk(() => import("@excalidraw/mermaid-to-excalidraw"));
	const parsed = await parseMermaidToExcalidraw(source);
	return {
		elements: convertToExcalidrawElements(parsed.elements, { regenerateIds: false }),
		files: parsed.files ?? {},
	};
}
