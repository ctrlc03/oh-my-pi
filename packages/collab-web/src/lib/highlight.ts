import type { HLJSApi } from "highlight.js";

/** Largest file (in characters) the viewer will highlight; bigger ones stay plain. */
export const HIGHLIGHT_MAX_CHARS = 256 * 1024;

/** highlight.js grammar by lowercase basename (`dockerfile`) or `.extension`. */
const LANGUAGES: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".rs": "rust",
	".nr": "rust",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".json": "json",
	".jsonc": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "ini",
	".ini": "ini",
	".cfg": "ini",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".css": "css",
	".html": "xml",
	".htm": "xml",
	".xhtml": "xml",
	".xml": "xml",
	".svg": "xml",
	".md": "markdown",
	".markdown": "markdown",
	".sql": "sql",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".swift": "swift",
	".rb": "ruby",
	".php": "php",
	".sol": "solidity",
	".yul": "yul",
	".mk": "makefile",
	".diff": "diff",
	".patch": "diff",
};

/** The highlight.js grammar for a file path, or undefined when the viewer should stay plain. */
export function languageOf(path: string): string | undefined {
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (Object.hasOwn(LANGUAGES, base)) return LANGUAGES[base];
	const ext = base.slice(base.lastIndexOf("."));
	return Object.hasOwn(LANGUAGES, ext) ? LANGUAGES[ext] : undefined;
}

let loaded: Promise<HLJSApi> | undefined;

/** The highlighter, fetched on first use and shared after that. A failed fetch is retried next time. */
export function loadHighlighter(): Promise<HLJSApi> {
	// highlight.js and its grammars are large and only the file viewer needs them: keep them out of the app bundle.
	loaded ??= import("./highlight-core").then(
		core => core.hljs,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}
