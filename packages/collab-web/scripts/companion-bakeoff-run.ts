/**
 * The stages of one bake-off (docs/design-review.md, *Stages*): entries → facts → write-ups → review → judge. The engine
 * (./companion-bakeoff) owns requests, storage and the run's lifecycle and calls these in order; every stage works on
 * the stored document and saves it, so a device sees each entry's progress and a failed run keeps what it made.
 *
 * Blindness is made here: the reviewer and the judge read the scrubbed write-ups, under labels the seed drew, from
 * folders that hold code exported without git (no branch names, no history). What a device or the companion's own
 * files show of models and branches is a leak the sandbox, not this module, contains (see the spec's *Anonymity*).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Bakeoff,
	type BakeoffEntry,
	type BakeoffFacts,
	type BakeoffFinding,
	type BakeoffJudgeState,
	type BakeoffPair,
	type BakeoffResult,
	type BakeoffVerdictPass,
	BAKEOFF_JUDGE_DIGEST_CHARS,
	isMeasuredMetric,
	splitBakeoffBudget,
} from "@oh-my-pi/pi-wire/bakeoff";
import type { FanoutGroup, FanoutKeepRequest, FanoutKeepResult, FanoutModel } from "../src/lib/fanout";
import {
	type AgentRunner,
	type AgentWatchOptions,
	agentFailureReason,
	agentFolderName,
	parseAgentJson,
	prepareOutputFile,
	READONLY_AGENT_TOOLS,
	restrictedOverlayYaml,
	runAgentToFile,
} from "./companion-agent";
import { createScrubber, type NamedModel, type Scrubber } from "./companion-bakeoff-anonymise";
import {
	buildDesignBrief,
	buildReviewBrief,
	buildWriteupBrief,
	type ReviewEntryInput,
} from "./companion-bakeoff-brief";
import {
	type JudgeDescribed,
	type JudgeLike,
	describeSecondOpinion,
	reasonOf,
	runJudgePass,
} from "./companion-bakeoff-judge";
import type { PrSource } from "./companion-quiz-stack";
import { type MeasureDeps, measureBench, measureTests, numstat } from "./companion-bakeoff-measure";
import { exportCommit, presentation } from "./companion-bakeoff-pack";
import { combine } from "./companion-bakeoff-rank";
import { parseReview, type ReviewIo, remapLabels, verifyReview, type VerifiedReview } from "./companion-bakeoff-review";
import type { BakeoffDoc } from "./companion-bakeoff-store";
import {
	factsLine,
	judgeDigest,
	parseWriteup,
	renderWriteup,
	scrubWriteup,
	verifyWriteup,
} from "./companion-bakeoff-write";
import { addWorktree, readBlob, removeWorktreeDir, snapshotWorkingTree, holdCommit } from "./companion-blueprint-git";
import { normalizeRepoPath } from "./companion-citations";
import { splitLines } from "./companion-excerpt";
import { partDiff } from "./companion-quiz-diff";
import { copyFolderFiles, MAX_STORED_CHARS, readFolderFile } from "./companion-quiz-folder";
import { Cancelled, errorText, type Run } from "./companion-review-base";

// ── what the engine gives the stages ─────────────────────────────────────────

/** A judge as the companion opens it (`openStandaloneJudge`), with what the engine needs of it. */
export interface OpenedJudge {
	judge: JudgeLike;
	native: boolean;
	describe: JudgeDescribed | undefined;
	/** USD per million tokens of the model it routes to first, as text, for the form's cost note. */
	price?: string;
	close(): void;
}

/** The fan-out (./companion-fanout) as a bake-off uses it. */
export interface BakeoffFanout {
	/** Create the worktrees (all from `startCommit`), start a session in each and record the group. */
	start(input: {
		cwd: string;
		prompt: string;
		models: string[];
		budgetUsd: number;
		sandboxed?: boolean;
		startCommit: string;
		bakeoff: string;
	}): Promise<FanoutGroup>;
	group(id: string): FanoutGroup | undefined;
	/** Keep one session's worktree and, when asked, remove the others; saves the group. */
	keep(group: FanoutGroup, request: FanoutKeepRequest): Promise<FanoutKeepResult>;
	/** Let a group go the way of any other group (its bake-off is gone); saves it. */
	unlink(groupId: string): Promise<void>;
}

export interface BakeoffDeps {
	/** `<agent dir>/bakeoffs`: the index and the bake-offs. */
	storeDir: string;
	/** `<config dir>/cache/bakeoffs`: `work/`, `out/`, `overlay/`. */
	cacheDir: string;
	/** `<agent dir>/sessions`, where the conversations of sessions are. */
	sessionsDir: string;
	now(): number;
	/** A bake-off's summary changed: tell the connected devices. */
	changed(id: string): void;
	/** The session writing designs, write-ups and the review; null when this computer cannot run one (no tmux). */
	agent: AgentRunner | null;
	/** Implementation mode's sessions; null when this computer cannot start them. */
	fanout: BakeoffFanout | null;
	/** The models the picker offers, for the names the scrubber hides. */
	models?(): Promise<FanoutModel[]>;
	/** Runs tests and benchmarks of an entry; without it no facts are measured. */
	measure?: MeasureDeps;
	/** Prepare a fresh checkout of the original (the companion's setup script) before its tests run. */
	setupCheckout?(tree: { root: string; path: string; branch: string }): Promise<unknown>;
	/** Opens the `judge` role's judge; `onUsage` is told the cost of each judgment. */
	openJudge?(root: string, onUsage: (usd: number) => void): Promise<OpenedJudge>;
	/** Timing of the waits; tests shorten it. */
	watch?: Partial<AgentWatchOptions>;
	/** The pull requests of a repository; tests replace it. */
	prSource?(root: string): PrSource;
	log?(message: string): void;
}

/** One run of a bake-off in this process. */
export interface BakeoffRun extends Run {
	/** Labels of entries the person stopped. */
	stops: Set<string>;
	/** The whole run was stopped by the person: it ends `failed` with what it made kept. */
	stopped: boolean;
	/**
	 * A bake-off of a folder that is not a git repository: the copy of the folder's text files every entry reads (one
	 * folder, made when the run started), the files in it, and the characters of cited files stored so far.
	 */
	folder?: { dir: string; files: string[]; stored: number };
	/** The session working on each entry (or on the review: `review`), to stop it. */
	sessions: Map<string, string>;
}

export interface Ctx {
	deps: BakeoffDeps;
	run: BakeoffRun;
	doc: BakeoffDoc;
	dirs: { work: string; out: string; overlay: string };
	/** Write the document and its summary and tell the devices; throws {@link Cancelled} when the bake-off is gone. */
	save(): Promise<void>;
	/** A step shown in the list row. */
	progress(text: string): Promise<void>;
	/** Output files and overlays are named with this and a counter, so concurrent sessions never share one. */
	counter: { next: number };
}

// ── small shared things ──────────────────────────────────────────────────────

const MIN_STAGE_USD = 0.01;
/** Designers and writers at once: each is a read-only session, but many at once crowd the machine. */
const SESSION_CONCURRENCY = 2;
/** Tail of the original's checkout name: the original's tests run in a throw-away checkout. */
const ORIGINAL_FOLDER = "original";

export function spent(bakeoff: Bakeoff): number {
	const { entries, writeups, review, judge } = bakeoff.costs;
	return entries + writeups + review + judge;
}

/** Of `share`, what is left of the limit, in whole cents. */
function afford(ctx: Ctx, share: number): number {
	const left = ctx.doc.maxCostUsd - spent(ctx.doc.bakeoff);
	return Math.floor(Math.min(share, left) * 100) / 100;
}

function metricLabels(bakeoff: Bakeoff): Record<string, string> {
	return Object.fromEntries(bakeoff.metrics.map(metric => [metric.id, metric.label]));
}

function measuredSet(doc: BakeoffDoc): Set<string> {
	const hasBench = doc.request.bench !== undefined;
	return new Set(doc.bakeoff.metrics.filter(metric => isMeasuredMetric(metric, hasBench)).map(metric => metric.id));
}

function original(bakeoff: Bakeoff): BakeoffEntry {
	return bakeoff.entries.find(entry => entry.kind === "original")!;
}

function entryOf(bakeoff: Bakeoff, label: string): BakeoffEntry {
	const entry = bakeoff.entries.find(candidate => candidate.label === label);
	if (!entry) throw new Error(`There is no entry ${label}.`);
	return entry;
}

/** The commit an entry's code is read at. */
export function commitOf(doc: BakeoffDoc, entry: BakeoffEntry): string {
	if (doc.bakeoff.mode === "design" || entry.kind === "original") return doc.commits.original;
	const commit = doc.commits.entries[entry.label];
	if (!commit) throw new Error(`Entry ${entry.label} has no code to read.`);
	return commit;
}

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
	});
	await Promise.all(workers);
}

function check(ctx: Ctx): void {
	if (ctx.run.cancelled) throw new Cancelled();
}

/** The scrubber of this bake-off: every challenger model's names and every branch. */
export async function scrubberOf(ctx: Ctx): Promise<Scrubber> {
	const catalog = await ctx.deps.models?.().catch(() => [] as FanoutModel[]);
	const named: NamedModel[] = ctx.doc.bakeoff.entries.flatMap(entry => {
		if (!entry.model) return [];
		const found = catalog?.find(model => model.selector === entry.model);
		return [{ selector: entry.model, name: found?.name, provider: found?.provider }];
	});
	const reviewer = ctx.doc.bakeoff.reviewer;
	const found = catalog?.find(model => model.selector === reviewer);
	named.push({ selector: reviewer, name: found?.name, provider: found?.provider });
	const writer = ctx.doc.bakeoff.writer;
	if (writer !== "@default" && !named.some(model => model.selector === writer)) named.push({ selector: writer });
	return createScrubber(
		named,
		ctx.doc.bakeoff.entries.flatMap(entry => (entry.branch ? [entry.branch] : [])),
	);
}

// ── one read-only session that writes one JSON file ──────────────────────────

interface FileTask<T> {
	/** The cost goes to this stage of the bake-off. */
	stage: keyof Bakeoff["costs"];
	/** Names the session's output file and folder; unique per session. */
	tag: string;
	cwd: string;
	model?: string;
	/** What it may spend on the first try; a retry takes what is left of this and the reserve. */
	maxCostUsd: number;
	/** The first message. `note` is why the last file was rejected, on a retry. */
	brief(outFile: string, note: string | undefined): string;
	/** "the design", "the write-up", "the review": completes "The agent did not write …". */
	what: string;
	/** An entry the person can stop. */
	stopLabel?: string;
	/** Turn the file's text into the result; throws the plain-words reason it cannot be used. */
	accept(text: string): Promise<T>;
	/** The session started. */
	started?(instanceId: string): Promise<void>;
}

interface FileResult<T> {
	value?: T;
	/** Why there is no value, in plain words. */
	error?: string;
	/** The person stopped this entry. */
	stopped: boolean;
	costUsd: number;
}

/**
 * Start the session, wait for its file and accept it. A file that is not usable gets one more session with the reason
 * appended (the agent runner cannot message a running session); a session that ended without a file is not retried.
 */
async function fileTask<T>(ctx: Ctx, task: FileTask<T>): Promise<FileResult<T>> {
	const { deps, run, doc } = ctx;
	if (deps.agent === null) throw new Error("This computer cannot run the sessions of a bake-off (tmux is missing).");
	let note: string | undefined;
	let costUsd = 0;
	let error = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const limit = attempt === 0 ? task.maxCostUsd : afford(ctx, task.maxCostUsd);
		if (limit < MIN_STAGE_USD) return { error: error || "the spending limit was used up", stopped: false, costUsd };
		const name = `${doc.id}-${task.tag}-${attempt}`;
		const outFile = await prepareOutputFile(ctx.dirs.out, name);
		const overlayPath = path.join(ctx.dirs.overlay, `${name}.yml`);
		const ran = await runAgentToFile({
			agent: deps.agent,
			launch: {
				cwd: task.cwd,
				prompt: task.brief(outFile, note),
				maxCostUsd: limit,
				model: task.model,
				outFile,
				overlayPath,
				overlayYaml: restrictedOverlayYaml(outFile, READONLY_AGENT_TOOLS),
				tools: READONLY_AGENT_TOOLS,
			},
			watch: deps.watch,
			now: deps.now,
			cancelled: () => run.cancelled || (task.stopLabel !== undefined && run.stops.has(task.stopLabel)),
			started: async instanceId => {
				run.sessions.set(task.stopLabel ?? task.tag, instanceId);
				await task.started?.(instanceId);
			},
			log: deps.log,
		});
		run.sessions.delete(task.stopLabel ?? task.tag);
		costUsd += ran.costUsd ?? 0;
		doc.bakeoff.costs[task.stage] += ran.costUsd ?? 0;
		check(ctx);
		const { outcome } = ran;
		if (outcome.kind === "cancelled") return { stopped: true, costUsd };
		if (outcome.kind !== "done")
			return {
				error: `The agent did not write ${task.what}: ${agentFailureReason(outcome, ran.costUsd, limit, task.what)}.`,
				stopped: false,
				costUsd,
			};
		try {
			return { value: await task.accept(outcome.text), stopped: false, costUsd };
		} catch (err) {
			const reason =
				err instanceof SyntaxError ? "its file was not valid JSON" : errorText(err).replace(/[.\s]+$/, "");
			error = `The agent's ${task.what.replace(/^the /, "")} could not be used (${reason}).`;
			note = `The file you wrote last time was rejected: ${reason}. Write the whole file again, fixed, in the template.`;
		}
	}
	return { error, stopped: false, costUsd };
}

/** Lines of a file of `commit`, for checking citations. */
function linesAt(root: string, commit: string): (file: string) => Promise<string[] | null> {
	return async file => {
		const text = await readBlob(root, commit, file);
		return text === null ? null : splitLines(text);
	};
}

/**
 * Put the code the entries are about at `dir`. A repository's: a checkout of `commit` (`how: "checkout"`, a designer's
 * own tree) or the commit exported without history. A folder's: a copy of its files as they were when the run started.
 */
async function placeCode(ctx: Ctx, dir: string, commit: string, how: "checkout" | "export"): Promise<void> {
	const { run, doc } = ctx;
	if (run.folder !== undefined) await copyFolderFiles(run.folder.dir, run.folder.files, dir);
	else if (how === "checkout") await addWorktree(doc.bakeoff.repo.root, dir, commit);
	else await exportCommit(doc.bakeoff.repo.root, commit, dir);
}

/**
 * Lines of a file of the code the entries are about, for checking citations: of `commit`, or of the folder's copy. Lines
 * a citation of a folder read are kept in the document (up to {@link MAX_STORED_CHARS}), since no commit holds them.
 */
function codeLines(ctx: Ctx, commit: string): (file: string) => Promise<string[] | null> {
	const { run, doc } = ctx;
	const folder = run.folder;
	if (folder === undefined) return linesAt(doc.bakeoff.repo.root, commit);
	return async file => {
		const lines = await readFolderFile(folder.dir, file);
		const key = normalizeRepoPath(file);
		if (lines === null || key === undefined) return null;
		doc.files ??= {};
		if (doc.files[key] === undefined) {
			const chars = lines.reduce((sum, line) => sum + line.length + 1, 0);
			if (folder.stored + chars > MAX_STORED_CHARS) return null;
			folder.stored += chars;
			doc.files[key] = lines;
		}
		return lines;
	};
}

// ── entries: design mode ─────────────────────────────────────────────────────

/**
 * What the designers and the writer read of an entry's change, beside the problem statement (which holds the document):
 * the numbered diff of the original's change. A design that is only a document has no diff.
 */
export async function originalBody(ctx: Ctx, commit: string): Promise<string> {
	const { doc } = ctx;
	if (!doc.commits.base) return "The design is the document in the problem statement above.";
	const diff = await partDiff(doc.bakeoff.repo.root, doc.commits.base, commit, { maxChars: 60_000 });
	return [
		"The change, as a numbered diff (a file header, then one line per diff line: a marker, a line number, two spaces, the text; cite context and added lines as `path@<number>@token`):",
		"",
		diff.stat,
		"",
		diff.text,
	].join("\n");
}

async function designOne(ctx: Ctx, entry: BakeoffEntry, limit: number): Promise<void> {
	const { doc } = ctx;
	const root = doc.bakeoff.repo.root;
	if (afford(ctx, limit) < MIN_STAGE_USD) {
		entry.status = "failed";
		entry.error = "The spending limit was used up before this design could start.";
		await ctx.save();
		return;
	}
	entry.status = "working";
	await ctx.save();
	const dir = path.join(
		ctx.dirs.work,
		doc.id,
		"design",
		entry.label,
		agentFolderName("Bake-off design", doc.bakeoff.repo.name, `entry ${entry.label}`),
	);
	await placeCode(ctx, dir, doc.commits.original, "checkout");
	try {
		const scrub = await scrubberOf(ctx);
		const metrics = doc.bakeoff.metrics;
		const ids = metrics.map(metric => metric.id);
		const body = await originalBody(ctx, doc.commits.original);
		const result = await fileTask(ctx, {
			stage: "entries",
			tag: `d${entry.label}`,
			cwd: dir,
			model: entry.model,
			maxCostUsd: afford(ctx, limit),
			stopLabel: entry.label,
			what: "the design",
			brief: (outFile, note) => {
				const brief = buildDesignBrief({
					repo: doc.bakeoff.repo.name,
					subject: doc.commits.base
						? "the change in the problem statement"
						: "the design in the problem statement",
					checkout:
						ctx.run.folder === undefined
							? "the code the design is about"
							: "a copy of the folder's text files as they are now",
					outFile,
					maxCostUsd: limit,
					problem: doc.problem,
					subjectBody: body,
					metrics,
					measured: measuredSet(doc),
					instructions: doc.bakeoff.instructions,
				});
				return note ? `${brief}\n\n# Last time\n\n${note}` : brief;
			},
			started: async instanceId => {
				entry.instanceId = instanceId;
				await ctx.save();
			},
			accept: async text => {
				const warnings: string[] = [];
				const parsed = parseWriteup(parseAgentJson(text), ids);
				const writeup = await verifyWriteup(parsed, codeLines(ctx, doc.commits.original), warnings);
				doc.bakeoff.warnings.push(...warnings.map(warning => `Entry ${entry.label}: ${warning}`));
				return scrubWriteup(writeup, text => scrub(text).text);
			},
		});
		entry.costUsd = (entry.costUsd ?? 0) + result.costUsd;
		entry.instanceId = undefined;
		if (result.value) {
			entry.writeup = result.value;
			entry.status = "ready";
		} else if (result.stopped) {
			entry.status = "stopped";
		} else {
			entry.status = "failed";
			entry.error = result.error;
		}
		await ctx.save();
	} catch (err) {
		if (err instanceof Cancelled) throw err;
		entry.status = "failed";
		entry.error = errorText(err);
		entry.instanceId = undefined;
		await ctx.save();
	} finally {
		if (ctx.run.folder === undefined) await removeWorktreeDir(root, dir).catch(() => undefined);
		else await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Design mode: each challenger writes its design, two at a time. */
export async function designStage(ctx: Ctx): Promise<void> {
	const { doc } = ctx;
	const budget = splitBakeoffBudget(doc.maxCostUsd, "design");
	const challengers = doc.bakeoff.entries.filter(entry => entry.kind === "challenger");
	const each = Math.floor((budget.challengers / challengers.length) * 100) / 100;
	await ctx.progress("The challengers are writing their designs");
	await pool(challengers, SESSION_CONCURRENCY, async entry => {
		check(ctx);
		await designOne(ctx, entry, each);
	});
}

// ── entries: implementation mode ─────────────────────────────────────────────

/** Implementation mode: one worktree and session per challenger, from the same commit; wait for them to settle. */
export async function implementationStage(ctx: Ctx, startCommit: string, prompt: string): Promise<void> {
	const { deps, doc, run } = ctx;
	if (deps.fanout === null || deps.agent === null)
		throw new Error("This computer cannot start the sessions of an implementation bake-off (tmux is missing).");
	const budget = splitBakeoffBudget(doc.maxCostUsd, "implementation");
	const challengers = doc.bakeoff.entries.filter(entry => entry.kind === "challenger");
	await ctx.progress("Creating a worktree for each challenger");
	const group = await deps.fanout.start({
		cwd: doc.bakeoff.repo.root,
		prompt,
		models: challengers.map(entry => entry.model!),
		budgetUsd: budget.challengers,
		sandboxed: doc.request.sandboxed,
		startCommit,
		bakeoff: doc.id,
	});
	doc.bakeoff.group = group.id;
	for (const [index, entry] of challengers.entries()) {
		const started = group.runs[index]!;
		entry.branch = started.branch;
		entry.path = started.path;
		if (started.instanceId === undefined) {
			entry.status = "failed";
			entry.error = started.error ?? "its session did not start";
		} else {
			entry.instanceId = started.instanceId;
			entry.status = "working";
		}
	}
	await ctx.save();
	check(ctx);
	await ctx.progress("The challengers are working");
	await awaitSessions(
		ctx,
		challengers.filter(entry => entry.status === "working"),
	);
	check(ctx);
	if (run.cancelled) throw new Cancelled();
}

/** Wait until every session has been idle for a while, ended or been stopped, or the time is up. */
async function awaitSessions(ctx: Ctx, entries: BakeoffEntry[]): Promise<void> {
	const { deps, doc, run } = ctx;
	const agent = deps.agent!;
	const options = {
		pollMs: 3_000,
		settleMs: 15_000,
		idleMs: 120_000,
		goneMs: 10_000,
		timeoutMs: 45 * 60_000,
		...deps.watch,
	};
	const started = deps.now();
	const state = new Map(
		entries.map(entry => [
			entry.label,
			{
				sawBusy: false,
				idleSince: null as number | null,
				goneSince: null as number | null,
				sessionId: undefined as string | undefined,
			},
		]),
	);
	const pending = new Set(entries.map(entry => entry.label));
	const perSession = splitBakeoffBudget(doc.maxCostUsd, "implementation").challengers / Math.max(1, entries.length);
	const settle = async (entry: BakeoffEntry, why: "idle" | "gone" | "stopped" | "time"): Promise<void> => {
		pending.delete(entry.label);
		const sessionId = state.get(entry.label)?.sessionId;
		const cost = sessionId ? await agent.cost(sessionId).catch(() => undefined) : undefined;
		if (cost !== undefined) {
			entry.costUsd = cost;
			if (cost >= perSession * 0.98) entry.flags.push("hit its spending limit");
		}
		if (why === "stopped") entry.status = "stopped";
		if (why === "time") {
			entry.flags.push("ran out of time");
			entry.status = "stopped";
		}
		doc.bakeoff.costs.entries = doc.bakeoff.entries.reduce((sum, candidate) => sum + (candidate.costUsd ?? 0), 0);
		await ctx.save();
	};
	while (pending.size > 0) {
		check(ctx);
		const now = deps.now();
		const hosts = await agent.hosts();
		for (const entry of entries) {
			if (!pending.has(entry.label)) continue;
			const seen = state.get(entry.label)!;
			if (run.stops.has(entry.label)) {
				await settle(entry, "stopped");
				continue;
			}
			const host = hosts.find(candidate => candidate.instanceId === entry.instanceId);
			if (!host) {
				seen.goneSince ??= now;
				if (now - seen.goneSince >= options.goneMs) await settle(entry, "gone");
				continue;
			}
			seen.goneSince = null;
			seen.sessionId = host.sessionId;
			if (host.busy === true) seen.sawBusy = true;
			seen.idleSince = host.busy === false ? (seen.idleSince ?? now) : null;
			const ready = seen.sawBusy || now - started >= options.idleMs;
			if (ready && seen.idleSince !== null && now - seen.idleSince >= options.settleMs) await settle(entry, "idle");
		}
		if (pending.size === 0) break;
		if (deps.now() - started > options.timeoutMs) {
			for (const entry of entries) if (pending.has(entry.label)) await settle(entry, "time");
			break;
		}
		await Bun.sleep(options.pollMs);
	}
}

// ── facts ────────────────────────────────────────────────────────────────────

/** Snapshot every entry's folder, hold the commits, measure the diffs and run the tests and the benchmark. */
export async function factsStage(ctx: Ctx): Promise<void> {
	const { deps, doc } = ctx;
	const root = doc.bakeoff.repo.root;
	const base = doc.commits.base;
	if (!base) return;
	await ctx.progress("Measuring each entry");
	const orig = original(doc.bakeoff);
	const measurable = doc.bakeoff.entries.filter(
		entry => entry.kind === "challenger" && entry.path && entry.status !== "failed",
	);
	for (const entry of measurable) {
		doc.commits.entries[entry.label] = await snapshotWorkingTree(entry.path!);
		const mapId = `${doc.id}/e${entry.label}`;
		await holdCommit(root, mapId, "head", doc.commits.entries[entry.label]!);
		doc.held.push(mapId);
	}
	doc.commits.entries[orig.label] = doc.commits.original;
	for (const entry of [orig, ...measurable]) {
		check(ctx);
		const commit = doc.commits.entries[entry.label]!;
		const facts: BakeoffFacts = { ...(await numstat(root, base, commit)) };
		if (doc.bakeoff.start === "original")
			facts.deltaFromOriginal =
				entry === orig ? { files: 0, added: 0, removed: 0 } : await numstat(root, doc.commits.original, commit);
		entry.facts = facts;
	}
	await ctx.save();
	const { test, bench } = doc.request;
	if (!deps.measure || (!test && !bench)) return;
	const checkout = path.join(
		ctx.dirs.work,
		doc.id,
		ORIGINAL_FOLDER,
		agentFolderName("Bake-off", doc.bakeoff.repo.name, ORIGINAL_FOLDER),
	);
	await addWorktree(root, checkout, doc.commits.original);
	try {
		await deps.setupCheckout?.({ root, path: checkout, branch: "" }).catch(err => {
			doc.bakeoff.warnings.push(
				`The original's checkout could not be prepared (${errorText(err)}); its tests may not run.`,
			);
		});
		const reference = await deps.measure.runs.targets(checkout).catch(() => []);
		for (const entry of [orig, ...measurable]) {
			check(ctx);
			const facts = entry.facts!;
			const folder = entry === orig ? checkout : entry.path!;
			const key = `bk-${doc.id}-${entry.label}`;
			if (test) {
				await ctx.progress(`Running the tests of entry ${entry.label}`);
				const measured = await measureTests({
					deps: deps.measure,
					key,
					root: folder,
					choice: test,
					reference,
					baseOnly: doc.bakeoff.start === "base" && entry !== orig,
				});
				facts.tests = measured.tests;
				for (const flag of measured.flags) if (!entry.flags.includes(flag)) entry.flags.push(flag);
			}
			if (bench) {
				await ctx.progress(`Running the benchmark of entry ${entry.label}`);
				const measured = await measureBench({
					deps: deps.measure,
					key,
					root: folder,
					choice: bench,
					reference,
					better: bench.better,
					valueRegex: bench.valueRegex,
				});
				facts.bench = measured.bench;
				for (const flag of measured.flags) if (!entry.flags.includes(flag)) entry.flags.push(flag);
			}
			await ctx.save();
		}
	} finally {
		await removeWorktreeDir(root, checkout).catch(() => undefined);
	}
}

// ── write-ups ────────────────────────────────────────────────────────────────

/** The writer's model: a selector, or the default model when the setting is `@default`. */
function writerModel(bakeoff: Bakeoff): string | undefined {
	return bakeoff.writer === "@default" ? undefined : bakeoff.writer;
}

async function writeOne(ctx: Ctx, entry: BakeoffEntry, limit: number): Promise<void> {
	const { doc } = ctx;
	const commit = commitOf(doc, entry);
	const metrics = doc.bakeoff.metrics;
	const ids = metrics.map(metric => metric.id);
	if (afford(ctx, limit) < MIN_STAGE_USD) {
		entry.flags.push("no write-up");
		entry.status = entry.status === "failed" ? "failed" : "ready";
		return;
	}
	const dir = path.join(
		ctx.dirs.work,
		doc.id,
		"writer",
		entry.label,
		agentFolderName("Bake-off write-up", doc.bakeoff.repo.name, `entry ${entry.label}`),
	);
	await placeCode(ctx, dir, commit, "export");
	const scrub = await scrubberOf(ctx);
	const body = await originalBody(ctx, commit);
	const result = await fileTask(ctx, {
		stage: "writeups",
		tag: `w${entry.label}`,
		cwd: dir,
		model: writerModel(doc.bakeoff),
		maxCostUsd: afford(ctx, limit),
		what: "the write-up",
		brief: (outFile, note) => {
			const brief = buildWriteupBrief({
				repo: doc.bakeoff.repo.name,
				subject:
					entry.kind === "original" && doc.document && !doc.commits.base
						? "the code the design document is about"
						: "the code of one solution",
				outFile,
				maxCostUsd: limit,
				problem: doc.problem,
				subjectBody: body,
				metrics,
			});
			return note ? `${brief}\n\n# Last time\n\n${note}` : brief;
		},
		accept: async text => {
			const warnings: string[] = [];
			const parsed = parseWriteup(parseAgentJson(text), ids);
			const writeup = await verifyWriteup(parsed, codeLines(ctx, commit), warnings);
			doc.bakeoff.warnings.push(...warnings.map(warning => `Entry ${entry.label}: ${warning}`));
			return scrubWriteup(writeup, text => scrub(text).text);
		},
	});
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	if (result.value) {
		entry.writeup = result.value;
	} else {
		entry.flags.push("no write-up");
		doc.bakeoff.warnings.push(`Entry ${entry.label} has no write-up: ${result.error ?? "the writer was stopped"}`);
	}
}

/** The write-up of every entry that needs one from the writer: the original, and in implementation mode every challenger. */
export async function writeupStage(ctx: Ctx): Promise<void> {
	const { doc } = ctx;
	const budget = splitBakeoffBudget(doc.maxCostUsd, doc.bakeoff.mode);
	const todo = doc.bakeoff.entries.filter(entry => {
		if (entry.writeup || entry.status === "failed") return false;
		return doc.bakeoff.mode === "design" ? entry.kind === "original" : doc.commits.entries[entry.label] !== undefined;
	});
	const each = Math.floor((budget.writers / Math.max(1, todo.length)) * 100) / 100;
	await ctx.progress("Writing up each entry in the same template");
	for (const entry of todo) if (entry.status === "working") entry.status = "writing-up";
	await ctx.save();
	await pool(todo, SESSION_CONCURRENCY, async entry => {
		check(ctx);
		try {
			await writeOne(ctx, entry, each);
		} catch (err) {
			if (err instanceof Cancelled) throw err;
			entry.flags.push("no write-up");
			doc.bakeoff.warnings.push(`Entry ${entry.label} has no write-up: ${errorText(err)}`);
		}
		await ctx.save();
	});
}

// ── review ───────────────────────────────────────────────────────────────────

/** An entry the review reads: it has a write-up, or at least code and facts. */
export function reviewable(doc: BakeoffDoc): BakeoffEntry[] {
	return doc.bakeoff.entries.filter(entry => entry.status !== "failed" && (entry.writeup || entry.facts));
}

interface PassResult {
	verified: VerifiedReview;
	pass: BakeoffVerdictPass;
}

/** One blind review under the presentation `pass` draws. */
async function reviewPass(ctx: Ctx, pass: 0 | 1, entries: BakeoffEntry[], limit: number): Promise<PassResult> {
	const { doc } = ctx;
	const root = doc.bakeoff.repo.root;
	const design = doc.bakeoff.mode === "design";
	const labels = entries.map(entry => entry.label);
	const view = presentation(doc.id, pass, labels);
	const toEntry = Object.fromEntries(Object.entries(view.packLabel).map(([entry, read]) => [read, entry]));
	const labelNames = metricLabels(doc.bakeoff);
	const cwd = path.join(
		ctx.dirs.work,
		doc.id,
		`review${pass}`,
		agentFolderName("Bake-off review", doc.bakeoff.repo.name, "blind"),
	);
	await fs.rm(cwd, { recursive: true, force: true });
	await fs.mkdir(cwd, { recursive: true });
	if (design) await placeCode(ctx, path.join(cwd, "code"), doc.commits.original, "export");

	const share = Math.max(8_000, Math.floor(120_000 / entries.length));
	const rendered = new Map<string, string>();
	const inputs: ReviewEntryInput[] = [];
	for (const label of view.order) {
		const entry = entryOf(doc.bakeoff, label);
		const folder = view.packLabel[label]!;
		const writeup = entry.writeup
			? renderWriteup(entry.writeup, labelNames)
			: "(No write-up was written for this entry; judge it by its code and the measured facts.)";
		rendered.set(label, writeup);
		const input: ReviewEntryInput = {
			label: folder,
			folder,
			writeup,
			facts: factsLine(design ? undefined : entry.facts),
			flags: entry.flags,
		};
		if (design) {
			await fs.mkdir(path.join(cwd, folder), { recursive: true });
			await Bun.write(path.join(cwd, folder, "design.md"), writeup);
		} else {
			await exportCommit(root, commitOf(doc, entry), path.join(cwd, folder));
			const diff = await partDiff(root, doc.commits.base!, commitOf(doc, entry), { maxChars: share });
			input.stat = diff.stat;
			input.diff = diff.text;
		}
		inputs.push(input);
	}
	const io: ReviewIo = {
		lines: async (label, file) => {
			if (design && file === "design.md") return splitLines(rendered.get(label) ?? "");
			const entry = entryOf(doc.bakeoff, label);
			return codeLines(ctx, commitOf(doc, entry))(file);
		},
	};
	const metrics = doc.bakeoff.metrics;
	const ids = metrics.map(metric => metric.id);
	const model = doc.bakeoff.reviewer;
	const result = await fileTask(ctx, {
		stage: "review",
		tag: `r${pass}`,
		cwd,
		model,
		maxCostUsd: limit,
		what: "the review",
		brief: (outFile, note) => {
			const brief = buildReviewBrief({
				repo: doc.bakeoff.repo.name,
				outFile,
				maxCostUsd: limit,
				problem: doc.problem,
				metrics,
				measured: measuredSet(doc),
				entries: inputs,
				folderNote: design
					? "the code all the designs are about is in `code/`; cite its files as `A/src/file.ts@line@token`, where A is the design the finding is about and the path is as inside `code/`, and cite a design's own text as `A/design.md@line@token`"
					: undefined,
			});
			return note ? `${brief}\n\n# Last time\n\n${note}` : brief;
		},
		accept: async text => {
			const parsed = parseReview(
				parseAgentJson(text),
				inputs.map(input => input.label),
				ids,
			);
			const warnings: string[] = [];
			const verified = await verifyReview(parsed, toEntry, io, warnings);
			doc.bakeoff.warnings.push(...warnings);
			return { verified, parsed };
		},
	});
	await fs.rm(path.dirname(cwd), { recursive: true, force: true }).catch(() => undefined);
	if (!result.value) throw new Error(result.error ?? "The review was stopped.");
	const { verified, parsed } = result.value;
	return {
		verified,
		pass: { ranking: verified.ranking, verdict: verified.verdict || remapLabels(parsed.verdict, toEntry) },
	};
}

/** What the reviewer passes made, merged. */
export interface Reviewed {
	rankings: string[][];
	scores: Record<string, Record<string, number>>;
	findings: BakeoffFinding[];
	passes: BakeoffVerdictPass[];
	unsure: string[];
}

/** The review: one blind pass, or two with reversed order and new labels. A second pass that fails is dropped with a note. */
export async function reviewStage(ctx: Ctx): Promise<Reviewed> {
	const { doc } = ctx;
	const entries = reviewable(doc);
	if (entries.length < 2) throw new Error("Fewer than two entries are left to compare.");
	await ctx.progress("The reviewer is reading every entry");
	const budget = splitBakeoffBudget(doc.maxCostUsd, doc.bakeoff.mode);
	const passes = doc.request.reviewerPasses ?? 1;
	const each = Math.floor((budget.reviewer / passes) * 100) / 100;
	const done: PassResult[] = [];
	for (const pass of [0, 1] as const) {
		if (pass >= passes) break;
		check(ctx);
		try {
			done.push(await reviewPass(ctx, pass, entries, afford(ctx, each)));
		} catch (err) {
			if (err instanceof Cancelled || pass === 0) throw err;
			doc.bakeoff.warnings.push(`The second review pass failed, so only one is used: ${errorText(err)}`);
		}
		await ctx.save();
	}
	const scores: Reviewed["scores"] = {};
	for (const entry of entries) {
		scores[entry.label] = {};
		for (const metric of doc.bakeoff.metrics) {
			const values = done.flatMap(result => result.verified.scores[entry.label]?.[metric.id] ?? []);
			if (values.length > 0)
				scores[entry.label]![metric.id] = values.reduce((sum, value) => sum + value, 0) / values.length;
		}
	}
	const findings = done.flatMap(result => result.verified.findings);
	const seen = new Set<string>();
	return {
		rankings: done.map(result => result.verified.ranking),
		scores,
		findings: findings.filter(finding => {
			const key = `${finding.label}|${finding.kind}|${finding.text}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
		passes: done.map(result => result.pass),
		unsure: [...new Set(done.flatMap(result => result.verified.unsure))],
	};
}

// ── judge and result ─────────────────────────────────────────────────────────

/** What the judge stage found; absent parts mean there was no second opinion. */
export interface Judged {
	scores: Record<string, Record<string, number>>;
	pairs: BakeoffPair[];
	consistency: number;
	label: string;
	kind: BakeoffJudgeState;
}

export interface JudgeOutcome {
	judged?: Judged;
	/** "No second opinion: …", when there is none. */
	note?: string;
}

/** The judge pass, or the reason there was none. A judge that cannot be reached never fails the bake-off. */
export async function judgeStage(ctx: Ctx, entries: BakeoffEntry[]): Promise<JudgeOutcome> {
	const { deps, doc } = ctx;
	if (doc.bakeoff.judge === "off") return {};
	if (!deps.openJudge) return { note: "No second opinion: no judge model is set up on this computer." };
	await ctx.progress("Asking the judge model for a second opinion");
	const budget = splitBakeoffBudget(doc.maxCostUsd, doc.bakeoff.mode);
	let used = 0;
	let opened: OpenedJudge | undefined;
	let label = "the judge";
	try {
		opened = await deps.openJudge(doc.bakeoff.repo.root, usd => {
			used += usd;
		});
		const info = await describeSecondOpinion(opened.describe, opened.judge, opened.price);
		label = info.label ?? label;
		if (info.state === "none")
			return { note: `No second opinion: ${info.reason ?? "no judge model is set up on this computer."}` };
		if (info.state === "fallback" && !doc.request.judgeAdvisory)
			return {
				note: `No second opinion: no judge model was assigned, and the fallback (${label}) was not allowed.`,
			};
		if (info.reachable === false)
			return { note: `No second opinion: ${label} was unreachable (${info.reason ?? "no answer"})` };
		const labelNames = metricLabels(doc.bakeoff);
		const pass = await runJudgePass({
			judge: opened.judge,
			native: opened.native,
			problem: doc.problem.slice(0, 2_000),
			entries: entries.map(entry => ({
				label: entry.label,
				digest: judgeDigest(entry.writeup, entry.facts, labelNames, BAKEOFF_JUDGE_DIGEST_CHARS),
			})),
			metrics: doc.bakeoff.metrics,
			spent: () => used,
			budgetUsd: Math.max(budget.judge, MIN_STAGE_USD),
		});
		const kind = info.state;
		const prefix = kind === "native" ? "" : kind === "fallback" ? "advisory: " : "prompted judge: ";
		return {
			judged: {
				scores: pass.scores,
				pairs: pass.pairs,
				consistency: pass.consistency,
				label: `${prefix}${label}`,
				kind,
			},
		};
	} catch (err) {
		return { note: `No second opinion: ${label} was unreachable (${reasonOf(err)})` };
	} finally {
		opened?.close();
		doc.bakeoff.costs.judge += used;
	}
}

/** Put the reviewer's and the judge's findings together into the stored result. */
export function buildResult(
	doc: BakeoffDoc,
	reviewed: Reviewed,
	outcome: JudgeOutcome,
	entries: BakeoffEntry[],
	selfPreference: string[],
): BakeoffResult {
	const labels = entries.map(entry => entry.label);
	const judge = outcome.judged;
	const hasBench = doc.request.bench !== undefined;
	const originalLabel = original(doc.bakeoff).label;
	const combined = combine({
		metrics: doc.bakeoff.metrics,
		labels,
		originalLabel,
		reviewer: reviewed.scores,
		reviewerRankings: reviewed.rankings,
		judge: judge ? { scores: judge.scores, consistency: judge.consistency } : undefined,
		facts: Object.fromEntries(entries.map(entry => [entry.label, entry.facts])),
		hasBench,
		hasTestTarget: doc.request.test !== undefined,
		findings: reviewed.findings,
		flags: Object.fromEntries(entries.map(entry => [entry.label, entry.flags])),
		selfPreference,
	});
	return {
		ranking: combined.ranking,
		verdict: reviewed.passes[0]?.verdict ?? "",
		findings: reviewed.findings,
		scores: combined.scores,
		...(judge ? { pairwise: judge.pairs } : {}),
		agreement: combined.agreement,
		reviewerModel: doc.bakeoff.reviewer,
		...(judge ? { judgeLabel: judge.label, judgeKind: judge.kind, consistency: judge.consistency } : {}),
		...(combined.judgeIgnored ? { judgeIgnored: true } : {}),
		...(outcome.note ? { judgeNote: outcome.note } : {}),
		...(combined.splitNote ? { splitNote: combined.splitNote } : {}),
		selfPreference,
		...(reviewed.passes.length > 1 ? { passes: reviewed.passes } : {}),
		unsure: reviewed.unsure,
	};
}

/** Entries written by the reviewer's own model, by selector. */
export function selfPreferenceOf(bakeoff: Bakeoff): string[] {
	return bakeoff.entries
		.filter(entry => entry.model !== undefined && entry.model === bakeoff.reviewer)
		.map(entry => entry.label);
}

/** The paths the citations of a finished bake-off name: its write-ups, the reviewer's findings and its verdicts. */
function citedPaths(bakeoff: Bakeoff): Set<string> {
	const cited = new Set<string>();
	for (const entry of bakeoff.entries) for (const ref of entry.writeup?.refs ?? []) cited.add(ref.path);
	const result = bakeoff.result;
	if (result === undefined) return cited;
	for (const finding of result.findings) for (const ref of finding.refs ?? []) cited.add(ref.path);
	for (const verdict of [result.verdict, ...(result.passes ?? []).map(pass => pass.verdict)])
		for (const match of verdict.matchAll(/(?<![\w/])[A-E]\/([^\s`@]+)@\d+@/g)) cited.add(match[1]!);
	return cited;
}

/** Review and judge, then the result: the last two stages, which "Review again" repeats. */
export async function finishStages(ctx: Ctx): Promise<void> {
	const { doc } = ctx;
	doc.bakeoff.stage = "review";
	await ctx.save();
	const reviewed = await reviewStage(ctx);
	check(ctx);
	doc.bakeoff.stage = "judge";
	await ctx.save();
	const entries = reviewable(doc);
	const outcome = await judgeStage(ctx, entries);
	check(ctx);
	doc.bakeoff.result = buildResult(doc, reviewed, outcome, entries, selfPreferenceOf(doc.bakeoff));
	// A folder has no commit to read the cited files from later: only the ones the result cites stay in the document.
	if (doc.files !== undefined) {
		const cited = citedPaths(doc.bakeoff);
		doc.files = Object.fromEntries(Object.entries(doc.files).filter(([file]) => cited.has(file)));
	}
	for (const entry of entries)
		if (entry.status === "waiting" || entry.status === "writing-up" || entry.status === "working")
			entry.status = "ready";
	doc.bakeoff.stage = "done";
	await ctx.save();
}
