/**
 * Syntax support for the editor, picked by file name and fetched on demand:
 * each grammar is its own chunk, so opening a Rust file never downloads the
 * HTML parser. Unknown files stay plain text.
 */
import type { Extension } from "@codemirror/state";

interface LanguageEntry {
	/** Shown in the status bar. */
	name: string;
	load(): Promise<Extension>;
}

async function legacy(load: () => Promise<import("@codemirror/language").StreamParser<unknown>>): Promise<Extension> {
	const [{ StreamLanguage }, parser] = await Promise.all([import("@codemirror/language"), load()]);
	return StreamLanguage.define(parser);
}

const words = (text: string): Record<string, true> => {
	const out: Record<string, true> = {};
	for (const word of text.split(" ")) out[word] = true;
	return out;
};

/** Solidity has no CodeMirror grammar; the C-like stream mode with its keywords reads well enough. */
async function solidity(): Promise<Extension> {
	return legacy(async () =>
		(await import("@codemirror/legacy-modes/mode/clike")).clike({
			name: "solidity",
			keywords: words(
				"pragma solidity import as from contract interface library abstract is using for struct enum event error modifier function constructor fallback receive returns return if else while do break continue emit revert try catch new delete assembly unchecked public private internal external view pure payable virtual override constant immutable memory storage calldata indexed anonymous",
			),
			types: words(
				"address bool string bytes byte int uint int8 int16 int32 int64 int128 int256 uint8 uint16 uint32 uint64 uint128 uint256 bytes1 bytes2 bytes4 bytes8 bytes16 bytes20 bytes32 mapping",
			),
			atoms: words("true false wei gwei ether seconds minutes hours days weeks this super msg block tx"),
			blockKeywords: words(
				"contract interface library function constructor modifier if else for while do try catch",
			),
		}),
	);
}

const JS: LanguageEntry = {
	name: "JavaScript",
	load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
};
const TS: LanguageEntry = {
	name: "TypeScript",
	load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
};
const TSX: LanguageEntry = {
	name: "TypeScript",
	load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
};
const RUST: LanguageEntry = { name: "Rust", load: async () => (await import("@codemirror/lang-rust")).rust() };
const CPP: LanguageEntry = { name: "C/C++", load: async () => (await import("@codemirror/lang-cpp")).cpp() };
const SHELL: LanguageEntry = {
	name: "Shell",
	load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
};

const BY_EXTENSION: Record<string, LanguageEntry> = {
	js: JS,
	mjs: JS,
	cjs: JS,
	jsx: JS,
	ts: TS,
	mts: TS,
	cts: TS,
	tsx: TSX,
	rs: RUST,
	// Noir reads close enough to Rust for highlighting.
	nr: { name: "Noir", load: RUST.load },
	sol: { name: "Solidity", load: solidity },
	py: { name: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
	go: { name: "Go", load: async () => (await import("@codemirror/lang-go")).go() },
	json: { name: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
	jsonc: { name: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
	css: { name: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
	html: { name: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
	md: { name: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
	mdx: { name: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
	yml: { name: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
	yaml: { name: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
	c: CPP,
	h: CPP,
	cc: CPP,
	cpp: CPP,
	hpp: CPP,
	java: { name: "Java", load: async () => (await import("@codemirror/lang-java")).java() },
	sql: { name: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
	sh: SHELL,
	bash: SHELL,
	zsh: SHELL,
	toml: {
		name: "TOML",
		load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
	},
};

const BY_NAME: Record<string, LanguageEntry> = {
	Dockerfile: {
		name: "Dockerfile",
		load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
	},
	Makefile: SHELL,
	".bashrc": SHELL,
	".zshrc": SHELL,
	".envrc": SHELL,
};

/** The language of `path`, or null for plain text. */
export function languageFor(path: string): LanguageEntry | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]!;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext]! : null;
}
