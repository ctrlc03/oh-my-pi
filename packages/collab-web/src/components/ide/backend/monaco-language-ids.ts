/**
 * Monaco language ids, and the status-bar names, for the files `languages.ts` gives a CodeMirror grammar, so a
 * file highlights and is labelled the same in both engines (a test compares the two tables). Monaco's
 * Monarch tokenizers come from `monaco-languages.ts`. Noir reads as Rust, `.toml` as INI and Makefiles as
 * shell, as in `languages.ts`. This module stays free of Monaco and CodeMirror: the Monaco bundle imports it.
 */

export interface MonacoLanguage {
	/** Monaco's language id. */
	id: string;
	/** Shown in the status bar. */
	name: string;
}

const JS: MonacoLanguage = { id: "javascript", name: "JavaScript" };
const TS: MonacoLanguage = { id: "typescript", name: "TypeScript" };
const CPP: MonacoLanguage = { id: "cpp", name: "C/C++" };
const SHELL: MonacoLanguage = { id: "shell", name: "Shell" };
const JSON_: MonacoLanguage = { id: "json", name: "JSON" };
const MARKDOWN: MonacoLanguage = { id: "markdown", name: "Markdown" };
const YAML: MonacoLanguage = { id: "yaml", name: "YAML" };

const BY_EXTENSION: Readonly<Record<string, MonacoLanguage>> = {
	js: JS,
	mjs: JS,
	cjs: JS,
	jsx: JS,
	ts: TS,
	mts: TS,
	cts: TS,
	tsx: TS,
	rs: { id: "rust", name: "Rust" },
	nr: { id: "rust", name: "Noir" },
	sol: { id: "sol", name: "Solidity" },
	py: { id: "python", name: "Python" },
	go: { id: "go", name: "Go" },
	json: JSON_,
	jsonc: JSON_,
	css: { id: "css", name: "CSS" },
	html: { id: "html", name: "HTML" },
	md: MARKDOWN,
	mdx: MARKDOWN,
	yml: YAML,
	yaml: YAML,
	c: CPP,
	h: CPP,
	cc: CPP,
	cpp: CPP,
	hpp: CPP,
	java: { id: "java", name: "Java" },
	sql: { id: "sql", name: "SQL" },
	sh: SHELL,
	bash: SHELL,
	zsh: SHELL,
	toml: { id: "ini", name: "TOML" },
};

const BY_NAME: Readonly<Record<string, MonacoLanguage>> = {
	Dockerfile: { id: "dockerfile", name: "Dockerfile" },
	Makefile: SHELL,
	".bashrc": SHELL,
	".zshrc": SHELL,
	".envrc": SHELL,
};

/** Every id above: `monaco-languages.ts` registers a tokenizer for each. */
export const MONACO_LANGUAGE_IDS: readonly string[] = [
	...new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_NAME)].map(language => language.id)),
];

/** The extensions (without the dot) and file names with a Monaco language. */
export const MONACO_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION);
export const MONACO_FILE_NAMES: readonly string[] = Object.keys(BY_NAME);

/** The Monaco language of `path`, or null for plain text. */
export function monacoLanguageOf(path: string): MonacoLanguage | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]!;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext]! : null;
}
