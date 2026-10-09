declare module "*.css";

declare module "highlightjs-solidity" {
	import type { LanguageFn } from "highlight.js";
	export const solidity: LanguageFn;
	export const yul: LanguageFn;
}
