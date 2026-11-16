import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HunkNote, ReviewNotesQuery } from "../src/lib/review-board";
import type { RunOmp } from "../scripts/companion-headless";
import { createReviewCache } from "../scripts/companion-review-cache";
import {
	batchHunks,
	buildNotesPrompt,
	checkNotesQuery,
	createReviewNotes,
	type Generator,
	hunkTexts,
	parseNotesAnswer,
	PROMPT_DIFF_CHARS,
} from "../scripts/companion-review-notes";

// ── pure helpers ─────────────────────────────────────────────────────────────

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,3 +1,3 @@ function f() {",
	" keep",
	"-  old();",
	"+  trimmed();",
	"@@ -40,2 +40,3 @@",
	" ctx",
	"+  second_change();",
	" tail",
	"",
].join("\n");

describe("hunkTexts", () => {
	it("gives each hunk its header and body, keyed by the header without its section text", () => {
		expect(hunkTexts(DIFF)).toEqual([
			{ hunk: "@@ -1,3 +1,3 @@", text: "@@ -1,3 +1,3 @@ function f() {\n keep\n-  old();\n+  trimmed();" },
			{ hunk: "@@ -40,2 +40,3 @@", text: "@@ -40,2 +40,3 @@\n ctx\n+  second_change();\n tail" },
		]);
	});

	it("stops a hunk at the next file's header", () => {
		const two = `${DIFF}diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n`;
		const texts = hunkTexts(two);
		expect(texts).toHaveLength(3);
		expect(texts[1]!.text.endsWith(" tail")).toBe(true);
	});
});

describe("batchHunks", () => {
	it("keeps hunks together while they fit one run and starts another when they do not", () => {
		const hunk = (n: number, size: number) => ({ hunk: `@@ -${n} +${n} @@`, text: "x".repeat(size) });
		expect(batchHunks([hunk(1, 10), hunk(2, 10)], 100).map(batch => batch.length)).toEqual([2]);
		expect(batchHunks([hunk(1, 60), hunk(2, 60), hunk(3, 10)], 100).map(batch => batch.length)).toEqual([1, 2]);
		expect(batchHunks([], 100)).toEqual([]);
	});

	it("cuts a hunk too large for a run and says so", () => {
		const [[cut]] = batchHunks(
			[{ hunk: "@@ -1 +1 @@", text: `${"line of code\n".repeat(2_000)}` }],
			PROMPT_DIFF_CHARS,
		);
		expect(cut!.text.length).toBeLessThan(7_000);
		expect(cut!.text).toContain("more characters of this hunk omitted");
	});
});

describe("buildNotesPrompt", () => {
	it("names the file, the session and what the author said, then lists the hunks by header", () => {
		const prompt = buildNotesPrompt({
			path: "src/a.ts",
			sessionTitle: "Fix the parser",
			excerpts: ["Trim the\ninput first."],
			hunks: [{ hunk: "@@ -1 +1 @@", text: "@@ -1 +1 @@\n-a\n+b" }],
		});
		expect(prompt).toContain("File: src/a.ts");
		expect(prompt).toContain("Fix the parser");
		expect(prompt).toContain("- Trim the input first.");
		expect(prompt).toContain("### @@ -1 +1 @@\n@@ -1 +1 @@\n-a\n+b");
	});
});

describe("parseNotesAnswer", () => {
	const known = new Set(["@@ -1,3 +1,3 @@", "@@ -40,2 +40,3 @@"]);

	it("reads the notes of a JSON object, also inside fences and chatter", () => {
		const raw =
			'Here you go:\n```json\n{"notes":[{"hunk":"@@ -1,3 +1,3 @@ function f() {","note":"Trims   the input."}]}\n```';
		expect([...parseNotesAnswer(raw, known)!]).toEqual([["@@ -1,3 +1,3 @@", "Trims the input."]]);
	});

	it("drops notes for headers it was not given, empty notes and repeats", () => {
		const raw = JSON.stringify({
			notes: [
				{ hunk: "@@ -9,9 +9,9 @@", note: "Invented." },
				{ hunk: "@@ -1,3 +1,3 @@", note: "   " },
				{ hunk: "@@ -40,2 +40,3 @@", note: "First." },
				{ hunk: "@@ -40,2 +40,3 @@", note: "Again." },
				{ hunk: 5, note: "bad" },
			],
		});
		expect([...parseNotesAnswer(raw, known)!]).toEqual([["@@ -40,2 +40,3 @@", "First."]]);
	});

	it("is null for an answer that is not a notes object", () => {
		expect(parseNotesAnswer("no json here", known)).toBeNull();
		expect(parseNotesAnswer('{"notes":"x"}', known)).toBeNull();
		expect(parseNotesAnswer('{"other":[]}', known)).toBeNull();
	});
});

describe("checkNotesQuery", () => {
	const good = {
		subject: { kind: "pr", number: 3 },
		version: "abc",
		files: [{ path: "a.ts", diff: "" }],
		generate: false,
	};

	it("accepts a well-formed request", () => {
		expect(checkNotesQuery(good)).toEqual(good as ReviewNotesQuery);
		expect(checkNotesQuery({ ...good, subject: { kind: "session", entryId: "e1" } }).subject).toEqual({
			kind: "session",
			entryId: "e1",
		});
		expect(checkNotesQuery({ ...good, subject: { kind: "branch", junk: 1 } }).subject).toEqual({ kind: "branch" });
	});

	it("refuses anything else", () => {
		for (const bad of [
			null,
			{ ...good, generate: "yes" },
			{ ...good, version: "" },
			{ ...good, files: [{ path: "", diff: "" }] },
			{ ...good, files: [{ path: "a", diff: 1 }] },
			{ ...good, subject: { kind: "pr", number: 0 } },
			{ ...good, subject: { kind: "nope" } },
			{ ...good, subject: { kind: "session", entryId: 4 } },
		]) {
			expect(() => checkNotesQuery(bad)).toThrow("invalid request");
		}
	});
});

// ── the engine ───────────────────────────────────────────────────────────────

let tmp: string;
let repo: string;
let sessionsDir: string;
let cacheDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

// What a session says about a change worth quoting: long enough, and about the code.
const SAID_TRIM =
	"The input must be trimmed before parsing, so that trailing whitespace never reaches the parser and breaks matching.";
const SAID_SECOND =
	"Adding the second_change call after the context, so the tail of the block runs once more for every request that comes in.";
const SAID_HELPER =
	"The helper trimmed the input before it reached the parser, so that whitespace at either end could not break the matching.";
const text = (value: string) => ({ type: "text", text: value });
const entry = (value: unknown) => JSON.stringify(value);

/** One session file in `sessionsDir` whose header says it ran in `cwd`. */
async function session(id: string, cwd: string, title: string, entries: string[], age = 0): Promise<void> {
	const header = entry({ type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd, title });
	const dir = path.join(sessionsDir, "folder");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	await fs.writeFile(file, `${[header, ...entries].join("\n")}\n`);
	const at = new Date(Date.UTC(2026, 9, 1, 10, 0, age));
	await fs.utimes(file, at, at);
}

/** A turn: a prompt, then an assistant message that says `said` and edits `src/a.ts`, whose result diff is `diff`. */
function turn(prompt: string, call: string, said: string, diff: string, intent?: string): string[] {
	return [
		entry({ type: "message", id: prompt, message: { role: "user", content: [text("go")] } }),
		entry({
			type: "message",
			id: `m-${call}`,
			timestamp: "2026-10-01T10:05:00.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain of thought" },
					text(said),
					{
						type: "toolCall",
						id: call,
						name: "edit",
						arguments: { path: "src/a.ts" },
						...(intent ? { intent } : {}),
					},
				],
			},
		}),
		entry({ type: "message", message: { role: "toolResult", toolCallId: call, isError: false, details: { diff } } }),
	];
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-notes-")));
	repo = path.join(tmp, "repo");
	sessionsDir = path.join(tmp, "sessions");
	cacheDir = path.join(tmp, "cache");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q");
	await session("sess-one", repo, "Fix the parser", [
		...turn("p1", "c1", SAID_TRIM, " 1|keep\n-2|  old();\n+2|  trimmed();\n", "Trimming input"),
		...turn("p2", "c2", SAID_SECOND, "+41|  second_change();\n"),
	]);
	await session("elsewhere", tmp, "Unrelated", turn("p9", "c9", "Outside the repository.", "+2|  trimmed();\n"), 5);
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function query(partial: Partial<ReviewNotesQuery> = {}): ReviewNotesQuery {
	return {
		// The first turn only: it explains the first hunk, not the second.
		subject: { kind: "session", entryId: "p1" },
		version: "v1",
		files: [{ path: "src/a.ts", diff: DIFF }],
		generate: false,
		...partial,
	};
}

const request = (q: ReviewNotesQuery, sessionId = "sess-one") => ({
	cwd: repo,
	sessionId,
	sessionTitle: "Fix the parser",
	query: q,
});

function engine(options: { run?: RunOmp; available?: boolean; cache?: string } = {}) {
	const argvs: string[][] = [];
	const prompts: string[] = [];
	const run: RunOmp =
		options.run ??
		(async () => ({
			code: 0,
			out: JSON.stringify({ notes: [{ hunk: "@@ -40,2 +40,3 @@", note: "Adds the second change." }] }),
			err: "",
		}));
	const generator: Generator = {
		available: async () => options.available ?? true,
		run: async (argv, stdin, cwd) => {
			argvs.push(argv);
			prompts.push(stdin);
			return run(argv, stdin, cwd);
		},
		ompBin: "omp",
		model: () => "@smol",
	};
	const notes = createReviewNotes({
		cache: createReviewCache(options.cache ?? cacheDir),
		sessionsDirs: () => [sessionsDir],
		generator,
		now: () => 7_000,
	});
	return { notes, argvs, prompts };
}

describe("createReviewNotes: what sessions said", () => {
	it("quotes the session for the hunk its edit made and leaves the rest unexplained", async () => {
		const { notes, prompts } = engine({ cache: path.join(tmp, "c-session") });
		const reply = await notes.notes(request(query()));
		expect(reply.canGenerate).toBe(true);
		expect(reply.unexplained).toBe(1);
		expect(reply.notes).toEqual([
			{
				path: "src/a.ts",
				hunk: "@@ -1,3 +1,3 @@",
				text: SAID_TRIM,
				source: "session",
				sessionId: "sess-one",
				sessionTitle: "Fix the parser",
				turn: 1,
				intent: "Trimming input",
				at: Date.parse("2026-10-01T10:05:00.000Z"),
			},
		]);
		expect(JSON.stringify(reply)).not.toContain("chain of thought");
		expect(prompts).toEqual([]);
	});

	it("reads the whole session when no turn is given", async () => {
		const { notes } = engine({ cache: path.join(tmp, "c-whole") });
		const reply = await notes.notes(request(query({ subject: { kind: "session" } })));
		expect(reply.notes.map(note => [note.hunk, note.turn])).toEqual([
			["@@ -1,3 +1,3 @@", 1],
			["@@ -40,2 +40,3 @@", 2],
		]);
		expect(reply.unexplained).toBe(0);
	});

	it("quotes the subagents a session started, as the turn that was running", async () => {
		// The parent ran elsewhere (so a repository scan does not reach it); the subagent worked in the repository.
		const parent = "sess-parent";
		await session(
			parent,
			tmp,
			"Parent work",
			[
				entry({
					type: "message",
					id: "pp1",
					timestamp: "2026-10-01T10:00:00.000Z",
					message: { role: "user", content: [text("go")] },
				}),
			],
			9,
		);
		const nestedDir = path.join(sessionsDir, "folder", `2026-10-01T10-00-00-000Z_${parent}`);
		await fs.mkdir(nestedDir, { recursive: true });
		const header = entry({
			type: "session",
			version: 3,
			id: "sub-1",
			timestamp: "2026-10-01T10:01:00.000Z",
			cwd: repo,
			title: "",
		});
		const work = turn("s1", "cs", SAID_HELPER, " 1|keep\n-2|  old();\n+2|  trimmed();\n");
		await fs.writeFile(path.join(nestedDir, "Helper.jsonl"), `${[header, ...work].join("\n")}\n`);
		const { notes } = engine({ cache: path.join(tmp, "c-sub") });
		const reply = await notes.notes(
			request(query({ subject: { kind: "session", entryId: "pp1" }, version: "v-sub" }), parent),
		);
		expect(reply.notes).toMatchObject([
			{
				hunk: "@@ -1,3 +1,3 @@",
				text: SAID_HELPER,
				sessionId: parent,
				sessionTitle: "Parent work › Helper",
				turn: 1,
			},
		]);
	});

	it("restricts a turn to its own edits", async () => {
		const { notes } = engine({ cache: path.join(tmp, "c-turn") });
		const first = await notes.notes(request(query({ subject: { kind: "session", entryId: "p1" } })));
		expect(first.notes.map(note => note.hunk)).toEqual(["@@ -1,3 +1,3 @@"]);
		const second = await notes.notes(request(query({ subject: { kind: "session", entryId: "p2" } })));
		expect(second.notes.map(note => [note.hunk, note.turn])).toEqual([["@@ -40,2 +40,3 @@", 2]]);
		expect(second.unexplained).toBe(1);
	});

	it("reads the repository's sessions for a pull request, not those that ran elsewhere", async () => {
		const { notes } = engine({ cache: path.join(tmp, "c-pr") });
		const reply = await notes.notes(
			request(query({ subject: { kind: "pr", number: 4 }, version: "sha1" }), "any-session"),
		);
		expect(reply.notes.map(note => [note.hunk, note.sessionId])).toEqual([
			["@@ -1,3 +1,3 @@", "sess-one"],
			["@@ -40,2 +40,3 @@", "sess-one"],
		]);
		expect(reply.unexplained).toBe(0);
	});

	it("answers a diff without hunks with nothing, and says whether a model could be asked", async () => {
		const { notes } = engine({ available: false, cache: path.join(tmp, "c-none") });
		expect(await notes.notes(request(query({ files: [{ path: "x.png", diff: "Binary files differ\n" }] })))).toEqual({
			notes: [],
			unexplained: 0,
			canGenerate: false,
		});
	});
});

describe("createReviewNotes: what a model writes", () => {
	it("writes notes for the unexplained hunks only, from their diff and what the session said", async () => {
		const { notes, argvs, prompts } = engine({ cache: path.join(tmp, "c-gen") });
		const reply = await notes.notes(request(query({ generate: true })));
		expect(reply.unexplained).toBe(0);
		expect(reply.notes.map(note => [note.hunk, note.source])).toEqual([
			["@@ -1,3 +1,3 @@", "session"],
			["@@ -40,2 +40,3 @@", "generated"],
		]);
		expect(reply.notes[1]).toMatchObject({ text: "Adds the second change.", at: 7_000 });
		expect(argvs).toHaveLength(1);
		expect(argvs[0]).toContain("--no-tools");
		expect(argvs[0]![argvs[0]!.indexOf("--model") + 1]).toBe("@smol");
		// Only the hunk no session explained is asked for; the session's words about the file are context.
		expect(prompts[0]).toContain("### @@ -40,2 +40,3 @@");
		expect(prompts[0]).not.toContain("### @@ -1,3 +1,3 @@");
		expect(prompts[0]).toContain(SAID_TRIM);
	});

	it("does not ask again once the notes are kept, also after a restart", async () => {
		const dir = path.join(tmp, "c-twice");
		const first = engine({ cache: dir });
		await first.notes.notes(request(query({ generate: true })));
		expect(first.prompts).toHaveLength(1);
		const restarted = engine({ cache: dir });
		const reply = await restarted.notes.notes(request(query({ generate: true })));
		expect(restarted.prompts).toEqual([]);
		expect(reply.notes.map(note => note.source)).toEqual(["session", "generated"]);
		const plain = await restarted.notes.notes(request(query()));
		expect(plain.unexplained).toBe(0);
	});

	it("asks again for the hunks a first answer left out, then counts what is still missing", async () => {
		let answers = 0;
		const { notes, prompts } = engine({
			cache: path.join(tmp, "c-skip"),
			run: async () => {
				answers++;
				return { code: 0, out: '{"notes":[]}', err: "" };
			},
		});
		const reply = await notes.notes(request(query({ generate: true })));
		expect(answers).toBe(2);
		expect(prompts[1]).toContain("### @@ -40,2 +40,3 @@");
		expect(reply.unexplained).toBe(1);
		expect(reply.notes.map(note => note.source)).toEqual(["session"]);
	});

	it("fails with the reason, makes up no note and keeps nothing for a run that failed", async () => {
		const dir = path.join(tmp, "c-fail");
		const failing = engine({ cache: dir, run: async () => ({ code: 3, out: "", err: "boom\nno model configured" }) });
		await expect(failing.notes.notes(request(query({ generate: true })))).rejects.toThrow(
			"Could not write the notes: omp exited with 3: no model configured",
		);
		const garbled = engine({ cache: dir, run: async () => ({ code: 0, out: "I cannot do that", err: "" }) });
		await expect(garbled.notes.notes(request(query({ generate: true })))).rejects.toThrow("answer was not readable");
		const plain = await engine({ cache: dir }).notes.notes(request(query()));
		expect(plain.notes.map(note => note.source)).toEqual(["session"]);
		expect(plain.unexplained).toBe(1);
	});

	it("refuses to generate without a model", async () => {
		const { notes } = engine({ available: false, cache: path.join(tmp, "c-nomodel") });
		await expect(notes.notes(request(query({ generate: true })))).rejects.toThrow("No model is available");
	});

	it("joins a second request for the same board that arrives while the first runs", async () => {
		let runs = 0;
		const { notes } = engine({
			cache: path.join(tmp, "c-join"),
			run: async () => {
				runs++;
				return { code: 0, out: JSON.stringify({ notes: [{ hunk: "@@ -40,2 +40,3 @@", note: "Done." }] }), err: "" };
			},
		});
		// Asked back to back, before either has answered.
		const [first, second] = await Promise.all([
			notes.notes(request(query({ generate: true }))),
			notes.notes(request(query({ generate: true }))),
		]);
		expect(runs).toBe(1);
		expect(second).toEqual(first);
	});

	it("keeps the notes of one board apart from another version of it", async () => {
		const dir = path.join(tmp, "c-version");
		const { notes, prompts } = engine({ cache: dir });
		await notes.notes(request(query({ generate: true })));
		await notes.notes(request(query({ generate: true, version: "v2" })));
		expect(prompts).toHaveLength(2);
	});
});

describe("createReviewNotes: weak quotes", () => {
	// A session whose only words are a short remark and the intent label: weak for both hunks.
	const WEAK = "weak-one";
	beforeAll(async () => {
		await session(
			WEAK,
			repo,
			"Terse work",
			[
				...turn(
					"w1",
					"cw1",
					"Cwd is ~/.omp; use absolute path.",
					" 1|keep\n-2|  old();\n+2|  trimmed();\n",
					"Trimming input",
				),
				...turn("w2", "cw2", "", "+41|  second_change();\n", "Second change"),
			],
			20,
		);
	});
	const weakQuery = (generate: boolean) => query({ subject: { kind: "session" }, version: "weak-v", generate });

	it("returns them marked weak, and counts their hunks as unexplained", async () => {
		const { notes, prompts } = engine({ cache: path.join(tmp, "c-weak") });
		const reply = await notes.notes(request(weakQuery(false), WEAK));
		expect(reply.notes.map(note => [note.hunk, note.weak, note.text])).toEqual([
			["@@ -1,3 +1,3 @@", true, "Cwd is ~/.omp; use absolute path."],
			["@@ -40,2 +40,3 @@", true, "Second change"],
		]);
		expect(reply.unexplained).toBe(2);
		expect(prompts).toEqual([]);
	});

	it("rewrites them when asked to generate, from the diff with the quote as context, keeping where the quote came from", async () => {
		const { notes, prompts } = engine({
			cache: path.join(tmp, "c-weak-gen"),
			run: async () => ({
				code: 0,
				out: JSON.stringify({
					notes: [
						{ hunk: "@@ -1,3 +1,3 @@", note: "Trims the input before it is parsed." },
						{ hunk: "@@ -40,2 +40,3 @@", note: "Adds a second change after the context." },
					],
				}),
				err: "",
			}),
		});
		const reply = await notes.notes(request(weakQuery(true), WEAK));
		expect(reply.unexplained).toBe(0);
		expect(reply.notes).toMatchObject([
			{
				hunk: "@@ -1,3 +1,3 @@",
				text: "Trims the input before it is parsed.",
				source: "generated",
				sessionId: WEAK,
				sessionTitle: "Terse work",
				turn: 1,
				intent: "Trimming input",
			},
			{ hunk: "@@ -40,2 +40,3 @@", source: "generated", sessionId: WEAK, turn: 2, intent: "Second change" },
		]);
		expect(reply.notes.some(note => note.weak)).toBe(false);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('The author\'s remark when making this change: "Cwd is ~/.omp; use absolute path."');
		expect(prompts[0]).toContain("### @@ -1,3 +1,3 @@");
	});

	it("keeps a good quote over a weak one of another session, and asks for nothing", async () => {
		// The repository's sessions: sess-one wrote both hunks with words about them, weak-one only with remarks.
		const pr = query({ subject: { kind: "pr", number: 9 }, version: "mix", generate: true });
		const { notes, prompts } = engine({ cache: path.join(tmp, "c-weak-mix") });
		const reply = await notes.notes(request(pr, "x"));
		expect(prompts).toEqual([]);
		expect(reply.unexplained).toBe(0);
		expect(reply.notes.map(note => [note.sessionId, note.weak])).toEqual([
			["sess-one", undefined],
			["sess-one", undefined],
		]);
	});
});

describe("hunk notes keep their shape", () => {
	it("are plain records a client can index by path and hunk", async () => {
		const { notes } = engine({ cache: path.join(tmp, "c-shape") });
		const reply = await notes.notes(request(query({ generate: true })));
		for (const note of reply.notes as HunkNote[]) {
			expect(
				Object.keys(note).every(key =>
					["path", "hunk", "text", "source", "sessionId", "sessionTitle", "turn", "intent", "at", "weak"].includes(
						key,
					),
				),
			).toBe(true);
		}
	});
});
