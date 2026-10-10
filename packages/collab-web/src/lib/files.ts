/**
 * Prompt file attachments. Images ride the wire as `ImageContent` (see images.ts); every other file
 * becomes text in the prompt itself: small text files are inlined as a fenced block, anything else
 * is uploaded to the paired computer and referenced by the path it was saved under, which the agent
 * can then read.
 */

/** Files other than images per prompt. */
export const MAX_FILES = 8;
/** Largest text file pasted into the prompt; beyond this it costs more context than it is worth. */
export const MAX_INLINE_BYTES = 256 * 1024;
/**
 * Largest file uploaded to the computer. The upload is one base64 frame (4/3 of the file) and the
 * relay drops frames over 16 MB, so 10 MB is the most that is safely deliverable.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** A non-image attachment: inlined text, or an upload that is `path: null` until the computer has saved it. */
export type AttachedFile =
	| { id: number; kind: "inline"; name: string; size: number; text: string }
	| { id: number; kind: "upload"; name: string; size: number; path: string | null };

/** What a picked file turns into; `refuse` carries the message to show. */
export type FilePlan = "image" | "inline" | "upload" | { refuse: string };

export interface FileMeta {
	name: string;
	type: string;
	size: number;
}

export const NEEDS_COMPANION = "Files other than text and images need the companion.";

/** Fence info string per extension; the same keys double as the known text extensions. */
const LANG_BY_EXT: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	json: "json",
	jsonc: "jsonc",
	md: "md",
	mdx: "mdx",
	txt: "",
	log: "",
	csv: "csv",
	tsv: "",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	ini: "ini",
	cfg: "ini",
	conf: "",
	env: "sh",
	xml: "xml",
	svg: "xml",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	fish: "fish",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	diff: "diff",
	patch: "diff",
	lua: "lua",
	php: "php",
	pl: "perl",
	r: "r",
	dart: "dart",
	vue: "vue",
	svelte: "svelte",
	tf: "hcl",
	proto: "protobuf",
};
/** Extensionless names that are plain text. */
const LANG_BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

const TEXT_MIME =
	/^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-javascript|typescript|x-sh)\b|[^;]+\+(json|xml|yaml))/;

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The picked file goes through the image pipeline; SVG is text. */
export function isImageFile(file: Pick<FileMeta, "type">): boolean {
	return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

/** By MIME type or name only: whether to try inlining. The bytes still have to decode as text. */
export function looksLikeText(file: Pick<FileMeta, "name" | "type">): boolean {
	if (TEXT_MIME.test(file.type)) return true;
	return Object.hasOwn(LANG_BY_EXT, extensionOf(file.name)) || Object.hasOwn(LANG_BY_NAME, file.name.toLowerCase());
}

/** Fence info string for `name`; empty when the type is unknown. */
export function languageOf(name: string): string {
	const lower = name.toLowerCase();
	if (Object.hasOwn(LANG_BY_NAME, lower)) return LANG_BY_NAME[lower];
	const ext = extensionOf(name);
	return Object.hasOwn(LANG_BY_EXT, ext) ? LANG_BY_EXT[ext] : "";
}

/** Upload route for a file that is not (or cannot be inlined as) text. */
export function planUpload(file: Pick<FileMeta, "name" | "size">, canUpload: boolean): "upload" | { refuse: string } {
	if (!canUpload) return { refuse: NEEDS_COMPANION };
	if (file.size > MAX_UPLOAD_BYTES) return { refuse: `${file.name} is over ${formatSize(MAX_UPLOAD_BYTES)}.` };
	return "upload";
}

/** Decides from metadata alone; an `inline` plan may still fall back to {@link planUpload} once the bytes fail to decode. */
export function planFile(file: FileMeta, canUpload: boolean): FilePlan {
	if (isImageFile(file)) return "image";
	if (looksLikeText(file) && file.size <= MAX_INLINE_BYTES) return "inline";
	return planUpload(file, canUpload);
}

/** `bytes` as text, or null when they are not valid UTF-8 or contain a NUL (a binary file). */
export function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / (1024 * 1024);
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The shortest backtick fence (at least three) that no line of `content` can close. */
export function fenceFor(content: string): string {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/** One attachment as the paragraph the agent reads. Null for an upload still in flight. */
export function attachmentBlock(file: AttachedFile): string | null {
	// A backtick in the name would end the code span it sits in.
	const name = file.name.replaceAll("`", "'");
	if (file.kind === "upload") {
		return file.path === null ? null : `Attached file: \`${file.path}\` (${name}, ${formatSize(file.size)})`;
	}
	const body = file.text.replace(/\r?\n$/, "");
	const fence = fenceFor(body);
	return `Attached file \`${name}\`:\n${fence}${languageOf(file.name)}\n${body}\n${fence}`;
}

/** The typed text followed by one block per attached file, blank-line separated. */
export function composePrompt(text: string, files: readonly AttachedFile[]): string {
	const blocks = files.map(attachmentBlock).filter((block): block is string => block !== null);
	return [text.trim(), ...blocks].filter(part => part !== "").join("\n\n");
}
