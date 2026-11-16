import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseEngine } from "../src/components/ide/backend";
import {
	MONACO_EXTENSIONS,
	MONACO_FILE_NAMES,
	MONACO_LANGUAGE_IDS,
	monacoLanguageOf,
} from "../src/components/ide/backend/monaco-language-ids";
import { GRAMMAR_EXTENSIONS, GRAMMAR_FILE_NAMES, languageFor } from "../src/components/ide/languages";
import { parseEnginePref } from "../src/lib/editor-prefs";

describe("editor engine choice", () => {
	it("picks Monaco only with a mouse and room, unless told otherwise", () => {
		expect(chooseEngine("auto", { finePointer: true, wide: true })).toBe("monaco");
		expect(chooseEngine("auto", { finePointer: true, wide: false })).toBe("codemirror");
		expect(chooseEngine("auto", { finePointer: false, wide: true })).toBe("codemirror");
		expect(chooseEngine("monaco", { finePointer: false, wide: false })).toBe("monaco");
		expect(chooseEngine("codemirror", { finePointer: true, wide: true })).toBe("codemirror");
	});

	it("reads the stored setting, defaulting to automatic", () => {
		expect(parseEnginePref({ engine: "monaco" })).toBe("monaco");
		expect(parseEnginePref({ engine: "codemirror" })).toBe("codemirror");
		for (const junk of [null, undefined, "monaco", 3, {}, { engine: "vim" }])
			expect(parseEnginePref(junk)).toBe("auto");
	});
});

describe("Monaco language table", () => {
	it("covers every file the CodeMirror grammars do, with the same names", () => {
		expect([...MONACO_EXTENSIONS].sort()).toEqual([...GRAMMAR_EXTENSIONS].sort());
		expect([...MONACO_FILE_NAMES].sort()).toEqual([...GRAMMAR_FILE_NAMES].sort());
		for (const ext of GRAMMAR_EXTENSIONS) {
			const file = `src/x.${ext}`;
			expect(monacoLanguageOf(file)?.name).toBe(languageFor(file)?.name);
		}
		for (const name of GRAMMAR_FILE_NAMES) {
			expect(monacoLanguageOf(`dir/${name}`)?.name).toBe(languageFor(`dir/${name}`)?.name);
		}
	});

	it("labels by extension, case-insensitively, and by file name", () => {
		expect(monacoLanguageOf("a/b/App.TSX")).toEqual({ id: "typescript", name: "TypeScript" });
		expect(monacoLanguageOf("circuits/main.nr")).toEqual({ id: "rust", name: "Noir" });
		expect(monacoLanguageOf("Dockerfile")).toEqual({ id: "dockerfile", name: "Dockerfile" });
		expect(monacoLanguageOf("notes.txt")).toBeNull();
		expect(monacoLanguageOf(".gitignore")).toBeNull();
		expect(monacoLanguageOf("constructor")).toBeNull();
	});

	it("uses ids Monaco registers, so each file gets its tokenizer", async () => {
		// Monaco's ids are not always the language's name (Solidity is `sol`); an unknown id leaves the file unhighlighted.
		const definitions = path.join(
			path.dirname(require.resolve("monaco-editor/package.json")),
			"esm/vs/languages/definitions",
		);
		const registered = new Set(["json"]); // registered by monaco-languages.ts itself
		for (const dir of fs.readdirSync(definitions)) {
			const register = path.join(definitions, dir, "register.js");
			if (!fs.existsSync(register)) continue;
			for (const match of (await Bun.file(register).text()).matchAll(/\bid: "([^"]+)"/g)) registered.add(match[1]!);
		}
		expect(MONACO_LANGUAGE_IDS.filter(id => !registered.has(id))).toEqual([]);
		expect(monacoLanguageOf("contracts/Vault.sol")?.id).toBe("sol");
	});
});
