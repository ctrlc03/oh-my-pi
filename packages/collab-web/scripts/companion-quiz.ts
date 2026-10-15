/**
 * "Quiz me" for the companion's `quiz-*` requests: questions that test whether the user understood a set of code
 * changes (a branch or working tree against the default branch, or the pull requests of a stack, one part each), or
 * the topic, design and implementation of a session (its conversation, the files in its folder and the topic's general
 * background), for a folder that is a git repository or not. The wire contract is `@oh-my-pi/pi-wire/quiz`.
 *
 * Writing the questions reuses what architecture maps are built from: refs resolve to commits and are held under private
 * refs (./companion-blueprint-git), a restricted read-only omp session in a throw-away checkout writes JSON to one result
 * file (./companion-agent), and every citation is verified (./companion-citations, via ./companion-quiz-verify): code
 * against its commit, or against the file as it was copied for a folder that is not a repository (./companion-quiz-folder;
 * the cited files are stored with the quiz), a quoted message against the session's file (./companion-quiz-session). The
 * session is given each part's numbered diff (./companion-quiz-diff), the title and description of each pull request
 * (read-only `gh`, ./companion-quiz-stack), or the folder's files, and, when a session id is given, a digest of that
 * session's conversation (./companion-quiz-digest) so it can ask why things were done. What the questions lean on is
 * the request's focus; the quiz of a high-stakes session also mixes in design and understanding questions.
 *
 * Grading never reaches a device before the answer: the rubric and the right choices stay in the stored document
 * (./companion-quiz-store). A choice is graded here; an open answer by one small headless model call
 * (./companion-quiz-grade). Writing the questions and grading together stay inside the quiz's spending limit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlueprintCommit, BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	QUIZ_DEFAULT_FOCUS,
	QUIZ_FOCUSES,
	QUIZ_MAX_ANSWER_CHARS,
	QUIZ_MAX_PARTS,
	type Quiz,
	type QuizAnswerRecord,
	type QuizAttempt,
	type QuizCreate,
	type QuizFocus,
	type QuizFolder,
	type QuizGetAnswer,
	type QuizStackPr,
	type QuizStackSource,
	type QuizSubject,
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
	type RunRequest,
	runAgentToFile,
} from "./companion-agent";
import {
	addWorktree,
	defaultBranch,
	holdCommit,
	pruneLeftoverWorktrees,
	readBlob,
	removeWorktreeDir,
	repoInfo,
	resolveTarget,
	snapshotWorkingTree,
} from "./companion-blueprint-git";
import { splitLines } from "./companion-excerpt";
import { headlessRunner, type RunOmp } from "./companion-headless";
import { buildQuizBrief, buildTopicBrief, DEFAULT_QUIZ_MAX_COST_USD } from "./companion-quiz-agent";
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
import {
	copyFolderFiles,
	type FolderInfo,
	folderInfo,
	hasCode,
	listFolderFiles,
	MAX_STORED_CHARS,
	readFolderFile,
} from "./companion-quiz-folder";
import { createQuizStore, type QuizDoc, type QuizDocStakes } from "./companion-quiz-store";
import { type ParsedQuestion, parseQuizOutput, verifyQuiz } from "./companion-quiz-verify";
import {
	briefParts,
	Cancelled,
	type CodeSubject,
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
	type ResolvedPart,
	resolveParts,
	type Run,
	verifiedRefs,
} from "./companion-review-base";

/** Quizzes written at once; the rest wait their turn. */
const MAX_CONCURRENT_RUNS = 2;
/** Of the spending limit, what the question-writing session may use; grading gets the rest and whatever it leaves. */
const GENERATION_SHARE = 0.75;
/** What a request for a quiz with no code to ask about says. */
const NO_CODE_ERROR = "Implementation questions need code, and this folder has none.";
/** How a focus reads in a list row. */
const FOCUS_LABEL: Record<QuizFocus, string> = {
	mixed: "Mixed",
	understanding: "Understanding",
	design: "Design",
	implementation: "Implementation",
};

/** What a run was asked to write, as {@link Job} (the changes it is about) plus what the questions lean on. */
interface QuizJob extends Job {
	about: QuizSubject;
	focus: QuizFocus;
	/** A quiz on a session's topic: the folder it reads (the changes fields of the job are unused). */
	topic?: FolderInfo;
	/** The quiz of a high-stakes session: it mixes in design and understanding questions; `delta` when it covers only the new changes. */
	stakes?: { delta: boolean };
}

/** @throws Error "invalid subject" for anything but a subject. */
function parseSubject(value: unknown): QuizSubject {
	if (value === undefined) return "changes";
	if (value !== "changes" && value !== "session") throw new Error("invalid subject");
	return value;
}

/** @throws Error "invalid focus" for anything but a focus. */
function parseFocus(value: unknown): QuizFocus {
	if (value === undefined) return QUIZ_DEFAULT_FOCUS;
	const focus = QUIZ_FOCUSES.find(candidate => candidate === value);
	if (focus === undefined) throw new Error("invalid focus");
	return focus;
}

/** A stored quiz as far as reading code goes: its commits, and the files stored with a quiz on a folder that is not a repository. */
function codeOf(doc: QuizDoc): CodeSubject {
	return {
		repo: doc.quiz.repo,
		parts: doc.quiz.parts,
		...(doc.files ? { documents: new Map(Object.entries(doc.files)) } : {}),
	};
}

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
	/**
	 * High-stakes sessions (./companion-stakes): the pass mark in force, and what to do when an attempt on a stakes quiz
	 * finishes (resolves true when it passed and unlocked the push).
	 */
	stakes?: {
		mark(): number;
		finished(doc: QuizDoc, attempt: QuizAttempt): Promise<boolean>;
	};
	log?(message: string): void;
}

export interface Quizzes {
	/** Load the index, mark what a previous run left as interrupted, remove leftover checkouts. */
	init(): Promise<void>;
	list(cwd: string | undefined): Promise<QuizSummary[]>;
	create(request: QuizCreate): Promise<{ id: string }>;
	get(id: string): Promise<QuizGetAnswer>;
	/** The list row of one quiz, or undefined when there is none. */
	summary(id: string): QuizSummary | undefined;
	/**
	 * Write a quiz for a high-stakes session's exact states (./companion-stakes): `head` and `base` are used as given,
	 * not re-resolved, so a delta quiz compares the two trees and nothing else.
	 */
	createForStakes(input: {
		cwd: string;
		sessionId: string;
		head: BlueprintCommit;
		base: BlueprintCommit;
		stakes: QuizDocStakes;
		model?: string;
	}): Promise<{ id: string }>;
	answer(request: { id: string; attempt: string; question: string; text?: unknown; choice?: unknown }): Promise<{
		verdict: QuizVerdict;
		attempt: QuizAttempt;
	}>;
	retry(request: { id: string; from?: string; only?: unknown }): Promise<{ attempt: QuizAttempt }>;
	excerpt(id: string, part: number, refs: readonly BlueprintExcerptRef[]): Promise<(BlueprintExcerpt | null)[]>;
	remove(id: string): Promise<void>;
	stack(cwd: string, pr: number): Promise<{ stack: QuizStackPr[]; source: QuizStackSource }>;
	/** What a quiz on the topic of the session in `cwd` can draw on (git or not, code or not, how many files). */
	folder(cwd: string): Promise<QuizFolder>;
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
	/** Stakes bindings of the runs in flight, written into the document when it is saved. */
	const stakesByRun = new Map<string, QuizDocStakes>();
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
			...(doc.stakes ? { stakes: { delta: doc.stakes.delta, passed: doc.stakes.passedAttempt !== undefined } } : {}),
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

	/** The one part of a quiz on a session's topic: the folder's working tree snapshotted into a commit, or the folder's files as they are. */
	async function topicParts(run: Run, job: QuizJob, topic: FolderInfo): Promise<ResolvedPart[]> {
		const title = "The topic of the session";
		if (!topic.git)
			return [{ title, head: { commit: "folder", subject: "The folder's files when the quiz was made" } }];
		const commit = await snapshotWorkingTree(topic.checkout);
		await holdCommit(job.root, `${run.id}/p0`, "head", commit);
		run.held = 1;
		return [{ title, head: { commit, ref: "@worktree", subject: "Working tree" } }];
	}

	async function execute(run: Run, job: QuizJob): Promise<void> {
		const agent = deps.agent;
		if (agent === null) throw new Error("This computer cannot run the question-writing session (tmux is missing).");
		const runDir = path.join(workDir, run.id);
		await slots.acquire();
		let worktreeDir: string | undefined;
		try {
			const topic = job.topic;
			const parts = topic ? await topicParts(run, job, topic) : await resolveParts({ prSource, progress }, run, job);
			if (run.cancelled) throw new Cancelled();
			const last = parts[parts.length - 1]!;
			const warnings: string[] = [];
			// A conversation is cited by a quiz on a topic, a high-stakes one (its design questions) or one leaning on ideas.
			const citeSession =
				topic !== undefined || job.stakes !== undefined || job.focus === "understanding" || job.focus === "design";

			await progress(run, topic ? "Reading the folder" : "Reading the changes");
			const briefs = topic ? [] : await briefParts(job.root, parts, job.subject, warnings, "questions");
			const files = topic ? await listFolderFiles(topic) : [];
			const code = hasCode(files);
			if (topic && job.focus === "implementation" && !code) throw new Error(NO_CODE_ERROR);
			const digest = await readDigest(deps.sessionsDir, job.sessionId, warnings, "questions", {
				ids: citeSession,
				without: topic ? "the folder's files and general background" : undefined,
			});
			if (topic && files.length === 0 && digest === null)
				throw new Error(
					"There is nothing to quiz on: the session's conversation could not be read and its folder has no files.",
				);

			if (run.cancelled) throw new Cancelled();
			const folder = agentFolderName("Quiz", job.name, job.subject);
			const checkoutDir = path.join(runDir, "head", folder);
			if (topic && !topic.git) {
				await progress(run, "Copying the folder's files");
				await copyFolderFiles(topic.checkout, files, checkoutDir);
			} else {
				await progress(run, "Checking out the code");
				await addWorktree(job.root, checkoutDir, last.head.commit);
				worktreeDir = checkoutDir;
			}
			const outFile = await prepareOutputFile(outDir, run.id);
			const overlayPath = path.join(overlayDir, `${run.id}.yml`);
			const generationLimit = Math.round(job.maxCostUsd * GENERATION_SHARE * 1000) / 1000;
			const prompt = topic
				? buildTopicBrief({
						repo: job.name,
						checkout: topic.git
							? "a throw-away checkout of the folder's working tree as it is now"
							: "a copy of the folder's text files as they are now",
						outFile,
						maxCostUsd: generationLimit,
						focus: job.focus,
						code,
						files,
						digest: digest ?? undefined,
					})
				: buildQuizBrief({
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
						focus: job.focus,
						stakes: job.stakes,
						sessionCites: citeSession,
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
					await update(run, {
						instanceId,
						progress: topic
							? "The agent is reading the folder and writing questions"
							: "The agent is reading the changes and writing questions",
					});
				},
				log,
			});
			const { outcome, model, costUsd } = ran;
			if (outcome.kind === "cancelled") throw new Cancelled();
			if (outcome.kind !== "done")
				throw new Error(
					`The agent did not write the quiz: ${agentFailureReason(outcome, costUsd, generationLimit, "the questions")}.`,
				);

			await progress(run, topic ? "Checking every citation" : "Checking every citation against the commit");
			let parsed: ParsedQuestion[];
			try {
				parsed = parseQuizOutput(parseAgentJson(outcome.text), parts.length, warnings, {
					background: topic !== undefined && job.focus !== "implementation",
				});
			} catch (err) {
				throw new Error(
					`The agent's quiz could not be used (${err instanceof SyntaxError ? "its file was not valid JSON" : errorText(err).replace(/[.\s]+$/, "")}).`,
				);
			}
			const commits = parts.map(part => ({ head: part.head.commit, base: part.base?.commit }));
			// Files of a folder that is not a repository, read once from the copy the agent saw; the cited ones are stored.
			const copied = new Map<string, string[]>();
			let copiedChars = 0;
			const verified = await verifyQuiz(
				parsed,
				{
					lines: async (part, side, file) => {
						if (topic && !topic.git) {
							if (side === "base") return null;
							const lines = await readFolderFile(checkoutDir, file);
							if (lines === null) return null;
							if (!copied.has(file)) {
								const chars = lines.reduce((sum, line) => sum + line.length + 1, 0);
								if (copiedChars + chars > MAX_STORED_CHARS) return null;
								copiedChars += chars;
								copied.set(file, lines);
							}
							return lines;
						}
						const commit = commits[part]![side];
						if (commit === undefined) return null;
						const text = await readBlob(job.root, commit, file);
						return text === null ? null : splitLines(text);
					},
					entries: digest?.entries,
				},
				run.id,
			);
			warnings.push(...verified.warnings);
			if (verified.questions.length === 0)
				throw new Error(
					topic
						? "None of the agent's questions held up against the folder and the conversation."
						: "None of the agent's questions held up against the code.",
				);
			for (const [index] of parts.entries()) {
				if (!verified.questions.some(question => question.part === index))
					warnings.push(`Part ${index + 1} has no questions: the agent wrote none that held up.`);
			}
			log(
				`quiz ${run.id}: ${verified.questions.length} questions; citations ${verified.stats.verified} verified, ${verified.stats.moved} moved, ${verified.stats.dropped} dropped; conversation citations ${verified.stats.session.verified} verified, ${verified.stats.session.dropped} dropped; ${verified.stats.questionsDropped} questions dropped`,
			);
			const storedFiles: Record<string, string[]> = {};
			for (const question of verified.questions)
				for (const ref of question.refs) if (copied.has(ref.path)) storedFiles[ref.path] = copied.get(ref.path)!;

			const createdAt = store.get(run.id)?.createdAt ?? deps.now();
			const quiz: Quiz = {
				v: QUIZ_VERSION,
				id: run.id,
				title: job.title,
				repo: { root: job.root, name: job.name, ...(job.github ? { github: job.github } : {}) },
				createdAt,
				...(model ? { model } : {}),
				...(digest && job.sessionId ? { sessionId: job.sessionId } : {}),
				about: job.about,
				focus: job.focus,
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
					...(part.base ? { base: part.base } : {}),
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
				...(Object.keys(storedFiles).length > 0 ? { files: storedFiles } : {}),
				...(stakesByRun.has(run.id) ? { stakes: stakesByRun.get(run.id) } : {}),
			};
			await progress(run, "Saving the quiz");
			const current = store.get(run.id);
			if (!current) throw new Cancelled();
			await store.writeDoc(doc);
			await store.put(summaryOf(doc, current));
			deps.changed(run.id);
		} finally {
			slots.release();
			stakesByRun.delete(run.id);
			if (worktreeDir) await removeWorktreeDir(job.root, worktreeDir).catch(() => undefined);
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

	/** Register a run for an already resolved subject and start writing its questions. */
	async function launch(
		info: { root: string; name: string; github?: string },
		plan: {
			target?: Job["target"];
			prs?: number[];
			title: string;
			subject: string;
			about: QuizSubject;
			focus: QuizFocus;
			topic?: FolderInfo;
		},
		parsed: RunRequest,
		sessionId: string | undefined,
		stakes: QuizDocStakes | undefined,
	): Promise<{ id: string }> {
		const { target, prs, title, subject, about, focus, topic } = plan;
		const id = store.newId();
		const run: Run = { id, cancelled: false, held: 0, done: Promise.resolve() };
		const job: QuizJob = {
			root: info.root,
			name: info.name,
			github: info.github,
			title,
			subject,
			prs,
			target,
			sessionId,
			maxCostUsd: parsed.maxCostUsd,
			model: parsed.model,
			about,
			focus,
			topic,
			stakes: stakes ? { delta: stakes.delta } : undefined,
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
			about,
			focus,
			...(sessionId ? { sessionId } : {}),
			...(stakes ? { stakes: { delta: stakes.delta, passed: false } } : {}),
		});
		if (stakes) stakesByRun.set(id, stakes);
		deps.changed(id);
		runs.set(id, run);
		run.done = execute(run, job)
			.catch(err => fail(run, info.root, err))
			.finally(() => {
				runs.delete(id);
			});
		return { id };
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
			const root = cwd === undefined ? undefined : (await folderInfo(cwd)).root;
			return store
				.list()
				.filter(quiz => root === undefined || quiz.repoRoot === root)
				.sort((a, b) => b.createdAt - a.createdAt);
		},

		async folder(cwd) {
			const info = await folderInfo(checkRunRequest({ cwd }, DEFAULT_QUIZ_MAX_COST_USD).cwd);
			const files = await listFolderFiles(info);
			return { git: info.git, code: hasCode(files), files: files.length, name: info.name };
		},

		async create(request) {
			const parsed = checkRunRequest(request, DEFAULT_QUIZ_MAX_COST_USD);
			const about = parseSubject(request.subject);
			const focus = parseFocus(request.focus);
			checkSessionId(request.sessionId);
			if (deps.agent === null)
				throw new Error("This computer cannot run the question-writing session (tmux is missing).");

			if (about === "session") {
				if (request.sessionId === undefined) throw new Error("A quiz on a session's topic needs the session.");
				const topic = await folderInfo(parsed.cwd);
				if (focus === "implementation" && !hasCode(await listFolderFiles(topic))) throw new Error(NO_CODE_ERROR);
				const subject = focus === "mixed" ? "Session topic" : `Session topic · ${FOCUS_LABEL[focus]}`;
				return await launch(
					topic,
					{ title: `${topic.name} · topic`, subject, about, focus, topic },
					parsed,
					request.sessionId,
					undefined,
				);
			}

			const prs = pullRequestNumbers(request);
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
			return await launch(info, { target, prs, title, subject, about, focus }, parsed, request.sessionId, undefined);
		},

		async createForStakes(input) {
			const parsed = checkRunRequest({ cwd: input.cwd, model: input.model }, DEFAULT_QUIZ_MAX_COST_USD);
			checkSessionId(input.sessionId);
			if (deps.agent === null)
				throw new Error("This computer cannot run the question-writing session (tmux is missing).");
			const info = await repoInfo(parsed.cwd);
			const baseName = input.base.ref ?? input.base.commit.slice(0, 8);
			const subject = input.stakes.delta ? "the new changes" : `worktree vs ${baseName}`;
			const title = `${info.name} · high stakes · ${subject}`;
			const target: Job["target"] = { head: input.head, base: input.base, label: "worktree" };
			return await launch(
				info,
				{ target, title, subject, about: "changes", focus: QUIZ_DEFAULT_FOCUS },
				parsed,
				input.sessionId,
				input.stakes,
			);
		},

		summary(id) {
			return store.get(id);
		},

		async get(id) {
			const doc = await readReady(id);
			return {
				quiz: doc.quiz,
				attempts: doc.attempts,
				...(doc.stakes && deps.stakes
					? {
							stakes: {
								sessionId: doc.stakes.sessionId,
								delta: doc.stakes.delta,
								passMark: deps.stakes.mark(),
								...(doc.stakes.passedAttempt ? { passedAttempt: doc.stakes.passedAttempt } : {}),
							},
						}
					: {}),
			};
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
					const excerpts = await partExcerpts(codeOf(doc), question.part, question.refs);
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
								explanation: key.explanation,
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
					const refs = await verifiedRefs(codeOf(doc), question.part, graded.grade.refs);
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
				if (doc.stakes && deps.stakes && (await deps.stakes.finished(doc, attempt)))
					doc.stakes.passedAttempt ??= attempt.id;
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
			return await partExcerpts(codeOf(doc), part, refs);
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
