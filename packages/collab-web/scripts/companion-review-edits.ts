/**
 * What the agent said when it changed the code, for the review board's "reasoning" column: the successful edits of a
 * session with the assistant text that came right before each, and the mapping of those edits to the hunks of a diff.
 *
 * An edit is what `src/lib/changes.ts` `collectChanges` counts as one: a successful `edit`, `apply_patch` or `write`
 * call (also when dispatched as `write xd://<tool>`) and an `ast_edit` that a later `resolve` applied. Its words are the
 * text blocks of its assistant message that precede the call (thinking is left out); when the message has none, the
 * latest assistant text since the prompt. The lines it added and removed come from the call's own result diff
 * (`details.perFileResults[].diff`), else from the call's input.
 *
 * An edit explains a hunk when the lines it added overlap the lines the hunk added (a pure deletion: the lines removed),
 * compared trimmed, ignoring blank lines ({@link explainHunks}).
 */

import * as path from "node:path";
import type { HunkNote } from "../src/lib/review-board";
import { inputPaths, isRecord, str } from "../src/tool-render/util";
import { callPaths } from "./companion-file-sessions";
import { type LineChange, parseLineChanges } from "./companion-attribution-lines";
import { isInside } from "./companion-git";

/** Longest note text: a few sentences. */
export const NOTE_CHARS = 800;
/** Assistant messages of the current turn kept, newest first, to find text for a call whose message has none. */
const RECENT_MESSAGES = 8;
const EDIT_TOOLS: Record<string, true> = { edit: true, apply_patch: true };
/** `xd://…`, `local://…`: tool devices and harness storage, not project files. */
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
export const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
/** A line of an omp edit result: ` 12|kept`, `-12|removed`, `+12|added` (`ast_edit` previews use `│`). */
const RESULT_LINE_RE = /^([+\- ])\s*\d+\s*[|│](.*)$/;
const AST_FILE_RE = /^##\s+(.+?)(?:\s+\(\d+ replacements?\))?$/;
const AST_DIR_RE = /^#\s+(.+?)\/?$/;

// ── text ─────────────────────────────────────────────────────────────────────

/** `text` cut to `max` characters at the end of a sentence, else a word, with an ellipsis. */
export function capText(text: string, max = NOTE_CHARS): string {
	const clean = text.replace(/\r\n/g, "\n").trim();
	if (clean.length <= max) return clean;
	const head = clean.slice(0, max);
	let cut = -1;
	for (const match of head.matchAll(/[.!?](?=\s|$)/g)) cut = match.index + 1;
	// A sentence end very early would throw most of the text away.
	if (cut < max * 0.4) cut = head.search(/\s\S*$/);
	if (cut < max * 0.4) cut = max;
	const body = head.slice(0, cut).trimEnd();
	return /[.!?]$/.test(body) ? body : `${body}…`;
}

/** The text blocks of `blocks[from, to)`, joined; thinking and every other block type are skipped. */
function textOf(blocks: readonly unknown[], from: number, to: number): string {
	const parts: string[] = [];
	for (let i = from; i < to; i++) {
		const block = blocks[i];
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
			parts.push(block.text.trim());
		}
	}
	return parts.join("\n\n");
}

/**
 * What the assistant wrote before the tool call at `index` of its message: the text since the previous call in the
 * message, else all the text before this call. Empty when it wrote none.
 */
export function textBefore(blocks: readonly unknown[], index: number): string {
	let start = index;
	while (
		start > 0 &&
		!(isRecord(blocks[start - 1]) && (blocks[start - 1] as Record<string, unknown>).type === "toolCall")
	) {
		start--;
	}
	return textOf(blocks, start, index) || textOf(blocks, 0, index);
}

// ── diff lines ───────────────────────────────────────────────────────────────

/** A line compared without its indentation; blank lines count for nothing. */
function normalized(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed !== "") out.push(trimmed);
	}
	return out;
}

/** Lines of a diff that carry no meaning alone: nothing but brackets and punctuation (`}`, `);`). */
function isTrivial(line: string): boolean {
	return !/[\p{L}\p{N}_]/u.test(line);
}

/** The lines a diff added and removed, normalized. Reads git's unified diff and omp's edit result (`+12|text`). */
export function changedLines(diff: string): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	const unified = /^(?:@@ |diff --git )/m.test(diff);
	let inHunk = !unified;
	for (const line of diff.split("\n")) {
		if (unified) {
			if (line.startsWith("@@")) inHunk = true;
			else if (line.startsWith("diff --git ")) inHunk = false;
			if (!inHunk || line.startsWith("@@")) continue;
			if (line.startsWith("+")) added.push(line.slice(1));
			else if (line.startsWith("-")) removed.push(line.slice(1));
			continue;
		}
		const match = RESULT_LINE_RE.exec(line);
		if (match?.[1] === "+") added.push(match[2]!);
		else if (match?.[1] === "-") removed.push(match[2]!);
	}
	return { added: normalized(added), removed: normalized(removed) };
}

/** The lines a call's input says to add or remove: hashline `+` rows, apply_patch `+`/`-` lines. */
function inputLines(input: string): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	for (const line of input.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
	}
	return { added: normalized(added), removed: normalized(removed) };
}

/** One hunk of the subject's diff, with what it added and removed. */
export interface HunkLines {
	path: string;
	/** `@@ -a,b +c,d @@`: the anchor notes carry. */
	hunk: string;
	added: string[];
	removed: string[];
}

/** The hunks of one file's diff. A diff with none (binary, mode change) has no hunks. */
export function fileHunks(filePath: string, diff: string): HunkLines[] {
	const hunks: HunkLines[] = [];
	let current: { added: string[]; removed: string[] } | null = null;
	for (const line of diff.split("\n")) {
		const header = HUNK_HEADER_RE.exec(line);
		if (header) {
			current = { added: [], removed: [] };
			hunks.push({ path: filePath, hunk: header[0], added: current.added, removed: current.removed });
		} else if (line.startsWith("diff --git ")) {
			current = null;
		} else if (current !== null) {
			if (line.startsWith("+")) current.added.push(line.slice(1));
			else if (line.startsWith("-")) current.removed.push(line.slice(1));
		}
	}
	return hunks.map(hunk => ({ ...hunk, added: normalized(hunk.added), removed: normalized(hunk.removed) }));
}

// ── edits of a session ───────────────────────────────────────────────────────

/** One successful change a session made to a file of the subject. */
export interface SessionEdit {
	sessionId: string;
	sessionTitle: string | null;
	/** 1-based prompt turn; 0 for an edit before the first prompt. */
	turn: number;
	/** Entry id of the turn's prompt (what `turn-diff` takes); empty before the first prompt. */
	turnId: string;
	/** Epoch ms of the call; 0 when the entry has no timestamp. */
	at: number;
	/** The subject's path of the file. */
	path: string;
	/** What the assistant wrote before the call; empty when it wrote nothing. */
	text: string;
	intent?: string;
	/** The model that made the call; absent when the entry does not say. */
	model?: string;
	/** The turn's prompt, whitespace collapsed and cut ({@link PROMPT_CHARS}); empty when it has no text. */
	prompt?: string;
	/** Normalized lines the edit added and removed. */
	added: string[];
	removed: string[];
	/** What the call replaced, by line (line attribution); absent when its result did not say. */
	changes?: LineChange[];
	/** The call wrote the whole file, so `changes` is all of it. */
	rewrite?: boolean;
}

/** A prompt of a session: what opens a turn. */
export interface PromptTurn {
	/** Entry id of the prompt. */
	id: string;
	/** 1-based. */
	turn: number;
	/** Epoch ms; 0 when the entry has no timestamp. */
	at: number;
	/** The prompt's first words (see {@link SessionEdit.prompt}). */
	prompt?: string;
}

/**
 * `edits` of a subagent's session moved into the turns of the session that started it: each belongs to the turn that was
 * running when the edit was made (the last prompt at or before it; the first turn for an edit before them all). With
 * no turns the edits are returned as they are.
 */
export function placeInTurns(edits: readonly SessionEdit[], turns: readonly PromptTurn[]): SessionEdit[] {
	if (turns.length === 0) return [...edits];
	return edits.map(edit => {
		let turn = turns[0]!;
		for (const candidate of turns) if (candidate.at <= edit.at) turn = candidate;
		return { ...edit, turn: turn.turn, turnId: turn.id, ...(turn.prompt ? { prompt: turn.prompt } : {}) };
	});
}

export interface ScanScope {
	sessionId: string;
	sessionTitle: string | null;
	/** The session's working directory as its header spells it, and with symlinks resolved. */
	cwd: string;
	realCwd: string;
	/** The repository's checkouts (primary and linked worktrees), symlinks resolved. */
	roots: readonly string[];
	/** The subject's files by the repo-relative path an edit may have used (a renamed file also by its old name). */
	files: ReadonlyMap<string, string>;
}

/** A call waiting for its result. */
interface PendingCall {
	name: string;
	args: Record<string, unknown>;
	text: string;
	intent?: string;
	model?: string;
	prompt: string;
	at: number;
	turn: number;
	turnId: string;
}

/** What one call changed in one file. */
interface FileEdit {
	path: string;
	lines: { added: string[]; removed: string[] };
	changes?: LineChange[];
	rewrite?: boolean;
}

function isFilePath(value: string | null): value is string {
	return value !== null && value.length > 0 && !URI_RE.test(value);
}

/** The files an `edit` / `apply_patch` call changed with what it added and removed, as `collectChanges` counts them. */
function editedFiles(args: Record<string, unknown>, details: Record<string, unknown>): FileEdit[] {
	const input = str(args.input) ?? str(args._input);
	const named = input ? inputPaths(input) : [];
	const argPath = str(args.file_path) ?? str(args.path);
	if (argPath) named.push(argPath);
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			const editPath = isRecord(edit) ? str(edit.path) : null;
			if (editPath) named.push(editPath);
		}
	}
	const reported = Array.isArray(details.perFileResults) ? details.perFileResults.filter(isRecord) : [details];
	const files: FileEdit[] = [];
	reported.forEach((file, i) => {
		if (file.isError === true) return;
		const filePath = str(file.path) ?? named[i] ?? null;
		const diff = str(file.diff);
		if (isFilePath(filePath) && diff) {
			files.push({ path: filePath, lines: changedLines(diff), changes: parseLineChanges(diff) });
		}
	});
	// A result without a diff: a call on one file says what it adds in its own input.
	if (files.length === 0 && input && new Set(named).size === 1 && isFilePath(named[0] ?? null)) {
		files.push({ path: named[0]!, lines: inputLines(input) });
	}
	return files;
}

/** The files of an `ast_edit` preview with the lines it shows as added and removed. */
function astEditedFiles(details: Record<string, unknown>): FileEdit[] {
	if (!Array.isArray(details.fileReplacements)) return [];
	const paths = details.fileReplacements
		.map(replacement => (isRecord(replacement) ? str(replacement.path) : null))
		.filter(isFilePath);
	const preview = typeof details.displayContent === "string" ? details.displayContent : "";
	const byPath = new Map<string, string[]>();
	let dir = "";
	let current: string[] | null = null;
	for (const line of preview.split("\n")) {
		const file = AST_FILE_RE.exec(line);
		if (file) {
			const name = dir ? `${dir}/${file[1]}` : file[1]!;
			const found = paths.find(p => p === name || p.endsWith(`/${file[1]}`) || p === file[1]);
			let lines: string[] | undefined;
			if (found !== undefined) {
				lines = byPath.get(found);
				if (lines === undefined) byPath.set(found, (lines = []));
			}
			current = lines ?? null;
			continue;
		}
		const directory = AST_DIR_RE.exec(line);
		if (directory && !line.startsWith("##")) {
			dir = directory[1]!;
			current = null;
			continue;
		}
		if (current !== null && RESULT_LINE_RE.test(line)) current.push(line);
	}
	return [...byPath].map(([filePath, lines]) => ({ path: filePath, lines: changedLines(lines.join("\n")) }));
}

/** The tool a successful `write xd://<tool>` call ran, with its own args and details. */
function xdevDispatch(
	name: string,
	result: Record<string, unknown>,
): { tool: string; args: Record<string, unknown>; details: Record<string, unknown> } | null {
	if (name !== "write" || !isRecord(result.details)) return null;
	const xdev = result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return {
		tool: xdev.tool,
		args: isRecord(xdev.args) ? xdev.args : {},
		details: isRecord(xdev.inner) ? xdev.inner : {},
	};
}

function timestampOf(entry: Record<string, unknown>): number {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** Longest prompt kept on an edit: the first words are enough to tell turns apart. */
export const PROMPT_CHARS = 120;

/** A prompt entry's text with whitespace collapsed, cut at {@link PROMPT_CHARS} on a word with an ellipsis. */
function promptWords(entry: Record<string, unknown>): string {
	const message = isRecord(entry.message) ? entry.message : null;
	const content = message === null ? entry.content : message.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? textOf(content, 0, content.length) : "";
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= PROMPT_CHARS) return clean;
	const cut = clean.lastIndexOf(" ", PROMPT_CHARS);
	return `${clean.slice(0, cut > PROMPT_CHARS * 0.5 ? cut : PROMPT_CHARS).trimEnd()}…`;
}

function parseLine(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * The edits a session made to the scope's files, oldest first. `lines` are the session file's lines, streamed; a line
 * is only parsed when it can matter (a prompt, a call that names one of the files or may apply an `ast_edit`, the
 * result of a call waiting for its result).
 */
export async function scanSessionEdits(
	lines: AsyncIterable<string> | Iterable<string>,
	scope: ScanScope,
	/** Receives the session's prompts as the scan finds them (the turns of a subagent's edits are looked up in them). */
	turns?: PromptTurn[],
): Promise<SessionEdit[]> {
	const needles = [...new Set([...scope.files.keys()].map(file => path.basename(file)))];
	const mayMatch = (line: string) =>
		line.includes("ast_edit") ||
		line.includes("resolve") ||
		line.includes("reject") ||
		line.includes("xd://") ||
		needles.some(needle => line.includes(needle));
	const edits: SessionEdit[] = [];
	const pending = new Map<string, PendingCall>();
	/** The `ast_edit` preview a `resolve` may still apply. */
	let staged: { call: PendingCall; files: FileEdit[] } | null = null;
	let turn = 0;
	let turnId = "";
	let turnPrompt = "";
	/** Raw assistant lines of the current turn, newest first. */
	let recent: string[] = [];

	const boardPath = (callPath: string): string | null => {
		let abs = path.resolve(scope.cwd, callPath);
		if (scope.realCwd !== scope.cwd && isInside(scope.cwd, abs))
			abs = path.join(scope.realCwd, path.relative(scope.cwd, abs));
		for (const root of scope.roots) {
			if (!isInside(root, abs)) continue;
			return scope.files.get(path.relative(root, abs).split(path.sep).join("/")) ?? null;
		}
		return null;
	};
	const record = (call: PendingCall, files: readonly FileEdit[]): void => {
		for (const file of files) {
			const target = boardPath(file.path);
			if (target === null) continue;
			edits.push({
				sessionId: scope.sessionId,
				sessionTitle: scope.sessionTitle,
				turn: call.turn,
				turnId: call.turnId,
				at: call.at,
				path: target,
				text: call.text,
				...(call.intent ? { intent: call.intent } : {}),
				...(call.model ? { model: call.model } : {}),
				...(call.prompt ? { prompt: call.prompt } : {}),
				added: file.lines.added,
				removed: file.lines.removed,
				...(file.changes ? { changes: file.changes } : {}),
				...(file.rewrite ? { rewrite: true } : {}),
			});
		}
	};
	/** The latest assistant text of the turn, for a call whose own message wrote none. */
	const recentText = (): string => {
		for (const raw of recent) {
			const message = parseLine(raw)?.message;
			if (!isRecord(message) || !Array.isArray(message.content)) continue;
			const text = textOf(message.content, 0, message.content.length);
			if (text) return text;
		}
		return "";
	};

	for await (const line of lines) {
		if (line.includes('"role":"user"') || line.includes('"collab-prompt"')) {
			const entry = parseLine(line);
			const prompt =
				entry !== null &&
				((entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") ||
					(entry.type === "custom_message" && entry.customType === "collab-prompt"));
			if (prompt) {
				turn++;
				turnId = typeof entry.id === "string" ? entry.id : "";
				turnPrompt = promptWords(entry);
				turns?.push({ id: turnId, turn, at: timestampOf(entry), ...(turnPrompt ? { prompt: turnPrompt } : {}) });
				recent = [];
			}
			continue;
		}
		if (line.includes('"role":"assistant"')) {
			if (!line.includes('"toolCall"') || !mayMatch(line)) {
				recent.unshift(line);
				recent.length = Math.min(recent.length, RECENT_MESSAGES);
				continue;
			}
			const entry = parseLine(line);
			const message = entry !== null && isRecord(entry.message) ? entry.message : null;
			if (entry === null || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			const blocks: unknown[] = message.content;
			blocks.forEach((block, index) => {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") return;
				const name = str(block.name) ?? "";
				const args = isRecord(block.arguments) ? block.arguments : {};
				const relevant =
					name === "ast_edit" ||
					name === "resolve" ||
					name === "reject" ||
					(name === "write" && (str(args.path) ?? str(args.file_path) ?? "").startsWith("xd://")) ||
					((EDIT_TOOLS[name] === true || name === "write") &&
						callPaths(name, args).some(p => boardPath(p) !== null));
				if (!relevant) return;
				const intent = (str(block.intent) ?? str(args.i))?.trim();
				const model = str(message.model);
				pending.set(block.id, {
					name,
					args,
					text: textBefore(blocks, index) || recentText(),
					...(intent ? { intent } : {}),
					...(model ? { model } : {}),
					prompt: turnPrompt,
					at: timestampOf(entry),
					turn,
					turnId,
				});
			});
			recent.unshift(line);
			recent.length = Math.min(recent.length, RECENT_MESSAGES);
			continue;
		}
		if (pending.size === 0 || !line.includes('"role":"toolResult"')) continue;
		const id = [...pending.keys()].find(candidate => line.includes(candidate));
		if (id === undefined) continue;
		const message = parseLine(line)?.message;
		if (!isRecord(message) || message.toolCallId !== id) continue;
		const call = pending.get(id)!;
		pending.delete(id);
		if (message.isError === true) continue;
		const xdev = xdevDispatch(call.name, message);
		const name = xdev?.tool ?? call.name;
		const args = xdev?.args ?? call.args;
		const details = xdev?.details ?? (isRecord(message.details) ? message.details : {});
		if (EDIT_TOOLS[name] === true) {
			record(call, editedFiles(args, details));
		} else if (name === "write") {
			const filePath = str(args.file_path) ?? str(args.path);
			const content = str(args.content);
			if (isFilePath(filePath) && content) {
				const written = content.split("\n");
				// A trailing newline ends the last line; it does not start another.
				if (written.at(-1) === "") written.pop();
				record(call, [
					{
						path: filePath,
						lines: { added: normalized(written), removed: [] },
						changes: [{ oldStart: 1, removed: 0, newStart: 1, added: written }],
						rewrite: true,
					},
				]);
			}
		} else if (name === "ast_edit") {
			staged = { call, files: astEditedFiles(details) };
		} else if (name === "resolve" || name === "reject") {
			const action = str(details.action) ?? str(args.action) ?? (name === "reject" ? "discard" : "apply");
			if (staged && action === "apply") record(staged.call, staged.files);
			staged = null;
		}
	}
	return edits;
}

// ── edits → hunks ────────────────────────────────────────────────────────────

/**
 * Whether `edit` lines overlap `hunk` lines: the lines that mean something alone (not `}` or `);`; all of them when a
 * hunk has nothing else) of the smaller side match for at least half, and for one line at least.
 */
export function linesOverlap(hunk: readonly string[], edit: readonly string[]): boolean {
	return overlappingLines(hunk, edit) > 0;
}

/** How many of the lines that mean something in `hunk` and `edit` are the same, when {@link linesOverlap} holds, else 0. */
function overlappingLines(hunk: readonly string[], edit: readonly string[]): number {
	const meaningful = (lines: readonly string[]): Set<string> => {
		const set = new Set(lines);
		const strong = new Set([...set].filter(line => !isTrivial(line)));
		return strong.size > 0 ? strong : set;
	};
	const wanted = meaningful(hunk);
	const given = meaningful(edit);
	if (wanted.size === 0 || given.size === 0) return 0;
	let hits = 0;
	for (const line of wanted) if (given.has(line)) hits++;
	return hits >= Math.max(1, Math.ceil(Math.min(wanted.size, given.size) / 2)) ? hits : 0;
}

/** How many lines of `hunk` `edit` wrote (see {@link editExplainsHunk}); 0 when it did not change it. */
function explainedLines(hunk: HunkLines, edit: SessionEdit): number {
	if (edit.path !== hunk.path) return 0;
	return hunk.added.length > 0
		? overlappingLines(hunk.added, edit.added)
		: overlappingLines(hunk.removed, edit.removed);
}

/** `edit` changed `hunk`: it added some of the lines the hunk added (a pure deletion: removed some of its removed lines). */
export function editExplainsHunk(hunk: HunkLines, edit: SessionEdit): boolean {
	return explainedLines(hunk, edit) > 0;
}

/** A hunk's identity in maps. */
export function hunkId(filePath: string, hunk: string): string {
	return `${filePath}\u0000${hunk}`;
}

/** A quote shorter than this many words says too little to explain a change. */
export const MIN_NOTE_WORDS = 12;
/** Words that say nothing about which change a note is about. */
const FILLER_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"now",
	"then",
	"use",
	"using",
	"add",
	"adding",
	"are",
	"was",
	"not",
	"but",
	"you",
	"its",
	"new",
	"also",
	"when",
	"will",
	"can",
	"need",
	"needs",
	"make",
]);

/** The lowercase words of `text` (camelCase and snake_case split, a plural's `s` dropped), for comparing. */
function wordsOf(text: string): string[] {
	const found =
		text
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/[a-z][a-z0-9]{2,}/g) ?? [];
	return found.map(word => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

/**
 * Whether a session's quote says little about `hunk`: it is only the edit's intent label, or has fewer than
 * {@link MIN_NOTE_WORDS} words, or shares no word with the hunk's path and code (a remark about something else that
 * the same message happened to carry).
 */
export function isWeakNote(
	text: string,
	intent: string | undefined,
	hunk: HunkLines,
	vocabulary: ReadonlySet<string> = hunkVocabulary(hunk),
): boolean {
	const clean = text.trim();
	if (intent && clean.toLowerCase() === intent.trim().toLowerCase()) return true;
	if (clean.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length < MIN_NOTE_WORDS) return true;
	return !wordsOf(clean).some(word => !FILLER_WORDS.has(word) && vocabulary.has(word));
}

/** The words of a hunk's path and code. */
function hunkVocabulary(hunk: HunkLines): Set<string> {
	return new Set(wordsOf([hunk.path, ...hunk.added, ...hunk.removed].join("\n")));
}

/**
 * One note per hunk that some edit explains, quoted from an edit that wrote part of it: the one that wrote most of the
 * hunk (the latest among equals) whose words say something about it, else, when none does, the best of the rest, marked
 * `weak`. A later tweak of a line or two does not speak for a hunk another edit wrote. Hunks no edit explains get none.
 */
export function explainHunks(hunks: readonly HunkLines[], edits: readonly SessionEdit[]): HunkNote[] {
	const notes: HunkNote[] = [];
	for (const hunk of hunks) {
		const candidates: { edit: SessionEdit; hits: number }[] = [];
		for (const edit of edits) {
			if (edit.text === "" && !edit.intent) continue;
			const hits = explainedLines(hunk, edit);
			if (hits > 0) candidates.push({ edit, hits });
		}
		if (candidates.length === 0) continue;
		candidates.sort((a, b) => b.hits - a.hits || b.edit.at - a.edit.at);
		const text = (edit: SessionEdit): string => capText(edit.text || edit.intent || "");
		const vocabulary = hunkVocabulary(hunk);
		const strong = candidates.find(({ edit }) => !isWeakNote(text(edit), edit.intent, hunk, vocabulary));
		const { edit: best } = strong ?? candidates[0]!;
		const note: HunkNote = {
			path: hunk.path,
			hunk: hunk.hunk,
			text: text(best),
			source: "session",
			sessionId: best.sessionId,
		};
		if (best.sessionTitle) note.sessionTitle = best.sessionTitle;
		if (best.turn > 0) note.turn = best.turn;
		if (best.intent) note.intent = best.intent;
		if (best.at > 0) note.at = best.at;
		if (strong === undefined) note.weak = true;
		notes.push(note);
	}
	return notes;
}
