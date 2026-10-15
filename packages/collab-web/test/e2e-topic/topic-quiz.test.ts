import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { answerQuiz, createQuiz, getQuiz, getQuizFolder, listQuizzes } from "../../src/components/quiz/quiz-api";
import type { GuestClient } from "../../src/lib/client";
import type { CompanionHost } from "../../src/lib/companion";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { stubModelsYml } from "../../scripts/e2e-personal-stub";
import { SCENARIO_TIMEOUT_MS, describeE2e } from "../e2e-personal/support";

const FIRST =
	"FHE-STATS-1: I want the mean and variance of salaries computed on encrypted data, never decrypted on the server. CKKS or BFV?";
const FIRST_REPLY =
	"We use CKKS: salaries are real numbers and CKKS does approximate arithmetic, so each result carries a small error we can bound. BFV would be exact, but only on integers.";
const SECOND = "FHE-STATS-2: Why does the noise budget matter for the variance?";
const SECOND_REPLY =
	"The variance needs a multiplication (squaring), and every multiplication consumes noise budget, so the design allows one level of multiplication and no more.";
const DESIGN =
	"# Statistics over encrypted salaries\n\nWe use CKKS because salaries are real numbers.\nThe server never holds the secret key.\nThe variance is computed as E[x^2] - E[x]^2, one multiplication deep.\n";
const STATS =
	"def mean(cts):\n    return sum(cts) / len(cts)\n\n\ndef variance(cts):\n    squares = [c * c for c in cts]\n    return mean(squares) - mean(cts) * mean(cts)\n";

/**
 * A quiz on a session's topic, end to end, for a session with no project: the real companion, a real omp session in tmux
 * in a scratch folder (not a git repository), the quiz-writing session, and a scripted model. The conversation about
 * statistics over fully homomorphic encryption is scripted, the question writer is scripted to cite it, the folder's
 * files and general background, and to write questions that do not hold. Run with `bun run e2e:topic`.
 */
describeE2e("a quiz on the topic of a session with no project", () => {
	let h: PersonalHarness;
	let guest: GuestClient;
	let host: CompanionHost;
	let folder: string;

	/** The assistant's text for the turn whose prompt holds `marker`. */
	const reply = (marker: string, text: string): void =>
		h.stub.enqueue(
			{ text },
			request => request.transcript.includes(marker) && !request.lastUser.includes("title-request"),
		);

	/**
	 * Send `prompt` as the paired device and wait for the turn: the scripted model answers `text`, the turn ends and omp has
	 * written both messages to the session file of this computer's agent folder (the quiz companion reads it from there).
	 */
	const turn = async (prompt: string, text: string): Promise<void> => {
		reply(prompt.slice(0, "FHE-STATS-1".length), text);
		const after = h.stub.requests.at(-1)?.n ?? 0;
		guest.sendPrompt(prompt);
		await h.stub.waitForRequest(request => request.transcript.includes(prompt), { after });
		await h.settle(guest);
		const sessions = path.join(h.configDir, "agent", "sessions");
		await until(
			"omp to write the turn to the session file",
			async () => {
				for await (const file of new Bun.Glob("**/*.jsonl").scan(sessions)) {
					if ((await Bun.file(path.join(sessions, file)).text()).includes(text)) return true;
				}
				return false;
			},
			{ timeoutMs: 30_000 },
		);
	};

	/** Script the question writer: it reads the entry ids from the brief, as a real one would, and writes `questions`. */
	const scriptQuizWriter = (
		questions: (ids: { user: string; agent: string }) => unknown[],
		outcome: { brief?: string[] } = {},
	): void => {
		h.stub.enqueue(
			request => {
				const target = /(\/\S*\/cache\/quizzes\/out\/\S+?\.json)/.exec(request.transcript)?.[1];
				if (!target) throw new Error("the quiz prompt names no output file");
				const user = /\[#(\S+?)\] User: FHE-STATS-1/.exec(request.transcript)?.[1];
				const agent = /\[#(\S+?)\] Assistant: We use CKKS/.exec(request.transcript)?.[1];
				if (!user || !agent) throw new Error("the brief has no entry ids for the conversation");
				outcome.brief = [request.transcript];
				const content = JSON.stringify({ parts: [{ part: 1, questions: questions({ user, agent }) }] });
				return { tools: [{ name: "write", args: { path: target, content } }] };
			},
			request =>
				request.transcript.includes("/cache/quizzes/out/") && request.messages.every(m => m.role !== "tool"),
		);
	};

	beforeAll(async () => {
		h = await PersonalHarness.start({
			defaultConfigYaml: "modelRoles:\n  default: stub/stub-model\nstartup:\n  setupWizard: false",
		});
		await Bun.write(path.join(h.configDir, "agent", "models.yml"), stubModelsYml(h.stub));
		await until("the companion to advertise topic quizzes", () => h.client.getSnapshot().canQuizTopic, {
			timeoutMs: 60_000,
		});
		const instanceId = await h.client.startSession(h.home, { scratch: { hint: "fhe statistics" } });
		host = await until(
			"the session's host row",
			() => h.client.getSnapshot().hosts.find(candidate => candidate.instanceId === instanceId),
			{ timeoutMs: 90_000 },
		);
		folder = host.cwd;
		guest = await h.openSession(host);
		await turn(FIRST, FIRST_REPLY);
		await turn(SECOND, SECOND_REPLY);
		await fs.mkdir(path.join(folder, "notes"), { recursive: true });
		await Bun.write(path.join(folder, "notes/design.md"), DESIGN);
		await Bun.write(path.join(folder, "stats.py"), STATS);
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	it(
		"knows the folder is not a repository, and has code and files to quiz on",
		async () => {
			expect(folder).toContain(`${path.sep}scratch${path.sep}`);
			expect(await getQuizFolder(h.client, folder)).toMatchObject({
				git: false,
				code: true,
				name: "Scratch · fhe statistics",
			});
			expect((await getQuizFolder(h.client, folder)).files).toBeGreaterThanOrEqual(2);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"writes a quiz from the conversation, the folder's files and general background, and keeps only questions that hold",
		async () => {
			const outcome: { brief?: string[] } = {};
			scriptQuizWriter(
				ids => [
					{
						kind: "open",
						topic: "Why CKKS here",
						prompt: "Why was CKKS chosen for the salaries, and what does that cost?",
						reminder: "CKKS computes on approximate real numbers.",
						session: [{ entry: ids.agent, quote: "CKKS does approximate arithmetic" }],
						refs: ["notes/design.md@3@CKKS"],
						rubric: { points: ["salaries are real numbers", "results are approximate"], misconceptions: [] },
					},
					{
						kind: "choice",
						topic: "Exact or approximate",
						prompt: "Which scheme did the session choose for the salaries?",
						reminder: "Think of what the salaries are.",
						session: [{ entry: ids.user, quote: "never decrypted on the server" }],
						choices: ["CKKS", "BFV", "TFHE"],
						answer: "a",
						explanation: "The session chose CKKS because salaries are real numbers.",
					},
					{
						kind: "choice",
						background: true,
						topic: "BFV versus CKKS",
						prompt: "Which scheme computes exactly on integers?",
						reminder: "The two schemes differ in what they encode.",
						choices: ["BFV", "CKKS", "Both are approximate"],
						answer: "a",
						explanation:
							"BFV encodes integers modulo a plaintext modulus and is exact; CKKS encodes approximate reals.",
					},
					{
						kind: "choice",
						topic: "Depth of the variance",
						prompt: "How deep is the variance in multiplications, as the design has it?",
						reminder: "Look at how the variance is written.",
						refs: ["notes/design.md@5@one multiplication deep"],
						choices: ["One level", "Two levels", "None"],
						answer: "a",
						explanation: "The design computes E[x^2] - E[x]^2, one multiplication deep.",
					},
					{
						kind: "choice",
						topic: "Squares",
						prompt: "What does `variance` do first?",
						reminder: "Read the function.",
						refs: ["stats.py@6@squares"],
						choices: ["Squares every ciphertext", "Decrypts them", "Sorts them"],
						answer: "a",
						explanation: "It squares every ciphertext, then takes means.",
					},
					{
						kind: "open",
						topic: "Invented message",
						prompt: "What did the developer say about GPUs?",
						reminder: "Nothing.",
						session: [{ entry: ids.user, quote: "we must run all of this on the GPU cluster" }],
						rubric: { points: ["gpus"], misconceptions: [] },
					},
					{
						kind: "open",
						topic: "Invented file",
						prompt: "What does the key manager do?",
						reminder: "There is none.",
						refs: ["notes/design.md@3@KeyManager"],
						rubric: { points: ["key manager"], misconceptions: [] },
					},
				],
				outcome,
			);
			const id = await createQuiz(h.client, {
				cwd: folder,
				sessionId: host.sessionId,
				subject: "session",
				focus: "mixed",
			});
			await until(
				"the quiz to be written",
				async () => (await listQuizzes(h.client)).find(quiz => quiz.id === id)?.status === "ready",
				{ timeoutMs: 180_000, everyMs: 500 },
			);

			// The writer was given the conversation, the files and the focus.
			const brief = outcome.brief![0]!;
			expect(brief).toContain("FHE-STATS-1");
			expect(brief).toContain("approximate arithmetic");
			expect(brief).toContain("notes/design.md");
			expect(brief).toContain("**Mixed.**");

			const [summary] = (await listQuizzes(h.client)).filter(quiz => quiz.id === id);
			expect(summary).toMatchObject({ about: "session", focus: "mixed", status: "ready", questionCount: 5 });
			const { quiz } = await getQuiz(h.client, id);
			expect(quiz.questions.map(q => q.prompt)).toEqual([
				"Why was CKKS chosen for the salaries, and what does that cost?",
				"Which scheme did the session choose for the salaries?",
				"Which scheme computes exactly on integers?",
				"How deep is the variance in multiplications, as the design has it?",
				"What does `variance` do first?",
			]);
			expect(quiz.questions[0]!.session?.[0]).toMatchObject({ role: "assistant" });
			expect(quiz.questions[0]!.refs[0]).toMatchObject({ path: "notes/design.md", line: 3 });
			expect(quiz.questions[1]!.session?.[0]).toMatchObject({
				role: "user",
				quote: "never decrypted on the server",
			});
			expect(quiz.questions[2]).toMatchObject({ background: true, refs: [] });
			expect(quiz.warnings.join(" ")).toContain("Dropped the question");

			// Answering scores it; the background question's explanation is the companion's until it is answered.
			expect(JSON.stringify(quiz)).not.toContain("encodes integers modulo");
			let last;
			const rightText: Record<string, string> = {
				"Which scheme did the session choose for the salaries?": "CKKS",
				"Which scheme computes exactly on integers?": "BFV",
				"How deep is the variance in multiplications, as the design has it?": "One level",
				"What does `variance` do first?": "Squares every ciphertext",
			};
			for (const question of quiz.questions.filter(q => q.kind === "choice")) {
				const right = question.choices!.find(c => c.text === rightText[question.prompt])!;
				const answered = await answerQuiz(h.client, id, "a1", question.id, { choice: right.id });
				expect(answered.verdict.kind).toBe("right");
				last = answered;
			}
			expect(last!.attempt.score.points).toBe(4);

			// The folder changes afterwards: the quiz keeps the text it was made from.
			await fs.rm(path.join(folder, "notes/design.md"));
			const again = await getQuiz(h.client, id);
			expect(again.quiz.questions[0]!.refs[0]!.path).toBe("notes/design.md");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses implementation questions for a folder with no code",
		async () => {
			const notes = path.join(path.dirname(folder), "2026-07-01-only-notes-a1b2c3");
			await fs.mkdir(notes, { recursive: true });
			await Bun.write(path.join(notes, "plan.md"), "# Plan\n\nA plan with no code.\n");
			expect(await getQuizFolder(h.client, notes)).toMatchObject({ git: false, code: false, files: 1 });
			await expect(
				createQuiz(h.client, {
					cwd: notes,
					sessionId: host.sessionId,
					subject: "session",
					focus: "implementation",
				}),
			).rejects.toThrow("Implementation questions need code, and this folder has none.");
		},
		SCENARIO_TIMEOUT_MS,
	);
});
