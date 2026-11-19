declare module "*.css";

declare module "highlightjs-solidity" {
	import type { LanguageFn } from "highlight.js";
	export const solidity: LanguageFn;
	export const yul: LanguageFn;
}

/** PDF.js's worker, imported as source text (`with { type: "text" }`) and started from a Blob; see components/viewer/pdf-engine.ts. */
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
	const source: string;
	export default source;
}

/** Where Excalidraw looks for its fonts first; set by lib/excalidraw-load.ts. */
interface Window {
	EXCALIDRAW_ASSET_PATH?: string;
}
