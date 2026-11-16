/** The Problems tab's rows: the language server's diagnostics of every open file, worst first. */
import type { LspDiagnostic, LspSeverity } from "../../lib/repo-intel";

export interface ProblemRow {
	/** Root-relative path of the open file. */
	path: string;
	/** 1-based. */
	line: number;
	/** 0-based UTF-16 offset in the line. */
	character: number;
	severity: LspSeverity;
	message: string;
	source?: string;
	code?: string;
}

const SEVERITY_ORDER: Record<LspSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** Errors first, then warnings, information and hints; each by file path, then line, then column. */
export function sortProblems(rows: readonly ProblemRow[]): ProblemRow[] {
	return rows.toSorted(
		(a, b) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			(a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
			a.line - b.line ||
			a.character - b.character,
	);
}

/** The sorted rows of the files' diagnostics; a file whose problems are not known (`null`) has none. */
export function problemRows(
	files: readonly { path: string; diagnostics: readonly LspDiagnostic[] | null }[],
): ProblemRow[] {
	const rows: ProblemRow[] = [];
	for (const file of files) {
		for (const d of file.diagnostics ?? []) {
			rows.push({
				path: file.path,
				line: d.range.start.line,
				character: d.range.start.character,
				severity: d.severity,
				message: d.message,
				source: d.source,
				code: d.code,
			});
		}
	}
	return sortProblems(rows);
}
