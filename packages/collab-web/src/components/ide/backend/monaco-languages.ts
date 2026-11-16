/**
 * Monaco's Monarch tokenizers for the languages the editor highlights (see `monaco-language-ids.ts`). Each
 * `register.js` only declares the language: Monaco fetches its tokenizer chunk the first time a model uses it.
 * JSON has no Monarch tokenizer in Monaco (its own comes with the JSON language service, which is left out),
 * so a small one is defined here.
 */
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/solidity/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import { languages } from "./monaco-core";

languages.register({ id: "json", extensions: [".json", ".jsonc"], aliases: ["JSON", "json"] });

languages.setLanguageConfiguration("json", {
	comments: { lineComment: "//", blockComment: ["/*", "*/"] },
	brackets: [
		["{", "}"],
		["[", "]"],
	],
	autoClosingPairs: [
		{ open: "{", close: "}", notIn: ["string"] },
		{ open: "[", close: "]", notIn: ["string"] },
		{ open: '"', close: '"', notIn: ["string"] },
	],
	surroundingPairs: [
		{ open: "{", close: "}" },
		{ open: "[", close: "]" },
		{ open: '"', close: '"' },
	],
});

languages.setMonarchTokensProvider("json", {
	defaultToken: "",
	tokenPostfix: ".json",
	tokenizer: {
		root: [
			[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "attribute.name"],
			[/"(?:[^"\\]|\\.)*"/, "string"],
			[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
			[/\b(?:true|false|null)\b/, "keyword"],
			[/\/\/.*$/, "comment"],
			[/\/\*/, "comment", "@comment"],
			[/[{}[\],:]/, "delimiter"],
		],
		comment: [
			[/[^/*]+/, "comment"],
			[/\*\//, "comment", "@pop"],
			[/[/*]/, "comment"],
		],
	},
});
