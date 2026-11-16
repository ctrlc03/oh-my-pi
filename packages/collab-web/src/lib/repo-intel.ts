/**
 * Shared contract for the explorer's content search and the editor's language-server features,
 * answered by the companion for a session's repository (`file-search`, `lsp`, `lsp-diagnostics`).
 * Paths are repository-relative with `/` separators, like `FileTree.files`. Lines are 1-based;
 * characters are 0-based UTF-16 offsets within the line (the LSP convention, and what both
 * editors report).
 */

/** Content search over the session's repository (needs `canRepoSearch`). */
export interface FileSearchQuery {
	/** Text to find; a regular expression when `regex` is set. */
	query: string;
	regex?: boolean;
	caseSensitive?: boolean;
	/** Whole-word match (applies to plain text and regexes). */
	wholeWord?: boolean;
	/** Glob filter on repository-relative paths, e.g. `src/**\/*.ts`; empty or absent: every file. */
	glob?: string;
}

export interface FileSearchMatch {
	path: string;
	line: number;
	/** 0-based start of the first match on the line, when known. */
	character?: number;
	/** The line, cut to a few hundred characters. */
	text: string;
}

export interface FileSearchResult {
	matches: FileSearchMatch[];
	/** Files with at least one match (counting those past the match cap). */
	files: number;
	/** The search stopped at its match cap or time limit; more matches exist. */
	limited: boolean;
}

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

/** A definition or reference target. */
export interface LspLocation {
	/** Repository-relative when `inRepo`, else absolute (a dependency or the standard library). */
	path: string;
	/** Outside the session's repository: listed, but the editor cannot open it. */
	inRepo: boolean;
	range: LspRange;
	/** The target's first line (trimmed), for in-repo locations. */
	preview?: string;
}

export type LspOp = "hover" | "definition" | "references";

export interface LspQuery {
	op: LspOp;
	path: string;
	position: LspPosition;
	/**
	 * The editor's unsaved text for `path`, so answers match what is on screen; absent when the
	 * buffer equals the file on disk.
	 */
	text?: string;
}

export type LspResult =
	/** No language server handles this file (`reason` says why: none configured, not installed, sandboxed session). */
	| { kind: "unavailable"; reason: string }
	| { kind: "hover"; server: string; markdown: string | null; range?: LspRange }
	| { kind: "locations"; server: string; locations: LspLocation[] };

export type LspSeverity = "error" | "warning" | "info" | "hint";

export interface LspDiagnostic {
	range: LspRange;
	severity: LspSeverity;
	message: string;
	source?: string;
	code?: string;
}

export type LspDiagnosticsResult =
	| { kind: "unavailable"; reason: string }
	/** `diagnostics: null` means the server sent no fresh report in time (not "clean"). */
	| { kind: "diagnostics"; server: string; diagnostics: LspDiagnostic[] | null };
