/**
 * The standalone HTML export of a map: one file with the map JSON, the code it cites, and the viewer's script and
 * styles inline, so it opens from a file with no network.
 *
 * The code is stored per file as merged line ranges (overlapping citations share lines), not per citation. A map of
 * a large repository has some 16 000 citations, so the default export carries only the code the agent's own diagrams
 * cite; the index diagrams (folders, files, symbols) keep their structure and show `path:line` with a note that the
 * code is not included. "All code" adds the rest, with a size estimate made before anything is fetched.
 *
 * The page's data sits in a `<script type="application/json">`; the viewer (`standalone.tsx`) reads it back with
 * {@link parsePayload}. The export builds the page here, in the browser, from what the live viewer already has.
 */
import type { Blueprint, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { BLUEPRINT_EXCERPT_CONTEXT } from "@oh-my-pi/pi-wire/blueprint";
import type { MapSource } from "./DetailPanel";
import { EXCERPT_BATCH } from "./blueprint-api";
import type { ExportedExcerpt } from "./blueprint-model";
import { allRefs, slug } from "./blueprint-model";

/** Format version of {@link ExportPayload}. */
export const EXPORT_VERSION = 2;
/** Id of the script element that holds the payload. */
export const PAYLOAD_ELEMENT_ID = "omp-blueprint";

/** What code an export carries: the agent's diagrams' citations, or every citation of the map. */
export type ExportScope = "diagrams" | "all";

/** A run of consecutive lines of one file; `html` is the highlighted markup of each line, when there is any. */
export interface ExportSegment {
	start: number;
	lines: string[];
	html?: string[];
}

/** The lines of one file (at one side's commit) the export carries. */
export interface ExportFile {
	commit: string;
	language?: string;
	/** Ascending and not touching. */
	segments: ExportSegment[];
}

export interface ExportPayload {
	v: typeof EXPORT_VERSION;
	/** Ms since epoch. */
	exportedAt: number;
	scope: ExportScope;
	map: Blueprint;
	/** By {@link fileKey}. */
	code: Record<string, ExportFile>;
}

export interface StandaloneAssets {
	script: string;
	style: string;
}

/** Where the build puts the viewer, under `architecture-assets/` next to `index.html` (see scripts/build-architecture-standalone.ts). */
export const STANDALONE_SCRIPT = "architecture-assets/standalone.js";
export const STANDALONE_STYLE = "architecture-assets/standalone.css";

/** Which file of which side a citation reads. */
export function fileKey(ref: Pick<BlueprintRef, "side" | "path">): string {
	return `${ref.side ?? "head"}:${ref.path}`;
}

/** Highlighting adds markup to every line: past this many lines the export keeps the code plain. */
export const HIGHLIGHT_MAX_LINES = 20_000;
/** What a line of code costs in the page (JSON, escapes), plain and with its highlighted markup. */
const BYTES_PER_LINE_PLAIN = 42;
const BYTES_PER_LINE_HIGHLIGHTED = 130;
/** The viewer's script and styles. */
const VIEWER_BYTES = 285_000;
/** Excerpts read at once. */
const EXCERPT_PARALLEL = 3;

/** One request's worth of citations that, with the lines around them, cover every citation of the map. */
export interface Cover {
	/** The citations to ask the companion for. */
	reps: BlueprintRef[];
	files: number;
	/** Distinct lines those excerpts cover. */
	lines: number;
}

/**
 * Pick the citations to read so that the {@link BLUEPRINT_EXCERPT_CONTEXT} lines around every citation of `refs` are
 * covered, with as few reads as possible: citations of one file that sit within reach of each other share excerpts.
 */
export function coverRefs(refs: readonly BlueprintRef[]): Cover {
	const context = BLUEPRINT_EXCERPT_CONTEXT;
	const byFile = new Map<string, Map<number, BlueprintRef>>();
	for (const ref of refs) {
		const key = fileKey(ref);
		let lines = byFile.get(key);
		if (lines === undefined) byFile.set(key, (lines = new Map()));
		if (!lines.has(ref.line)) lines.set(ref.line, ref);
	}
	const reps: BlueprintRef[] = [];
	let total = 0;
	for (const lines of byFile.values()) {
		const sorted = [...lines.keys()].sort((a, b) => a - b);
		let i = 0;
		while (i < sorted.length) {
			let current = sorted[i]!;
			const first = Math.max(1, current - context);
			reps.push(lines.get(current)!);
			// Hop to the furthest citation whose excerpt still touches this one's: the excerpts form one run.
			for (;;) {
				let next = i;
				while (next + 1 < sorted.length && sorted[next + 1]! <= current + 2 * context + 1) next++;
				if (next === i) break;
				i = next;
				current = sorted[i]!;
				reps.push(lines.get(current)!);
			}
			total += current + context - first + 1;
			i++;
		}
	}
	return { reps, files: byFile.size, lines: total };
}

/** What an export of one scope would hold and weigh, known before anything is read. */
export interface ExportPlan {
	scope: ExportScope;
	citations: number;
	/** Excerpts read, in {@link EXCERPT_BATCH}es. */
	reads: number;
	files: number;
	lines: number;
	/** The finished page, estimated. */
	bytes: number;
	/** The code will carry syntax colours. */
	highlighted: boolean;
}

/** The plan of each scope of `map`. */
export function planExports(map: Blueprint): Record<ExportScope, ExportPlan> {
	const mapBytes = JSON.stringify(map).length;
	const plan = (scope: ExportScope): ExportPlan => {
		const refs = allRefs(map, scope === "diagrams" ? "agent" : undefined);
		const cover = coverRefs(refs);
		const highlighted = cover.lines <= HIGHLIGHT_MAX_LINES;
		return {
			scope,
			citations: refs.length,
			reads: cover.reps.length,
			files: cover.files,
			lines: cover.lines,
			bytes:
				mapBytes + VIEWER_BYTES + cover.lines * (highlighted ? BYTES_PER_LINE_HIGHLIGHTED : BYTES_PER_LINE_PLAIN),
			highlighted,
		};
	};
	return { diagrams: plan("diagrams"), all: plan("all") };
}

export interface ExportProgress {
	phase: "reading" | "colouring";
	done: number;
	total: number;
}

export interface CollectOptions {
	onProgress?(progress: ExportProgress): void;
	signal?: AbortSignal;
}

/** hljs markup split into one self-contained fragment per line: spans open across a line break are closed and reopened. */
export function splitHighlighted(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let line = "";
	for (const part of html.split(/(<[^>]+>)/)) {
		if (part.startsWith("</")) {
			open.pop();
			line += part;
		} else if (part.startsWith("<")) {
			open.push(part);
			line += part;
		} else {
			part.split("\n").forEach((piece, i) => {
				if (i > 0) {
					lines.push(line + "</span>".repeat(open.length));
					line = open.join("");
				}
				line += piece;
			});
		}
	}
	lines.push(line);
	return lines;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The export was cancelled.", "AbortError");
}

/** Let the page paint and answer input between slices of work. */
function breathe(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

/** Read the code of `scope`, in batches of {@link EXCERPT_BATCH}, and lay it out as merged per-file ranges. */
export async function collectPayload(
	map: Blueprint,
	source: MapSource,
	scope: ExportScope,
	options: CollectOptions = {},
): Promise<ExportPayload> {
	const { onProgress, signal } = options;
	const { reps } = coverRefs(allRefs(map, scope === "diagrams" ? "agent" : undefined));
	const batches: BlueprintRef[][] = [];
	for (let at = 0; at < reps.length; at += EXCERPT_BATCH) batches.push(reps.slice(at, at + EXCERPT_BATCH));

	const files = new Map<string, { commit: string; language?: string; lines: Map<number, string> }>();
	let done = 0;
	onProgress?.({ phase: "reading", done, total: reps.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < batches.length) {
			throwIfAborted(signal);
			const batch = batches[next++]!;
			const got = await source.excerpts(batch);
			batch.forEach((ref, i) => {
				const excerpt = got[i];
				if (excerpt === null || excerpt === undefined) return;
				const key = fileKey(ref);
				let file = files.get(key);
				if (file === undefined)
					files.set(key, (file = { commit: excerpt.commit, language: excerpt.language, lines: new Map() }));
				excerpt.lines.forEach((text, k) => file.lines.set(excerpt.start + k, text));
			});
			done += batch.length;
			onProgress?.({ phase: "reading", done, total: reps.length });
		}
	};
	await Promise.all(Array.from({ length: Math.min(EXCERPT_PARALLEL, batches.length) }, worker));

	const code: Record<string, ExportFile> = {};
	let lineCount = 0;
	for (const [key, file] of files) {
		const numbers = [...file.lines.keys()].sort((a, b) => a - b);
		const segments: ExportSegment[] = [];
		for (const n of numbers) {
			const last = segments.at(-1);
			if (last !== undefined && last.start + last.lines.length === n) last.lines.push(file.lines.get(n)!);
			else segments.push({ start: n, lines: [file.lines.get(n)!] });
		}
		lineCount += numbers.length;
		code[key] = { commit: file.commit, language: file.language, segments };
	}

	const highlight = source.highlight;
	if (highlight !== undefined && lineCount <= HIGHLIGHT_MAX_LINES) {
		let coloured = 0;
		for (const [key, file] of Object.entries(code)) {
			throwIfAborted(signal);
			const side = key.startsWith("base:") ? "base" : "head";
			for (const segment of file.segments) {
				// A grammar that fails to load only costs the colours.
				const markup = await highlight({
					path: key.slice(key.indexOf(":") + 1),
					start: segment.start,
					lines: segment.lines,
					line: segment.start,
					side,
					commit: file.commit,
					language: file.language,
				}).catch(() => undefined);
				const split = markup === undefined ? undefined : splitHighlighted(markup);
				if (split !== undefined && split.length === segment.lines.length) segment.html = split;
				coloured += segment.lines.length;
			}
			onProgress?.({ phase: "colouring", done: coloured, total: lineCount });
			await breathe();
		}
	}
	return { v: EXPORT_VERSION, exportedAt: Date.now(), scope, map, code };
}

/** The excerpt the export holds around `ref`: up to {@link BLUEPRINT_EXCERPT_CONTEXT} lines either side, within one run. */
function excerptAt(code: Record<string, ExportFile>, ref: BlueprintRef): ExportedExcerpt | null {
	const key = fileKey(ref);
	const file = Object.hasOwn(code, key) ? code[key] : undefined;
	const segment = file?.segments.find(item => ref.line >= item.start && ref.line < item.start + item.lines.length);
	if (file === undefined || segment === undefined) return null;
	const from = Math.max(segment.start, ref.line - BLUEPRINT_EXCERPT_CONTEXT);
	const to = Math.min(segment.start + segment.lines.length - 1, ref.line + BLUEPRINT_EXCERPT_CONTEXT);
	const excerpt: ExportedExcerpt = {
		path: ref.path,
		start: from,
		lines: segment.lines.slice(from - segment.start, to - segment.start + 1),
		line: ref.line,
		side: ref.side ?? "head",
		commit: file.commit,
		language: file.language,
	};
	if (segment.html !== undefined)
		excerpt.html = segment.html.slice(from - segment.start, to - segment.start + 1).join("\n");
	return excerpt;
}

/** The code of an exported page, as the viewer reads it. */
export function sourceFromPayload(payload: ExportPayload): MapSource {
	return {
		absent:
			payload.scope === "all"
				? "This line is not in the exported code."
				: "Code not included in this export. It carries the code the main diagrams cite.",
		excerpts: async refs => refs.map(ref => excerptAt(payload.code, ref)),
	};
}

/** JSON safe inside a `<script>`: no `<` can open a tag or a comment, and line separators cannot break a parser. */
function embeddedJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/** Script text safe inside a `<script>`: neither `</script` nor `<!--` may appear in it. */
function embeddedScript(code: string): string {
	return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** Style text safe inside a `<style>`. */
function embeddedStyle(css: string): string {
	return css.replace(/<\/(style)/gi, "<\\/$1");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The whole page. */
export function buildHtml(payload: ExportPayload, assets: StandaloneAssets): string {
	const { map } = payload;
	const theme = `(function(){try{var s=localStorage.getItem("omp-architecture-theme");if(s==="light"||s==="dark")document.documentElement.dataset.theme=s;}catch(e){}})();`;
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
		'<meta name="color-scheme" content="light dark">',
		`<title>${escapeHtml(map.title)} · architecture map</title>`,
		`<style>${embeddedStyle(assets.style)}</style>`,
		"</head>",
		'<body class="ar-standalone">',
		'<div id="root"></div>',
		`<script>${theme}</script>`,
		`<script type="application/json" id="${PAYLOAD_ELEMENT_ID}">${embeddedJson(payload)}</script>`,
		`<script>${embeddedScript(assets.script)}</script>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

/** The payload in the page's data element; throws when it is not an export of this version. */
export function parsePayload(text: string): ExportPayload {
	const value = JSON.parse(text) as Partial<ExportPayload> | null;
	if (value === null || typeof value !== "object" || value.v !== EXPORT_VERSION || value.map === undefined) {
		throw new Error("This page does not hold an architecture map this viewer can read.");
	}
	return {
		v: EXPORT_VERSION,
		exportedAt: value.exportedAt ?? 0,
		scope: value.scope ?? "diagrams",
		map: value.map,
		code: value.code ?? {},
	};
}

/** File name of the export: the map's title, dated, led by the repository's name unless the title already carries it. */
export function exportFilename(map: Blueprint): string {
	const day = new Date(map.createdAt).toISOString().slice(0, 10);
	const repo = slug(map.repo.name);
	const title = slug(map.title);
	const stem = title === repo || title.startsWith(`${repo}-`) ? title : slug(`${repo}-${title}`);
	return `${stem}-${day}.html`;
}
