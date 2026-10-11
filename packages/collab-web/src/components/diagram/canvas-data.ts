/**
 * What the canvas opens with, built from a {@link CanvasSource} once the Excalidraw engine is loaded: a
 * stored scene is restored, code map skeletons are expanded, a Mermaid diagram is converted to editable
 * shapes (or, when the converter cannot take it, placed as an image above its source text).
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { CanvasSource } from "../../lib/diagram-store";
import { svgToPngBlob } from "../../lib/diagram-export";
import { renderDiagram } from "../../lib/diagram-svg";
import type * as ExcalidrawModule from "../../lib/excalidraw-engine";
import type { Scene } from "../../lib/excalidraw-scene";
import { svgSize } from "../../lib/svg";
import { pageBackground } from "../../lib/theme-tokens";
import type { SystemTheme } from "../../lib/theme";

export type ExcalidrawEngine = typeof ExcalidrawModule;

export interface CanvasInit {
	elements: readonly ExcalidrawElement[];
	files: BinaryFiles;
	viewBackgroundColor?: string;
	/** Said above the canvas when the source did not convert the usual way. */
	notice?: string;
}

/** Gap between the placed image and the source text under it. */
const TEXT_GAP = 32;
/** Excalidraw's code font family. */
const CODE_FONT = 3;

function blobDataUrl(blob: Blob): Promise<string> {
	const done = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => done.resolve(String(reader.result));
	reader.onerror = () => done.reject(new Error("could not read the image"));
	reader.readAsDataURL(blob);
	return done.promise;
}

/** A validated scene as the elements and images the canvas loads. */
function restoreScene(engine: ExcalidrawEngine, scene: Scene): CanvasInit {
	return { ...engine.loadScene(scene), viewBackgroundColor: scene.appState.viewBackgroundColor };
}

/** A Mermaid diagram that would not convert: its rendering as an image element, its source as text beneath. */
async function mermaidAsImage(engine: ExcalidrawEngine, source: string, theme: SystemTheme): Promise<CanvasInit> {
	const rendered = await renderDiagram("mermaid", theme, source);
	const text: ExcalidrawElementSkeleton = {
		type: "text",
		x: 0,
		y: 0,
		text: source,
		fontSize: 14,
		fontFamily: CODE_FONT,
	};
	if (!rendered.ok) {
		return {
			elements: engine.convertToExcalidrawElements([text]),
			files: {},
			notice: `The diagram could not be drawn (${rendered.error}); its source is on the canvas as text.`,
		};
	}
	const size = svgSize(rendered.svg) ?? { width: 800, height: 600 };
	// A PNG, not the SVG: a scene is validated (and sent to the agent) with raster images only.
	const png = await svgToPngBlob(rendered.svg, size, pageBackground());
	const dataURL = await blobDataUrl(png);
	// The library brands file ids; this one is ours alone.
	const fileId = "mermaid-render" as FileId;
	const elements = engine.convertToExcalidrawElements([
		{ type: "image", fileId, status: "saved", x: 0, y: 0, width: size.width, height: size.height },
		{ ...text, y: size.height + TEXT_GAP },
	]);
	// The library's file id and data URL types are branded strings.
	const files = {
		[fileId]: { id: fileId, mimeType: "image/png", dataURL, created: Date.now() },
	} as unknown as BinaryFiles;
	return {
		elements,
		files,
		notice: "Converted as an image with the source below it: this diagram type has no editable form.",
	};
}

export async function buildCanvasInit(
	engine: ExcalidrawEngine,
	source: CanvasSource,
	theme: SystemTheme,
): Promise<CanvasInit> {
	switch (source.kind) {
		case "blank":
			return { elements: [], files: {} };
		case "scene":
			return restoreScene(engine, source.scene);
		case "skeleton":
			// Our skeleton shape is the library's own, narrowed to what the code map draws.
			return {
				elements: engine.convertToExcalidrawElements(source.elements as unknown as ExcalidrawElementSkeleton[]),
				files: {},
			};
		case "mermaid":
			try {
				const converted = await engine.mermaidToElements(source.source);
				if (converted.elements.length > 0) return converted;
			} catch {
				// Not every Mermaid diagram type converts; the image fallback below still gives a starting point.
			}
			return mermaidAsImage(engine, source.source, theme);
	}
}
