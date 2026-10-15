import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentLaunch } from "../scripts/companion-agent";
import type { RunOmp } from "../scripts/companion-headless";
import { createQuizzes, type Quizzes } from "../scripts/companion-quiz";

const SESSION_ID = "01a12fa5-758e-7595-b768-bb9462d6e44e";
const USER_ENTRY = "aa11bb22";
const AGENT_ENTRY = "cc33dd44";
const USER_TEXT = "Compute the mean and the variance of the salaries without ever decrypting them on the server.";
const AGENT_TEXT = "CKKS is approximate, so every result carries a small error that we can bound.";
const DESIGN =
	"# Design\n\nWe use CKKS because salaries are real numbers.\nThe noise budget is checked after each multiplication.\n";
const STATS = "def mean(xs):\n    return sum(xs) / len(xs)\n";

let tmp: string;
let sessionsDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
}

async function folder(name: string, files: Record<string, string>): Promise<string> {
	const dir = path.join(tmp, "scratch", `2026-07-01-${name}-a1b2c3`);
	for (const [file, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), text);
	}
	return dir;
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quiz-topic-")));
	sessionsDir = path.join(tmp, "sessions", "-work-fhe");
	await fs.mkdir(sessionsDir, { recursive: true });
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-07-01T10:00:00.000Z", cwd: "/work/fhe" },
		{
			type: "message",
			id: USER_ENTRY,
			parentId: null,
			timestamp: "2026-07-01T10:00:01.000Z",
			message: { role: "user", content: USER_TEXT },
		},
		{
			type: "message",
			id: AGENT_ENTRY,
			parentId: USER_ENTRY,
			timestamp: "2026-07-01T10:00:05.000Z",
			message: { role: "assistant", content: [{ type: "text", text: AGENT_TEXT }] },
		},
	];
	await fs.writeFile(
		path.join(sessionsDir, `2026-07-01T10-00-00-000Z_${SESSION_ID}.jsonl`),
		`${lines.map(line => JSON.stringify(line)).join("\n")}\n`,
	);
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const good = {
	open: {
		kind: "open",
		topic: "Why CKKS",
		prompt: "Why was CKKS chosen for salaries, and what does it cost?",
		reminder: "CKKS computes on approximate real numbers.",
		session: [{ entry: AGENT_ENTRY, quote: "every result carries a small error that we can bound" }],
		refs: ["notes/design.md@3@CKKS"],
		rubric: { points: ["salaries are real numbers", "results are approximate"], misconceptions: [] },
	},
	background: {
		kind: "choice",
		background: true,
		topic: "CKKS versus BFV",
		prompt: "Which scheme works on exact integers?",
		reminder: "The two schemes differ in what they encode.",
		choices: ["BFV", "CKKS", "Both are approximate"],
		answer: "a",
		explanation: "BFV encodes exact integers modulo a plaintext modulus; CKKS encodes approximate reals.",
	},
	backgroundOpen: {
		kind: "open",
		background: true,
		topic: "Noise budget",
		prompt: "What is the noise budget?",
		reminder: "Each operation adds noise.",
		explanation: "Each homomorphic operation adds noise; when it exceeds a bound, decryption fails.",
		rubric: {
			points: ["noise grows with each operation", "decryption fails when it is exhausted"],
			misconceptions: [],
		},
	},
	badQuote: {
		kind: "open",
		topic: "Invented",
		prompt: "What did the developer say about GPUs?",
		reminder: "Nothing.",
		session: [{ entry: USER_ENTRY, quote: "we should run everything on the GPU cluster" }],
		rubric: { points: ["gpus"], misconceptions: [] },
	},
	badFile: {
		kind: "open",
		topic: "Invented file",
		prompt: "What does the key manager do?",
		reminder: "There is none.",
		refs: ["notes/design.md@3@KeyManager"],
		rubric: { points: ["key manager"], misconceptions: [] },
	},
	code: {
		kind: "open",
		topic: "Mean",
		prompt: "How does `mean` compute its result?",
		reminder: "Sum, then divide.",
		refs: ["stats.py@2@sum(xs)"],
		rubric: { points: ["divides the sum by the length"], misconceptions: [] },
	},
};

interface Harness {
	quizzes: Quizzes;
	launches: AgentLaunch[];
	graded: string[];
	copies: Promise<string[]>[];
}

function harness(name: string, file: unknown): Harness {
	const launches: AgentLaunch[] = [];
	const graded: string[] = [];
	const copies: Promise<string[]>[] = [];
	const run: RunOmp = async (_argv, stdin) => {
		graded.push(stdin);
		const text = JSON.stringify({ verdict: "right", explanation: "That is the idea.", refs: [] });
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				model: "stub-model",
				content: [{ type: "text", text }],
				usage: { cost: { total: 0.01 } },
			},
		};
		return { code: 0, out: `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify(event)}\n`, err: "" };
	};
	const quizzes = createQuizzes({
		storeDir: path.join(tmp, name, "agent", "quizzes"),
		cacheDir: path.join(tmp, name, "cache", "quizzes"),
		sessionsDir: path.join(tmp, "sessions"),
		now: () => Date.now(),
		changed: () => undefined,
		agent: {
			start: async launch => {
				launches.push(launch);
				// What the agent can read, as it is while it runs.
				copies.push(fs.readdir(launch.cwd, { recursive: true }));
				await fs.writeFile(launch.outFile, JSON.stringify(file));
				return "agent-1";
			},
			hosts: async () => [{ instanceId: "agent-1", sessionId: "s-1", model: "stub/stub-model", busy: false }],
			stop: async () => undefined,
			cost: async () => 0.2,
		},
		ompBin: "omp",
		run,
		watch: { pollMs: 10, settleMs: 30 },
	});
	return { quizzes, launches, graded, copies };
}

const quizOf = (...questions: unknown[]) => ({ parts: [{ part: 1, questions }] });

describe("a quiz on the topic of a session in a folder that is not a repository", () => {
	let scratch: string;

	beforeAll(async () => {
		scratch = await folder("fhe-statistics", { "notes/design.md": DESIGN, "stats.py": STATS, ".env": "SECRET=1\n" });
	});

	it("describes the folder, writes questions from the conversation, the files and background, and checks each citation", async () => {
		const h = harness("t1", quizOf(good.open, good.background, good.backgroundOpen, good.badQuote, good.badFile));
		expect(await h.quizzes.folder(scratch)).toEqual({
			git: false,
			code: true,
			files: 2,
			name: "Scratch · fhe statistics",
		});
		const { id } = await h.quizzes.create({
			cwd: scratch,
			sessionId: SESSION_ID,
			subject: "session",
			focus: "understanding",
		});
		await h.quizzes.idle();
		const summary = h.quizzes.summary(id)!;
		expect(summary).toMatchObject({
			status: "ready",
			questionCount: 3,
			partCount: 1,
			about: "session",
			focus: "understanding",
			sessionId: SESSION_ID,
			title: "Scratch · fhe statistics · topic",
			subject: "Session topic · Understanding",
		});

		// The brief has the conversation with its entry ids, the files, the focus and the background rules.
		const prompt = h.launches[0]!.prompt;
		expect(prompt).toContain(`[#${USER_ENTRY}] User: ${USER_TEXT}`);
		expect(prompt).toContain(`[#${AGENT_ENTRY}] Assistant: ${AGENT_TEXT}`);
		expect(prompt).toContain("notes/design.md");
		expect(prompt).toContain("**Understanding.**");
		expect(prompt).not.toContain(".env");
		// The agent read a copy of the files, not the dotfile, and the folder is untouched.
		const seen = await h.copies[0]!;
		expect(seen).toEqual(expect.arrayContaining(["notes/design.md", "stats.py"]));
		expect(seen).not.toContain(".env");
		expect(await fs.readdir(path.dirname(h.launches[0]!.cwd)).catch(() => [])).toEqual([]);
		expect(h.launches[0]!.cwd.startsWith(scratch)).toBe(false);

		const { quiz } = await h.quizzes.get(id);
		expect(quiz).toMatchObject({ about: "session", focus: "understanding", sessionId: SESSION_ID });
		expect(quiz.parts).toHaveLength(1);
		expect(quiz.parts[0]).toMatchObject({ title: "The topic of the session", head: { commit: "folder" } });
		expect(quiz.parts[0]!.base).toBeUndefined();
		expect(quiz.questions.map(q => [q.kind, q.background === true])).toEqual([
			["open", false],
			["choice", true],
			["open", true],
		]);
		expect(quiz.questions[0]).toMatchObject({
			refs: [{ path: "notes/design.md", line: 3, token: "CKKS" }],
			session: [
				{ entry: AGENT_ENTRY, role: "assistant", quote: "every result carries a small error that we can bound" },
			],
		});
		expect(quiz.questions[1]!.refs).toEqual([]);
		expect(quiz.warnings.join(" ")).toContain("Dropped the question");
		// No answer key on the wire, not even a background question's explanation.
		const wire = JSON.stringify(quiz);
		expect(wire).not.toContain("exact integers modulo");
		expect(wire).not.toContain("decryption fails");

		// The cited file is stored: editing or deleting it afterwards changes nothing in the quiz.
		await fs.writeFile(path.join(scratch, "notes/design.md"), "# Rewritten\n");
		const [excerpt] = await h.quizzes.excerpt(id, 0, [quiz.questions[0]!.refs[0]!]);
		expect(excerpt!.lines.join("\n")).toContain("We use CKKS because salaries are real numbers.");
		await fs.rm(path.join(scratch, "notes/design.md"));
		const [still] = await h.quizzes.excerpt(id, 0, [quiz.questions[0]!.refs[0]!]);
		expect(still!.lines.join("\n")).toContain("We use CKKS");
		await fs.mkdir(path.join(scratch, "notes"), { recursive: true });
		await fs.writeFile(path.join(scratch, "notes/design.md"), DESIGN);
	});

	it("grades a background answer against its explanation, a choice at once, and keeps the explanation to itself until answered", async () => {
		const h = harness("t2", quizOf(good.background, good.backgroundOpen));
		const { id } = await h.quizzes.create({ cwd: scratch, sessionId: SESSION_ID, subject: "session" });
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		expect(quiz.focus).toBe("mixed");
		const choice = quiz.questions.find(q => q.kind === "choice")!;
		const right = choice.choices!.find(c => c.text === "BFV")!;
		const verdict = await h.quizzes.answer({ id, attempt: "a1", question: choice.id, choice: right.id });
		expect(verdict.verdict).toMatchObject({ kind: "right", graded: "local" });
		expect(verdict.verdict.explanation).toContain("exact integers");
		const open = quiz.questions.find(q => q.kind === "open")!;
		const answered = await h.quizzes.answer({
			id,
			attempt: "a1",
			question: open.id,
			text: "Noise piles up with every operation.",
		});
		expect(answered.verdict.kind).toBe("right");
		expect(h.graded).toHaveLength(1);
		expect(h.graded[0]).toContain("general background knowledge");
		expect(h.graded[0]).toContain("when it exceeds a bound, decryption fails");
		expect(h.graded[0]).toContain("Noise piles up with every operation.");
	});

	it("refuses implementation questions for a folder with no code, and says so", async () => {
		const notes = await folder("only-notes", { "notes/plan.md": "# Plan\n\nSome words.\n" });
		const h = harness("t3", quizOf(good.open));
		expect(await h.quizzes.folder(notes)).toMatchObject({ git: false, code: false, files: 1 });
		await expect(
			h.quizzes.create({ cwd: notes, sessionId: SESSION_ID, subject: "session", focus: "implementation" }),
		).rejects.toThrow("Implementation questions need code, and this folder has none.");
		expect(h.launches).toHaveLength(0);
		// The other focuses are fine for it.
		await h.quizzes.create({ cwd: notes, sessionId: SESSION_ID, subject: "session", focus: "design" });
		await h.quizzes.idle();
		expect(h.launches[0]!.prompt).toContain("**Design.**");
		expect(h.launches[0]!.prompt).not.toContain("**Implementation.**");
	});

	it("allows no background question in an implementation quiz, and asks only about code", async () => {
		const h = harness("t4", quizOf(good.code, good.background, good.open));
		const { id } = await h.quizzes.create({
			cwd: scratch,
			sessionId: SESSION_ID,
			subject: "session",
			focus: "implementation",
		});
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		// The background question is not one here, so it cites nothing and is dropped.
		expect(quiz.questions.map(q => q.prompt)).toEqual([good.code.prompt, good.open.prompt]);
		expect(quiz.questions.every(q => q.background === undefined)).toBe(true);
		expect(h.launches[0]!.prompt).toContain("**Implementation.**");
	});

	it("needs the session, a known subject and a known focus", async () => {
		const h = harness("t5", quizOf(good.open));
		await expect(h.quizzes.create({ cwd: scratch, subject: "session" })).rejects.toThrow(
			"A quiz on a session's topic needs the session.",
		);
		await expect(
			h.quizzes.create({ cwd: scratch, sessionId: SESSION_ID, subject: "everything" as never }),
		).rejects.toThrow("invalid subject");
		await expect(
			h.quizzes.create({ cwd: scratch, sessionId: SESSION_ID, subject: "session", focus: "trivia" as never }),
		).rejects.toThrow("invalid focus");
		await expect(h.quizzes.folder("relative/path")).rejects.toThrow();
	});

	it("fails with a clear reason when nothing the agent wrote holds up", async () => {
		const h = harness("t6", quizOf(good.badQuote, good.badFile));
		const { id } = await h.quizzes.create({ cwd: scratch, sessionId: SESSION_ID, subject: "session" });
		await h.quizzes.idle();
		expect(h.quizzes.summary(id)).toMatchObject({
			status: "failed",
			error: "None of the agent's questions held up against the folder and the conversation.",
		});
	});
});

describe("a quiz on the topic of a session in a git folder", () => {
	let repo: string;

	beforeAll(async () => {
		repo = path.join(tmp, "demo");
		await fs.mkdir(repo, { recursive: true });
		await git(repo, "init", "-q", "-b", "main");
		await fs.writeFile(path.join(repo, "stats.py"), STATS);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "init");
		// Not committed: the quiz reads the working tree.
		await fs.mkdir(path.join(repo, "notes"), { recursive: true });
		await fs.writeFile(path.join(repo, "notes/design.md"), DESIGN);
	});

	it("reads the working tree as it was snapshotted, so a later edit does not change the quiz, and leaves the repository alone", async () => {
		const h = harness("g1", quizOf(good.open, good.code));
		expect(await h.quizzes.folder(repo)).toMatchObject({ git: true, code: true, files: 2, name: "demo" });
		const { id } = await h.quizzes.create({ cwd: repo, sessionId: SESSION_ID, subject: "session", focus: "design" });
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		expect(quiz.questions.map(q => q.id)).toEqual(["q1", "q2"]);
		expect(quiz.parts[0]).toMatchObject({ title: "The topic of the session", head: { ref: "@worktree" } });
		expect(quiz.parts[0]!.base).toBeUndefined();
		expect(h.launches[0]!.prompt).toContain("notes/design.md");
		expect(await git(repo, "status", "--porcelain")).toBe("?? notes/");

		await fs.writeFile(path.join(repo, "notes/design.md"), "# Rewritten\n");
		const [excerpt] = await h.quizzes.excerpt(id, 0, [quiz.questions[0]!.refs[0]!]);
		expect(excerpt!.lines.join("\n")).toContain("We use CKKS because");
		await fs.writeFile(path.join(repo, "notes/design.md"), DESIGN);

		await h.quizzes.remove(id);
		expect(await git(repo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("is listed with the quizzes of its folder, with what it is about", async () => {
		const h = harness("g2", quizOf(good.code));
		await h.quizzes.create({ cwd: repo, sessionId: SESSION_ID, subject: "session", focus: "implementation" });
		await h.quizzes.idle();
		expect(await h.quizzes.list(repo)).toMatchObject([{ about: "session", focus: "implementation" }]);
		expect(await h.quizzes.list(undefined)).toHaveLength(1);
	});
});

describe("a quiz of changes with a focus, and an old stored quiz", () => {
	let repo: string;

	beforeAll(async () => {
		repo = path.join(tmp, "changes");
		await fs.mkdir(repo, { recursive: true });
		await git(repo, "init", "-q", "-b", "main");
		await fs.writeFile(path.join(repo, "stats.py"), "def mean(xs):\n    return 0\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "init");
		await git(repo, "checkout", "-q", "-b", "feature");
		await fs.writeFile(path.join(repo, "stats.py"), STATS);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "mean");
	});

	it("states the focus and lets a design quiz cite the conversation, and keeps the quiz about its changes", async () => {
		const h = harness("c1", quizOf(good.code, { ...good.open, refs: [] }));
		const { id } = await h.quizzes.create({
			cwd: repo,
			ref: "feature",
			base: "main",
			sessionId: SESSION_ID,
			focus: "design",
		});
		await h.quizzes.idle();
		const prompt = h.launches[0]!.prompt;
		expect(prompt).toContain("Focus of this quiz: **design**");
		expect(prompt).toContain(`[#${USER_ENTRY}] User:`);
		expect(prompt).toContain('"session": [{"entry"');
		const { quiz } = await h.quizzes.get(id);
		expect(quiz).toMatchObject({ about: "changes", focus: "design" });
		// A question that cites only the conversation holds in a quiz of changes too.
		expect(quiz.questions).toHaveLength(2);
		expect(quiz.questions[1]!.session).toHaveLength(1);
	});

	it("leaves the brief of a mixed quiz without conversation citations as before", async () => {
		const h = harness("c2", quizOf(good.code));
		await h.quizzes.create({ cwd: repo, ref: "feature", base: "main", sessionId: SESSION_ID });
		await h.quizzes.idle();
		const prompt = h.launches[0]!.prompt;
		expect(prompt).not.toContain("Focus of this quiz");
		expect(prompt).not.toContain('"session": [{"entry"');
		expect(prompt).not.toContain(`[#${USER_ENTRY}]`);
	});

	it("loads a quiz stored before focus and topic existed, and still answers it", async () => {
		const h = harness("c3", quizOf(good.code));
		const { id } = await h.quizzes.create({ cwd: repo, ref: "feature", base: "main" });
		await h.quizzes.idle();
		// Rewrite its files as an older companion wrote them: no about, no focus.
		const dir = path.join(tmp, "c3", "agent", "quizzes");
		const docFile = path.join(dir, `${id}.json`);
		const doc = JSON.parse(await fs.readFile(docFile, "utf8"));
		delete doc.quiz.about;
		delete doc.quiz.focus;
		await fs.writeFile(docFile, JSON.stringify(doc));
		const indexFile = path.join(dir, "index.json");
		const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
		for (const summary of index.quizzes) {
			delete summary.about;
			delete summary.focus;
		}
		await fs.writeFile(indexFile, JSON.stringify(index));

		const again = createQuizzes({
			storeDir: dir,
			cacheDir: path.join(tmp, "c3", "cache", "quizzes"),
			sessionsDir: path.join(tmp, "sessions"),
			now: () => Date.now(),
			changed: () => undefined,
			agent: null,
			ompBin: "omp",
			run: async () => ({ code: 1, out: "", err: "no model" }),
			watch: { pollMs: 10, settleMs: 30 },
		});
		await again.init();
		const [summary] = await again.list(repo);
		expect(summary).toMatchObject({ id, status: "ready", questionCount: 1 });
		expect(summary).not.toHaveProperty("about");
		const { quiz } = await again.get(id);
		expect(quiz.about).toBeUndefined();
		expect(quiz.questions[0]!.refs).toHaveLength(1);
		const [excerpt] = await again.excerpt(id, 0, [quiz.questions[0]!.refs[0]!]);
		expect(excerpt!.lines.join("\n")).toContain("sum(xs)");
	});
});
