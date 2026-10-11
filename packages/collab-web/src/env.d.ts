declare module "*.css";

declare module "highlightjs-solidity" {
	import type { LanguageFn } from "highlight.js";
	export const solidity: LanguageFn;
	export const yul: LanguageFn;
}

/** Where Excalidraw looks for its fonts first; set by lib/excalidraw-load.ts. */
interface Window {
	EXCALIDRAW_ASSET_PATH?: string;
}
