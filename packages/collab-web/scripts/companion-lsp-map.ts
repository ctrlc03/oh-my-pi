/**
 * Pure mapping from language-server answers to the editor's wire types (`LspResult`, `LspDiagnostic`). Kept apart
 * from the server management in companion-lsp.ts so it needs no omp module. Server positions are 0-based lines;
 * the wire is 1-based lines (characters stay 0-based UTF-16 on both).
 */

import * as path from "node:path";
import { isRecord } from "../src/tool-render/util";
import type { LspDiagnostic, LspLocation, LspPosition, LspRange, LspSeverity } from "../src/lib/repo-intel";
import { isGitInternal, isInside } from "./companion-git";

/** Locations kept from one answer. */
export const MAX_LOCATIONS = 500;
/** Longest preview line kept. */
const PREVIEW_CHARS = 200;

interface RawPosition {
	line: number;
	character: number;
}

interface RawRange {
	start: RawPosition;
	end: RawPosition;
}

/** A `Location`, or a `LocationLink` reduced to its target. */
export interface RawLocation {
	uri: string;
	range: RawRange;
}

/** A server's diagnostic, as far as the wire keeps it. */
export interface RawDiagnostic {
	range: RawRange;
	severity?: number;
	code?: string | number | { value?: string | number };
	source?: string;
	message: string;
}

function isRange(value: unknown): value is RawRange {
	if (!isRecord(value)) return false;
	const { start, end } = value;
	const isPosition = (p: unknown): p is RawPosition =>
		isRecord(p) && typeof p.line === "number" && typeof p.character === "number";
	return isPosition(start) && isPosition(end);
}

/** `value` when it is a server range, else undefined. */
export function rawRange(value: unknown): RawRange | undefined {
	return isRange(value) ? value : undefined;
}

/** The wire position (1-based line) as the server wants it (0-based line). */
export function toServerPosition(position: LspPosition): RawPosition {
	return { line: position.line - 1, character: position.character };
}

/** A server range (0-based lines) as the wire has it (1-based lines). */
export function toWireRange(range: RawRange): LspRange {
	return {
		start: { line: range.start.line + 1, character: range.start.character },
		end: { line: range.end.line + 1, character: range.end.character },
	};
}

/** A code fence longer than any backtick run inside `body`, so the body cannot close it. */
function fence(body: string, language: string): string {
	let longest = 2;
	for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(longest + 1);
	return `${ticks}${language}\n${body}\n${ticks}`;
}

/** One hover content item as markdown. */
function markdownOf(item: unknown): string {
	if (typeof item === "string") return item;
	if (!isRecord(item) || typeof item.value !== "string") return "";
	// MarkedString { language, value }.
	if (typeof item.language === "string") return fence(item.value, item.language);
	// MarkupContent: plain text must not be read as markdown.
	if (item.kind === "plaintext") return fence(item.value, "");
	return item.value;
}

/**
 * A hover result's `contents` (MarkupContent, MarkedString, or an array of them) as one markdown string; null
 * when it holds no text.
 */
export function hoverMarkdown(contents: unknown): string | null {
	const items = Array.isArray(contents) ? contents : [contents];
	const parts = items.map(markdownOf).filter(part => part.trim() !== "");
	return parts.length === 0 ? null : parts.join("\n\n");
}

/** The locations in a definition or references answer: `Location`, `Location[]`, `LocationLink`, `LocationLink[]`, or null. */
export function rawLocations(result: unknown): RawLocation[] {
	if (result === null || result === undefined) return [];
	const items: unknown[] = Array.isArray(result) ? result : [result];
	const found: RawLocation[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		if (typeof item.uri === "string" && isRange(item.range)) {
			found.push({ uri: item.uri, range: item.range });
		} else if (typeof item.targetUri === "string") {
			// A link points at its symbol's name when it can, else at the whole declaration.
			const range = isRange(item.targetSelectionRange) ? item.targetSelectionRange : item.targetRange;
			if (isRange(range)) found.push({ uri: item.targetUri, range });
		}
	}
	return found;
}

/** A location with the absolute file it names. */
export interface MappedLocation {
	location: LspLocation;
	/** Absolute path of the file. */
	abs: string;
}

/**
 * The wire location for a server location. In the repository (`base`, symlink-resolved, and not in a `.git`
 * directory) the path is repository-relative; elsewhere it stays absolute and the editor cannot open it.
 * @param toPath Converts a `file://` URI to a path.
 */
export function toLocation(raw: RawLocation, base: string, toPath: (uri: string) => string): MappedLocation {
	const abs = toPath(raw.uri);
	const inRepo = path.isAbsolute(abs) && isInside(base, abs) && !isGitInternal(base, abs);
	return {
		abs,
		location: {
			path: inRepo ? path.relative(base, abs).split(path.sep).join("/") : abs,
			inRepo,
			range: toWireRange(raw.range),
		},
	};
}

/** A source line as a one-line preview: trimmed and cut. */
export function previewOf(line: string | undefined): string | undefined {
	const text = line?.trim();
	if (text === undefined || text === "") return undefined;
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/** Wire severity of a server's 1-4 number; one it does not know (or none) reads as info. */
export function severityName(severity: number | undefined): LspSeverity {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 4:
			return "hint";
		default:
			return "info";
	}
}

function codeText(code: RawDiagnostic["code"]): string | undefined {
	const value = isRecord(code) ? code.value : code;
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Wire diagnostics for a server's, in file order. */
export function toDiagnostics(raw: readonly RawDiagnostic[]): LspDiagnostic[] {
	return raw
		.filter(item => isRange(item.range) && typeof item.message === "string")
		.map(item => {
			const code = codeText(item.code);
			return {
				range: toWireRange(item.range),
				severity: severityName(item.severity),
				message: item.message,
				...(typeof item.source === "string" ? { source: item.source } : {}),
				...(code === undefined ? {} : { code }),
			};
		})
		.sort(
			(a, b) =>
				a.range.start.line - b.range.start.line ||
				a.range.start.character - b.range.start.character ||
				a.message.localeCompare(b.message),
		);
}
