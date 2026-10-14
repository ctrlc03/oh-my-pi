import { HIGHLIGHT_MAX_CHARS, languageOf, loadHighlighter } from "../../lib/highlight";

/** The app's highlighter over an excerpt's lines; undefined where the file type has no grammar. */
export async function highlightExcerpt(excerpt: { path: string; lines: string[] }): Promise<string | undefined> {
	const language = languageOf(excerpt.path);
	const text = excerpt.lines.join("\n");
	if (language === undefined || text.length > HIGHLIGHT_MAX_CHARS) return undefined;
	const hljs = await loadHighlighter();
	return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
