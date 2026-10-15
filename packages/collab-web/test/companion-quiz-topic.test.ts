import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizQuestion } from "@oh-my-pi/pi-wire/quiz";
import { buildQuizBrief, buildTopicBrief } from "../scripts/companion-quiz-agent";
import type { DigestEntry } from "../scripts/companion-quiz-digest";
import { extractTurns } from "../scripts/companion-quiz-digest";
import {
	copyFolderFiles,
	folderInfo,
	hasCode,
	listFolderFiles,
	MAX_FOLDER_FILES,
	readFolderFile,
} from "../scripts/companion-quiz-folder";
import { buildGradePrompt, GRADE_SYSTEM_PROMPT, renderReference } from "../scripts/companion-quiz-grade";
import { MIN_QUOTE_CHARS } from "../scripts/companion-quiz-session";
import { parseQuizOutput, verifyQuiz } from "../scripts/companion-quiz-verify";

const ENTRIES = new Map<string, DigestEntry>([
	[
		"u1",
		{
			role: "user",
			text: "Compute the mean and the variance of the salaries without ever decrypting\nthem on the server.",
		},
	],
	["a1", { role: "assistant", text: "CKKS is approximate, so  the result carries a small   error we can bound." }],
]);

const open = (over: Record<string, unknown> = {}) => ({
	kind: "open",
	topic: "A topic",
	prompt: "Why?",
	reminder: "Remember.",
	refs: [],
	rubric: { points: ["says why"], misconceptions: [] },
	...over,
});

async function verify(
	questions: unknown[],
	options: { entries?: ReadonlyMap<string, DigestEntry>; background?: boolean },
) {
	const warnings: string[] = [];
	const parsed = parseQuizOutput({ questions: questions.map(q => ({ part: 1, ...(q as object) })) }, 1, warnings, {
		background: options.background,
	});
	return await verifyQuiz(parsed, { lines: async () => null, entries: options.entries }, "qz-1");
}

describe("conversation citations", () => {
	it("keeps a quote found in the message it names, whitespace aside, and records the role", async () => {
		const result = await verify(
			[
				open({
					prompt: "What did the developer want?",
					session: [{ entry: "u1", quote: "mean and the variance of the salaries without ever decrypting them" }],
				}),
				open({ prompt: "What kind of error?", session: [{ entry: "#a1", quote: "…a small error we can bound." }] }),
			],
			{ entries: ENTRIES },
		);
		expect(result.questions.map(q => q.session)).toEqual([
			[
				{
					entry: "u1",
					role: "user",
					quote: "mean and the variance of the salaries without ever decrypting them",
				},
			],
			[{ entry: "a1", role: "assistant", quote: "a small error we can bound." }],
		]);
		expect(result.stats.session).toEqual({ verified: 2, dropped: 0 });
	});

	it("drops a wrong quote, an unknown message and a quote too short to prove anything, and the question with them", async () => {
		const result = await verify(
			[
				open({ prompt: "Wrong quote", session: [{ entry: "u1", quote: "the server decrypts everything first" }] }),
				open({
					prompt: "Unknown entry",
					session: [{ entry: "zz9", quote: "mean and the variance of the salaries" }],
				}),
				open({ prompt: "Short quote", session: [{ entry: "u1", quote: "salaries" }] }),
				open({
					prompt: "Quote of the other message",
					session: [{ entry: "a1", quote: "mean and the variance of" }],
				}),
				open({
					prompt: "One good, one bad",
					session: [
						{ entry: "u1", quote: "the mean and the variance" },
						{ entry: "u1", quote: "invented words that are long" },
					],
				}),
			],
			{ entries: ENTRIES },
		);
		expect("salaries".length).toBeLessThan(MIN_QUOTE_CHARS);
		expect(result.questions.map(q => q.prompt)).toEqual(["One good, one bad"]);
		expect(result.questions[0]!.session).toHaveLength(1);
		expect(result.stats.session).toEqual({ verified: 1, dropped: 5 });
		expect(result.stats.questionsDropped).toBe(4);
		expect(result.warnings.join(" ")).toContain("there is no such message");
		expect(result.warnings.join(" ")).toContain("not in that message");
	});

	it("drops every conversation citation when the conversation could not be read", async () => {
		const result = await verify(
			[open({ session: [{ entry: "u1", quote: "mean and the variance of the salaries" }] })],
			{},
		);
		expect(result.questions).toEqual([]);
		expect(result.warnings.join(" ")).toContain("the conversation was not available");
	});

	it("takes the entry ids from the transcript's own entries, so a citation can be shown in it", () => {
		const entries = [
			{
				type: "message",
				id: "e1a1b2c3",
				message: { role: "user", content: "How does CKKS differ from BFV here?" },
			},
			{
				type: "message",
				id: "e2a1b2c3",
				message: { role: "assistant", content: [{ type: "text", text: "CKKS is approximate; BFV is exact." }] },
			},
		];
		expect(extractTurns(entries, { ids: true }).map(turn => [turn.id, turn.role])).toEqual([
			["e1a1b2c3", "user"],
			["e2a1b2c3", "assistant"],
		]);
	});
});

describe("background questions", () => {
	const background = (over: Record<string, unknown> = {}) =>
		open({
			background: true,
			prompt: "What is the noise budget in an FHE scheme?",
			explanation: "Each homomorphic operation adds noise; when it grows past a bound, decryption fails.",
			...over,
		});

	it("keeps one with an explanation in a quiz that allows them, with no citation, and stores the explanation", async () => {
		const result = await verify([background()], { background: true });
		expect(result.questions).toHaveLength(1);
		expect(result.questions[0]).toMatchObject({ background: true, refs: [] });
		expect(result.questions[0]).not.toHaveProperty("session");
		expect(result.keys.q1!.explanation).toContain("decryption fails");
	});

	it("asks a choice question to have a definitive answer, and gives it its explanation", async () => {
		const result = await verify(
			[
				background({
					kind: "choice",
					rubric: undefined,
					choices: ["Exact integers", "Approximate real numbers", "Only booleans"],
					answer: "b",
					explanation: "CKKS encodes approximate real numbers; BFV works on exact integers.",
				}),
				background({
					kind: "choice",
					rubric: undefined,
					prompt: "Which one?",
					choices: ["x", "y"],
					answer: "maybe",
				}),
			],
			{ background: true },
		);
		expect(result.questions.map(q => q.kind)).toEqual(["choice"]);
		expect(Object.keys(result.questions[0]!)).not.toContain("explanation");
		expect(result.keys.q1!.explanation).toContain("approximate real numbers");
	});

	it("skips one with no explanation, and refuses background questions in a quiz of changes", async () => {
		await expect(verify([background({ explanation: undefined })], { background: true })).rejects.toThrow(
			"None of the agent's questions could be used.",
		);
		const inChanges = await verify([background()], {});
		expect(inChanges.questions).toEqual([]);
		expect(inChanges.warnings.join(" ")).toContain("it cites nothing");
	});

	it("strips citations a background question carries: it is general knowledge, not the code", async () => {
		const result = await verify(
			[background({ refs: ["a.ts@1@x"], session: [{ entry: "u1", quote: "mean and the variance" }] })],
			{ background: true, entries: ENTRIES },
		);
		expect(result.questions[0]).toMatchObject({ background: true, refs: [] });
		expect(result.questions[0]).not.toHaveProperty("session");
	});
});

describe("the grader of a question without code", () => {
	const question: QuizQuestion = {
		id: "q1",
		part: 0,
		kind: "open",
		prompt: "What is the noise budget?",
		topic: "Noise",
		refs: [],
		background: true,
		session: [{ entry: "a1", role: "assistant", quote: "the result carries a small error we can bound" }],
	};

	it("is given the explanation and the cited passages, and told not to reward vagueness", () => {
		const prompt = buildGradePrompt({
			question,
			partTitle: "The topic of the session",
			rubric: { points: ["noise grows per operation"], misconceptions: [] },
			excerpts: "",
			explanation: "Each operation adds noise.",
			answer: "It is about how much you can do.",
		});
		expect(prompt).toContain("general background knowledge");
		expect(prompt).toContain("Each operation adds noise.");
		expect(prompt).toContain('The agent: "the result carries a small error we can bound"');
		expect(renderReference({ question: { ...question, background: undefined, session: undefined } })).toBe("");
		expect(GRADE_SYSTEM_PROMPT).toContain("Do not reward vague answers");
	});
});

describe("the brief of a quiz on a topic", () => {
	const base = {
		repo: "Scratch · fhe statistics",
		checkout: "a copy of the folder's text files",
		outFile: "/tmp/out.json",
		maxCostUsd: 0.75,
		files: ["notes/design.md", "src/stats.py"],
		code: true,
		digest: { text: "[#u1] User: mean and variance over ciphertexts", turns: 1, omitted: 0 },
	} as const;

	it("states each focus, and always allows conversation, file and background sources", () => {
		for (const focus of ["mixed", "understanding", "design", "implementation"] as const) {
			const brief = buildTopicBrief({ ...base, focus });
			expect(brief).toContain("notes/design.md");
			expect(brief).toContain("[#u1] User: mean and variance over ciphertexts");
			expect(brief).toContain("explanation");
		}
		const understanding = buildTopicBrief({ ...base, focus: "understanding" });
		const design = buildTopicBrief({ ...base, focus: "design" });
		const implementation = buildTopicBrief({ ...base, focus: "implementation" });
		expect(understanding).toContain("background");
		expect(design).toContain("trade-offs");
		expect(implementation).toContain("how the implementation does it");
		expect(implementation).not.toBe(design);
	});

	it("does not ask for implementation questions of a folder without code", () => {
		const brief = buildTopicBrief({ ...base, focus: "mixed", code: false, files: ["notes/design.md"] });
		expect(brief).not.toBe(buildTopicBrief({ ...base, focus: "mixed" }));
		expect(brief).toContain("ask no implementation question");
	});

	it("works with no conversation and with no files", () => {
		expect(buildTopicBrief({ ...base, focus: "mixed", digest: undefined })).toContain("could not be read");
		expect(buildTopicBrief({ ...base, focus: "mixed", files: [], code: false })).toContain("there are none to read");
	});
});

describe("the brief of a quiz of changes", () => {
	const input = {
		repo: "demo",
		subject: "feature vs main",
		checkout: "the changed code",
		outFile: "/tmp/out.json",
		maxCostUsd: 0.75,
		stack: false,
		parts: [{ title: "Changes", about: "branch feature vs main", stat: "", diff: "diff" }],
	} as never;

	it("asks about a quarter design and understanding questions of a high-stakes quiz, and only the new changes of a delta one", () => {
		const full = buildQuizBrief({ ...(input as object), stakes: { delta: false }, focus: "mixed" } as never);
		expect(full).toContain("about a quarter (25 %)");
		expect(full).toContain("never more than a third");
		expect(full).not.toContain("new changes only");
		const delta = buildQuizBrief({ ...(input as object), stakes: { delta: true }, focus: "mixed" } as never);
		expect(delta).toContain("new changes only");
		expect(buildQuizBrief({ ...(input as object), focus: "mixed" } as never)).not.toContain("about a quarter");
	});

	it("leaves a plain mixed quiz as it was, and states the focus otherwise", () => {
		const plain = buildQuizBrief(input);
		const design = buildQuizBrief({ ...(input as object), focus: "design" } as never);
		expect(plain).not.toContain("Focus of this quiz");
		expect(design).toContain("Focus of this quiz: **design**");
	});
});

describe("reading a folder that is not a repository", () => {
	let tmp: string;
	let folder: string;

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quiz-folder-")));
		folder = path.join(tmp, "scratch", "2026-07-01-fhe-statistics-a1b2c3");
		await fs.mkdir(path.join(folder, "notes"), { recursive: true });
		await fs.mkdir(path.join(folder, "node_modules/pkg"), { recursive: true });
		await fs.mkdir(path.join(folder, ".git-like"), { recursive: true });
		await fs.writeFile(path.join(folder, "notes/design.md"), "# Design\n\nWe use CKKS.\n");
		await fs.writeFile(path.join(folder, "stats.py"), "def mean(xs):\n    return sum(xs) / len(xs)\n");
		await fs.writeFile(path.join(folder, ".env"), "SECRET=1\n");
		await fs.writeFile(path.join(folder, ".git-like/x.md"), "hidden\n");
		await fs.writeFile(path.join(folder, "node_modules/pkg/index.js"), "x\n");
		await fs.writeFile(path.join(folder, "blob.bin"), Buffer.from([1, 0, 2, 0]));
		await fs.writeFile(path.join(folder, "nul.txt"), Buffer.from("a\0b"));
		await fs.writeFile(path.join(tmp, "outside.txt"), "outside the folder\n");
		await fs.symlink(path.join(tmp, "outside.txt"), path.join(folder, "link.txt"));
	});

	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("describes it by its scratch label and lists its text files, not dotfiles, dependencies or binaries", async () => {
		const info = await folderInfo(folder);
		expect(info).toMatchObject({ git: false, name: "Scratch · fhe statistics", root: folder, checkout: folder });
		const files = await listFolderFiles(info);
		expect(files).toEqual(["notes/design.md", "nul.txt", "stats.py"]);
		expect(files).not.toContain(".env");
		expect(files).not.toContain(".git-like/x.md");
		expect(files.some(file => file.startsWith("node_modules/"))).toBe(false);
		expect(files).not.toContain("blob.bin");
		expect(files.length).toBeLessThanOrEqual(MAX_FOLDER_FILES);
		expect(hasCode(files)).toBe(true);
		expect(hasCode(["notes/design.md", "data.csv"])).toBe(false);
		await expect(folderInfo(path.join(folder, "missing"))).rejects.toThrow("invalid folder");
	});

	it("reads only what a citation may name: nothing outside the folder, no dotfile, no binary", async () => {
		expect(await readFolderFile(folder, "notes/design.md")).toEqual(["# Design", "", "We use CKKS.", ""]);
		expect(await readFolderFile(folder, "stats.py")).toEqual(["def mean(xs):", "    return sum(xs) / len(xs)", ""]);
		for (const rel of [
			"../outside.txt",
			"/etc/passwd",
			"link.txt",
			".env",
			".git-like/x.md",
			"nul.txt",
			"missing.md",
			"notes",
		])
			expect(await readFolderFile(folder, rel)).toBeNull();
	});

	it("copies the listed files, skipping what is not a regular file, so the agent reads a fixed copy", async () => {
		const info = await folderInfo(folder);
		const to = path.join(tmp, "copy");
		const copied = await copyFolderFiles(info.checkout, await listFolderFiles(info), to);
		expect(copied).toEqual(expect.arrayContaining(["notes/design.md", "stats.py"]));
		expect(copied).not.toContain("link.txt");
		await fs.writeFile(path.join(folder, "notes/design.md"), "changed afterwards\n");
		expect(await fs.readFile(path.join(to, "notes/design.md"), "utf8")).toBe("# Design\n\nWe use CKKS.\n");
		await fs.writeFile(path.join(folder, "notes/design.md"), "# Design\n\nWe use CKKS.\n");
	});
});
