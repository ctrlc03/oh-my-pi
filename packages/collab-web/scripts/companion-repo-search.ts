/**
 * Content search for the companion's `file-search` request: the explorer's "Search in files" over a session's
 * repository, run by omp's native grep (the engine behind the agent's `grep` tool) so it honours `.gitignore`,
 * skips binaries and stays fast on large trees.
 *
 * The native module is loaded lazily: a checkout without the built natives must leave the rest of the companion
 * working, and `canRepoSearch` follows whether it loaded.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GrepMatch, GrepOptions, grep as NativeGrep } from "@oh-my-pi/pi-natives";
import type { FileSearchMatch, FileSearchQuery, FileSearchResult } from "../src/lib/repo-intel";
import { isGitInternal, isInside, repoScope } from "./companion-git";

/** Longest query text accepted. */
export const MAX_QUERY_CHARS = 1000;
const MAX_GLOB_CHARS = 500;
/** Matches returned; more set `limited`. */
export const MAX_MATCHES = 1000;
const MAX_MATCHES_PER_FILE = 100;
/** Lines longer than this are cut by the search. */
const MAX_COLUMNS = 300;
export const SEARCH_TIMEOUT_MS = 20_000;
/** Files whose path is checked against the scope at once. */
const CHECK_BATCH = 64;

let nativeGrep: typeof NativeGrep | null = null;
let loading: Promise<boolean> | undefined;

/** Load the native search once; false when this checkout cannot (reason logged once). */
export function loadRepoSearch(): Promise<boolean> {
	loading ??= import("@oh-my-pi/pi-natives").then(
		module => {
			nativeGrep = module.grep;
			return true;
		},
		(err: unknown) => {
			console.error(`companion: repository search unavailable: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		},
	);
	return loading;
}

/** Escape `text` for the search's regex dialect. */
export function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the search runs: the query as a regex, whole-word anchored when asked. The native search falls back to
 * literal text for a pattern it cannot compile, so a regex that is plainly malformed is refused here instead of
 * silently turning into a literal search.
 * @throws Error "Invalid regex: …" for a malformed regex.
 */
export function searchPattern(search: FileSearchQuery): string {
	const base = search.regex === true ? search.query : escapeRegex(search.query);
	if (search.regex === true) {
		try {
			new RegExp(base, "u");
		} catch (err) {
			const reason = err instanceof Error ? err.message.replace(/^Invalid regular expression:\s*/i, "") : "";
			// Only structural errors: the dialect also takes constructs a JavaScript regex does not (`(?i)`, `(?P<n>…)`).
			if (
				/missing \)|missing terminating \]|nothing to repeat|at end of pattern|unmatched parentheses|out of order/i.test(
					reason,
				)
			)
				throw new Error(`Invalid regex: ${reason}`);
		}
	}
	return search.wholeWord === true ? `\\b(?:${base})\\b` : base;
}

/** Validate a `file-search` request body. @throws Error naming what is wrong. */
export function checkFileSearch(value: unknown): FileSearchQuery {
	if (typeof value !== "object" || value === null) throw new Error("invalid search");
	const search = value as Partial<FileSearchQuery>;
	if (typeof search.query !== "string" || search.query === "") throw new Error("Enter something to search for.");
	if (search.query.length > MAX_QUERY_CHARS) throw new Error(`The search text is over ${MAX_QUERY_CHARS} characters.`);
	if (search.query.includes("\0")) throw new Error("invalid search");
	if (search.glob !== undefined && (typeof search.glob !== "string" || search.glob.includes("\0")))
		throw new Error("invalid file filter");
	if (search.glob !== undefined && search.glob.length > MAX_GLOB_CHARS)
		throw new Error("The file filter is too long.");
	for (const flag of ["regex", "caseSensitive", "wholeWord"] as const) {
		if (search[flag] !== undefined && typeof search[flag] !== "boolean") throw new Error("invalid search");
	}
	return {
		query: search.query,
		regex: search.regex,
		caseSensitive: search.caseSensitive,
		wholeWord: search.wholeWord,
		glob: search.glob?.trim() || undefined,
	};
}

/** Start of the first match of `pattern` in `line` (UTF-16), or undefined when it cannot be told. */
function matchStart(pattern: RegExp | null, line: string): number | undefined {
	if (pattern === null) return undefined;
	const found = pattern.exec(line);
	return found === null ? undefined : found.index;
}

/** The query as a JavaScript regex for locating a match's column; null when the dialects disagree. */
function columnPattern(source: string, caseSensitive: boolean): RegExp | null {
	try {
		return new RegExp(source, caseSensitive ? "u" : "iu");
	} catch {
		return null;
	}
}

/** Repository-relative `/` path for a native match path, or null when it is not a plain relative path. */
function relativePath(raw: string): string | null {
	const normal = raw.split(path.sep).join("/");
	if (normal === "" || normal.startsWith("/") || path.isAbsolute(normal)) return null;
	if (normal.split("/").some(part => part === "..")) return null;
	return normal;
}

/** The paths among `files` (repo-relative) that resolve inside `base` and outside any `.git` directory. */
async function pathsInScope(base: string, files: string[]): Promise<Set<string>> {
	const allowed = new Set<string>();
	for (let i = 0; i < files.length; i += CHECK_BATCH) {
		await Promise.all(
			files.slice(i, i + CHECK_BATCH).map(async file => {
				try {
					const real = await fs.realpath(path.join(base, file));
					if (isInside(base, real) && !isGitInternal(base, real)) allowed.add(file);
				} catch {
					// Vanished since the search saw it.
				}
			}),
		);
	}
	return allowed;
}

/**
 * Search the repository containing `cwd` (the directory itself outside a repository).
 * @throws Error for an invalid query or regex, or when the native search is unavailable.
 */
export async function searchRepoFiles(cwd: string, value: unknown): Promise<FileSearchResult> {
	const search = checkFileSearch(value);
	const pattern = searchPattern(search);
	if (!(await loadRepoSearch()) || nativeGrep === null)
		throw new Error("repository search is unavailable on this computer");
	const scope = await repoScope(cwd);

	const collected: GrepMatch[] = [];
	const options: GrepOptions = {
		pattern,
		path: scope.base,
		glob: search.glob,
		// A glob with a `/` is relative to the repository root; a bare one (`*.ts`) matches at any depth.
		recursive: search.glob === undefined || !search.glob.includes("/"),
		ignoreCase: search.caseSensitive !== true,
		hidden: true,
		gitignore: true,
		exclude: [".git"],
		maxCount: MAX_MATCHES,
		maxCountPerFile: MAX_MATCHES_PER_FILE,
		maxColumns: MAX_COLUMNS,
		timeoutMs: SEARCH_TIMEOUT_MS,
	};
	let matches: GrepMatch[];
	let files: number;
	let limited: boolean;
	try {
		const result = await nativeGrep(options, (_err, match) => {
			collected.push(match);
		});
		matches = result.matches;
		limited =
			result.limitReached === true || result.totalMatches > result.matches.length || matches.length >= MAX_MATCHES;
		files = result.filesWithMatches;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/^regex(?: parse)? error/i.test(message))
			throw new Error(message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
		if (!message.includes("Aborted: Timeout")) throw err;
		// What the walk found before the time limit is still worth showing.
		matches = collected;
		limited = true;
		files = new Set(collected.map(match => match.path)).size;
	}

	const relative = matches.map(match => relativePath(match.path));
	const allowed = await pathsInScope(scope.base, [
		...new Set(relative.filter((file): file is string => file !== null)),
	]);
	const column = columnPattern(pattern, search.caseSensitive === true);
	const found: FileSearchMatch[] = [];
	let dropped = 0;
	for (const [index, match] of matches.entries()) {
		const file = relative[index];
		if (file === null || !allowed.has(file)) {
			dropped++;
			continue;
		}
		const character = match.truncated === true ? undefined : matchStart(column, match.line);
		found.push({
			path: file,
			line: match.lineNumber,
			...(character === undefined ? {} : { character }),
			text: match.line,
		});
	}
	if (dropped > 0)
		files = Math.max(found.length === 0 ? 0 : new Set(found.map(match => match.path)).size, files - dropped);
	return { matches: found, files, limited };
}
