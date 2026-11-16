/**
 * Pure logic of the explorer's Search and References views: the highlight ranges of a match (computed here with the
 * query's case, whole-word and regex options, since the companion reports only where a line's first match starts)
 * and the grouping of results by file.
 */
import type { FileSearchMatch, LspLocation } from "../../../lib/repo-intel";

/** The options of a content search that decide what counts as a match. */
export interface MatchOptions {
	query: string;
	regex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
}

/** `[start, end)` UTF-16 offsets into a line. */
export type Span = readonly [start: number, end: number];

export type Highlighter = { ok: true; spans(text: string): Span[] } | { ok: false; message: string };

/** Matches one line can show; a pattern like `.` on a long line would otherwise produce hundreds. */
export const MAX_SPANS = 50;

const ESCAPE = /[.*+?^${}()|[\]\\/-]/g;

/** `text` as a regular expression source that matches it literally. */
export function escapeRegex(text: string): string {
	return text.replace(ESCAPE, "\\$&");
}

/** Characters that make a word; a whole-word match may not touch one on either side. */
const WORD = String.raw`[\p{L}\p{N}_]`;
const WORD_ASCII = "[A-Za-z0-9_]";

function compile(source: string, flags: string, wholeWord: boolean): RegExp {
	try {
		const body = wholeWord ? `(?<!${WORD})(?:${source})(?!${WORD})` : source;
		return new RegExp(body, `${flags}u`);
	} catch {
		// Syntax valid without the unicode flag only (a lone `\-`, an escape of a non-syntax character).
		const body = wholeWord ? `(?<!${WORD_ASCII})(?:${source})(?!${WORD_ASCII})` : source;
		return new RegExp(body, flags);
	}
}

/**
 * A highlighter for `options`, null for an empty query. An invalid regular expression is reported, not thrown.
 * Zero-width matches are skipped, so `a*` highlights the runs of `a` and nothing else.
 */
export function compileHighlighter(options: MatchOptions): Highlighter | null {
	if (options.query.length === 0) return null;
	const source = options.regex ? options.query : escapeRegex(options.query);
	const flags = options.caseSensitive ? "g" : "gi";
	let re: RegExp;
	try {
		re = compile(source, flags, options.wholeWord);
	} catch (error) {
		const reason = error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : "";
		return {
			ok: false,
			message: reason.length > 0 ? `Invalid regular expression: ${reason}` : "Invalid regular expression",
		};
	}
	return {
		ok: true,
		spans(text) {
			const spans: Span[] = [];
			re.lastIndex = 0;
			for (let m = re.exec(text); m !== null && spans.length < MAX_SPANS; m = re.exec(text)) {
				if (m[0].length === 0) {
					re.lastIndex += 1;
					continue;
				}
				spans.push([m.index, m.index + m[0].length]);
			}
			return spans;
		},
	};
}

/** `text` cut at `spans` into runs; `hit` marks the matched ones. Spans must be ordered and disjoint. */
export function splitBySpans(text: string, spans: readonly Span[]): { text: string; hit: boolean }[] {
	const runs: { text: string; hit: boolean }[] = [];
	let at = 0;
	for (const [start, end] of spans) {
		if (start > at) runs.push({ text: text.slice(at, start), hit: false });
		runs.push({ text: text.slice(start, end), hit: true });
		at = end;
	}
	if (at < text.length) runs.push({ text: text.slice(at), hit: false });
	return runs;
}

/** Characters of context kept before the first match when a long line is cut for display. */
const LEAD = 24;

/**
 * A result line made ready to show: leading whitespace dropped, and a line whose first match is far from its start
 * cut (with a leading `…`) so the match is on screen. `spans` are moved to the returned text.
 */
export function windowLine(text: string, spans: readonly Span[]): { text: string; spans: Span[] } {
	const indent = text.length - text.trimStart().length;
	const first = spans[0]?.[0] ?? 0;
	const cut = Math.max(indent, first - LEAD);
	const ellipsis = cut > indent ? "…" : "";
	const shift = cut - ellipsis.length;
	return {
		text: ellipsis + text.slice(cut),
		spans: spans.filter(([start]) => start >= cut).map(([start, end]): Span => [start - shift, end - shift]),
	};
}

export interface FileGroup<T> {
	path: string;
	items: T[];
}

/** Matches grouped by file, files by path and each file's matches by line. */
export function groupMatches(matches: readonly FileSearchMatch[]): FileGroup<FileSearchMatch>[] {
	const byPath = new Map<string, FileSearchMatch[]>();
	for (const match of matches) {
		const list = byPath.get(match.path);
		if (list === undefined) byPath.set(match.path, [match]);
		else list.push(match);
	}
	return [...byPath]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, items]) => ({
			path,
			items: items.sort((a, b) => a.line - b.line || (a.character ?? 0) - (b.character ?? 0)),
		}));
}

/** Reference locations grouped by file: files in the repository first, each by path, locations in file order. */
export function groupLocations(locations: readonly LspLocation[]): FileGroup<LspLocation>[] {
	const byPath = new Map<string, LspLocation[]>();
	for (const location of locations) {
		const list = byPath.get(location.path);
		if (list === undefined) byPath.set(location.path, [location]);
		else list.push(location);
	}
	const inRepo = (items: readonly LspLocation[]): boolean => items[0]?.inRepo === true;
	return [...byPath]
		.sort(([pa, a], [pb, b]) => Number(inRepo(b)) - Number(inRepo(a)) || pa.localeCompare(pb))
		.map(([path, items]) => ({
			path,
			items: items.sort(
				(a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
			),
		}));
}

/** "12 results in 3 files". */
export function resultCounts(results: number, files: number): string {
	return `${results.toLocaleString()} result${results === 1 ? "" : "s"} in ${files.toLocaleString()} file${files === 1 ? "" : "s"}`;
}
