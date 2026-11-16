/**
 * The language-server features' pure parts, shared by both editors: position conversion between the
 * contract's coordinates (1-based line, 0-based UTF-16 character) and each engine's own, picking what a
 * go-to-definition answer does, and turning diagnostics into each engine's marker shape.
 */
import type { LspDiagnostic, LspLocation, LspPosition, LspResult, LspSeverity } from "../../../lib/repo-intel";

/** The slice of CodeMirror's `Text` the conversions read (a test can pass a real `Text`). */
export interface LineDoc {
	readonly lines: number;
	readonly length: number;
	line(n: number): { from: number; to: number; length: number };
	lineAt(pos: number): { number: number; from: number };
}

/** A document offset as a contract position. */
export function offsetToPosition(doc: LineDoc, offset: number): LspPosition {
	const line = doc.lineAt(Math.min(Math.max(offset, 0), doc.length));
	return { line: line.number, character: Math.min(Math.max(offset, 0), doc.length) - line.from };
}

/** A contract position as a document offset; a line or character past the end clamps to it. */
export function positionToOffset(doc: LineDoc, pos: LspPosition): number {
	const line = doc.line(Math.min(Math.max(pos.line, 1), doc.lines));
	return line.from + Math.min(Math.max(pos.character, 0), line.length);
}

/**
 * A contract position for an offset into `text`, which must use LF line breaks (the form a diff against
 * the disk's text is in; a CRLF document is compared on its LF form). A lone CR is not a line break.
 */
export function textPositionAt(text: string, offset: number): LspPosition {
	const end = Math.min(Math.max(offset, 0), text.length);
	let line = 1;
	let lineStart = 0;
	for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) {
		line++;
		lineStart = at + 1;
	}
	return { line, character: end - lineStart };
}

/** The editor's way of showing a definition answer. */
export type DefinitionTarget =
	/** Exactly one place, in the repository: go there. */
	| { kind: "open"; path: string; line: number; character: number }
	/** Several places, or one outside the repository: let the user choose (out-of-repo rows are not openable). */
	| { kind: "list"; locations: LspLocation[] }
	/** The server has nothing: look the name up in the code map instead. */
	| { kind: "fallback" };

function sameLocation(a: LspLocation, b: LspLocation): boolean {
	return (
		a.path === b.path &&
		a.range.start.line === b.range.start.line &&
		a.range.start.character === b.range.start.character
	);
}

/** Locations with repeats (servers list a symbol once per overload or declaration file) dropped, order kept. */
export function uniqueLocations(locations: readonly LspLocation[]): LspLocation[] {
	const out: LspLocation[] = [];
	for (const location of locations) if (!out.some(seen => sameLocation(seen, location))) out.push(location);
	return out;
}

export function chooseDefinitionTarget(result: LspResult | null): DefinitionTarget {
	if (result === null || result.kind !== "locations") return { kind: "fallback" };
	const locations = uniqueLocations(result.locations);
	if (locations.length === 0) return { kind: "fallback" };
	const only = locations[0]!;
	if (locations.length === 1 && only.inRepo) {
		return { kind: "open", path: only.path, line: only.range.start.line, character: only.range.start.character };
	}
	return { kind: "list", locations };
}

/** Whether the file has a language server at all: `unavailable` is a fact about the file, not about this request. */
export function isUnavailable(result: { kind: string }): result is { kind: "unavailable"; reason: string } {
	return result.kind === "unavailable";
}

/** Monaco's `MarkerSeverity` values (restated so this module needs no Monaco import). */
const MONACO_SEVERITY: Record<LspSeverity, 1 | 2 | 4 | 8> = { hint: 1, info: 2, warning: 4, error: 8 };

export interface MarkerData {
	severity: 1 | 2 | 4 | 8;
	message: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	source?: string;
	code?: string;
}

/**
 * A Monaco marker for a diagnostic: the 0-based character becomes a 1-based column, and an empty range is
 * widened to one character (Monaco paints nothing for it). `lineLength(line)` is a line's length; the
 * range is clamped into the document of `lineCount` lines.
 */
export function toMarker(d: LspDiagnostic, lineCount: number, lineLength: (line: number) => number): MarkerData {
	const startLine = Math.min(Math.max(d.range.start.line, 1), Math.max(lineCount, 1));
	const endLine = Math.min(Math.max(d.range.end.line, startLine), Math.max(lineCount, 1));
	let startColumn = Math.min(Math.max(d.range.start.character, 0), lineLength(startLine)) + 1;
	let endColumn = Math.min(Math.max(d.range.end.character, 0), lineLength(endLine)) + 1;
	if (endLine === startLine && endColumn <= startColumn) {
		const length = lineLength(startLine);
		if (startColumn <= length) endColumn = startColumn + 1;
		// At the very end of a line there is no character after the spot: underline the one before it.
		else if (startColumn > 1) startColumn -= 1;
	}
	return {
		severity: MONACO_SEVERITY[d.severity],
		message: d.message,
		startLineNumber: startLine,
		startColumn,
		endLineNumber: endLine,
		endColumn,
		source: d.source,
		code: d.code,
	};
}

export interface RangeDiagnostic {
	from: number;
	to: number;
	severity: "error" | "warning" | "info";
	message: string;
	source?: string;
}

/** A CodeMirror diagnostic: offsets into the document, an empty range widened to one character, hints shown as info. */
export function toRangeDiagnostic(d: LspDiagnostic, doc: LineDoc): RangeDiagnostic {
	const from = positionToOffset(doc, d.range.start);
	let to = Math.max(positionToOffset(doc, d.range.end), from);
	let start = from;
	if (to === from) {
		if (to < doc.length) to = from + 1;
		else if (start > 0) start = from - 1;
	}
	const code = d.code === undefined ? "" : ` (${d.code})`;
	return {
		from: start,
		to,
		severity: d.severity === "hint" ? "info" : d.severity,
		message: `${d.message}${code}`,
		source: d.source,
	};
}

export interface DiagnosticCounts {
	errors: number;
	warnings: number;
}

export function countDiagnostics(list: readonly LspDiagnostic[]): DiagnosticCounts {
	let errors = 0;
	let warnings = 0;
	for (const d of list) {
		if (d.severity === "error") errors++;
		else if (d.severity === "warning") warnings++;
	}
	return { errors, warnings };
}

/** The status bar's wording for a file with no language server: `.rs`, `.xyz`, or the file's own name. */
export function unavailableNote(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return `No language server for ${dot > 0 ? name.slice(dot) : name}`;
}
