/**
 * Which code fences and repository files are diagrams. Pure: the heavy renderers (Mermaid, Excalidraw)
 * live behind dynamic imports elsewhere and are only reached once one of these says "diagram".
 */

export type DiagramKind = "mermaid" | "excalidraw";

/**
 * The smallest zoom at which a diagram's text stays readable, per kind: Mermaid labels are 16px and an
 * Excalidraw default text is 20px, so the floor keeps both at about 11px. A figure or viewer that cannot fit
 * the whole diagram at this zoom shows it here and lets the reader pan instead of shrinking the text further.
 */
export const READABLE_SCALE: Record<DiagramKind, number> = { mermaid: 0.7, excalidraw: 0.55 };

/** Fence info strings that name a diagram language. */
const KIND_BY_LANG: Record<string, DiagramKind> = { mermaid: "mermaid", mmd: "mermaid", excalidraw: "excalidraw" };

/** Repository file extensions that open in the diagram viewer or canvas. */
const KIND_BY_EXT: Record<string, DiagramKind> = { excalidraw: "excalidraw", mmd: "mermaid", mermaid: "mermaid" };

/** Sources past these sizes stay plain code blocks: the renderer would stall the page on them. */
export const MAX_MERMAID_CHARS = 50_000;
export const MAX_EXCALIDRAW_CHARS = 1_000_000;

/** An Excalidraw scene file starts with its `type` marker; used to recognise a plain ```json fence. */
const SCENE_START = /^\s*\{\s*"type"\s*:\s*"excalidraw"/;

/**
 * The diagram a fenced block holds, or null for ordinary code. `lang` is the fence's first info word;
 * a ```json block counts when it is an Excalidraw scene (its `type` is the first key).
 */
export function diagramKindOf(lang: string, text: string): DiagramKind | null {
	const word = lang.toLowerCase();
	const named = Object.hasOwn(KIND_BY_LANG, word) ? KIND_BY_LANG[word]! : null;
	if (named === "mermaid") return text.length <= MAX_MERMAID_CHARS ? named : null;
	if (named === "excalidraw") return text.length <= MAX_EXCALIDRAW_CHARS ? named : null;
	if ((word === "json" || word === "") && SCENE_START.test(text) && text.length <= MAX_EXCALIDRAW_CHARS) {
		return "excalidraw";
	}
	return null;
}

/**
 * Whether a fenced code token's raw text ends with its closing fence. A streaming reply carries an open
 * fence until the model writes the closer: rendering the half-written source each token would flash errors.
 */
export function isClosedFence(raw: string): boolean {
	const lines = raw.replace(/\s+$/, "").split("\n");
	if (lines.length < 2) return false;
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!);
	if (open === null) return false;
	const fence = open[1]!;
	const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
	return close.test(lines[lines.length - 1]!);
}

/** The diagram kind of a repository file by its extension, or null. */
export function diagramFileKind(path: string): DiagramKind | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const ext = name.slice(dot + 1).toLowerCase();
	return Object.hasOwn(KIND_BY_EXT, ext) ? KIND_BY_EXT[ext]! : null;
}
