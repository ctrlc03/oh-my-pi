/**
 * "Design bake-off" for the companion's `bakeoff-*` requests (docs/design-review.md): several models each try to do
 * better than a design or an implementation, and a reviewer model, blind to who wrote what, ranks every entry with
 * code citations. The wire contract is `@oh-my-pi/pi-wire/bakeoff`.
 *
 * This module is the engine: it checks requests, resolves what the bake-off is about to commits, stores the bake-off
 * (./companion-bakeoff-store) and runs the stages (./companion-bakeoff-run) one bake-off at a time per computer.
 * Reading and review reuse what architecture maps, quizzes and fan-outs are built from: commits held under private
 * refs (./companion-blueprint-git), read-only agent sessions writing one JSON file (./companion-agent), the fan-out's
 * worktrees (./companion-fanout), citations verified against commits (./companion-citations).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	BAKEOFF_DEFAULT_MAX_COST_USD,
	BAKEOFF_MAX_CHALLENGERS,
	BAKEOFF_MAX_CUSTOM_CHARS,
	BAKEOFF_MAX_DOC_CHARS,
	BAKEOFF_MAX_INSTRUCTIONS_CHARS,
	BAKEOFF_MAX_METRICS,
	BAKEOFF_MIN_CHALLENGERS,
	BAKEOFF_PRESETS,
	BAKEOFF_VERSION,
	type Bakeoff,
	type BakeoffCreate,
	type BakeoffEntry,
	type BakeoffFolder,
	type BakeoffJudgeInfo,
	type BakeoffMetric,
	type BakeoffSummary,
	type BakeoffTakeResult,
} from "@oh-my-pi/pi-wire/bakeoff";
import { MODEL_SELECTOR_RE } from "../src/lib/fanout";
import { checkRunRequest } from "./companion-agent";
import { buildImplementationPrompt, problemText } from "./companion-bakeoff-brief";
import { describeSecondOpinion } from "./companion-bakeoff-judge";
import { drawLabels } from "./companion-bakeoff-pack";
import {
	type BakeoffDeps,
	type OpenedJudge,
	type BakeoffRun,
	commitOf,
	designStage,
	type Ctx,
	factsStage,
	finishStages,
	implementationStage,
	reviewable,
	spent,
	writeupStage,
} from "./companion-bakeoff-run";
import { type BakeoffDoc, createBakeoffStore } from "./companion-bakeoff-store";
import {
	holdCommit,
	pruneLeftoverWorktrees,
	readBlob,
	releaseCommits,
	repoInfo,
	resolveTarget,
} from "./companion-blueprint-git";
import { assertRangeBudget, excerptOf, MAX_EXCERPT_REFS, readExcerpts } from "./companion-excerpt";
import { normalizeRepoPath } from "./companion-citations";
import { entryPatch, patchStates } from "./companion-bakeoff-patch";
import { copyFolderFiles, type FolderInfo, folderInfo, listFolderFiles, readFolderFile } from "./companion-quiz-folder";
import { ghPrSource } from "./companion-quiz-stack";
import {
	Cancelled,
	checkSessionId,
	errorText,
	type Job,
	type Locks,
	locked,
	positiveInt,
	readDigest,
	releaseParts,
	resolveParts,
} from "./companion-review-base";

/** Bake-offs kept on disk; the oldest go first, except one whose worktree was taken. */
export const MAX_BAKEOFFS = 20;
const MAX_GOAL_CHARS = 2_000;
const MAX_TARGET_CHARS = 200;
const MAX_DETAIL_CHARS = 4_000;
const MAX_REGEX_CHARS = 200;
const MAX_LABEL_CHARS = 60;
const MAX_PATH_CHARS = 500;
const CUSTOM_ID_RE = /^custom:\d+$/;
/** The commit of a folder's bake-off: a placeholder, as a topic quiz of a folder has (`{ commit: "folder" }`). */
const FOLDER_COMMIT = "folder";
const NOT_GIT_NOTE =
	"A folder that is not a git repository has no changes, branches, pull requests or worktrees: only a design bake-off from a design document can be made there.";

// ── the request ──────────────────────────────────────────────────────────────

function isPresetId(id: string): id is Extract<BakeoffMetric["id"], string> {
	return BAKEOFF_PRESETS.some(preset => preset.id === id);
}

/** The metrics of a request, checked: known presets or custom ones with their text, weights 1–3, no repeats. */
function checkMetrics(value: unknown, mode: BakeoffCreate["mode"]): BakeoffMetric[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > BAKEOFF_MAX_METRICS)
		throw new Error(`Pick 1 to ${BAKEOFF_MAX_METRICS} things that matter.`);
	const seen = new Set<string>();
	return value.map((raw: unknown): BakeoffMetric => {
		if (typeof raw !== "object" || raw === null) throw new Error("invalid metric");
		const { id, label, text, weight } = raw as Record<string, unknown>;
		if (typeof id !== "string" || (!isPresetId(id) && !CUSTOM_ID_RE.test(id))) throw new Error("invalid metric");
		if (seen.has(id)) throw new Error("A metric is listed twice.");
		seen.add(id);
		if (weight !== 1 && weight !== 2 && weight !== 3) throw new Error("A metric's weight is 1, 2 or 3.");
		const preset = BAKEOFF_PRESETS.find(candidate => candidate.id === id);
		if (preset?.implementationOnly && mode === "design")
			throw new Error(`"${preset.label}" only makes sense when comparing implementations.`);
		if (id.startsWith("custom:")) {
			if (typeof text !== "string" || text.trim() === "") throw new Error("Describe what a custom metric means.");
			if (text.length > BAKEOFF_MAX_CUSTOM_CHARS)
				throw new Error(`A custom metric is at most ${BAKEOFF_MAX_CUSTOM_CHARS} characters.`);
			const name =
				typeof label === "string" && label.trim() !== "" ? label.trim().slice(0, MAX_LABEL_CHARS) : "Custom";
			return { id: id as BakeoffMetric["id"], label: name, text: text.trim(), weight };
		}
		return { id: id as BakeoffMetric["id"], label: preset!.label, weight };
	});
}

function checkSelector(value: unknown, what: string, allowForeign: boolean): string {
	if (typeof value !== "string" || !MODEL_SELECTOR_RE.test(value)) throw new Error(`invalid ${what}`);
	if (!allowForeign && value.startsWith("agent:"))
		throw new Error(`The ${what} must be an omp model: a vendor agent cannot be kept blind and read-only here.`);
	return value;
}

function checkTarget(value: unknown, what: string): { target: string; detail?: string } {
	if (typeof value !== "object" || value === null) throw new Error(`invalid ${what}`);
	const { target, detail } = value as Record<string, unknown>;
	if (typeof target !== "string" || target === "" || target.length > MAX_TARGET_CHARS)
		throw new Error(`invalid ${what}`);
	if (detail !== undefined && (typeof detail !== "string" || detail.length > MAX_DETAIL_CHARS))
		throw new Error(`invalid ${what}`);
	return { target, ...(detail !== undefined ? { detail } : {}) };
}

/** A path of the repository: relative, inside it, without NUL. */
function checkRepoPath(value: unknown, folder: boolean): string {
	if (
		typeof value !== "string" ||
		value === "" ||
		value.length > MAX_PATH_CHARS ||
		value.includes("\0") ||
		path.isAbsolute(value) ||
		value.split(/[\\/]/).includes("..")
	)
		throw new Error(
			folder
				? "The design document's path must be a text file inside the folder."
				: "The design document's path must be a file inside the repository.",
		);
	return value;
}

/** What a request asks for, checked: a device sent it. */
export interface CheckedCreate {
	cwd: string;
	ref?: string;
	base?: string;
	pr?: number;
	sessionId?: string;
	mode: BakeoffCreate["mode"];
	doc?: { text: string; name?: string } | { path: string };
	instructions?: string;
	metrics: BakeoffMetric[];
	models: string[];
	reviewer: string;
	reviewerPasses: 1 | 2;
	writer: string;
	judge: "auto" | "off";
	judgeAdvisory: boolean;
	start: "original" | "base";
	goal?: string;
	test?: { target: string; detail?: string };
	bench?: { target: string; detail?: string; better: "lower" | "higher"; valueRegex?: string };
	sandboxed: boolean;
	maxCostUsd: number;
}

/**
 * @throws Error with a plain message for anything a request may not say: a folder that is not absolute, a model that
 * is not a selector (or a vendor agent where blindness needs an omp model), a metric that does not exist, an input that
 * is missing or too long, a test or benchmark in design mode, a spending limit that is not a positive number.
 */
export function checkBakeoffCreate(request: Partial<BakeoffCreate>, folder = false): CheckedCreate {
	const parsed = checkRunRequest(request, BAKEOFF_DEFAULT_MAX_COST_USD);
	const { mode } = request;
	if (mode !== "design" && mode !== "implementation") throw new Error("invalid mode");
	if (
		folder &&
		(mode !== "design" || request.pr !== undefined || parsed.ref !== undefined || parsed.base !== undefined)
	)
		throw new Error(NOT_GIT_NOTE);
	const pr = request.pr === undefined ? undefined : positiveInt(request.pr, "pull request");
	if (pr !== undefined && (parsed.ref !== undefined || request.sessionId !== undefined))
		throw new Error("Name a pull request or a branch, not both.");
	const sessionId = checkSessionId(request.sessionId);
	let doc: CheckedCreate["doc"];
	if (request.doc !== undefined) {
		if (typeof request.doc !== "object" || request.doc === null) throw new Error("invalid design document");
		if ("path" in request.doc) {
			doc = { path: checkRepoPath(request.doc.path, folder) };
		} else {
			const { text, name } = request.doc;
			if (typeof text !== "string" || text.trim() === "") throw new Error("The design document is empty.");
			if (text.length > BAKEOFF_MAX_DOC_CHARS)
				throw new Error(`The design document is longer than ${BAKEOFF_MAX_DOC_CHARS} characters.`);
			if (name !== undefined && (typeof name !== "string" || name.length > MAX_LABEL_CHARS * 4))
				throw new Error("invalid design document");
			doc = { text, ...(name !== undefined ? { name } : {}) };
		}
	}
	// A folder that is not a repository has no change to start from: a conversation only says why the design is wanted.
	const change = !folder && (pr !== undefined || parsed.ref !== undefined || sessionId !== undefined);
	if (mode === "implementation" && !change) throw new Error("Pick the change that the challengers improve on.");
	if (mode === "design" && !change && !doc)
		throw new Error(
			folder
				? "Add a design document: paste it, or name a text file of the folder."
				: "Pick a change or a design document to start from.",
		);
	if (
		request.instructions !== undefined &&
		(typeof request.instructions !== "string" || request.instructions.length > BAKEOFF_MAX_INSTRUCTIONS_CHARS)
	)
		throw new Error(`The instructions are at most ${BAKEOFF_MAX_INSTRUCTIONS_CHARS} characters.`);
	const metrics = checkMetrics(request.metrics, mode);
	const models = request.models;
	if (!Array.isArray(models) || models.length < BAKEOFF_MIN_CHALLENGERS || models.length > BAKEOFF_MAX_CHALLENGERS)
		throw new Error(`Pick ${BAKEOFF_MIN_CHALLENGERS} to ${BAKEOFF_MAX_CHALLENGERS} models.`);
	const selectors = models.map(model => checkSelector(model, "model", mode === "implementation"));
	if (new Set(selectors).size !== selectors.length) throw new Error("Pick different models.");
	const reviewer = checkSelector(request.reviewer, "reviewer", false);
	if (request.reviewerPasses !== undefined && request.reviewerPasses !== 1 && request.reviewerPasses !== 2)
		throw new Error("invalid review");
	const writer =
		request.writer === undefined || request.writer === "@default"
			? "@default"
			: checkSelector(request.writer, "writer", false);
	if (request.judge !== undefined && request.judge !== "auto" && request.judge !== "off")
		throw new Error("invalid judge");
	if (request.judgeAdvisory !== undefined && typeof request.judgeAdvisory !== "boolean")
		throw new Error("invalid judge");
	if (request.start !== undefined && request.start !== "original" && request.start !== "base")
		throw new Error("invalid start");
	if (request.sandboxed !== undefined && typeof request.sandboxed !== "boolean") throw new Error("invalid request");
	if (request.goal !== undefined && (typeof request.goal !== "string" || request.goal.length > MAX_GOAL_CHARS))
		throw new Error(`The goal is at most ${MAX_GOAL_CHARS} characters.`);
	if (mode === "design" && (request.test !== undefined || request.bench !== undefined))
		throw new Error("A design bake-off runs no tests or benchmarks.");
	const test = request.test === undefined ? undefined : checkTarget(request.test, "test");
	let bench: CheckedCreate["bench"];
	if (request.bench !== undefined) {
		const { better, valueRegex } = request.bench;
		if (better !== "lower" && better !== "higher") throw new Error("invalid benchmark");
		if (valueRegex !== undefined && (typeof valueRegex !== "string" || valueRegex.length > MAX_REGEX_CHARS))
			throw new Error("invalid benchmark");
		bench = { ...checkTarget(request.bench, "benchmark"), better, ...(valueRegex ? { valueRegex } : {}) };
	}
	return {
		cwd: parsed.cwd,
		ref: parsed.ref,
		base: parsed.base,
		pr,
		sessionId,
		mode,
		doc,
		...(request.instructions?.trim() ? { instructions: request.instructions.trim() } : {}),
		metrics,
		models: selectors,
		reviewer,
		reviewerPasses: request.reviewerPasses ?? 1,
		writer,
		judge: request.judge ?? "auto",
		judgeAdvisory: request.judgeAdvisory ?? false,
		start: request.start ?? "original",
		...(request.goal?.trim() ? { goal: request.goal.trim() } : {}),
		test,
		bench,
		sandboxed: request.sandboxed ?? false,
		maxCostUsd: parsed.maxCostUsd,
	};
}

// ── the engine ───────────────────────────────────────────────────────────────

export interface Bakeoffs {
	/** Load the index, mark what a previous run left as interrupted, remove leftover folders. */
	init(): Promise<void>;
	list(cwd: string | undefined): Promise<BakeoffSummary[]>;
	/** What the second opinion would use, and whether it answers. */
	judge(cwd: string | undefined): Promise<BakeoffJudgeInfo>;
	create(request: Partial<BakeoffCreate>): Promise<{ id: string }>;
	get(id: string): Promise<Bakeoff>;
	excerpt(id: string, entry: string, refs: readonly BlueprintExcerptRef[]): Promise<(BlueprintExcerpt | null)[]>;
	/** Stop one entry (what it did so far is kept), or the whole run. */
	stop(id: string, entry: string | undefined): Promise<void>;
	/** Take an entry: design mode marks it, implementation mode keeps its worktree. */
	take(request: {
		id: string;
		entry: string;
		removeOthers?: boolean;
		discardDirty?: boolean;
	}): Promise<BakeoffTakeResult | undefined>;
	remove(id: string): Promise<void>;
	/** An implementation entry's code as a patch against the base (`git apply` takes it). */
	patch(id: string, entry: string): Promise<string>;
	/** Whether `cwd` is a git repository, and how many files a bake-off of the folder could read. */
	folder(cwd: string): Promise<BakeoffFolder>;
	/** Run the review and the judge again after they failed. */
	review(id: string): Promise<void>;
	/** Mark runs in flight as interrupted and end their sessions. */
	shutdown(): Promise<void>;
	/** Resolves when no run is in flight. */
	idle(): Promise<void>;
}

/** What a run was asked, resolved at the request. */
interface BakeoffJob extends Job {
	request: CheckedCreate;
	/** The folder the bake-off is about, when it is not a git repository. */
	folder?: FolderInfo;
}

/**
 * The excerpts of a folder's bake-off: read from the files stored with it, since nothing else holds them once the run is
 * over. Null for a ref no stored file has.
 */
function folderExcerpts(doc: BakeoffDoc, refs: readonly BlueprintExcerptRef[]): (BlueprintExcerpt | null)[] {
	if (refs.length > MAX_EXCERPT_REFS) throw new Error("too many references");
	assertRangeBudget(refs);
	return refs.map(ref => {
		const file = normalizeRepoPath(ref?.path);
		const lines = file === undefined ? undefined : doc.files?.[file];
		const line = typeof ref?.line === "number" && Number.isSafeInteger(ref.line) ? ref.line : 0;
		return file === undefined || lines === undefined
			? null
			: excerptOf(lines, { path: file, line, from: ref.from, to: ref.to }, "head", FOLDER_COMMIT);
	});
}

export function createBakeoffs(deps: BakeoffDeps): Bakeoffs {
	const store = createBakeoffStore(deps.storeDir);
	const dirs = {
		work: path.join(deps.cacheDir, "work"),
		out: path.join(deps.cacheDir, "out"),
		overlay: path.join(deps.cacheDir, "overlay"),
	};
	const runs = new Map<string, BakeoffRun>();
	const locks: Locks = new Map();
	const log = deps.log ?? (() => undefined);
	const prSource = deps.prSource ?? ghPrSource;

	async function update(run: BakeoffRun, patch: Partial<BakeoffSummary>): Promise<void> {
		if (run.cancelled) throw new Cancelled();
		const current = store.get(run.id);
		if (!current) throw new Cancelled();
		await store.put({ ...current, ...patch });
		deps.changed(run.id);
	}

	function summaryOf(doc: BakeoffDoc, current: BakeoffSummary): BakeoffSummary {
		const { bakeoff } = doc;
		const top = bakeoff.result?.ranking[0]?.label;
		const note = bakeoff.result?.judgeNote;
		const { top: _top, note: _note, taken: _taken, ...rest } = current;
		return {
			...rest,
			mode: bakeoff.mode,
			stage: bakeoff.stage,
			entryCount: bakeoff.entries.length,
			...(top ? { top } : {}),
			...(bakeoff.result?.taken ? { taken: bakeoff.result.taken } : {}),
			...(note ? { note } : {}),
			costUsd: spent(bakeoff),
			maxCostUsd: doc.maxCostUsd,
		};
	}

	/** Write a changed document and its summary, and tell the devices. */
	async function save(run: BakeoffRun | undefined, doc: BakeoffDoc): Promise<void> {
		if (run?.cancelled) throw new Cancelled();
		const current = store.get(doc.id);
		if (!current) throw new Cancelled();
		await store.writeDoc(doc);
		await store.put(summaryOf(doc, current));
		deps.changed(doc.id);
	}

	async function readDoc(id: string): Promise<BakeoffDoc> {
		const summary = store.get(store.checkId(id));
		if (!summary) throw new Error("There is no such bake-off.");
		const doc = await store.readDoc(id);
		if (!doc)
			throw new Error(
				summary.status === "running" ? "The bake-off is still being prepared." : "The bake-off file is missing.",
			);
		return doc;
	}

	async function readFinished(id: string): Promise<BakeoffDoc> {
		const summary = store.get(store.checkId(id));
		if (!summary) throw new Error("There is no such bake-off.");
		if (summary.status === "running") throw new Error("The bake-off is still running.");
		const doc = await readDoc(id);
		if (!doc.bakeoff.result)
			throw new Error(`The bake-off has no result${summary.error ? `: ${summary.error}` : ""}.`);
		return doc;
	}

	async function fail(run: BakeoffRun, root: string, err: unknown): Promise<void> {
		if (err instanceof Cancelled && !run.stopped) return;
		const reason = err instanceof Cancelled ? "Stopped." : errorText(err);
		log(`bake-off ${run.id} failed: ${reason}`);
		const current = store.get(run.id);
		if (current === undefined) return;
		await store.put({ ...current, status: "failed", error: reason, progress: undefined, instanceId: undefined });
		// A bake-off that got as far as its document keeps its commits: "Review again" and the citations read them.
		if ((await store.readDoc(run.id).catch(() => null)) === null) await releaseParts(root, run.id, run.held);
		deps.changed(run.id);
	}

	/** The pieces every stage of one run shares. */
	function contextOf(run: BakeoffRun, doc: BakeoffDoc): Ctx {
		return {
			deps,
			run,
			doc,
			dirs,
			counter: { next: 0 },
			save: () => save(run, doc),
			progress: text => update(run, { progress: text }),
		};
	}

	/** The prepared document of a new bake-off: its entries labelled by the seed, its commits held. */
	async function prepare(run: BakeoffRun, job: BakeoffJob): Promise<BakeoffDoc> {
		const { request } = job;
		const warnings: string[] = [];
		let head: string;
		let base: string | undefined;
		let pr: { title: string; body?: string } | undefined;
		if (job.folder) {
			// No commit to read: every entry reads one copy of the folder's text files, made now.
			await update(run, { progress: "Copying the folder's files" });
			const dir = path.join(dirs.work, run.id, "folder");
			const copied = await copyFolderFiles(job.folder.checkout, await listFolderFiles(job.folder), dir);
			run.folder = { dir, files: copied, stored: 0 };
			head = FOLDER_COMMIT;
		} else if (job.prs || job.target) {
			const [part] = await resolveParts(
				{ prSource, progress: (r, text) => update(run, { progress: text }) },
				run,
				job,
			);
			head = part!.head.commit;
			base = part!.base.commit;
			if (part!.pr) pr = { title: part!.pr.title, body: part!.pr.body };
		} else {
			const target = await resolveTarget(job.root, { checkout: job.root });
			head = target.head.commit;
			await holdCommit(job.root, `${run.id}/p0`, "head", head);
			run.held = 1;
		}
		let document: BakeoffDoc["document"];
		if (request.doc) {
			if ("text" in request.doc) {
				document = { text: request.doc.text, ...(request.doc.name ? { name: request.doc.name } : {}) };
			} else if (job.folder) {
				const lines = await readFolderFile(run.folder!.dir, request.doc.path);
				if (lines === null) throw new Error(`There is no text file ${request.doc.path} in the folder.`);
				const text = lines.join("\n");
				if (text.length > BAKEOFF_MAX_DOC_CHARS)
					throw new Error(`${request.doc.path} is longer than ${BAKEOFF_MAX_DOC_CHARS} characters.`);
				document = { text, name: request.doc.path };
			} else {
				const text = await readBlob(job.root, head, request.doc.path);
				if (text === null)
					throw new Error(`There is no file ${request.doc.path} in the code the bake-off starts from.`);
				if (text.length > BAKEOFF_MAX_DOC_CHARS)
					throw new Error(`${request.doc.path} is longer than ${BAKEOFF_MAX_DOC_CHARS} characters.`);
				document = { text, name: request.doc.path };
			}
		}
		const digest = await readDigest(deps.sessionsDir, job.sessionId, warnings, "entries");
		if (
			request.mode === "implementation" &&
			request.start === "base" &&
			!request.goal &&
			!document &&
			!pr?.body &&
			!digest
		)
			throw new Error(
				"Starting from the base needs a statement of the goal: write it, add a design document, or pick a pull request or session that explains it.",
			);
		const problem = problemText({
			// Neutral: a branch's name would tell the reviewer which entry is the original.
			subject: job.folder
				? "a design for a folder of files"
				: base
					? "one change to the repository"
					: "a design for the repository",
			goal: request.goal,
			doc: document,
			pr,
			digest: digest?.text,
		});
		const labels = drawLabels(run.id, 1 + request.models.length);
		const entries: BakeoffEntry[] = [
			{ label: labels[0]!, kind: "original", status: "waiting", flags: [] } satisfies BakeoffEntry,
			...request.models.map((model, index): BakeoffEntry => ({
				label: labels[index + 1]!,
				kind: "challenger",
				model,
				status: "waiting",
				flags: [],
			})),
		].sort((a, b) => a.label.localeCompare(b.label));
		const writerInModels = request.writer !== "@default" && request.models.includes(request.writer);
		if (writerInModels)
			warnings.push(
				"The writer is also a challenger, so it writes up its own entry: it may favour its own wording.",
			);
		if (request.models.includes(request.reviewer))
			warnings.push("The reviewer is also a challenger: it may favour the entry its own model wrote.");
		const createdAt = store.get(run.id)?.createdAt ?? deps.now();
		const bakeoff: Bakeoff = {
			v: BAKEOFF_VERSION,
			id: run.id,
			title: job.title,
			repo: { root: job.root, name: job.name, ...(job.github ? { github: job.github } : {}) },
			createdAt,
			mode: request.mode,
			...(request.mode === "implementation" ? { start: request.start } : {}),
			metrics: request.metrics,
			...(request.instructions ? { instructions: request.instructions } : {}),
			entries,
			stage: "preparing",
			warnings,
			reviewer: request.reviewer,
			writer: request.writer,
			judge: request.judge,
			costs: { entries: 0, writeups: 0, review: 0, judge: 0 },
			...(job.folder ? { folder: true as const } : {}),
		};
		return {
			v: BAKEOFF_VERSION,
			id: run.id,
			bakeoff,
			commits: { ...(base ? { base } : {}), original: head, entries: {} },
			problem,
			request: {
				reviewerPasses: request.reviewerPasses,
				judge: request.judge,
				judgeAdvisory: request.judgeAdvisory,
				test: request.test,
				bench: request.bench,
				start: request.start,
				sandboxed: request.sandboxed,
				goal: request.goal,
			},
			subject: job.subject,
			maxCostUsd: request.maxCostUsd,
			held: Array.from({ length: run.held }, (_, index) => `${run.id}/p${index}`),
			...(document ? { document } : {}),
		};
	}

	async function execute(run: BakeoffRun, job: BakeoffJob): Promise<void> {
		const { request } = job;
		const doc = await prepare(run, job);
		if (run.cancelled) throw new Cancelled();
		const ctx = contextOf(run, doc);
		await store.writeDoc(doc);
		doc.bakeoff.stage = "entries";
		await ctx.save();
		if (request.mode === "design") {
			await designStage(ctx);
		} else {
			const targets = request.test ? await deps.measure?.runs.targets(job.root).catch(() => []) : undefined;
			const command = targets?.find(target => target.id === request.test?.target)?.command;
			const prompt = buildImplementationPrompt({
				problem: doc.problem,
				metrics: doc.bakeoff.metrics,
				measured: new Set(
					doc.bakeoff.metrics
						.filter(
							metric =>
								metric.id === "lines-changed" || (metric.id === "performance" && request.bench !== undefined),
						)
						.map(metric => metric.id),
				),
				instructions: doc.bakeoff.instructions,
				startsFromOriginal: request.start === "original",
				testCommand: command,
			});
			await implementationStage(
				ctx,
				request.start === "original" ? doc.commits.original : doc.commits.base!,
				prompt,
			);
			doc.bakeoff.stage = "facts";
			await ctx.save();
			await factsStage(ctx);
		}
		if (run.cancelled) throw new Cancelled();
		doc.bakeoff.stage = "writeups";
		await ctx.save();
		await writeupStage(ctx);
		if (run.cancelled) throw new Cancelled();
		await finishStages(ctx);
		await update(run, { status: "ready", progress: undefined, error: undefined, instanceId: undefined });
	}

	/** Start `work` as the one run of this computer. */
	function launch(id: string, root: string, work: (run: BakeoffRun) => Promise<void>): void {
		const run: BakeoffRun = {
			id,
			cancelled: false,
			stopped: false,
			held: 0,
			done: Promise.resolve(),
			stops: new Set(),
			sessions: new Map(),
		};
		runs.set(id, run);
		run.done = work(run)
			.catch(err => fail(run, root, err))
			.finally(() => {
				runs.delete(id);
				void fs.rm(path.join(dirs.work, id), { recursive: true, force: true }).catch(() => undefined);
			});
	}

	function checkNoneRunning(): void {
		if (runs.size > 0)
			throw new Error("A bake-off is already running on this computer. Wait for it, or stop it first.");
	}

	async function prune(): Promise<void> {
		const all = store
			.list()
			.filter(item => item.status !== "running")
			.sort((a, b) => b.createdAt - a.createdAt);
		const kept = all.filter(item => item.taken !== undefined && item.mode === "implementation");
		let room = MAX_BAKEOFFS - kept.length;
		for (const item of all) {
			if (kept.includes(item)) continue;
			if (room-- > 0) continue;
			await remove(item.id).catch(err => log(`removing an old bake-off failed: ${errorText(err)}`));
		}
	}

	async function remove(id: string): Promise<void> {
		store.checkId(id);
		const summary = store.get(id);
		if (!summary) throw new Error("There is no such bake-off.");
		const run = runs.get(id);
		if (run) {
			run.cancelled = true;
			for (const instanceId of run.sessions.values()) await deps.agent?.stop(instanceId).catch(() => undefined);
			await run.done;
		}
		const doc = await store.readDoc(id).catch(() => null);
		if (doc) {
			for (const mapId of doc.held) await releaseCommits(doc.bakeoff.repo.root, mapId).catch(() => undefined);
			if (doc.bakeoff.group) await deps.fanout?.unlink(doc.bakeoff.group).catch(() => undefined);
		} else {
			await releaseParts(summary.repoRoot, id, 1);
		}
		await store.remove(id);
		deps.changed(id);
	}

	return {
		async init() {
			const { interruptedInstances } = await store.load();
			await pruneLeftoverWorktrees(dirs.work);
			await Promise.all([
				fs.rm(dirs.out, { recursive: true, force: true }),
				fs.rm(dirs.overlay, { recursive: true, force: true }),
			]);
			if (deps.agent) {
				for (const instanceId of interruptedInstances)
					await deps.agent
						.stop(instanceId)
						.catch(err => log(`ending an interrupted bake-off's session failed: ${errorText(err)}`));
			}
		},

		async list(cwd) {
			const root = cwd === undefined ? undefined : (await folderInfo(cwd)).root;
			return store
				.list()
				.filter(item => root === undefined || item.repoRoot === root)
				.sort((a, b) => b.createdAt - a.createdAt);
		},

		async judge(cwd) {
			if (!deps.openJudge) return { state: "none", reason: "No judge model is set up on this computer." };
			let opened: OpenedJudge | undefined;
			try {
				const root = cwd === undefined ? process.cwd() : (await folderInfo(cwd)).root;
				opened = await deps.openJudge(root, () => undefined);
				return await describeSecondOpinion(opened.describe, opened.judge, opened.price);
			} catch (err) {
				return { state: "none", reason: errorText(err).replace(/^judgment:\s*/i, "") };
			} finally {
				opened?.close();
			}
		},

		async create(request) {
			const { cwd } = checkRunRequest(request, BAKEOFF_DEFAULT_MAX_COST_USD);
			const topic = await folderInfo(cwd);
			const checked = checkBakeoffCreate(request, !topic.git);
			if (deps.agent === null)
				throw new Error("This computer cannot run the sessions of a bake-off (tmux is missing).");
			if (checked.mode === "implementation" && deps.fanout === null)
				throw new Error("This computer cannot start the sessions of an implementation bake-off (tmux is missing).");
			checkNoneRunning();
			const info = topic.git ? await repoInfo(checked.cwd) : topic;
			let target: Job["target"];
			let subject: string;
			const docName = checked.doc && "name" in checked.doc && checked.doc.name ? checked.doc.name : "a design";
			if (!topic.git) {
				subject = docName;
			} else if (checked.pr !== undefined) {
				subject = `PR #${checked.pr}`;
			} else if (checked.ref !== undefined || checked.sessionId !== undefined) {
				const resolved = await resolveTarget(info.root, {
					ref: checked.ref,
					base: checked.base ?? "@default",
					checkout: info.checkout,
				});
				target = resolved;
				subject = `${resolved.label} vs ${resolved.base?.ref ?? resolved.base?.commit.slice(0, 8) ?? "the base"}`;
			} else {
				subject = docName;
			}
			const title = `${info.name} · ${subject}`;
			const id = store.newId();
			const job: BakeoffJob = {
				root: info.root,
				name: info.name,
				github: info.github,
				title,
				subject,
				prs: checked.pr === undefined ? undefined : [checked.pr],
				target,
				sessionId: checked.sessionId,
				maxCostUsd: checked.maxCostUsd,
				request: checked,
				...(topic.git ? {} : { folder: topic }),
			};
			await store.put({
				id,
				title,
				repoRoot: info.root,
				subject,
				createdAt: deps.now(),
				status: "running",
				progress: "Waiting to start",
				mode: checked.mode,
				stage: "preparing",
				maxCostUsd: checked.maxCostUsd,
			});
			deps.changed(id);
			launch(id, info.root, run => execute(run, job));
			void prune();
			return { id };
		},

		async get(id) {
			const doc = await readDoc(id);
			const states = await patchStates(doc);
			if (states.size === 0) return doc.bakeoff;
			return {
				...doc.bakeoff,
				entries: doc.bakeoff.entries.map(entry => {
					const patch = states.get(entry.label);
					return patch === undefined ? entry : { ...entry, patch };
				}),
			};
		},

		async excerpt(id, label, refs) {
			const doc = await readDoc(id);
			const entry = doc.bakeoff.entries.find(candidate => candidate.label === label);
			if (!entry) throw new Error("There is no such entry.");
			if (doc.bakeoff.folder) return folderExcerpts(doc, refs);
			return readExcerpts(doc.bakeoff.repo.root, { head: commitOf(doc, entry) }, refs);
		},

		async patch(id, label) {
			return await entryPatch(await readDoc(id), label);
		},

		async folder(cwd) {
			const info = await folderInfo(checkRunRequest({ cwd }, BAKEOFF_DEFAULT_MAX_COST_USD).cwd);
			const files = info.git ? [] : await listFolderFiles(info);
			return { git: info.git, files: files.length, name: info.name };
		},

		async stop(id, label) {
			store.checkId(id);
			const run = runs.get(id);
			if (!run) throw new Error("This bake-off is not running.");
			if (label === undefined) {
				run.stopped = true;
				run.cancelled = true;
				for (const instanceId of run.sessions.values()) await deps.agent?.stop(instanceId).catch(() => undefined);
				const doc = await store.readDoc(id).catch(() => null);
				for (const entry of doc?.bakeoff.entries ?? []) {
					if (entry.instanceId) await deps.agent?.stop(entry.instanceId).catch(() => undefined);
				}
				return;
			}
			const doc = await readDoc(id);
			const entry = doc.bakeoff.entries.find(
				candidate => candidate.label === label && candidate.kind === "challenger",
			);
			if (!entry) throw new Error("There is no such entry to stop.");
			run.stops.add(label);
			const instanceId = run.sessions.get(label) ?? entry.instanceId;
			if (instanceId) await deps.agent?.stop(instanceId).catch(() => undefined);
		},

		take(request) {
			return locked(locks, store.checkId(request.id), async () => {
				const doc = await readFinished(request.id);
				const entry = doc.bakeoff.entries.find(candidate => candidate.label === request.entry);
				if (!entry || !reviewable(doc).includes(entry)) throw new Error("There is no such entry to take.");
				let result: BakeoffTakeResult | undefined;
				if (doc.bakeoff.mode === "implementation" && entry.kind === "challenger") {
					const group = doc.bakeoff.group ? deps.fanout?.group(doc.bakeoff.group) : undefined;
					if (!group || !entry.instanceId || !deps.fanout)
						throw new Error("This entry's worktree is not available any more.");
					if (request.discardDirty && !request.removeOthers) throw new Error("invalid request");
					const kept = await deps.fanout.keep(group, {
						group: group.id,
						keep: entry.instanceId,
						removeOthers: request.removeOthers === true,
						discardDirty: request.discardDirty === true,
					});
					result = { removed: kept.removed, skipped: kept.skipped };
				} else if (request.removeOthers) {
					throw new Error("There is no worktree to keep for this entry, so there is nothing to remove.");
				}
				doc.bakeoff.result!.taken = entry.label;
				await save(undefined, doc);
				return result;
			});
		},

		remove(id) {
			return locked(locks, store.checkId(id), () => remove(id));
		},

		review(id) {
			return locked(locks, store.checkId(id), async () => {
				const summary = store.get(id);
				if (!summary || summary.status !== "failed")
					throw new Error("Only a bake-off whose review failed can be reviewed again.");
				const doc = await readDoc(id);
				if (doc.bakeoff.folder)
					throw new Error(
						"A bake-off of a folder cannot be reviewed again: the folder's files are only read while it runs.",
					);
				if (doc.bakeoff.stage !== "review" && doc.bakeoff.stage !== "judge")
					throw new Error("This bake-off did not fail in the review, so there is nothing to review again.");
				if (reviewable(doc).length < 2) throw new Error("Fewer than two entries are left to compare.");
				checkNoneRunning();
				await store.put({ ...summary, status: "running", error: undefined, progress: "Waiting to start" });
				deps.changed(id);
				launch(id, summary.repoRoot, async run => {
					const ctx = contextOf(run, doc);
					doc.bakeoff.costs.review = 0;
					doc.bakeoff.costs.judge = 0;
					await finishStages(ctx);
					await update(run, { status: "ready", progress: undefined, error: undefined });
				});
			});
		},

		async shutdown() {
			for (const run of runs.values()) {
				run.cancelled = true;
				for (const instanceId of run.sessions.values()) await deps.agent?.stop(instanceId).catch(() => undefined);
			}
			await Promise.all([...runs.values()].map(run => run.done));
		},

		async idle() {
			await Promise.all([...runs.values()].map(run => run.done));
		},
	};
}
