/**
 * The agent's reasoning per hunk for the review board (`review-notes`): the notes of a board's files, first quoted from
 * the sessions that made the changes (./companion-review-edits, no model involved), then, when asked, written by a
 * model for the hunks no session explains.
 *
 * Generated notes come from headless `omp -p` runs of a cheap role, the way generated commit messages do
 * (./companion-gitmsg): one run per batch of one file's hunks, handed the hunks' diff and what the author said about
 * the file's other changes, answering one JSON note per hunk header. An answer that does not parse, or a run that fails,
 * is an error: no note is made up. Replies are kept on disk (./companion-review-cache), so a board opened again, and a
 * model run that already happened, cost nothing.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HunkNote, ReviewNotesQuery, ReviewNotesReply, ReviewSubject } from "../src/lib/review-board";
import { isRecord } from "../src/tool-render/util";
import { repoInfo } from "./companion-blueprint-git";
import { fileLines, MAX_FILE_BYTES, repoSessions } from "./companion-file-sessions";
import { git } from "./companion-git";
import { NOISE_FILE_RE } from "./companion-gitmsg";
import { headlessOmpArgs, type RunOmp } from "./companion-headless";
import { type ReviewCache, reviewCacheKey } from "./companion-review-cache";
import {
	capText,
	explainHunks,
	fileHunks,
	type HunkLines,
	HUNK_HEADER_RE,
	hunkId,
	type ScanScope,
	type PromptTurn,
	placeInTurns,
	type SessionEdit,
	scanSessionEdits,
} from "./companion-review-edits";
import { findSessionFile, isPrivateSession, readSessionHead } from "./companion-sessions";

const MAX_QUERY_FILES = 3_000;
const MAX_PATH_CHARS = 4_096;
const MAX_VERSION_CHARS = 200;
const MAX_QUERY_CHARS = 32 * 1024 * 1024;
/** Sessions not read by this time are left out (and the reading is not remembered). */
const SCAN_DEADLINE_MS = 20_000;
const SCAN_CONCURRENCY = 4;
/** Subagent sessions read per session. */
const MAX_SUBAGENTS = 200;
/** Characters of diff in one model run, and of one hunk in it. */
export const PROMPT_DIFF_CHARS = 24_000;
const MAX_HUNK_CHARS = 6_000;
/** Model runs of one request: what is left stays unexplained, and is counted. */
export const MAX_RUNS = 24;
const RUN_CONCURRENCY = 3;
/** Tries per batch: the second asks only for the hunks the first left out. */
const ATTEMPTS = 2;
const MAX_COST_USD = 0.1;
const MAX_GENERATED_CHARS = 600;
const EXCERPTS = 3;
const EXCERPT_CHARS = 300;
const MAX_ERROR_CHARS = 300;

const SYSTEM_PROMPT =
	"You explain code changes to the reviewer who reads them. You are given one file's diff split into hunks, and " +
	"sometimes what the author said about other changes in the same file, or a remark the author made when making a hunk. " +
	"A remark is context: use it where it is about that change, ignore it where it is not, and write the note from the diff either way. " +
	'Reply with one JSON object and nothing else, no code fences, no commentary: {"notes":[{"hunk":"<the hunk header exactly as given>","note":"<one to three sentences>"}]} ' +
	"with exactly one note per hunk. Say what the change does and why it was needed, the way the author would tell a reviewer. " +
	"Describe only what the diff shows; never invent intent, tickets or tests. No headings or lists inside a note.";

// ── the request ──────────────────────────────────────────────────────────────

function checkSubject(value: unknown): ReviewSubject {
	if (!isRecord(value)) throw new Error("invalid request");
	if (value.kind === "branch") return { kind: "branch" };
	if (value.kind === "pr") {
		if (typeof value.number !== "number" || !Number.isInteger(value.number) || value.number < 1)
			throw new Error("invalid request");
		return { kind: "pr", number: value.number };
	}
	if (value.kind === "session") {
		if (value.entryId === undefined) return { kind: "session" };
		if (typeof value.entryId !== "string" || value.entryId === "" || value.entryId.length > MAX_VERSION_CHARS) {
			throw new Error("invalid request");
		}
		return { kind: "session", entryId: value.entryId };
	}
	throw new Error("invalid request");
}

/** A request from a device, checked. @throws Error "invalid request". */
export function checkNotesQuery(value: unknown): ReviewNotesQuery {
	if (!isRecord(value) || typeof value.generate !== "boolean") throw new Error("invalid request");
	const { version, files } = value;
	if (typeof version !== "string" || version === "" || version.length > MAX_VERSION_CHARS)
		throw new Error("invalid request");
	if (!Array.isArray(files) || files.length > MAX_QUERY_FILES) throw new Error("invalid request");
	let chars = 0;
	const checked = files.map(file => {
		if (!isRecord(file) || typeof file.path !== "string" || typeof file.diff !== "string")
			throw new Error("invalid request");
		if (file.path === "" || file.path.length > MAX_PATH_CHARS || file.path.includes("\0"))
			throw new Error("invalid request");
		chars += file.diff.length;
		if (chars > MAX_QUERY_CHARS) throw new Error("the diff is too large to explain");
		return { path: file.path, diff: file.diff };
	});
	return { subject: checkSubject(value.subject), version, files: checked, generate: value.generate };
}

// ── what sessions said ───────────────────────────────────────────────────────

/** The checkouts of the repository (the primary one first, then its linked worktrees), symlinks resolved. */
async function checkouts(root: string, checkout: string): Promise<string[]> {
	const found = new Set<string>([root, checkout]);
	const listing = await git(root, ["worktree", "list", "--porcelain"]);
	if (listing.code === 0) {
		for (const line of new TextDecoder().decode(listing.out).split("\n")) {
			if (line.startsWith("worktree ")) found.add(line.slice("worktree ".length));
		}
	}
	const resolved = await Promise.all([...found].map(dir => fs.realpath(dir).catch(() => null)));
	return [...new Set(resolved.filter((dir): dir is string => dir !== null))];
}

/** The subject's files by the repo-relative path an edit used: the new path, and the old path of a renamed file. */
function wantedFiles(files: ReviewNotesQuery["files"]): Map<string, string> {
	const wanted = new Map<string, string>();
	for (const file of files) {
		wanted.set(file.path, file.path);
		const renamed = /^rename from (.+)$/m.exec(file.diff);
		if (renamed?.[1]) wanted.set(renamed[1], file.path);
	}
	return wanted;
}

interface Scanned {
	edits: SessionEdit[];
	/** Every session was read: the answer may be remembered. */
	complete: boolean;
}

/** Session files of the subagents a session started: beside it in a folder of its own name, up to two folders deep. */
async function subagentSessions(file: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (found.length >= MAX_SUBAGENTS) return;
			const full = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
			else if (entry.isDirectory() && depth < 2) await walk(full, depth + 1);
		}
	};
	await walk(file.replace(/\.jsonl$/, ""), 0);
	return found;
}

/**
 * The edits of a session and of the subagents it started (what a `task` call's agents wrote is the session's work too).
 * A subagent's edits carry the session's id, the turn that was running when it made them, and a title that names it.
 */
export async function scanWithSubagents(file: string, scope: ScanScope): Promise<SessionEdit[]> {
	const turns: PromptTurn[] = [];
	const edits = await scanSessionEdits(fileLines(file, MAX_FILE_BYTES), scope, turns);
	const nested = await subagentSessions(file);
	for (let i = 0; i < nested.length; i += SCAN_CONCURRENCY) {
		const found = await Promise.all(
			nested.slice(i, i + SCAN_CONCURRENCY).map(async (subagent): Promise<SessionEdit[]> => {
				try {
					const head = await readSessionHead(subagent);
					if (head === null) return [];
					const realCwd = await fs.realpath(head.cwd).catch(() => head.cwd);
					const name = path.basename(subagent, ".jsonl");
					const sub = await scanSessionEdits(fileLines(subagent, MAX_FILE_BYTES), {
						...scope,
						sessionTitle: `${scope.sessionTitle ?? "session"} › ${head.title || name}`,
						cwd: head.cwd,
						realCwd,
					});
					return placeInTurns(sub, turns);
				} catch {
					// A subagent file that cannot be read says nothing; the others still do.
					return [];
				}
			}),
		);
		for (const list of found) edits.push(...list);
	}
	return edits;
}

/** The edits that changed the subject's files: in the asking session for a session subject, else in the repository's sessions. */
async function sessionEdits(
	dirs: readonly string[],
	query: ReviewNotesQuery,
	sessionId: string,
	roots: readonly string[],
): Promise<Scanned> {
	const files = wantedFiles(query.files);
	const scan = (file: string, scope: Omit<ScanScope, "roots" | "files">): Promise<SessionEdit[]> =>
		scanWithSubagents(file, { ...scope, roots, files });
	const { subject } = query;
	if (subject.kind === "session") {
		const file = await findSessionFile(dirs, sessionId);
		const head = file === null ? null : await readSessionHead(file);
		if (file === null || head === null) return { edits: [], complete: true };
		const realCwd = await fs.realpath(head.cwd).catch(() => head.cwd);
		const edits = await scan(file, { sessionId: head.id, sessionTitle: head.title, cwd: head.cwd, realCwd });
		return { edits: subject.entryId ? edits.filter(edit => edit.turnId === subject.entryId) : edits, complete: true };
	}
	const candidates = await repoSessions({ sessionsDir: dirs[0]!, extraSessionsDirs: dirs.slice(1) }, roots);
	const deadline = Date.now() + SCAN_DEADLINE_MS;
	const edits: SessionEdit[] = [];
	let complete = true;
	for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
		if (Date.now() >= deadline) {
			complete = false;
			break;
		}
		const batch = candidates.slice(i, i + SCAN_CONCURRENCY);
		const found = await Promise.all(
			batch.map(candidate =>
				scan(candidate.found.file, {
					sessionId: candidate.found.sessionId,
					sessionTitle: candidate.found.title,
					cwd: candidate.cwd,
					realCwd: candidate.realCwd,
				}).catch(() => {
					// A session file that cannot be read says nothing; the others still do.
					return [] as SessionEdit[];
				}),
			),
		);
		for (const list of found) edits.push(...list);
	}
	return { edits, complete };
}

// ── what a model writes ──────────────────────────────────────────────────────

/** A hunk of a diff with its text: the header line, then the lines up to the next hunk or file. */
export interface HunkText {
	hunk: string;
	text: string;
	/** What the author said when making the change, when that is all there is to go on: context, not the answer. */
	said?: string;
}

/** The hunks of one file's diff with their text. */
export function hunkTexts(diff: string): HunkText[] {
	const hunks: HunkText[] = [];
	let lines: string[] | null = null;
	const close = () => {
		if (lines !== null) hunks[hunks.length - 1]!.text = lines.join("\n").trimEnd();
		lines = null;
	};
	for (const line of diff.split("\n")) {
		const header = HUNK_HEADER_RE.exec(line);
		if (header) {
			close();
			hunks.push({ hunk: header[0], text: "" });
			lines = [line];
		} else if (line.startsWith("diff --git ")) {
			close();
		} else if (lines !== null) {
			lines.push(line);
		}
	}
	close();
	return hunks;
}

function clipHunk(text: string): string {
	if (text.length <= MAX_HUNK_CHARS) return text;
	const cut = text.lastIndexOf("\n", MAX_HUNK_CHARS);
	return `${text.slice(0, cut > 0 ? cut : MAX_HUNK_CHARS)}\n[… ${text.length - (cut > 0 ? cut : MAX_HUNK_CHARS)} more characters of this hunk omitted]`;
}

/** Hunks grouped so that each group's diff fits one model run; a hunk is cut at {@link MAX_HUNK_CHARS}. */
export function batchHunks(hunks: readonly HunkText[], budget = PROMPT_DIFF_CHARS): HunkText[][] {
	const batches: HunkText[][] = [];
	let current: HunkText[] = [];
	let size = 0;
	for (const hunk of hunks) {
		const clipped: HunkText = { hunk: hunk.hunk, text: clipHunk(hunk.text) };
		if (hunk.said !== undefined) clipped.said = hunk.said;
		if (current.length > 0 && size + clipped.text.length > budget) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(clipped);
		size += clipped.text.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export interface NotesPromptInput {
	path: string;
	sessionTitle?: string | null;
	/** What the author said about other changes in the file. */
	excerpts: readonly string[];
	hunks: readonly HunkText[];
}

export function buildNotesPrompt(input: NotesPromptInput): string {
	const parts = [`File: ${input.path}`];
	if (input.sessionTitle) parts.push(`Session the changes were made in: ${input.sessionTitle}`);
	if (input.excerpts.length > 0) {
		parts.push(
			`What the author said about other changes in this file:\n${input.excerpts.map(text => `- ${text.replaceAll("\n", " ")}`).join("\n")}`,
		);
	}
	parts.push(
		`Write one note for each of these ${input.hunks.length} hunk(s); use each hunk header exactly as given:\n\n${input.hunks
			.map(
				hunk =>
					`### ${hunk.hunk}\n${hunk.said === undefined ? "" : `[The author's remark when making this change: "${hunk.said.replaceAll("\n", " ")}"]\n`}${hunk.text}`,
			)
			.join("\n\n")}`,
	);
	return parts.join("\n\n");
}

/** The first JSON object in the model's answer, tolerating code fences and chatter around it. */
function jsonObject(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The notes of the model's answer by hunk header. Notes for a header that is not one of `known` and empty notes are
 * dropped; null when the answer is not a `{"notes": […]}` object at all.
 */
export function parseNotesAnswer(raw: string, known: ReadonlySet<string>): Map<string, string> | null {
	const object = jsonObject(raw);
	if (object === null || !Array.isArray(object.notes)) return null;
	const notes = new Map<string, string>();
	for (const item of object.notes) {
		if (!isRecord(item) || typeof item.hunk !== "string" || typeof item.note !== "string") continue;
		const key = HUNK_HEADER_RE.exec(item.hunk.trim())?.[0];
		const text = capText(item.note.replace(/\s+/g, " "), MAX_GENERATED_CHARS);
		if (key === undefined || !known.has(key) || text === "" || notes.has(key)) continue;
		notes.set(key, text);
	}
	return notes;
}

export interface Generator {
	/** Whether a model can be asked. */
	available(): Promise<boolean>;
	run: RunOmp;
	ompBin: string;
	/** Model id or role. */
	model(): string;
}

function failureText(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err);
	return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** One model run: the notes it wrote by hunk header. @throws Error when omp fails or the answer is unreadable. */
async function askModel(
	generator: Generator,
	prompt: string,
	known: ReadonlySet<string>,
	isPrivate: boolean,
): Promise<Map<string, string>> {
	const argv = headlessOmpArgs({
		ompBin: generator.ompBin,
		model: generator.model(),
		systemPrompt: SYSTEM_PROMPT,
		maxCostUsd: MAX_COST_USD,
		private: isPrivate,
	});
	// A neutral folder: the project's own context files and settings have no part in this.
	const result = await generator.run(argv, prompt, os.tmpdir());
	if (result.code !== 0) {
		const reason =
			result.err
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.pop() ?? `exit ${result.code}`;
		throw new Error(`omp exited with ${result.code}: ${reason}`);
	}
	const notes = parseNotesAnswer(result.out, known);
	if (notes === null) throw new Error("the model's answer was not readable");
	return notes;
}

/** Hunks of one file still to explain, with what is known about the file. */
interface FileWork {
	path: string;
	hunks: HunkText[];
	excerpts: string[];
}

/** A generated note for a hunk whose session quote was weak: it keeps where the quote came from. */
function rewritten(note: HunkNote, quote: HunkNote | undefined): HunkNote {
	if (quote === undefined) return note;
	const kept: HunkNote = { ...note };
	if (quote.sessionId !== undefined) kept.sessionId = quote.sessionId;
	if (quote.sessionTitle !== undefined) kept.sessionTitle = quote.sessionTitle;
	if (quote.turn !== undefined) kept.turn = quote.turn;
	if (quote.intent !== undefined) kept.intent = quote.intent;
	return kept;
}

/** Notes for `work` from the model, in runs of at most {@link MAX_RUNS}; what could not be written is in `failure`. */
async function generateNotes(
	generator: Generator,
	work: readonly FileWork[],
	sessionTitle: string | null,
	now: () => number,
	isPrivate: boolean,
): Promise<{ notes: HunkNote[]; failure: string | null }> {
	const jobs = work.flatMap(file => batchHunks(file.hunks).map(hunks => ({ file, hunks }))).slice(0, MAX_RUNS);
	const notes: HunkNote[] = [];
	let failure: string | null = null;
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) {
			let todo = job.hunks;
			try {
				for (let attempt = 0; attempt < ATTEMPTS && todo.length > 0; attempt++) {
					const known = new Set(todo.map(hunk => hunk.hunk));
					const answer = await askModel(
						generator,
						buildNotesPrompt({ path: job.file.path, sessionTitle, excerpts: job.file.excerpts, hunks: todo }),
						known,
						isPrivate,
					);
					for (const [hunk, text] of answer)
						notes.push({ path: job.file.path, hunk, text, source: "generated", at: now() });
					todo = todo.filter(hunk => !answer.has(hunk.hunk));
				}
			} catch (err) {
				failure ??= failureText(err);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, jobs.length) }, worker));
	return { notes, failure };
}

// ── the engine ───────────────────────────────────────────────────────────────

export interface ReviewNotesDeps {
	cache: ReviewCache;
	/** Where sessions live: omp's folder first, then the Personal profile's. */
	sessionsDirs(): readonly string[];
	/** Null when the companion cannot run a model. */
	generator: Generator | null;
	now(): number;
}

export interface NotesRequest {
	/** The asking session's working directory: its repository is the board's. */
	cwd: string;
	sessionId: string;
	sessionTitle: string | null;
	/** From a device: checked here. */
	query: unknown;
}

export interface ReviewNotes {
	notes(request: NotesRequest): Promise<ReviewNotesReply>;
}

export function createReviewNotes(deps: ReviewNotesDeps): ReviewNotes {
	/** One reading of the same board at a time: a second tap on "Explain" joins the run in flight. */
	const inFlight = new Map<string, Promise<ReviewNotesReply>>();

	async function answer(request: NotesRequest, query: ReviewNotesQuery): Promise<ReviewNotesReply> {
		const canGenerate = deps.generator !== null && (await deps.generator.available());
		const hunks: HunkLines[] = query.files.flatMap(file => fileHunks(file.path, file.diff));
		if (hunks.length === 0) return { notes: [], unexplained: 0, canGenerate };
		const info = await repoInfo(request.cwd);
		const key = reviewCacheKey(info.root, query.subject, query.version, request.sessionId);
		const cached = await deps.cache.read(key);
		const known = new Set(hunks.map(hunk => hunkId(hunk.path, hunk.hunk)));
		const stillThere = (note: HunkNote): boolean => known.has(hunkId(note.path, note.hunk));

		let session = cached?.session?.filter(stillThere);
		let generated = (cached?.generated ?? []).filter(stillThere);
		let remember = false;
		let write = false;
		if (session === undefined) {
			const roots = await checkouts(info.root, info.checkout);
			const scanned = await sessionEdits(deps.sessionsDirs(), query, request.sessionId, roots);
			session = explainHunks(hunks, scanned.edits);
			remember = scanned.complete;
			write = scanned.complete;
		}

		let failure: string | null = null;
		// A weak quote does not count as an explanation: its hunk is written again, with the quote as context.
		const weak = new Map(session.filter(note => note.weak).map(note => [hunkId(note.path, note.hunk), note]));
		const explained = new Set(
			[...session.filter(note => !note.weak), ...generated].map(note => hunkId(note.path, note.hunk)),
		);
		if (query.generate && explained.size < hunks.length) {
			if (!canGenerate || deps.generator === null)
				throw new Error("No model is available on this computer to write the notes.");
			const texts = new Map(query.files.map(file => [file.path, hunkTexts(file.diff)]));
			const work: FileWork[] = [];
			for (const file of query.files) {
				if (NOISE_FILE_RE.test(file.path)) continue;
				const todo = (texts.get(file.path) ?? [])
					.filter(hunk => !explained.has(hunkId(file.path, hunk.hunk)))
					.map(hunk => {
						const said = weak.get(hunkId(file.path, hunk.hunk))?.text;
						return said === undefined ? hunk : { ...hunk, said };
					});
				if (todo.length === 0) continue;
				const excerpts = [
					...new Set(
						session
							.filter(note => note.path === file.path && !note.weak)
							.map(note => capText(note.text, EXCERPT_CHARS)),
					),
				].slice(0, EXCERPTS);
				work.push({ path: file.path, hunks: todo, excerpts });
			}
			// The notes quote the session and its changes: a private session's are written by local models only.
			const isPrivate = await isPrivateSession(deps.sessionsDirs(), request.sessionId);
			const made = await generateNotes(deps.generator, work, request.sessionTitle, deps.now, isPrivate);
			generated = [...generated, ...made.notes.map(note => rewritten(note, weak.get(hunkId(note.path, note.hunk))))];
			failure = made.failure;
			write ||= made.notes.length > 0;
		}
		// A cache that cannot be written is only slower, never wrong.
		if (write) {
			const keepSession = session !== undefined && (remember || cached?.session !== undefined);
			await deps.cache.write(key, { ...(keepSession ? { session } : {}), generated }).catch(err => {
				console.error(`companion: could not keep the review notes: ${failureText(err)}`);
			});
		}
		if (failure !== null) throw new Error(`Could not write the notes: ${failure}`);

		// What a model wrote stands for a hunk whose session quote is weak, never for one whose quote is good.
		const byHunk = new Map<string, HunkNote>();
		for (const note of generated) byHunk.set(hunkId(note.path, note.hunk), note);
		for (const note of session) {
			const id = hunkId(note.path, note.hunk);
			if (!note.weak || !byHunk.has(id)) byHunk.set(id, note);
		}
		const notes = hunks.flatMap(hunk => byHunk.get(hunkId(hunk.path, hunk.hunk)) ?? []);
		return { notes, unexplained: hunks.length - notes.filter(note => !note.weak).length, canGenerate };
	}

	return {
		async notes(request) {
			const query = checkNotesQuery(request.query);
			const flight = `${request.cwd}\0${request.sessionId}\0${query.version}\0${JSON.stringify(query.subject)}\0${query.generate}`;
			const joined = inFlight.get(flight);
			if (joined !== undefined) return joined;
			const run = answer(request, query);
			inFlight.set(flight, run);
			try {
				return await run;
			} finally {
				inFlight.delete(flight);
			}
		},
	};
}
