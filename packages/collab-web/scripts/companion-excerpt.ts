/**
 * Code around a cited line, read from git at the commit a map or quiz was made at, so it stays right after the branch
 * moves on. Shared by architecture maps (`blueprint-excerpt`) and quizzes (`quiz-excerpt`).
 */

import * as path from "node:path";
import {
	BLUEPRINT_EXCERPT_CONTEXT,
	BLUEPRINT_EXCERPT_MAX_LINES,
	BLUEPRINT_EXCERPT_MAX_RANGES,
	type BlueprintExcerpt,
	type BlueprintExcerptRef,
} from "@oh-my-pi/pi-wire/blueprint";
import { readBlob } from "./companion-blueprint-git";
import { normalizeRepoPath, pool, type Side } from "./companion-citations";

/** References one excerpt request may carry (the HTML export asks for every ref of a map at once). */
export const MAX_EXCERPT_REFS = 20_000;
const EXCERPT_CONCURRENCY = 8;
const MAX_EXCERPT_LINE_CHARS = 400;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	mts: "ts",
	cts: "ts",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	rs: "rs",
	sol: "sol",
	nr: "noir",
	py: "py",
	go: "go",
	java: "java",
	kt: "kt",
	swift: "swift",
	rb: "rb",
	php: "php",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "cs",
	json: "json",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	md: "md",
	html: "html",
	css: "css",
	sh: "sh",
	sql: "sql",
};

/** Language of a path for highlighting, from its extension. */
export function languageOf(file: string): string | undefined {
	const ext = path.posix.extname(file).slice(1).toLowerCase();
	return Object.hasOwn(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : undefined;
}

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** Lines of a file as git shows them: the empty piece after a final newline is not a line. */
function lineCount(lines: readonly string[]): number {
	return lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** Whole numbers only: a range with a fraction, `NaN`, a string or a missing end is not a range. */
function isLineNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * The lines (1-based, inclusive) an excerpt of a cited line holds: the default window around it, or the range asked for
 * as `from`/`to`. A range is widened to hold the cited line, cut to the file (`from` < 1 starts at the top, `to` past
 * the end stops at the last line) and then to {@link BLUEPRINT_EXCERPT_MAX_LINES}, keeping the first line asked for
 * unless that would lose the cited line. One that is not a pair of whole numbers with `from <= to` is ignored: the default
 * window, as for a request with no range.
 * @param total lines in the file; the cited line is within `1..total`.
 */
export function excerptRange(
	total: number,
	line: number,
	range?: { from?: unknown; to?: unknown },
): { start: number; end: number } {
	const { from, to } = range ?? {};
	if (!isLineNumber(from) || !isLineNumber(to) || from > to) {
		return {
			start: Math.max(1, line - BLUEPRINT_EXCERPT_CONTEXT),
			end: Math.min(total, line + BLUEPRINT_EXCERPT_CONTEXT),
		};
	}
	const start = Math.max(1, Math.min(from, line));
	const end = Math.min(total, Math.max(to, line));
	if (end - start + 1 <= BLUEPRINT_EXCERPT_MAX_LINES) return { start, end };
	// Too long: keep the top of the request, unless that would lose the cited line.
	const top = Math.max(start, line - BLUEPRINT_EXCERPT_MAX_LINES + 1);
	return { start: top, end: top + BLUEPRINT_EXCERPT_MAX_LINES - 1 };
}

/**
 * Lines around a cited line, as {@link BlueprintExcerpt} (with the file's line count as `total`); null when the line
 * is not in the file. `ref.from`/`ref.to` ask for a wider range, see {@link excerptRange}.
 */
export function excerptOf(
	lines: readonly string[],
	ref: { path: string; line: number; from?: unknown; to?: unknown },
	side: Side,
	commit: string,
): BlueprintExcerpt | null {
	const total = lineCount(lines);
	if (ref.line < 1 || ref.line > total) return null;
	const { start, end } = excerptRange(total, ref.line, ref);
	return {
		path: ref.path,
		start,
		lines: lines
			.slice(start - 1, end)
			.map(line => (line.length > MAX_EXCERPT_LINE_CHARS ? `${line.slice(0, MAX_EXCERPT_LINE_CHARS - 1)}…` : line)),
		line: ref.line,
		side,
		commit,
		language: languageOf(ref.path),
		total,
	};
}

/**
 * Refuses a request with more than {@link BLUEPRINT_EXCERPT_MAX_RANGES} refs asking for a range (a malformed range
 * counts: it is still a request for more), so a reply holds at most that many long excerpts.
 * @throws Error when there are more.
 */
export function assertRangeBudget(refs: readonly (BlueprintExcerptRef | undefined)[]): void {
	if (refs.filter(ref => ref?.from !== undefined || ref?.to !== undefined).length > BLUEPRINT_EXCERPT_MAX_RANGES)
		throw new Error("too many ranges");
}

/**
 * The excerpt of each ref in the repository at `root`, in the order of `refs`; null for a ref the commit does not have
 * (a bad path, a missing file, a line past the end). `commits.base` serves refs with `side: "base"`.
 * A ref may ask for a range of lines, see {@link excerptRange}.
 * @throws Error when there are more than {@link MAX_EXCERPT_REFS} refs, or too many ask for a range ({@link assertRangeBudget}).
 */
export async function readExcerpts(
	root: string,
	commits: { head: string; base?: string },
	refs: readonly BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	if (refs.length > MAX_EXCERPT_REFS) throw new Error("too many references");
	assertRangeBudget(refs);
	const files = new Map<string, Promise<string[] | null>>();
	const read = (commit: string, file: string): Promise<string[] | null> => {
		const key = `${commit}\0${file}`;
		let cached = files.get(key);
		if (!cached) {
			cached = readBlob(root, commit, file).then(text => (text === null ? null : splitLines(text)));
			files.set(key, cached);
		}
		return cached;
	};
	const wanted = refs.map(ref => {
		const file = normalizeRepoPath(ref?.path);
		const side: Side = ref?.side === "base" ? "base" : "head";
		const commit = side === "base" ? commits.base : commits.head;
		const line = typeof ref?.line === "number" && Number.isSafeInteger(ref.line) ? ref.line : 0;
		return file === undefined || commit === undefined
			? null
			: { file, side, commit, line, from: ref.from, to: ref.to };
	});
	// Warm the cache a few files at a time; the answers below then only slice.
	const unique = [...new Map(wanted.flatMap(w => (w ? [[`${w.commit}\0${w.file}`, w] as const] : []))).values()];
	await pool(unique, EXCERPT_CONCURRENCY, async item => {
		await read(item.commit, item.file);
	});
	return await Promise.all(
		wanted.map(async w => {
			if (w === null) return null;
			const lines = await read(w.commit, w.file);
			return lines === null
				? null
				: excerptOf(lines, { path: w.file, line: w.line, from: w.from, to: w.to }, w.side, w.commit);
		}),
	);
}
