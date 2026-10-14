/**
 * "Quiz me" for the companion's `quiz-*` requests: questions that test whether the user understood a set of code
 * changes (a branch or working tree against the default branch, or the pull requests of a stack, one part each). The
 * wire contract is `@oh-my-pi/pi-wire/quiz`.
 *
 * Writing the questions reuses what architecture maps are built from: refs resolve to commits and are held under private
 * refs (./companion-blueprint-git), a restricted read-only omp session in a throw-away checkout writes JSON to one result
 * file (./companion-agent), and every citation is verified against its commit (./companion-citations, via
 * ./companion-quiz-verify). The session is given each part's numbered diff (./companion-quiz-diff), the title and
 * description of each pull request (read-only `gh`, ./companion-quiz-stack) and, when a session id is given, a digest of
 * that session's conversation (./companion-quiz-digest) so it can ask why things were done.
 *
 * Grading never reaches a device before the answer: the rubric and the right choices stay in the stored document
 * (./companion-quiz-store). A choice is graded here; an open answer by one small headless model call
 * (./companion-quiz-grade). Writing the questions and grading together stay inside the quiz's spending limit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlueprintExcerpt, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	QUIZ_MAX_ANSWER_CHARS,
	QUIZ_MAX_PARTS,
	type Quiz,
	type QuizAnswerRecord,
	type QuizAttempt,
	type QuizCreate,
	type QuizGetAnswer,
	type QuizStackPr,
	type QuizStackSource,
	type QuizSummary,
	type QuizVerdict,
	QUIZ_VERSION,
	scoreAttempt,
} from "@oh-my-pi/pi-wire/quiz";
import {
	type AgentRunner,
	type AgentWatchOptions,
	agentFailureReason,
	agentFolderName,
	checkRunRequest,
	parseAgentJson,
	prepareOutputFile,
	READONLY_AGENT_TOOLS,
	restrictedOverlayYaml,
	runAgentToFile,
} from "./companion-agent";
import {
	addWorktree,
	defaultBranch,
	pruneLeftoverWorktrees,
	readBlob,
	removeWorktreeDir,
	repoInfo,
	resolveTarget,
} from "./companion-blueprint-git";
import { splitLines } from "./companion-excerpt";
import { headlessRunner, type RunOmp } from "./companion-headless";
import { buildQuizBrief, DEFAULT_QUIZ_MAX_COST_USD } from "./companion-quiz-agent";
import {
	DEFAULT_GRADE_MODEL,
	GRADE_TIMEOUT_MS,
	type GradeOpenResult,
	GradeError,
	gradeChoice,
	gradeOpen,
	MIN_GRADE_BUDGET_USD,
	renderExcerpts,
} from "./companion-quiz-grade";
import { detectStack, ghPrSource, type PrSource } from "./companion-quiz-stack";
import { createQuizStore, type QuizDoc } from "./companion-quiz-store";
import { type ParsedQuestion, parseQuizOutput, verifyQuiz } from "./companion-quiz-verify";
import {
	briefParts,
	Cancelled,
	checkSessionId,
	createRunSlots,
	errorText,
	type Job,
	type Locks,
	locked,
	partExcerpts,
	positiveInt,
	prRange,
	pullRequestNumbers,
	readDigest,
	releaseParts,
	resolveParts,
	type Run,
	verifiedRefs,
} from "./companion-review-base";

/** Quizzes written at once; the rest wait their turn. */
const MAX_CONCURRENT_RUNS = 2;
/** Of the spending limit, what the question-writing session may use; grading gets the rest and whatever it leaves. */
const GENERATION_SHARE = 0.75;

export interface QuizDeps {
	/** `<agent dir>/quizzes`: the index and the quizzes. */
	storeDir: string;
	/** `<config dir>/cache/quizzes`: `work/` (checkouts), `out/` (the agent's result files), `overlay/`. */
	cacheDir: string;
	/** `<agent dir>/sessions`, where the conversations of sessions are. */
	sessionsDir: string;
	now(): number;
	/** A quiz's summary changed: tell the connected devices. */
	changed(id: string): void;
	/** The session writing the questions; null when this computer cannot run one (no tmux), and no quiz can be made. */
	agent: AgentRunner | null;
	/** The omp program a grading call runs. */
	ompBin: string;
	/** Runs a grading call; tests replace it. */
	run?: RunOmp;
	/** Model of a grading call: a role (`@smol`) or a model id. */
	gradeModel?: string;
	/** The pull requests of a repository; tests replace it. */
	prSource?: (root: string) => PrSource;
	/** Timing of the wait for the agent; tests shorten it. */
	watch?: Partial<AgentWatchOptions>;
	log?(message: string): void;
}

export interface Quizzes {
	/** Load the index, mark what a previous run left as interrupted, remove leftover checkouts. */
	init(): Promise<void>;
	list(cwd: string | undefined): Promise<QuizSummary[]>;
	create(request: QuizCreate): Promise<{ id: string }>;
	get(id: string): Promise<QuizGetAnswer>;
	answer(request: { id: string; attempt: string; question: string; text?: unknown; choice?: unknown }): Promise<{
		verdict: QuizVerdict;
		attempt: QuizAttempt;
	}>;
	retry(request: { id: string; from?: string; only?: unknown }): Promise<{ attempt: QuizAttempt }>;
	excerpt(id: string, part: number, refs: readonly BlueprintRef[]): Promise<(BlueprintExcerpt | null)[]>;
	remove(id: string): Promise<void>;
	stack(cwd: string, pr: number): Promise<{ stack: QuizStackPr[]; source: QuizStackSource }>;
	/** Mark runs in flight as interrupted and end their sessions. */
	shutdown(): Promise<void>;
	/** Resolves when no run is in flight. */
	idle(): Promise<void>;
}

export function createQuizzes(deps: QuizDeps): Quizzes {
	const store = createQuizStore(deps.storeDir);
	const workDir = path.join(deps.cacheDir, "work");
	const outDir = path.join(deps.cacheDir, "out");
	const overlayDir = path.join(deps.cacheDir, "overlay");
	const runs = new Map<string, Run>();
	const locks: Locks = new Map();
	const slots = createRunSlots(MAX_CONCURRENT_RUNS);
	const log = deps.log ?? (() => undefined);
	const prSource = deps.prSource ?? ghPrSource;
	const runOmp = deps.run ?? headlessRunner(GRADE_TIMEOUT_MS);

	const update = async (run: Run, patch: Partial<QuizSummary>): Promise<void> => {
		if (run.cancelled) throw new Cancelled();
		const current = store.get(run.id);
		if (!current) throw new Cancelled();
		await store.put({ ...current, ...patch });
		deps.changed(run.id);
	};
	const progress = (run: Run, text: string): Promise<void> => update(run, { progress: text });

	function summaryOf(doc: QuizDoc, current: QuizSummary): QuizSummary {
		const answered = doc.attempts.filter(attempt => Object.keys(attempt.answers).length > 0);
		const last = answered[answered.length - 1];
		const { latest: _latest, ...rest } = current;
		return {
			...rest,
			status: "ready",
			progress: undefined,
			error: undefined,
			instanceId: undefined,
			partCount: doc.quiz.parts.length,
			questionCount: doc.quiz.questions.length,
			attemptCount: doc.attempts.length,
			...(last
				? {
						latest: {
							points: last.score.points,
							total: last.score.total,
							percent: last.score.percent,
							finished: last.finishedAt !== undefined,
							at: last.finishedAt ?? last.startedAt,
						},
					}
				: {}),
			costUsd: doc.generationCostUsd + doc.gradingCostUsd,
			maxCostUsd: doc.maxCostUsd,
			...(doc.quiz.sessionId ? { sessionId: doc.quiz.sessionId } : {}),
		};
	}

	/** Write a changed document and its summary, and tell the devices. */
	async function save(doc: QuizDoc): Promise<void> {
		const current = store.get(doc.id);
		if (!current) throw new Error("There is no such quiz.");
		await store.writeDoc(doc);
		await store.put(summaryOf(doc, current));
		deps.changed(doc.id);
	}

	async function readReady(id: string): Promise<QuizDoc> {
		const summary = store.get(store.checkId(id));
		if (!summary) throw new Error("There is no such quiz.");
		if (summary.status === "running") throw new Error("The quiz is still being written.");
		if (summary.status === "failed") throw new Error(`The quiz failed: ${summary.error ?? "unknown error"}`);
		const doc = await store.readDoc(id);
		if (!doc) throw new Error("The quiz file is missing.");
		return doc;
	}

	async function execute(run: Run, job: Job): Promise<void> {
		const agent = deps.agent;
		if (agent === null) throw new Error("This computer cannot run the question-writing session (tmux is missing).");
		const runDir = path.join(workDir, run.id);
		await slots.acquire();
		let checkoutDir: string | undefined;
		try {
			const parts = await resolveParts({ prSource, progress }, run, job);
			if (run.cancelled) throw new Cancelled();
			const last = parts[parts.length - 1]!;
			const warnings: string[] = [];

			await progress(run, "Reading the changes");
			const briefs = await briefParts(job.root, parts, job.subject, warnings, "questions");
			const digest = await readDigest(deps.sessionsDir, job.sessionId, warnings, "questions");

			if (run.cancelled) throw new Cancelled();
			const folder = agentFolderName("Quiz", job.name, job.subject);
			checkoutDir = path.join(runDir, "head", folder);
			await progress(run, "Checking out the code");
			await addWorktree(job.root, checkoutDir, last.head.commit);
			const outFile = await prepareOutputFile(outDir, run.id);
			const overlayPath = path.join(overlayDir, `${run.id}.yml`);
			const generationLimit = Math.round(job.maxCostUsd * GENERATION_SHARE * 1000) / 1000;
			const prompt = buildQuizBrief({
				repo: job.name,
				subject: job.subject,
				checkout: job.prs
					? parts.length > 1
						? "the head of the last pull request of the stack"
						: "the head of the pull request"
					: "the changed code (its new version)",
				outFile,
				maxCostUsd: generationLimit,
				stack: parts.length > 1,
				parts: briefs,
				digest: digest ?? undefined,
			});
			await progress(run, "Starting the question-writing session");
			const ran = await runAgentToFile({
				agent,
				launch: {
					cwd: checkoutDir,
					prompt,
					maxCostUsd: generationLimit,
					model: job.model,
					outFile,
					overlayPath,
					overlayYaml: restrictedOverlayYaml(outFile, READONLY_AGENT_TOOLS),
					tools: READONLY_AGENT_TOOLS,
				},
				watch: deps.watch,
				now: deps.now,
				cancelled: () => run.cancelled,
				started: async instanceId => {
					run.instanceId = instanceId;
					await update(run, { instanceId, progress: "The agent is reading the changes and writing questions" });
				},
				log,
			});
			const { outcome, model, costUsd } = ran;
			if (outcome.kind === "cancelled") throw new Cancelled();
			if (outcome.kind !== "done")
				throw new Error(
					`The agent did not write the quiz: ${agentFailureReason(outcome, costUsd, generationLimit, "the questions")}.`,
				);

			await progress(run, "Checking every citation against the commit");
			let parsed: ParsedQuestion[];
			try {
				parsed = parseQuizOutput(parseAgentJson(outcome.text), parts.length, warnings);
			} catch (err) {
				throw new Error(
					`The agent's quiz could not be used (${err instanceof SyntaxError ? "its file was not valid JSON" : errorText(err).replace(/[.\s]+$/, "")}).`,
				);
			}
			const commits = parts.map(part => ({ head: part.head.commit, base: part.base.commit }));
			const verified = await verifyQuiz(
				parsed,
				{
					lines: async (part, side, file) => {
						const text = await readBlob(job.root, commits[part]![side], file);
						return text === null ? null : splitLines(text);
					},
				},
				run.id,
			);
			warnings.push(...verified.warnings);
			if (verified.questions.length === 0)
				throw new Error("None of the agent's questions held up against the code.");
			for (const [index] of parts.entries()) {
				if (!verified.questions.some(question => question.part === index))
					warnings.push(`Part ${index + 1} has no questions: the agent wrote none that held up.`);
			}
			log(
				`quiz ${run.id}: ${verified.questions.length} questions; citations ${verified.stats.verified} verified, ${verified.stats.moved} moved, ${verified.stats.dropped} dropped; ${verified.stats.questionsDropped} questions dropped`,
			);

			const createdAt = store.get(run.id)?.createdAt ?? deps.now();
			const quiz: Quiz = {
				v: QUIZ_VERSION,
				id: run.id,
				title: job.title,
				repo: { root: job.root, name: job.name, ...(job.github ? { github: job.github } : {}) },
				createdAt,
				...(model ? { model } : {}),
				...(digest && job.sessionId ? { sessionId: job.sessionId } : {}),
				parts: parts.map((part, index) => ({
					index,
					title: part.title,
					...(part.pr
						? {
								pr: {
									number: part.pr.number,
									...(part.pr.url ? { url: part.pr.url } : {}),
									...(part.pr.head ? { head: part.pr.head } : {}),
									...(part.pr.base ? { base: part.pr.base } : {}),
								},
							}
						: {}),
					head: part.head,
					base: part.base,
				})),
				questions: verified.questions,
				warnings,
			};
			const attempt: QuizAttempt = {
				id: "a1",
				startedAt: createdAt,
				questions: quiz.questions.map(question => question.id),
				answers: {},
				score: scoreAttempt(quiz.questions, { questions: quiz.questions.map(q => q.id), answers: {} }),
			};
			if (run.cancelled) throw new Cancelled();
			const doc: QuizDoc = {
				v: QUIZ_VERSION,
				id: run.id,
				quiz,
				keys: verified.keys,
				attempts: [attempt],
				maxCostUsd: job.maxCostUsd,
				generationCostUsd: costUsd ?? 0,
				gradingCostUsd: 0,
			};
			await progress(run, "Saving the quiz");
			const current = store.get(run.id);
			if (!current) throw new Cancelled();
			await store.writeDoc(doc);
			await store.put(summaryOf(doc, current));
			deps.changed(run.id);
		} finally {
			slots.release();
			if (checkoutDir) await removeWorktreeDir(job.root, checkoutDir).catch(() => undefined);
			await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async function fail(run: Run, root: string, err: unknown): Promise<void> {
		if (err instanceof Cancelled) return;
		log(`quiz ${run.id} failed: ${errorText(err)}`);
		const current = store.get(run.id);
		if (current === undefined) return;
		await store.put({
			...current,
			status: "failed",
			error: errorText(err),
			progress: undefined,
			instanceId: undefined,
		});
		await releaseParts(root, run.id, run.held);
		deps.changed(run.id);
	}

	function refreshAttempt(doc: QuizDoc, attempt: QuizAttempt, now: number): void {
		attempt.score = scoreAttempt(doc.quiz.questions, attempt);
		if (attempt.finishedAt === undefined && attempt.questions.every(id => Object.hasOwn(attempt.answers, id)))
			attempt.finishedAt = now;
	}

	return {
		async init() {
			const { interruptedInstances } = await store.load();
			await pruneLeftoverWorktrees(workDir);
			await Promise.all([
				fs.rm(outDir, { recursive: true, force: true }),
				fs.rm(overlayDir, { recursive: true, force: true }),
			]);
			if (deps.agent) {
				for (const instanceId of interruptedInstances)
					await deps.agent
						.stop(instanceId)
						.catch(err => log(`ending an interrupted quiz's agent failed: ${errorText(err)}`));
			}
		},

		async list(cwd) {
			const root = cwd === undefined ? undefined : (await repoInfo(cwd)).root;
			return store
				.list()
				.filter(quiz => root === undefined || quiz.repoRoot === root)
				.sort((a, b) => b.createdAt - a.createdAt);
		},

		async create(request) {
			const parsed = checkRunRequest(request, DEFAULT_QUIZ_MAX_COST_USD);
			const prs = pullRequestNumbers(request);
			checkSessionId(request.sessionId);
			if (deps.agent === null)
				throw new Error("This computer cannot run the question-writing session (tmux is missing).");

			const info = await repoInfo(parsed.cwd);
			let target: Job["target"];
			let title: string;
			let subject: string;
			if (prs) {
				subject = prRange(prs);
				title = `${info.name} · ${subject}`;
			} else {
				const resolved = await resolveTarget(info.root, {
					ref: parsed.ref,
					base: parsed.base ?? "@default",
					checkout: info.checkout,
				});
				target = resolved;
				const baseName = resolved.base?.ref ?? resolved.base?.commit.slice(0, 8) ?? "the base";
				subject = `${resolved.label} vs ${baseName}`;
				title = `${info.name} @ ${subject}`;
			}
			const id = store.newId();
			const run: Run = { id, cancelled: false, held: 0, done: Promise.resolve() };
			const job: Job = {
				root: info.root,
				name: info.name,
				github: info.github,
				title,
				subject,
				prs,
				target,
				sessionId: request.sessionId,
				maxCostUsd: parsed.maxCostUsd,
				model: parsed.model,
			};
			await store.put({
				id,
				title,
				repoRoot: info.root,
				subject,
				createdAt: deps.now(),
				status: "running",
				progress: "Waiting to start",
				maxCostUsd: parsed.maxCostUsd,
				...(request.sessionId ? { sessionId: request.sessionId } : {}),
			});
			deps.changed(id);
			runs.set(id, run);
			run.done = execute(run, job)
				.catch(err => fail(run, info.root, err))
				.finally(() => {
					runs.delete(id);
				});
			return { id };
		},

		async get(id) {
			const doc = await readReady(id);
			return { quiz: doc.quiz, attempts: doc.attempts };
		},

		answer(request) {
			return locked(locks, store.checkId(request.id), async () => {
				const doc = await readReady(request.id);
				const attempt = doc.attempts.find(candidate => candidate.id === request.attempt);
				if (!attempt) throw new Error("There is no such attempt.");
				const question = doc.quiz.questions.find(candidate => candidate.id === request.question);
				if (!question || !attempt.questions.includes(question.id))
					throw new Error("That question is not in this attempt.");
				if (Object.hasOwn(attempt.answers, question.id))
					throw new Error("That question is already answered in this attempt.");
				const key = Object.hasOwn(doc.keys, question.id) ? doc.keys[question.id]! : {};
				const now = deps.now();
				let verdict: QuizVerdict;
				let record: QuizAnswerRecord;
				if (question.kind === "choice") {
					if (typeof request.choice !== "string") throw new Error("Pick one of the choices.");
					verdict = gradeChoice(question, key, request.choice);
					record = { choice: request.choice, verdict, at: now };
				} else {
					const text = typeof request.text === "string" ? request.text.trim() : "";
					if (text === "") throw new Error("Write an answer first.");
					if (text.length > QUIZ_MAX_ANSWER_CHARS)
						throw new Error(`The answer is longer than ${QUIZ_MAX_ANSWER_CHARS} characters.`);
					if (!key.rubric) throw new Error("This question has no answer key to grade against.");
					const budget = doc.maxCostUsd - doc.generationCostUsd - doc.gradingCostUsd;
					if (budget < MIN_GRADE_BUDGET_USD)
						throw new Error(
							`This quiz has used up its spending limit ($${doc.maxCostUsd.toFixed(2)}), so open answers cannot be graded. Multiple-choice questions still can be.`,
						);
					const excerpts = await partExcerpts(doc.quiz, question.part, question.refs);
					let graded: GradeOpenResult;
					try {
						graded = await gradeOpen({
							ompBin: deps.ompBin,
							model: deps.gradeModel ?? DEFAULT_GRADE_MODEL,
							run: runOmp,
							budgetUsd: budget,
							input: {
								question,
								partTitle: doc.quiz.parts[question.part]?.title ?? "",
								rubric: key.rubric,
								excerpts: renderExcerpts(excerpts),
								answer: text,
							},
						});
					} catch (err) {
						if (err instanceof GradeError && err.costUsd) {
							doc.gradingCostUsd += err.costUsd;
							await save(doc);
						}
						throw new Error(`The answer could not be graded: ${errorText(err).replace(/[.\s]+$/, "")}.`);
					}
					doc.gradingCostUsd += graded.costUsd ?? 0;
					const refs = await verifiedRefs(doc.quiz, question.part, graded.grade.refs);
					verdict = {
						kind: graded.grade.kind,
						explanation: graded.grade.explanation,
						...(refs.length > 0 ? { refs } : {}),
						keyPoints: key.rubric.points,
						graded: "model",
					};
					record = { text, verdict, at: now };
				}
				attempt.answers[question.id] = record;
				refreshAttempt(doc, attempt, now);
				await save(doc);
				return { verdict, attempt };
			});
		},

		retry(request) {
			return locked(locks, store.checkId(request.id), async () => {
				const doc = await readReady(request.id);
				if (request.only !== undefined && request.only !== "all" && request.only !== "missed")
					throw new Error("invalid retry");
				const from =
					request.from === undefined
						? doc.attempts[doc.attempts.length - 1]
						: doc.attempts.find(candidate => candidate.id === request.from);
				if (!from) throw new Error("There is no such attempt.");
				const only = request.only ?? "all";
				const ids =
					only === "all"
						? doc.quiz.questions.map(question => question.id)
						: from.questions.filter(
								id => !Object.hasOwn(from.answers, id) || from.answers[id]!.verdict.kind !== "right",
							);
				if (ids.length === 0) throw new Error("Nothing to retry: every question was answered right.");
				const attempt: QuizAttempt = {
					id: `a${doc.attempts.length + 1}`,
					startedAt: deps.now(),
					questions: ids,
					answers: {},
					retryOf: from.id,
					score: scoreAttempt(doc.quiz.questions, { questions: ids, answers: {} }),
				};
				doc.attempts.push(attempt);
				await save(doc);
				return { attempt };
			});
		},

		async excerpt(id, part, refs) {
			const doc = await readReady(id);
			return await partExcerpts(doc.quiz, part, refs);
		},

		async remove(id) {
			store.checkId(id);
			const summary = store.get(id);
			if (!summary) throw new Error("There is no such quiz.");
			const run = runs.get(id);
			if (run) {
				run.cancelled = true;
				if (run.instanceId !== undefined && deps.agent)
					await deps.agent.stop(run.instanceId).catch(() => undefined);
			}
			await store.remove(id);
			await releaseParts(summary.repoRoot, id, summary.partCount ?? run?.held ?? QUIZ_MAX_PARTS);
			deps.changed(id);
		},

		async stack(cwd, pr) {
			const root = (await repoInfo(cwd)).root;
			const branch = await defaultBranch(root)
				.then(found => found.name)
				.catch(() => undefined);
			return await detectStack(positiveInt(pr, "pull request number"), prSource(root), { defaultBranch: branch });
		},

		async shutdown() {
			const inFlight = [...runs.values()];
			for (const run of inFlight) run.cancelled = true;
			await Promise.allSettled(
				inFlight.map(async run => {
					const current = store.get(run.id);
					if (current)
						await store.put({
							...current,
							status: "failed",
							error: "interrupted",
							progress: undefined,
							instanceId: undefined,
						});
					if (run.instanceId !== undefined && deps.agent) await deps.agent.stop(run.instanceId);
				}),
			);
		},

		async idle() {
			while (runs.size > 0) await Promise.allSettled([...runs.values()].map(run => run.done));
		},
	};
}
