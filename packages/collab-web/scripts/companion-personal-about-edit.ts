/**
 * Line-level edits of the About-you file for a proposal (`add` a line under a section, `replace` or `remove`
 * a line) and the diff the app shows. Pure text in, text out: the caller writes the file (and its history)
 * through the About store. A proposal is one bullet at a time, never a rewrite, so the owner can read the
 * whole change at a glance.
 */

import type { PersonalDiffLine } from "@oh-my-pi/pi-wire/personal";
import type { PersonalProposalDraft } from "@oh-my-pi/pi-wire/personal-ipc";

/** Lines of context kept around a change in the diff. */
const DIFF_CONTEXT = 2;

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const EMPTY_BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s*$/;

/** A line without its indent and list marker, trimmed: what a `target` is compared on. */
export function lineText(line: string): string {
	const bullet = BULLET_RE.exec(line);
	return (bullet ? bullet[2] : line).trim();
}

/** A section name as typed (`## How I like to work`, `How I like to work:`) folded for comparison. */
function sectionKey(name: string): string {
	return name
		.replace(/^#+\s*/, "")
		.replace(/:\s*$/, "")
		.trim()
		.toLowerCase();
}

/** Text of a proposed line: no list marker, one line. */
export function cleanLine(text: string): string {
	return lineText(text.replace(/\s*\n\s*/g, " "));
}

/** The shape of one change to the lines of the file: remove `remove` lines at `at`, then insert `insert` there. */
export interface LineChange {
	at: number;
	remove: number;
	insert: string[];
}

type Draft = Pick<PersonalProposalDraft, "op" | "section" | "target">;

function headings(lines: readonly string[]): { index: number; level: number; key: string }[] {
	const found: { index: number; level: number; key: string }[] = [];
	lines.forEach((line, index) => {
		const match = HEADING_RE.exec(line);
		if (match) found.push({ index, level: match[1].length, key: sectionKey(match[2]) });
	});
	return found;
}

/** Index range `[start, end)` of the body of the section named `name`, or undefined when there is none. */
function sectionBody(
	lines: readonly string[],
	name: string,
): { start: number; end: number; level: number } | undefined {
	const all = headings(lines);
	const key = sectionKey(name);
	const at = all.findIndex(h => h.key === key);
	if (at === -1) return undefined;
	const { index, level } = all[at];
	const next = all.slice(at + 1).find(h => h.level <= level);
	return { start: index + 1, end: next === undefined ? lines.length : next.index, level };
}

function findLine(lines: readonly string[], target: string, within?: { start: number; end: number }): number {
	const wanted = lineText(target);
	if (wanted === "") return -1;
	const inRange = (i: number): boolean => within === undefined || (i >= within.start && i < within.end);
	const hit = lines.findIndex((line, i) => inRange(i) && lineText(line) === wanted);
	return hit !== -1 || within === undefined ? hit : lines.findIndex(line => lineText(line) === wanted);
}

/**
 * Where and how `draft` (with `text` as the line to add or the replacement) changes `lines`.
 * undefined: the target line is gone (stale). An empty `insert` with `remove` 0: nothing to change (the line is already there).
 */
export function planChange(lines: readonly string[], draft: Draft, text: string): LineChange | undefined {
	if (draft.op === "add") {
		const section = draft.section;
		if (section === undefined) return undefined;
		const body = sectionBody(lines, section);
		if (body === undefined) {
			// The section does not exist yet: it goes at the end of the file.
			const end = lines.length;
			const title = section
				.replace(/^#+\s*/, "")
				.replace(/:\s*$/, "")
				.trim();
			return {
				at: end,
				remove: 0,
				insert: [...(end > 0 && lines[end - 1] !== "" ? [""] : []), `## ${title}`, "", `- ${text}`],
			};
		}
		let last = body.end - 1;
		while (last >= body.start && lines[last].trim() === "") last--;
		if (lines.slice(body.start, last + 1).some(line => lineText(line) === text))
			return { at: body.end, remove: 0, insert: [] };
		// The template's empty `- ` placeholder gives way to the first real line.
		if (last >= body.start && EMPTY_BULLET_RE.test(lines[last]))
			return { at: last, remove: 1, insert: [`- ${text}`] };
		return { at: last + 1, remove: 0, insert: [`- ${text}`] };
	}
	if (draft.target === undefined) return undefined;
	const within = draft.section === undefined ? undefined : sectionBody(lines, draft.section);
	const hit = findLine(lines, draft.target, within);
	if (hit === -1) return undefined;
	if (draft.op === "remove") return { at: hit, remove: 1, insert: [] };
	const bullet = BULLET_RE.exec(lines[hit]);
	return { at: hit, remove: 1, insert: [`${bullet ? bullet[1] : ""}${text}`] };
}

/** `text` after `change`; the file's trailing newline stays as it was. */
export function applyChange(text: string, change: LineChange): string {
	const trailing = text.endsWith("\n");
	const lines = (trailing ? text.slice(0, -1) : text).split("\n");
	lines.splice(change.at, change.remove, ...change.insert);
	return lines.join("\n") + (trailing || text === "" ? "\n" : "");
}

/** The lines of `text` with the trailing newline's empty element dropped. */
export function textLines(text: string): string[] {
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Context lines around `change` with the change marked; for a stale target, the line the owner would have seen removed. */
export function diffLines(
	lines: readonly string[],
	change: LineChange | undefined,
	draft: Draft,
	text: string,
): PersonalDiffLine[] {
	if (change === undefined) {
		const gone: PersonalDiffLine[] = draft.target === undefined ? [] : [{ op: "del", text: draft.target }];
		return draft.op === "replace" ? [...gone, { op: "add", text }] : gone;
	}
	if (change.remove === 0 && change.insert.length === 0) return [];
	const from = Math.max(0, change.at - DIFF_CONTEXT);
	const to = Math.min(lines.length, change.at + change.remove + DIFF_CONTEXT);
	return [
		...lines.slice(from, change.at).map((line): PersonalDiffLine => ({ op: "keep", text: line })),
		...lines.slice(change.at, change.at + change.remove).map((line): PersonalDiffLine => ({ op: "del", text: line })),
		...change.insert.map((line): PersonalDiffLine => ({ op: "add", text: line })),
		...lines.slice(change.at + change.remove, to).map((line): PersonalDiffLine => ({ op: "keep", text: line })),
	];
}
