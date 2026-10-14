/**
 * Citations an agent writes, shared by architecture maps (./companion-blueprint-verify) and quizzes
 * (./companion-quiz-verify): parsing `path@line@token` into the wire shape, and checking a citation against the
 * commit it names. Pure over a file reader, so the rules are testable without git.
 *
 * A citation `path@line@token` holds when `token` is on that line of `path` at the commit. When it is not, but the
 * token occurs on exactly one line of the file (or on exactly one line near the cited one), the citation moves there;
 * otherwise it is dropped with a warning.
 */

import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { isRecord } from "../src/tool-render/util";

export const MAX_TOKEN_CHARS = 200;
const MAX_PATH_CHARS = 1024;
const MAX_REFS_PER_ITEM = 6;
/** A citation whose line is wrong moves to the one place its token appears within this many lines of it. */
const NEAR_LINES = 20;
/** Warnings of one kind listed before the rest are only counted. */
const WARNINGS_PER_KIND = 12;

export type Side = "head" | "base";

/** Collects warnings in plain words, listing a few per kind and counting the rest. */
export class Warnings {
	readonly #kinds = new Map<string, { shown: string[]; more: number; summary: (more: number) => string }>();

	add(kind: string, message: string, summary: (more: number) => string): void {
		let entry = this.#kinds.get(kind);
		if (!entry) {
			entry = { shown: [], more: 0, summary };
			this.#kinds.set(kind, entry);
		}
		if (entry.shown.length < WARNINGS_PER_KIND) entry.shown.push(message);
		else entry.more++;
	}

	list(): string[] {
		return [...this.#kinds.values()].flatMap(entry => [
			...entry.shown,
			...(entry.more > 0 ? [entry.summary(entry.more)] : []),
		]);
	}
}

/** A trimmed, length-capped string, or undefined when `value` is not a string or is blank. */
export function str(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A repository-relative path with "/" separators; undefined for an absolute path, one that leaves the repository, or the root itself. */
export function normalizeRepoPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_PATH_CHARS || value.includes("\0")) return undefined;
	const segments: string[] = [];
	for (const segment of value.replaceAll("\\", "/").split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return undefined;
		segments.push(segment);
	}
	if (value.startsWith("/") || segments.length === 0) return undefined;
	return segments.join("/");
}

/**
 * `path@line@token`, or `base:path@line@token` for the base commit of a diff: the path ends at the first
 * `@<digits>@`; the token is the rest (it may contain `@`, as a decorator does).
 */
export function parseRefText(text: string): BlueprintRef | undefined {
	const trimmed = text.trim();
	const side = trimmed.startsWith("base:") ? "base" : undefined;
	const match = /^(.+?)@(\d+)@(.+)$/s.exec(side ? trimmed.slice("base:".length) : trimmed);
	if (!match) return undefined;
	const path = normalizeRepoPath(match[1]);
	const token = match[3]!.trim();
	const line = Number(match[2]);
	if (path === undefined || token === "" || token.length > MAX_TOKEN_CHARS || !Number.isSafeInteger(line) || line < 1)
		return undefined;
	return { path, line, token, ...(side ? { side } : {}) };
}

function parseRef(value: unknown): BlueprintRef | undefined {
	if (typeof value === "string") return parseRefText(value);
	if (!isRecord(value)) return undefined;
	const path = normalizeRepoPath(value.path);
	const token = typeof value.token === "string" ? value.token.trim() : "";
	const line = typeof value.line === "number" ? value.line : Number(value.line);
	if (path === undefined || token === "" || token.length > MAX_TOKEN_CHARS || token.includes("\n")) return undefined;
	if (!Number.isSafeInteger(line) || line < 1) return undefined;
	return { path, line, token, ...(value.side === "base" ? { side: "base" as const } : {}) };
}

/** The citations in a list the agent wrote (each an object or a `path@line@token` string), deduplicated and capped. */
export function parseRefs(value: unknown): BlueprintRef[] {
	if (!Array.isArray(value)) return [];
	const refs: BlueprintRef[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		const ref = parseRef(raw);
		if (!ref) continue;
		const key = `${ref.side ?? "head"}\0${ref.path}\0${ref.line}\0${ref.token}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push(ref);
		if (refs.length >= MAX_REFS_PER_ITEM) break;
	}
	return refs;
}

/** Run `work` over `items` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await work(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface CitationStats {
	verified: number;
	moved: number;
	dropped: number;
}

/** The file key {@link readCitedFiles} stores a file under. */
export function fileKey(side: Side, path: string): string {
	return `${side}\0${path}`;
}

/** Read each file the citations name once, a few at a time: lines by {@link fileKey}, null for a file that cannot be read. */
export async function readCitedFiles(
	wanted: Iterable<{ side: Side; path: string }>,
	lines: (side: Side, path: string) => Promise<string[] | null>,
	concurrency = 8,
): Promise<Map<string, string[] | null>> {
	const unique = new Map<string, { side: Side; path: string }>();
	for (const item of wanted) unique.set(fileKey(item.side, item.path), item);
	const files = new Map<string, string[] | null>();
	await pool([...unique.values()], concurrency, async ({ side, path }) => {
		files.set(fileKey(side, path), await lines(side, path));
	});
	return files;
}

/**
 * The citations of `refs` that hold at their commit, with moved ones corrected and repeated ones removed, counting
 * what happened in `stats` and describing each drop in `warnings` (`where` says what the citation belonged to).
 * `sideOf` says which commit a citation reads; `files` is {@link readCitedFiles}' result.
 */
export function checkCitations(
	refs: readonly BlueprintRef[],
	where: string,
	sideOf: (ref: BlueprintRef) => Side,
	files: ReadonlyMap<string, string[] | null>,
	stats: CitationStats,
	warnings: Warnings,
): BlueprintRef[] {
	const kept: BlueprintRef[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const side = sideOf(ref);
		const lines = files.get(fileKey(side, ref.path));
		const cite = `${ref.path}@${ref.line}@${ref.token}`;
		const dropped = (why: string): void => {
			stats.dropped++;
			warnings.add("ref", `Dropped citation ${cite} (${where}): ${why}.`, n => `${n} more citations were dropped.`);
		};
		if (!lines) {
			dropped("the file is not readable at that commit");
			continue;
		}
		let line = ref.line;
		if (lines[line - 1]?.includes(ref.token)) {
			stats.verified++;
		} else {
			const hits: number[] = [];
			for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(ref.token)) hits.push(i + 1);
			const near = hits.filter(hit => Math.abs(hit - line) <= NEAR_LINES);
			const target = hits.length === 1 ? hits[0] : near.length === 1 ? near[0] : undefined;
			if (target === undefined) {
				dropped(
					hits.length === 0
						? "the token is not in the file"
						: `the token is not on that line and appears on ${hits.length} lines, none clearly the one meant`,
				);
				continue;
			}
			line = target;
			stats.moved++;
		}
		const fixed: BlueprintRef = { path: ref.path, line, token: ref.token, ...(side === "base" ? { side } : {}) };
		const key = `${side}\0${ref.path}\0${line}\0${ref.token}`;
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(fixed);
	}
	return kept;
}
