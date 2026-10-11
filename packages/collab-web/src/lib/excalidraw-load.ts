/**
 * Loading Excalidraw on first use. The library, its stylesheet and its fonts all come from this app's own
 * files (`scripts/build-assets.ts` copies the stylesheet and fonts next to the bundle), never from a CDN, so
 * the canvas works offline once it has been opened once and the service worker has cached it.
 */

import type * as ExcalidrawModule from "./excalidraw-engine";

type ExcalidrawEngine = typeof ExcalidrawModule;

/** Where the build puts Excalidraw's stylesheet and `fonts/`, relative to the page. */
export const EXCALIDRAW_ASSET_DIR = "excalidraw-assets/";

let loaded: Promise<ExcalidrawEngine> | undefined;

function assetBase(): string {
	return new URL(EXCALIDRAW_ASSET_DIR, document.baseURI).href;
}

/** Add the stylesheet once; resolves when it has applied (or failed: the canvas is then merely unstyled). */
function loadStylesheet(): Promise<void> {
	const href = `${assetBase()}index.css`;
	if (document.head.querySelector(`link[data-excalidraw-css]`) !== null) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	link.dataset.excalidrawCss = "";
	link.onload = () => resolve();
	link.onerror = () => {
		link.remove();
		resolve();
	};
	document.head.append(link);
	return promise;
}

/** The Excalidraw library, fetched on first use and shared after that. A failed fetch is retried next time. */
export function loadExcalidraw(): Promise<ExcalidrawEngine> {
	// Fonts are looked up under this path first; the library falls back to a CDN only for a file missing here.
	window.EXCALIDRAW_ASSET_PATH = assetBase();
	// Dynamic: Excalidraw is the largest dependency and must stay out of the entry bundle.
	loaded ??= Promise.all([import("./excalidraw-engine"), loadStylesheet()]).then(
		([engine]) => engine,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}
