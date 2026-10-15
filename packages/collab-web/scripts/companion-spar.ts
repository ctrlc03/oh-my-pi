/**
 * "Sparring partner" for the companion's `spar-*` requests: "Quiz me" turned around. A read-only agent challenges the
 * decisions in a set of code changes and/or a design document, one point at a time; the user defends each point in their
 * own words and a model answers from a hidden case file. The wire contract is `@oh-my-pi/pi-wire/spar`.
 *
 * Writing the points is the quiz's pipeline (./companion-review-base): refs resolve to commits held under private refs, a
 * restricted read-only omp session in a throw-away checkout writes JSON to one result file (./companion-agent), every
 * citation is verified against its commit (./companion-spar-verify). A design document is cited as `@design@line@token`
 * and read from its stored copy. A reply is one headless model call (./companion-spar-reply) that counts against the
 * spar's spending limit together with writing the points; closing a point yourself calls no model.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import { QUIZ_MAX_PARTS, type QuizPart, type QuizStackPr, type QuizStackSource } from "@oh-my-pi/pi-wire/quiz";
import {
	SPAR_DESIGN_PATH,
	SPAR_MAX_DOC_CHARS,
	SPAR_MAX_REPLY_CHARS,
	SPAR_DEFAULT_MAX_COST_USD,
	SPAR_VERSION,
	type Spar,
	type SparCreate,
	type SparGetAnswer,
	type SparOutcomeKind,
	type SparPoint,
	type SparRecord,
	type SparRun,
	type SparSummary,
	type SparTurn,
	scoreSpar,
} from "@oh-my-pi/pi-wire/spar";
import { MODEL_SELECTOR_RE } from "../src/lib/fanout";
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
	removeWorktreeDir,
	repoInfo,
	resolveTarget,
} from "./companion-blueprint-git";
import { normalizeRepoPath } from "./companion-citations";
import { splitLines } from "./companion-excerpt";
import { headlessRunner, type RunOmp } from "./companion-headless";
import { MIN_GRADE_BUDGET_USD } from "./companion-quiz-grade";
import { detectStack, ghPrSource, type PrSource } from "./companion-quiz-stack";
import {
	briefParts,
	type CodeSubject,
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
	type ResolvedPart,
	type Run,
	verifiedRefs,
} from "./companion-review-base";
import { buildSparBrief } from "./companion-spar-agent";
import {
	applyRound,
	DEFAULT_REPLY_MODEL,
	defenceMentions,
	REPLY_TIMEOUT_MS,
	ReplyError,
	type ReplyResult,
	replyToDefence,
} from "./companion-spar-reply";
import { createSparStore, type SparDoc } from "./companion-spar-store";
import { type ParsedPoint, parseSparOutput, type SparCase, verifySpar } from "./companion-spar-verify";

/** Spars written at once; the rest wait their turn. */
const MAX_CONCURRENT_RUNS = 2;
/** Of the spending limit, what the point-writing session may use; replies get the rest and whatever it leaves. */
export const GENERATION_SHARE_SPAR = 0.4;
const MAX_NOTE_CHARS = 1_000;
const MAX_DOC_NAME_CHARS = 120;
const PASTED_DOC_NAME = "Pasted design";

export interface SparDeps {
	/** `<agent dir>/spars`: the index and the spars. */
	storeDir: string;
	/** `<config dir>/cache/spars`: `work/` (checkouts), `out/` (the agent's result files), `overlay/`. */
	cacheDir: string;
	/** `<agent dir>/sessions`, where the conversations of sessions are. */
	sessionsDir: string;
	now(): number;
	/** A spar's summary changed: tell the connected devices. */
	changed(id: string): void;
	/** The session writing the points; null when this computer cannot run one (no tmux), and no spar can be made. */
	agent: AgentRunner | null;
	/** The omp program a reply runs. */
	ompBin: string;
	/** Runs a reply call; tests replace it. */
	run?: RunOmp;
	/** Model of a reply when the request names none: a role (`@default`) or a model id. */
	replyModel?: string;
	/** The pull requests of a repository; tests replace it. */
	prSource?: (root: string) => PrSource;
	/** Timing of the wait for the agent; tests shorten it. */
	watch?: Partial<AgentWatchOptions>;
	log?(message: string): void;
}

export interface Spars {
	/** Load the index, mark what a previous run left as interrupted, remove leftover checkouts. */
	init(): Promise<void>;
	list(cwd: string | undefined): Promise<SparSummary[]>;
	create(request: SparCreate): Promise<{ id: string }>;
	get(id: string): Promise<SparGetAnswer>;
	reply(request: { id: string; run: string; point: string; text?: unknown }): Promise<{
		turn: SparTurn;
		record: SparRecord;
		run: SparRun;
	}>;
	close(request: { id: string; run: string; point: string; as?: unknown; note?: unknown }): Promise<{
		record: SparRecord;
		run: SparRun;
	}>;
	again(request: { id: string; from?: string; only?: unknown }): Promise<{ run: SparRun }>;
	excerpt(id: string, part: number, refs: readonly BlueprintExcerptRef[]): Promise<(BlueprintExcerpt | null)[]>;
	remove(id: string): Promise<void>;
	stack(cwd: string, pr: number): Promise<{ stack: QuizStackPr[]; source: QuizStackSource }>;
	/** Mark runs in flight as interrupted and end their sessions. */
	shutdown(): Promise<void>;
	/** Resolves when no run is in flight. */
	idle(): Promise<void>;
}

/** What a spar was asked to challenge: a change, a design document, or both. */
interface SparJob extends Job {
	doc?: { name: string; text: string };
	/** The model of the replies, when the request names one. */
	replyModel?: string;
}

/** The reply-model name from a request: a role (`@default`) or a model selector. @throws Error "invalid model". */
function checkReplyModel(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(/^@[a-z][\w-]{0,40}$/.test(value) || MODEL_SELECTOR_RE.test(value)))
		throw new Error("invalid model");
	return value;
}

/** The documents a stored spar holds that are not in git, for reading cited lines. */
function subjectOf(doc: SparDoc): CodeSubject {
	return {
		repo: doc.spar.repo,
		parts: doc.spar.parts,
		...(doc.doc ? { documents: new Map([[SPAR_DESIGN_PATH, splitLines(doc.doc.text)]]) } : {}),
	};
}

/** What a closed point shows: the strongest defence, and for a lost or partly held point the suggestion. */
function revealOf(caseFile: SparCase | undefined, kind: SparOutcomeKind): SparRecord["reveal"] {
	if (caseFile === undefined) return undefined;
	const suggest = (kind === "lost" || kind === "partly") && caseFile.suggestion !== undefined;
	return {
		strongestDefence: caseFile.strongestDefence,
		...(suggest ? { suggestion: caseFile.suggestion } : {}),
		...(suggest && caseFile.suggestionRefs.length > 0 ? { refs: caseFile.suggestionRefs } : {}),
	};
}

/** The run's records and result brought up to date after `point` changed. */
function refreshRun(run: SparRun, now: number): void {
	run.result = scoreSpar(run);
	if (run.finishedAt === undefined && run.points.every(id => run.records[id]?.outcome !== undefined))
		run.finishedAt = now;
}

export function createSpars(deps: SparDeps): Spars {
	const store = createSparStore(deps.storeDir);
	const workDir = path.join(deps.cacheDir, "work");
	const outDir = path.join(deps.cacheDir, "out");
	const overlayDir = path.join(deps.cacheDir, "overlay");
	const runs = new Map<string, Run>();
	const locks: Locks = new Map();
	const slots = createRunSlots(MAX_CONCURRENT_RUNS);
	const log = deps.log ?? (() => undefined);
	const prSource = deps.prSource ?? ghPrSource;
	const runOmp = deps.run ?? headlessRunner(REPLY_TIMEOUT_MS);

	const update = async (run: Run, patch: Partial<SparSummary>): Promise<void> => {
		if (run.cancelled) throw new Cancelled();
		const current = store.get(run.id);
		if (!current) throw new Cancelled();
		await store.put({ ...current, ...patch });
		deps.changed(run.id);
	};
	const progress = (run: Run, text: string): Promise<void> => update(run, { progress: text });

	function summaryOf(doc: SparDoc, current: SparSummary): SparSummary {
		const answered = doc.runs.filter(run =>
			Object.values(run.records).some(record => record.turns.length > 0 || record.outcome),
		);
		const last = answered[answered.length - 1];
		const { latest: _latest, ...rest } = current;
		return {
			...rest,
			status: "ready",
			progress: undefined,
			error: undefined,
			instanceId: undefined,
			partCount: doc.spar.parts.length,
			pointCount: doc.spar.points.length,
			runCount: doc.runs.length,
			...(last
				? {
						latest: {
							held: last.result.held.length,
							asked: last.points.length,
							percentHeld: last.result.percentHeld,
							finished: last.finishedAt !== undefined,
							at: last.finishedAt ?? last.startedAt,
						},
					}
				: {}),
			costUsd: doc.generationCostUsd + doc.replyCostUsd,
			maxCostUsd: doc.maxCostUsd,
			...(doc.spar.sessionId ? { sessionId: doc.spar.sessionId } : {}),
		};
	}

	/** Write a changed document and its summary, and tell the devices. */
	async function save(doc: SparDoc): Promise<void> {
		const current = store.get(doc.id);
		if (!current) throw new Error("There is no such spar.");
		await store.writeDoc(doc);
		await store.put(summaryOf(doc, current));
		deps.changed(doc.id);
	}

	async function readReady(id: string): Promise<SparDoc> {
		const summary = store.get(store.checkId(id));
		if (!summary) throw new Error("There is no such spar.");
		if (summary.status === "running") throw new Error("The spar is still being written.");
		if (summary.status === "failed") throw new Error(`The spar failed: ${summary.error ?? "unknown error"}`);
		const doc = await store.readDoc(id);
		if (!doc) throw new Error("The spar file is missing.");
		return doc;
	}

	function runOf(doc: SparDoc, id: unknown): SparRun {
		const found = doc.runs.find(candidate => candidate.id === id);
		if (!found) throw new Error("There is no such run.");
		return found;
	}

	/** The point of `run` and its record, created empty on first use. @throws Error when the point is not in the run. */
	function pointOf(doc: SparDoc, run: SparRun, id: unknown): { point: SparPoint; record: SparRecord } {
		const point = doc.spar.points.find(candidate => candidate.id === id);
		if (!point || !run.points.includes(point.id)) throw new Error("That point is not in this run.");
		const record = Object.hasOwn(run.records, point.id) ? run.records[point.id]! : { turns: [] };
		run.records[point.id] = record;
		return { point, record };
	}

	/** The part of a document-only spar: the commit the document is checked against, with no diff. */
	async function documentPart(run: Run, job: SparJob): Promise<ResolvedPart[]> {
		const { head } = job.target!;
		await holdCommit(job.root, `${run.id}/p0`, "head", head.commit);
		run.held = 1;
		return [{ title: `Design: ${job.doc?.name ?? PASTED_DOC_NAME}`, head }];
	}

	async function execute(run: Run, job: SparJob): Promise<void> {
		const agent = deps.agent;
		if (agent === null) throw new Error("This computer cannot run the point-writing session (tmux is missing).");
		const runDir = path.join(workDir, run.id);
		await slots.acquire();
		let checkoutDir: string | undefined;
		try {
			const parts =
				job.target !== undefined && job.target.base === undefined
					? await documentPart(run, job)
					: await resolveParts({ prSource, progress }, run, job);
			if (run.cancelled) throw new Cancelled();
			const last = parts[parts.length - 1]!;
			const warnings: string[] = [];

			await progress(run, "Reading the work");
			const briefs = await briefParts(job.root, parts, job.subject, warnings, "points");
			const digest = await readDigest(deps.sessionsDir, job.sessionId, warnings, "points");

			if (run.cancelled) throw new Cancelled();
			const folder = agentFolderName("Spar", job.name, job.subject);
			checkoutDir = path.join(runDir, "head", folder);
			await progress(run, "Checking out the code");
			await addWorktree(job.root, checkoutDir, last.head.commit);
			const outFile = await prepareOutputFile(outDir, run.id);
			const overlayPath = path.join(overlayDir, `${run.id}.yml`);
			const generationLimit = Math.round(job.maxCostUsd * GENERATION_SHARE_SPAR * 1000) / 1000;
			const prompt = buildSparBrief({
				repo: job.name,
				subject: job.subject,
				checkout: job.prs
					? parts.length > 1
						? "the head of the last pull request of the stack"
						: "the head of the pull request"
					: job.doc && !parts[0]?.base
						? "the code the document describes"
						: "the changed code (its new version)",
				outFile,
				maxCostUsd: generationLimit,
				stack: parts.length > 1,
				parts: briefs,
				doc: job.doc,
				digest: digest ?? undefined,
			});
			await progress(run, "Starting the sparring session");
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
					await update(run, { instanceId, progress: "The agent is reading the work and preparing its points" });
				},
				log,
			});
			const { outcome, model, costUsd } = ran;
			if (outcome.kind === "cancelled") throw new Cancelled();
			if (outcome.kind !== "done")
				throw new Error(
					`The agent did not write the points: ${agentFailureReason(outcome, costUsd, generationLimit, "the points")}.`,
				);

			await progress(run, "Checking every citation against the commit");
			let parsed: ParsedPoint[];
			try {
				parsed = parseSparOutput(parseAgentJson(outcome.text), parts.length, warnings);
			} catch (err) {
				throw new Error(
					`The agent's points could not be used (${err instanceof SyntaxError ? "its file was not valid JSON" : errorText(err).replace(/[.\s]+$/, "")}).`,
				);
			}
			const documentLines = job.doc ? splitLines(job.doc.text) : null;
			const commits = parts.map(part => ({ head: part.head.commit, base: part.base?.commit }));
			const verified = await verifySpar(parsed, {
				lines: async (part, side, file) => {
					if (file === SPAR_DESIGN_PATH) return documentLines;
					const commit = side === "base" ? commits[part]!.base : commits[part]!.head;
					if (commit === undefined) return null;
					const text = await readBlob(job.root, commit, file);
					return text === null ? null : splitLines(text);
				},
			});
			warnings.push(...verified.warnings);
			if (verified.points.length === 0) throw new Error("None of the agent's points held up against the code.");
			for (const [index] of parts.entries()) {
				if (!verified.points.some(point => point.part === index))
					warnings.push(`Part ${index + 1} has no points: the agent wrote none that held up.`);
			}
			log(
				`spar ${run.id}: ${verified.points.length} points; citations ${verified.stats.verified} verified, ${verified.stats.moved} moved, ${verified.stats.dropped} dropped; ${verified.stats.pointsDropped} points dropped`,
			);

			const createdAt = store.get(run.id)?.createdAt ?? deps.now();
			const quizParts: QuizPart[] = parts.map((part, index) => ({
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
			}));
			const spar: Spar = {
				v: SPAR_VERSION,
				id: run.id,
				title: job.title,
				repo: { root: job.root, name: job.name, ...(job.github ? { github: job.github } : {}) },
				createdAt,
				...(model ? { model } : {}),
				...(digest && job.sessionId ? { sessionId: job.sessionId } : {}),
				parts: quizParts,
				points: verified.points,
				warnings,
				...(job.doc ? { doc: { name: job.doc.name, chars: job.doc.text.length } } : {}),
			};
			const first: SparRun = {
				id: "r1",
				startedAt: createdAt,
				points: spar.points.map(point => point.id),
				records: {},
				result: scoreSpar({ points: spar.points.map(point => point.id), records: {} }),
			};
			if (run.cancelled) throw new Cancelled();
			const doc: SparDoc = {
				v: SPAR_VERSION,
				id: run.id,
				spar,
				cases: verified.cases,
				runs: [first],
				...(job.doc ? { doc: job.doc } : {}),
				replyModel: job.replyModel ?? deps.replyModel ?? DEFAULT_REPLY_MODEL,
				maxCostUsd: job.maxCostUsd,
				generationCostUsd: costUsd ?? 0,
				replyCostUsd: 0,
			};
			await progress(run, "Saving the spar");
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
		log(`spar ${run.id} failed: ${errorText(err)}`);
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

	/** The document of a request as name and text, read from the repository for a file; undefined when there is none. */
	async function documentOf(
		request: SparCreate,
		root: string,
		commit: string | undefined,
	): Promise<{ name: string; text: string } | undefined> {
		const given = request.doc;
		if (given === undefined) return undefined;
		if (typeof given !== "object" || given === null) throw new Error("invalid document");
		let name: string;
		let text: string;
		if ("path" in given && typeof given.path === "string") {
			const file = normalizeRepoPath(given.path);
			if (file === undefined) throw new Error("invalid document path");
			if (commit === undefined) throw new Error("There is no commit to read the document from.");
			const read = await readBlob(root, commit, file);
			if (read === null) throw new Error(`The file ${file} is not in the repository there, or is not a text file.`);
			name = file;
			text = read;
		} else if ("text" in given && typeof given.text === "string") {
			text = given.text;
			const typedName = "name" in given && typeof given.name === "string" ? given.name.trim() : "";
			name = (typedName === "" ? PASTED_DOC_NAME : typedName)
				.replace(/[\0-\x1f]/g, " ")
				.slice(0, MAX_DOC_NAME_CHARS);
		} else {
			throw new Error("invalid document");
		}
		text = text.replace(/\r\n/g, "\n");
		if (text.trim() === "") throw new Error("The design document is empty.");
		if (text.length > SPAR_MAX_DOC_CHARS)
			throw new Error(`The design document is longer than ${SPAR_MAX_DOC_CHARS} characters.`);
		return { name, text };
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
						.catch(err => log(`ending an interrupted spar's agent failed: ${errorText(err)}`));
			}
		},

		async list(cwd) {
			const root = cwd === undefined ? undefined : (await repoInfo(cwd)).root;
			return store
				.list()
				.filter(spar => root === undefined || spar.repoRoot === root)
				.sort((a, b) => b.createdAt - a.createdAt);
		},

		async create(request) {
			const parsed = checkRunRequest(request, SPAR_DEFAULT_MAX_COST_USD);
			const replyModel = checkReplyModel(request.replyModel);
			if (request.doc !== undefined && (typeof request.doc !== "object" || request.doc === null))
				throw new Error("invalid document");
			const prs = pullRequestNumbers(request);
			checkSessionId(request.sessionId);
			if (deps.agent === null)
				throw new Error("This computer cannot run the point-writing session (tmux is missing).");
			const hasChange = prs !== undefined || request.ref !== undefined || request.base !== undefined;
			if (!hasChange && request.doc === undefined)
				throw new Error("Pick something to challenge: a change or a design document.");

			const info = await repoInfo(parsed.cwd);
			let target: SparJob["target"];
			let subject: string;
			let commit: string | undefined;
			if (prs) {
				subject = prRange(prs);
			} else if (hasChange) {
				const resolved = await resolveTarget(info.root, {
					ref: parsed.ref,
					base: parsed.base ?? "@default",
					checkout: info.checkout,
				});
				target = resolved;
				commit = resolved.head.commit;
				if (!resolved.base) throw new Error("There is nothing to compare these changes with.");
				const baseName = resolved.base.ref ?? resolved.base.commit.slice(0, 8);
				subject = `${resolved.label} vs ${baseName}`;
			} else {
				// A document alone: checked against the files as they are, which is where a file of the repository is read.
				const resolved = await resolveTarget(info.root, {
					ref: parsed.ref ?? (request.doc && "path" in request.doc ? "@worktree" : undefined),
					checkout: info.checkout,
				});
				target = resolved;
				commit = resolved.head.commit;
				subject = "a design document";
			}
			if (commit === undefined && request.doc !== undefined && "path" in request.doc)
				commit = (await resolveTarget(info.root, { ref: "@worktree", checkout: info.checkout })).head.commit;
			const doc = await documentOf(request, info.root, commit);
			if (doc && hasChange) subject = `${subject} and ${doc.name}`;
			else if (doc) subject = `a design document: ${doc.name}`;
			const title = `${info.name} ${prs ? "·" : "@"} ${subject}`;

			const id = store.newId();
			const run: Run = { id, cancelled: false, held: 0, done: Promise.resolve() };
			const job: SparJob = {
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
				doc,
				replyModel,
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
			return { spar: doc.spar, runs: doc.runs };
		},

		reply(request) {
			return locked(locks, store.checkId(request.id), async () => {
				const doc = await readReady(request.id);
				const run = runOf(doc, request.run);
				const { point, record } = pointOf(doc, run, request.point);
				if (record.outcome !== undefined) throw new Error("That point is already closed.");
				const defence = typeof request.text === "string" ? request.text.trim() : "";
				if (defence === "") throw new Error("Write your defence first.");
				if (defence.length > SPAR_MAX_REPLY_CHARS)
					throw new Error(`The defence is longer than ${SPAR_MAX_REPLY_CHARS} characters.`);
				const caseFile = Object.hasOwn(doc.cases, point.id) ? doc.cases[point.id] : undefined;
				if (!caseFile) throw new Error("This point has no case file to argue from.");
				const budget = doc.maxCostUsd - doc.generationCostUsd - doc.replyCostUsd;
				if (budget < MIN_GRADE_BUDGET_USD)
					throw new Error(
						`This sparring session has used up its spending limit ($${doc.maxCostUsd.toFixed(2)}), so the partner cannot answer. Concede, accept the risk or skip: they still work.`,
					);
				const round = record.turns.filter(turn => turn.by === "you").length + 1;
				const subject = subjectOf(doc);
				const own = await partExcerpts(subject, point.part, point.refs);
				const mentions = defenceMentions(defence, point.refs);
				const found = mentions.length > 0 ? await partExcerpts(subject, point.part, mentions) : [];
				const notFound = mentions.filter((_, at) => found[at] === null).map(ref => `${ref.path}:${ref.line}`);
				const replyModel = doc.replyModel;
				let answered: ReplyResult;
				try {
					answered = await replyToDefence({
						ompBin: deps.ompBin,
						model: replyModel,
						run: runOmp,
						budgetUsd: budget,
						input: {
							point,
							partTitle: doc.spar.parts[point.part]?.title ?? "",
							case: caseFile,
							thread: record.turns,
							defence,
							round,
							excerpts: { own, mentioned: found },
							notFound,
						},
					});
				} catch (err) {
					if (err instanceof ReplyError && err.costUsd) {
						doc.replyCostUsd += err.costUsd;
						await save(doc);
					}
					throw new Error(`The reply could not be read: ${errorText(err).replace(/[.\s]+$/, "")}.`);
				}
				doc.replyCostUsd += answered.costUsd ?? 0;
				const { reply } = answered;
				const now = deps.now();
				const refs = await verifiedRefs(subject, point.part, reply.refs, "the partner's reply");
				const turn: SparTurn = {
					by: "partner",
					text: reply.message,
					move: reply.move,
					...(refs.length > 0 ? { refs } : {}),
					...(reply.checked.length > 0 ? { checked: reply.checked } : {}),
					at: now,
				};
				record.turns.push({ by: "you", text: defence, at: now }, turn);
				const decided = applyRound(reply.move, round);
				if (decided) {
					record.outcome = decided;
					const reveal = revealOf(caseFile, decided.kind);
					if (reveal) record.reveal = reveal;
				}
				refreshRun(run, now);
				await save(doc);
				return { turn, record, run };
			});
		},

		close(request) {
			return locked(locks, store.checkId(request.id), async () => {
				if (request.as !== "lost" && request.as !== "open") throw new Error("invalid outcome");
				const doc = await readReady(request.id);
				const run = runOf(doc, request.run);
				const { point, record } = pointOf(doc, run, request.point);
				if (record.outcome !== undefined) throw new Error("That point is already closed.");
				const note =
					typeof request.note === "string" && request.note.trim() !== ""
						? request.note.trim().slice(0, MAX_NOTE_CHARS)
						: undefined;
				record.outcome = { kind: request.as, by: "you", ...(note ? { note } : {}) };
				const reveal = revealOf(Object.hasOwn(doc.cases, point.id) ? doc.cases[point.id] : undefined, request.as);
				if (reveal) record.reveal = reveal;
				refreshRun(run, deps.now());
				await save(doc);
				return { record, run };
			});
		},

		again(request) {
			return locked(locks, store.checkId(request.id), async () => {
				const doc = await readReady(request.id);
				if (request.only !== undefined && request.only !== "all" && request.only !== "unsettled")
					throw new Error("invalid repeat");
				const from =
					request.from === undefined
						? doc.runs[doc.runs.length - 1]
						: doc.runs.find(candidate => candidate.id === request.from);
				if (!from) throw new Error("There is no such run.");
				const ids =
					(request.only ?? "unsettled") === "all"
						? doc.spar.points.map(point => point.id)
						: from.points.filter(id => from.records[id]?.outcome?.kind !== "held");
				if (ids.length === 0) throw new Error("Nothing to repeat: every point was held.");
				const run: SparRun = {
					id: `r${doc.runs.length + 1}`,
					startedAt: deps.now(),
					points: ids,
					records: {},
					retryOf: from.id,
					result: scoreSpar({ points: ids, records: {} }),
				};
				doc.runs.push(run);
				await save(doc);
				return { run };
			});
		},

		async excerpt(id, part, refs) {
			const doc = await readReady(id);
			return await partExcerpts(subjectOf(doc), part, refs);
		},

		async remove(id) {
			store.checkId(id);
			const summary = store.get(id);
			if (!summary) throw new Error("There is no such spar.");
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
