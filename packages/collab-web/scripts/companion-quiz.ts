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
import type { BlueprintCommit, BlueprintExcerpt, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	QUIZ_MAX_ANSWER_CHARS,
	QUIZ_MAX_PARTS,
	type Quiz,
	type QuizAnswerRecord,
	type QuizAttempt,
	type QuizCreate,
	type QuizGetAnswer,
	type QuizPart,
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
	holdCommit,
	pruneLeftoverWorktrees,
	readBlob,
	releaseCommits,
	removeWorktreeDir,
	repoInfo,
	resolveTarget,
	stackBase,
} from "./companion-blueprint-git";
import { checkCitations, readCitedFiles, type Side, Warnings } from "./companion-citations";
import { readExcerpts, splitLines } from "./companion-excerpt";
import { headlessRunner, type RunOmp } from "./companion-headless";
import { type BriefPart, buildQuizBrief, DEFAULT_QUIZ_MAX_COST_USD } from "./companion-quiz-agent";
import { partDiff } from "./companion-quiz-diff";
import { type Digest, sessionDigest } from "./companion-quiz-digest";
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
import { detectStack, ghPrSource, type PrSource, type StackPr } from "./companion-quiz-stack";
import { createQuizStore, type QuizDoc } from "./companion-quiz-store";
import { type ParsedQuestion, parseQuizOutput, verifyQuiz } from "./companion-quiz-verify";
import { findSessionFile } from "./companion-sessions";

/** Quizzes written at once; the rest wait their turn. */
const MAX_CONCURRENT_RUNS = 2;
/** Of the spending limit, what the question-writing session may use; grading gets the rest and whatever it leaves. */
const GENERATION_SHARE = 0.75;
/** Characters of diff over all parts of a brief, and the least one part gets. */
const TOTAL_DIFF_CHARS = 90_000;
const MIN_PART_DIFF_CHARS = 8_000;
/** Characters of the session conversation in the brief. */
const DIGEST_CHARS = 24_000;
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{6,80}$/;

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

/** Thrown inside a run whose quiz was deleted. */
class Cancelled extends Error {}

interface Run {
	id: string;
	cancelled: boolean;
	instanceId?: string;
	/** Parts whose commits are held, so they can be released. */
	held: number;
	done: Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function positiveInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 999_999_999)
		throw new Error(`invalid ${what}`);
	return value;
}

interface Job {
	root: string;
	name: string;
	github?: string;
	title: string;
	subject: string;
	/** Pull requests (bottom first) or, for one change that is not a pull request, the resolved target. */
	prs?: number[];
	target?: { head: BlueprintCommit; base?: BlueprintCommit; label: string };
	sessionId?: string;
	maxCostUsd: number;
	model?: string;
}

/** One part, resolved to the commits its questions cite. */
interface ResolvedPart {
	title: string;
	pr?: StackPr;
	head: BlueprintCommit;
	base: BlueprintCommit;
}

/** The pull requests a request names, bottom first: its `stack`, else its `pr`; undefined for a change that is not a pull request. */
function pullRequestNumbers(request: Pick<QuizCreate, "stack" | "pr">): number[] | undefined {
	if (request.stack !== undefined) {
		if (!Array.isArray(request.stack)) throw new Error("invalid stack");
		const numbers = request.stack.map(number => positiveInt(number, "pull request number"));
		if (numbers.length === 0 || numbers.length > QUIZ_MAX_PARTS)
			throw new Error(`A stack has between 1 and ${QUIZ_MAX_PARTS} pull requests.`);
		if (new Set(numbers).size !== numbers.length) throw new Error("invalid stack");
		return numbers;
	}
	return request.pr === undefined ? undefined : [positiveInt(request.pr, "pull request number")];
}

function prRange(prs: readonly number[]): string {
	const first = prs[0]!;
	const last = prs[prs.length - 1]!;
	return prs.length === 1 ? `PR #${first}` : `PRs #${first}–#${last}`;
}

export function createQuizzes(deps: QuizDeps): Quizzes {
	const store = createQuizStore(deps.storeDir);
	const workDir = path.join(deps.cacheDir, "work");
	const outDir = path.join(deps.cacheDir, "out");
	const overlayDir = path.join(deps.cacheDir, "overlay");
	const runs = new Map<string, Run>();
	const waiting: (() => void)[] = [];
	const locks = new Map<string, Promise<unknown>>();
	let active = 0;
	const log = deps.log ?? (() => undefined);
	const prSource = deps.prSource ?? ghPrSource;
	const runOmp = deps.run ?? headlessRunner(GRADE_TIMEOUT_MS);

	const acquire = async (): Promise<void> => {
		if (active < MAX_CONCURRENT_RUNS) {
			active++;
			return;
		}
		await new Promise<void>(resolve => waiting.push(resolve));
	};
	const release = (): void => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};

	/** Answers and retries of one quiz run one after the other: each rewrites the whole document. */
	async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
		const previous = locks.get(id) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.catch(() => undefined);
		locks.set(id, tail);
		try {
			return await next;
		} finally {
			if (locks.get(id) === tail) locks.delete(id);
		}
	}

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

	/** The part's commits, for reading code out of git. */
	function commitsOf(part: QuizPart): { head: string; base?: string } {
		return { head: part.head.commit, base: part.base?.commit };
	}

	async function resolveParts(run: Run, job: Job): Promise<ResolvedPart[]> {
		if (job.target) {
			const { head, base } = job.target;
			if (!base) throw new Error("There is nothing to compare these changes with.");
			await holdCommit(job.root, `${run.id}/p0`, "head", head.commit);
			await holdCommit(job.root, `${run.id}/p0`, "base", base.commit);
			run.held = 1;
			return [{ title: job.sessionId ? "What the session changed" : job.subject, head, base }];
		}
		const source = prSource(job.root);
		const parts: ResolvedPart[] = [];
		for (const number of job.prs ?? []) {
			if (run.cancelled) throw new Cancelled();
			await progress(run, `Fetching pull request #${number}`);
			const target = await resolveTarget(job.root, { ref: `pr/${number}` });
			const viewed = await source.view(number).catch(() => null);
			const below = parts[parts.length - 1];
			// A pull request stacked on the one below shows its own changes only, whatever the branch below has become.
			const base =
				below?.pr?.head && viewed?.base === below.pr.head
					? await stackBase(job.root, target.head.commit, below.head)
					: target.base;
			if (!base) throw new Error(`Could not find what pull request #${number} changes: it has no base.`);
			const index = parts.length;
			await holdCommit(job.root, `${run.id}/p${index}`, "head", target.head.commit);
			await holdCommit(job.root, `${run.id}/p${index}`, "base", base.commit);
			run.held = index + 1;
			parts.push({
				title: `#${number} ${viewed?.title || target.head.subject || ""}`.trim(),
				pr: viewed ?? { number, title: target.head.subject ?? "", head: "", base: "" },
				head: target.head,
				base,
			});
		}
		return parts;
	}

	function describePart(part: ResolvedPart, index: number, count: number, subject: string): string {
		if (part.pr) {
			const branches = part.pr.head && part.pr.base ? ` (${part.pr.head} → ${part.pr.base})` : "";
			return `Pull request #${part.pr.number}${branches}${count > 1 ? `, part ${index + 1} of the stack` : ""}.`;
		}
		return `${subject}: the changes since \`${part.base.commit.slice(0, 8)}\` (${part.base.ref ?? "the base"}), up to \`${part.head.commit.slice(0, 8)}\`.`;
	}

	async function execute(run: Run, job: Job): Promise<void> {
		const agent = deps.agent;
		if (agent === null) throw new Error("This computer cannot run the question-writing session (tmux is missing).");
		const runDir = path.join(workDir, run.id);
		await acquire();
		let checkoutDir: string | undefined;
		try {
			const parts = await resolveParts(run, job);
			if (run.cancelled) throw new Cancelled();
			const last = parts[parts.length - 1]!;
			const warnings: string[] = [];

			await progress(run, "Reading the changes");
			const share = Math.max(MIN_PART_DIFF_CHARS, Math.floor(TOTAL_DIFF_CHARS / parts.length));
			const briefParts: BriefPart[] = [];
			for (const [index, part] of parts.entries()) {
				const diff = await partDiff(job.root, part.base.commit, part.head.commit, { maxChars: share });
				if (diff.truncated)
					warnings.push(
						`Part ${index + 1}: the diff was too large to show whole${diff.omittedFiles > 0 ? ` (${diff.omittedFiles} files left out)` : ""}; questions are about the part that was shown.`,
					);
				briefParts.push({
					title: part.title,
					about: describePart(part, index, parts.length, job.subject),
					body: part.pr?.body,
					stat: diff.stat,
					diff: diff.text,
				});
			}

			let digest: Digest | null = null;
			if (job.sessionId) {
				const file = await findSessionFile(deps.sessionsDir, job.sessionId);
				digest = file === null ? null : await sessionDigest(file, DIGEST_CHARS);
				if (digest === null)
					warnings.push(
						`The conversation of session ${job.sessionId} could not be read, so the questions come from the code alone.`,
					);
			}

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
				parts: briefParts,
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
			release();
			if (checkoutDir) await removeWorktreeDir(job.root, checkoutDir).catch(() => undefined);
			await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async function releaseParts(root: string, id: string, count: number): Promise<void> {
		for (let index = 0; index < count; index++) await releaseCommits(root, `${id}/p${index}`).catch(() => undefined);
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

	/** The part's cited code as graders and the screen read it. */
	async function partExcerpts(
		doc: QuizDoc,
		part: number,
		refs: readonly BlueprintRef[],
	): Promise<(BlueprintExcerpt | null)[]> {
		const found = doc.quiz.parts[part];
		if (!found) throw new Error("There is no such part.");
		return await readExcerpts(doc.quiz.repo.root, commitsOf(found), refs);
	}

	/** Refs the grader pointed at that hold in the part's code. */
	async function verifiedRefs(doc: QuizDoc, part: number, refs: readonly BlueprintRef[]): Promise<BlueprintRef[]> {
		const found = doc.quiz.parts[part];
		if (!found || refs.length === 0) return [];
		const commits = commitsOf(found);
		const files = await readCitedFiles(
			refs.map(ref => ({ side: ref.side ?? "head", path: ref.path })),
			async (side: Side, file) => {
				const text = await readBlob(
					doc.quiz.repo.root,
					side === "base" ? (commits.base ?? commits.head) : commits.head,
					file,
				);
				return text === null ? null : splitLines(text);
			},
		);
		return checkCitations(
			refs,
			"the explanation",
			ref => ref.side ?? "head",
			files,
			{ verified: 0, moved: 0, dropped: 0 },
			new Warnings(),
		);
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
			if (
				request.sessionId !== undefined &&
				(typeof request.sessionId !== "string" || !SESSION_ID_RE.test(request.sessionId))
			)
				throw new Error("invalid session");
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
			return locked(store.checkId(request.id), async () => {
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
					const excerpts = await partExcerpts(doc, question.part, question.refs);
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
					const refs = await verifiedRefs(doc, question.part, graded.grade.refs);
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
			return locked(store.checkId(request.id), async () => {
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
			return await partExcerpts(doc, part, refs);
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
