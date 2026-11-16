import { describe, expect, it } from "bun:test";
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
		expect(MONACO_LANGUAGE_IDS).toContain("solidity");
	});
});
