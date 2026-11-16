/**
 * A language server's hover text (markdown with fenced code) for CodeMirror's tooltip, drawn with the
 * transcript's markdown renderer. The fences are coloured with the app's highlighter once it has loaded;
 * until then they show as plain code. (Monaco draws hovers itself.)
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { loadHighlighter } from "../../../lib/highlight";
import { Markdown } from "../../transcript/Markdown";

/** highlight.js grammar names for the language ids servers put on a fence. */
const FENCE_ALIASES: Record<string, string> = {
	rust: "rust",
	typescript: "typescript",
	typescriptreact: "typescript",
	ts: "typescript",
	tsx: "typescript",
	javascript: "javascript",
	javascriptreact: "javascript",
	js: "javascript",
	jsx: "javascript",
	python: "python",
	go: "go",
	golang: "go",
	json: "json",
	jsonc: "json",
	c: "c",
	cpp: "cpp",
	"c++": "cpp",
	java: "java",
	sh: "bash",
	shell: "bash",
	bash: "bash",
	zsh: "bash",
	yaml: "yaml",
	toml: "ini",
	css: "css",
	html: "xml",
	xml: "xml",
	sql: "sql",
	solidity: "solidity",
};

async function highlightFences(root: HTMLElement): Promise<void> {
	const blocks = [...root.querySelectorAll<HTMLElement>("pre code[class*='language-']")];
	if (blocks.length === 0) return;
	const hljs = await loadHighlighter();
	for (const block of blocks) {
		const id = /language-(\S+)/.exec(block.className)?.[1]?.toLowerCase();
		const language = id === undefined ? undefined : (FENCE_ALIASES[id] ?? id);
		if (language === undefined || hljs.getLanguage(language) === undefined || !block.isConnected) continue;
		block.innerHTML = hljs.highlight(block.textContent ?? "", { language, ignoreIllegals: true }).value;
	}
}

/** The tooltip's content: `dom` for the editor to place, `destroy` when it goes away. */
export function renderHover(markdown: string): { dom: HTMLElement; destroy(): void } {
	const dom = document.createElement("div");
	dom.className = "sh-ide-hover";
	const root = createRoot(dom);
	// Committed now, so the fences are in `dom` to colour; the editor measures the tooltip as soon as it has it.
	flushSync(() => root.render(<Markdown text={markdown} />));
	void highlightFences(dom).catch(() => {});
	return {
		dom,
		destroy() {
			// Unmounting inside the tooltip's own teardown re-enters React: let it finish first.
			queueMicrotask(() => root.unmount());
		},
	};
}
