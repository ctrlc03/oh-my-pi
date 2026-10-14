/**
 * Code around a cited line, read from git at the commit a map or quiz was made at, so it stays right after the branch
 * moves on. Shared by architecture maps (`blueprint-excerpt`) and quizzes (`quiz-excerpt`).
 */

import * as path from "node:path";
import { BLUEPRINT_EXCERPT_CONTEXT, type BlueprintExcerpt, type BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
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

/** Lines around a cited line, as {@link BlueprintExcerpt}; null when the line is not in the file. */
export function excerptOf(
	lines: readonly string[],
	ref: { path: string; line: number },
	side: Side,
	commit: string,
): BlueprintExcerpt | null {
	if (ref.line < 1 || ref.line > lines.length) return null;
	const start = Math.max(1, ref.line - BLUEPRINT_EXCERPT_CONTEXT);
	const end = Math.min(lines.length, ref.line + BLUEPRINT_EXCERPT_CONTEXT);
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
	};
}

/**
 * The excerpt of each ref in the repository at `root`, in the order of `refs`; null for a ref the commit does not have
 * (a bad path, a missing file, a line past the end). `commits.base` serves refs with `side: "base"`.
 * @throws Error when there are more than {@link MAX_EXCERPT_REFS} refs.
 */
export async function readExcerpts(
	root: string,
	commits: { head: string; base?: string },
	refs: readonly BlueprintRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	if (refs.length > MAX_EXCERPT_REFS) throw new Error("too many references");
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
		return file === undefined || commit === undefined ? null : { file, side, commit, line };
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
			return lines === null ? null : excerptOf(lines, { path: w.file, line: w.line }, w.side, w.commit);
		}),
	);
}
