/**
 * Architecture maps for the companion's `blueprint-*` requests: layered diagrams of a repository at one commit
 * (or of a change), generated on this computer and stored under the omp config folder, never in the repository.
 *
 * A run (see {@link createBlueprints}):
 *  1. resolves what the user picked to commits (./companion-blueprint-git),
 *  2. checks the head (and for a diff map the base) out as detached worktrees under the cache folder,
 *  3. builds the lower levels from omp's code index with no model (./companion-blueprint-index),
 *  4. runs an omp session, read-only, that writes the top diagrams as JSON to a file outside the repository
 *     (./companion-blueprint-agent),
 *  5. verifies every citation against the commit and stores the map (./companion-blueprint-verify),
 *  6. removes the checkouts and ends the session.
 * The session is started through the companion's own session start, so it is listed, watchable and stoppable
 * like any other and obeys its spending limit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Codemap } from "@oh-my-pi/pi-coding-agent/codemap/index";
import {
	type Blueprint,
	BLUEPRINT_VERSION,
	type BlueprintCreate,
	type BlueprintDiagram,
	type BlueprintExcerpt,
	type BlueprintExcerptRef,
	type BlueprintRefsAnswer,
	type BlueprintSummary,
} from "@oh-my-pi/pi-wire/blueprint";
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
import { buildBrief, DEFAULT_MAX_COST_USD } from "./companion-blueprint-agent";
import {
	addWorktree,
	changedFiles,
	diffHunks,
	diffStat,
	holdCommit,
	isStale,
	listFiles,
	listRefs,
	pruneLeftoverWorktrees,
	readBlob,
	releaseCommits,
	removeWorktreeDir,
	repoInfo,
	resolveTarget,
	type ResolvedTarget,
} from "./companion-blueprint-git";
import { buildIndexDiagrams, type IndexResult, isManifest } from "./companion-blueprint-index";
import { createIndexSource, type DiffInput } from "./companion-blueprint-source";
import { createBlueprintStore } from "./companion-blueprint-store";
import { type AgentOutput, parseAgentOutput, verifyBlueprint, type VerifyIo } from "./companion-blueprint-verify";
import { readExcerpts, splitLines } from "./companion-excerpt";

/** Maps generated at once; the rest wait their turn (indexing a large repository is heavy). */
const MAX_CONCURRENT_RUNS = 2;
const STALE_CHECK_CONCURRENCY = 8;
/** Changed files whose symbols are listed in the agent's brief. */
const MAX_BRIEF_FILES = 80;

export interface BlueprintDeps {
	/** `<agent dir>/blueprints`: the index and the maps. */
	storeDir: string;
	/** `<config dir>/cache/blueprints`: `work/` (checkouts), `out/` (the agent's result files), `overlay/`. */
	cacheDir: string;
	now(): number;
	/** A map's summary changed: tell the connected devices. */
	changed(id: string): void;
	/** Opens an index of a checkout; the caller closes it and deletes its `dbPath`. */
	openIndex(root: string): Promise<Codemap>;
	/** The session running the agent part; null when this computer cannot run one (no tmux), and the map then has index levels only. */
	agent: AgentRunner | null;
	/** Timing of the wait for the agent; tests shorten it. */
	watch?: Partial<AgentWatchOptions>;
	log?(message: string): void;
}

export interface Blueprints {
	/** Load the index, mark what a previous run left as interrupted, remove leftover checkouts. */
	init(): Promise<void>;
	list(cwd: string | undefined): Promise<BlueprintSummary[]>;
	create(request: BlueprintCreate): Promise<{ id: string }>;
	get(id: string): Promise<Blueprint>;
	excerpt(id: string, refs: readonly BlueprintExcerptRef[]): Promise<(BlueprintExcerpt | null)[]>;
	remove(id: string): Promise<void>;
	refs(cwd: string, query: string | undefined): Promise<BlueprintRefsAnswer>;
	/** Mark runs in flight as interrupted and end their sessions. */
	shutdown(): Promise<void>;
	/** Resolves when no run is in flight. */
	idle(): Promise<void>;
}

/** Thrown inside a run whose map was deleted. */
class Cancelled extends Error {}

interface Run {
	id: string;
	cancelled: boolean;
	instanceId?: string;
	done: Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Files and every folder above them, for "does this path exist at the commit". */
function pathSet(files: readonly string[]): Set<string> {
	const set = new Set<string>();
	for (const file of files) {
		set.add(file);
		for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1))
			set.add(file.slice(0, slash));
	}
	return set;
}

function parseCreate(request: BlueprintCreate, checkId: (value: unknown) => string): RunRequest & { refresh?: string } {
	if (request.refresh !== undefined) checkId(request.refresh);
	return { ...checkRunRequest(request, DEFAULT_MAX_COST_USD), refresh: request.refresh };
}

function titleOf(repo: string, target: ResolvedTarget): string {
	const head = target.label.startsWith("PR #") ? `${repo} · ${target.label}` : `${repo} @ ${target.label}`;
	return target.base && !target.label.startsWith("PR #")
		? `${head} vs ${target.base.ref ?? target.base.commit.slice(0, 8)}`
		: head;
}

export function createBlueprints(deps: BlueprintDeps): Blueprints {
	const store = createBlueprintStore(deps.storeDir);
	const workDir = path.join(deps.cacheDir, "work");
	const outDir = path.join(deps.cacheDir, "out");
	const overlayDir = path.join(deps.cacheDir, "overlay");
	const runs = new Map<string, Run>();
	const waiting: (() => void)[] = [];
	let active = 0;
	const log = deps.log ?? (() => undefined);

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

	const update = async (run: Run, patch: Partial<BlueprintSummary>): Promise<void> => {
		if (run.cancelled) throw new Cancelled();
		const current = store.get(run.id);
		if (!current) throw new Cancelled();
		await store.put({ ...current, ...patch });
		deps.changed(run.id);
	};
	const progress = (run: Run, text: string): Promise<void> => update(run, { progress: text });

	/** Verification's view of the repository at the map's commits. */
	async function verifyIo(
		root: string,
		head: string,
		base: string | undefined,
		byPath: IndexResult["byPath"],
	): Promise<VerifyIo> {
		const [headFiles, baseFiles] = await Promise.all([
			listFiles(root, head),
			base ? listFiles(root, base) : Promise.resolve([]),
		]);
		const sets = { head: pathSet(headFiles), base: pathSet(baseFiles) };
		const commits = { head, base: base ?? head };
		return {
			lines: async (side, file) => {
				const text = await readBlob(root, commits[side], file);
				return text === null ? null : splitLines(text);
			},
			hasPath: (side, file) => sets[side].has(file),
			diagramForPath: file => byPath.get(file),
		};
	}

	/** Index levels from the checkouts: the diagrams, and for a diff map the changed symbols for the agent's brief. */
	async function indexLevels(
		run: Run,
		root: string,
		repoName: string,
		dirs: { head: string; base?: string },
		target: ResolvedTarget,
	): Promise<{ index: IndexResult; changedSymbols: string[]; stat: string }> {
		await progress(run, "Indexing the code");
		const opened: Codemap[] = [];
		try {
			const head = await deps.openIndex(dirs.head);
			opened.push(head);
			let diff: DiffInput | undefined;
			let stat = "";
			if (target.base && dirs.base) {
				const base = await deps.openIndex(dirs.base);
				opened.push(base);
				const [changed, hunks] = await Promise.all([
					changedFiles(root, target.base.commit, target.head.commit),
					diffHunks(root, target.base.commit, target.head.commit),
				]);
				stat = await diffStat(root, target.base.commit, target.head.commit, 6_000);
				diff = { base, baseDir: dirs.base, changed, hunks };
			}
			const manifests = (await listFiles(root, target.head.commit)).filter(isManifest);
			if (run.cancelled) throw new Cancelled();
			const source = createIndexSource({ head, headDir: dirs.head, manifests, diff });
			await progress(run, "Mapping packages, folders and files");
			const index = await buildIndexDiagrams(source, { repoName });
			const changedSymbols: string[] = [];
			if (diff) {
				for (const file of diff.changed.slice(0, MAX_BRIEF_FILES)) {
					for (const symbol of await source.symbols(file.path))
						if (symbol.change) changedSymbols.push(`${file.path}: ${symbol.name} (${symbol.change})`);
				}
			}
			return { index, changedSymbols, stat };
		} finally {
			for (const codemap of opened) {
				const dbPath = codemap.dbPath;
				codemap.close();
				await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(file => fs.rm(file, { force: true })));
			}
		}
	}

	interface AgentResult {
		output?: AgentOutput;
		model?: string;
		costUsd?: number;
		warnings: string[];
	}

	/** Start the session, wait for its file, read its cost, end it. Never throws for an agent that failed: the map keeps its index levels and says why. */
	async function runAgent(
		run: Run,
		job: {
			id: string;
			root: string;
			repoName: string;
			headDir: string;
			baseDir?: string;
			target: ResolvedTarget;
			index: IndexResult;
			changedSymbols: string[];
			stat: string;
			maxCostUsd: number;
			model?: string;
			previous?: Blueprint;
		},
	): Promise<AgentResult> {
		const agent = deps.agent;
		const warnings: string[] = [];
		if (agent === null) {
			warnings.push(
				"The agent diagrams were skipped: this computer cannot run the agent session (tmux is missing). The map shows the code-index levels only.",
			);
			return { warnings };
		}
		const outFile = await prepareOutputFile(outDir, job.id);
		const overlayPath = path.join(overlayDir, `${job.id}.yml`);
		let previousFile: string | undefined;
		if (job.previous) {
			previousFile = path.join(outDir, `${job.id}.previous.json`);
			const agentDiagrams: Record<string, BlueprintDiagram> = {};
			for (const [id, diagram] of Object.entries(job.previous.diagrams))
				if (diagram.origin === "agent") agentDiagrams[id] = diagram;
			await fs.writeFile(
				previousFile,
				JSON.stringify({ root: job.previous.root, diagrams: Object.values(agentDiagrams) }),
				{ mode: 0o600 },
			);
		}
		const prompt = buildBrief({
			repo: job.repoName,
			target: job.target.label.startsWith("PR #")
				? `pull request ${job.target.label.slice(3)}`
				: job.target.label === "worktree"
					? "the working tree"
					: `\`${job.target.label}\``,
			commit: job.target.head.commit,
			outFile,
			maxCostUsd: job.maxCostUsd,
			index: job.index,
			diff:
				job.target.base && job.baseDir
					? {
							baseTarget: job.target.base.ref ?? job.target.base.commit.slice(0, 8),
							baseCommit: job.target.base.commit,
							baseDir: job.baseDir,
							stat: job.stat,
							symbols: job.changedSymbols,
						}
					: undefined,
			refresh:
				job.previous && previousFile
					? {
							previousCommit: job.previous.head.commit,
							previousFile,
							stat: await diffStat(job.root, job.previous.head.commit, job.target.head.commit, 6_000).catch(
								() => "",
							),
						}
					: undefined,
		});
		try {
			await progress(run, "Starting the agent");
			const ran = await runAgentToFile({
				agent,
				launch: {
					cwd: job.headDir,
					prompt,
					maxCostUsd: job.maxCostUsd,
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
						progress: "The agent is reading the code and drawing the system diagram",
					});
				},
				log,
			});
			const { outcome, model, costUsd } = ran;
			if (outcome.kind === "cancelled") throw new Cancelled();
			if (outcome.kind !== "done") {
				warnings.push(
					`The agent diagrams are missing: ${agentFailureReason(outcome, costUsd, job.maxCostUsd, "the diagrams")}. The map shows the code-index levels only.`,
				);
				return { model, costUsd, warnings };
			}
			let output: AgentOutput;
			try {
				output = parseAgentOutput(parseAgentJson(outcome.text), warnings);
			} catch (err) {
				warnings.push(
					`The agent diagrams could not be used (${err instanceof SyntaxError ? "its file was not valid JSON" : errorText(err)}). The map shows the code-index levels only.`,
				);
				return { model, costUsd, warnings };
			}
			// A refresh keeps earlier diagrams the agent listed as still right.
			if (job.previous) {
				const raw = parseAgentJson(outcome.text) as { keep?: unknown };
				const keep = Array.isArray(raw.keep) ? raw.keep.filter((id): id is string => typeof id === "string") : [];
				for (const id of keep) {
					const earlier = job.previous.diagrams[id];
					if (earlier?.origin === "agent" && !Object.hasOwn(output.diagrams, id)) output.diagrams[id] = earlier;
				}
				output.root ??=
					job.previous.diagrams[job.previous.root]?.origin === "agent" &&
					Object.hasOwn(output.diagrams, job.previous.root)
						? job.previous.root
						: undefined;
			}
			return { output, model, costUsd, warnings };
		} catch (err) {
			if (err instanceof Cancelled) throw err;
			warnings.push(
				`The agent diagrams are missing: ${errorText(err).replace(/[.\s]+$/, "")}. The map shows the code-index levels only.`,
			);
			return { warnings };
		} finally {
			if (previousFile) await fs.rm(previousFile, { force: true });
		}
	}

	async function execute(
		run: Run,
		job: {
			info: { root: string; name: string; github?: string };
			target: ResolvedTarget;
			title: string;
			maxCostUsd: number;
			model?: string;
			previous?: Blueprint;
		},
	): Promise<void> {
		const { info, target } = job;
		const runDir = path.join(workDir, run.id);
		const folder = agentFolderName("Architecture", info.name, target.label);
		const headDir = path.join(runDir, "head", folder);
		const baseDir = target.base ? path.join(runDir, "base", `${info.name} before the change`) : undefined;
		await acquire();
		try {
			await progress(run, "Checking out the code");
			await addWorktree(info.root, headDir, target.head.commit);
			if (baseDir && target.base) await addWorktree(info.root, baseDir, target.base.commit);
			if (run.cancelled) throw new Cancelled();
			const levels = await indexLevels(run, info.root, info.name, { head: headDir, base: baseDir }, target);
			const agent = await runAgent(run, {
				id: run.id,
				root: info.root,
				repoName: info.name,
				headDir,
				baseDir,
				target,
				index: levels.index,
				changedSymbols: levels.changedSymbols,
				stat: levels.stat,
				maxCostUsd: job.maxCostUsd,
				model: job.model,
				previous: job.previous,
			});
			// The checkouts are not needed any more: verification reads git.
			await Promise.all([
				removeWorktreeDir(info.root, headDir),
				baseDir ? removeWorktreeDir(info.root, baseDir) : undefined,
			]);
			await progress(run, "Checking every citation against the commit");
			const agentDiagrams = agent.output?.diagrams ?? {};
			const rootId =
				agent.output === undefined
					? levels.index.root
					: (agent.output.root ??
						(Object.hasOwn(agentDiagrams, "system") ? "system" : Object.keys(agentDiagrams)[0]!));
			const warnings = [...levels.index.warnings, ...agent.warnings];
			if (agent.output && agent.output.root === undefined && rootId !== "system")
				warnings.push(`The agent did not name a root diagram; "${agentDiagrams[rootId]?.title}" is used.`);
			const draft: Blueprint = {
				v: BLUEPRINT_VERSION,
				id: run.id,
				title: job.title,
				repo: { root: info.root, name: info.name, ...(info.github ? { github: info.github } : {}) },
				head: target.head,
				...(target.base ? { base: target.base } : {}),
				createdAt: store.get(run.id)?.createdAt ?? deps.now(),
				...(agent.model ? { model: agent.model } : {}),
				...(agent.costUsd !== undefined ? { costUsd: agent.costUsd } : {}),
				root: rootId,
				diagrams: { ...levels.index.diagrams, ...agentDiagrams },
				warnings,
			};
			const io = await verifyIo(info.root, target.head.commit, target.base?.commit, levels.index.byPath);
			const { map, stats } = await verifyBlueprint(draft, io);
			log(
				`blueprint ${run.id}: ${Object.keys(map.diagrams).length} diagrams; citations ${stats.refsVerified} verified, ${stats.refsMoved} moved, ${stats.refsDropped} dropped; ${stats.edgesDropped} edges dropped`,
			);
			await progress(run, "Saving the map");
			if (run.cancelled) throw new Cancelled();
			await store.writeDoc(map);
			await update(run, {
				status: "ready",
				progress: undefined,
				instanceId: undefined,
				diagramCount: Object.keys(map.diagrams).length,
				...(map.costUsd !== undefined ? { costUsd: map.costUsd } : {}),
			});
		} finally {
			release();
			await Promise.all([
				removeWorktreeDir(info.root, headDir),
				baseDir ? removeWorktreeDir(info.root, baseDir) : undefined,
			]);
			await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async function fail(run: Run, root: string, err: unknown): Promise<void> {
		if (err instanceof Cancelled) return;
		log(`blueprint ${run.id} failed: ${errorText(err)}`);
		const current = store.get(run.id);
		if (current === undefined) return;
		await store.put({
			...current,
			status: "failed",
			error: errorText(err),
			progress: undefined,
			instanceId: undefined,
		});
		await releaseCommits(root, run.id);
		deps.changed(run.id);
	}

	return {
		async init() {
			const { interruptedInstances } = await store.load();
			await pruneLeftoverWorktrees(workDir);
			await Promise.all([
				fs.rm(outDir, { recursive: true, force: true }),
				fs.rm(overlayDir, { recursive: true, force: true }),
			]);
			// A session a previous companion left writing a map would run on to its spending limit for nothing.
			if (deps.agent) {
				for (const instanceId of interruptedInstances)
					await deps.agent
						.stop(instanceId)
						.catch(err => log(`ending an interrupted map's agent failed: ${errorText(err)}`));
			}
		},

		async list(cwd) {
			const root = cwd === undefined ? undefined : (await repoInfo(cwd)).root;
			const maps = store.list().filter(map => root === undefined || map.repoRoot === root);
			const stale = new Set<string>();
			const checks = maps.filter(map => map.status === "ready");
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(STALE_CHECK_CONCURRENCY, checks.length) }, async () => {
					while (next < checks.length) {
						const map = checks[next++]!;
						if (await isStale(map.repoRoot, map.head).catch(() => false)) stale.add(map.id);
					}
				}),
			);
			return maps
				.map(map => (stale.has(map.id) ? { ...map, stale: true } : map))
				.sort((a, b) => b.createdAt - a.createdAt);
		},

		async create(request) {
			const parsed = parseCreate(request, store.checkId);
			const info = await repoInfo(parsed.cwd);
			let previous: Blueprint | undefined;
			let ref = parsed.ref;
			let base = parsed.base;
			if (parsed.refresh !== undefined) {
				const earlier = await store.readDoc(parsed.refresh);
				if (!earlier) throw new Error("There is no finished map to refresh.");
				if (earlier.repo.root !== info.root) throw new Error("That map belongs to a different repository.");
				previous = earlier;
				ref ??= earlier.head.ref;
				base ??= earlier.base === undefined ? undefined : (earlier.base.ref ?? "@default");
			}
			const target = await resolveTarget(info.root, { ref, base, checkout: info.checkout });
			if (previous && previous.head.commit === target.head.commit && previous.base?.commit === target.base?.commit)
				throw new Error("The map is already up to date with that commit.");
			const id = store.newId();
			await holdCommit(info.root, id, "head", target.head.commit);
			if (target.base) await holdCommit(info.root, id, "base", target.base.commit);
			await store.put({
				id,
				title: titleOf(info.name, target),
				repoRoot: info.root,
				head: target.head,
				...(target.base ? { base: target.base } : {}),
				createdAt: deps.now(),
				status: "running",
				progress: "Waiting to start",
			});
			deps.changed(id);
			const run: Run = { id, cancelled: false, done: Promise.resolve() };
			runs.set(id, run);
			run.done = execute(run, {
				info,
				target,
				title: titleOf(info.name, target),
				maxCostUsd: parsed.maxCostUsd,
				model: parsed.model,
				previous,
			})
				.catch(err => fail(run, info.root, err))
				.finally(() => {
					runs.delete(id);
				});
			return { id };
		},

		async get(id) {
			const summary = store.get(store.checkId(id));
			if (!summary) throw new Error("There is no such map.");
			if (summary.status === "running") throw new Error("The map is still being made.");
			if (summary.status === "failed") throw new Error(`The map failed: ${summary.error ?? "unknown error"}`);
			const map = await store.readDoc(id);
			if (!map) throw new Error("The map file is missing.");
			return map;
		},

		async excerpt(id, refs) {
			const map = await store.readDoc(store.checkId(id));
			if (!map) throw new Error("There is no such map.");
			return await readExcerpts(map.repo.root, { head: map.head.commit, base: map.base?.commit }, refs);
		},

		async remove(id) {
			store.checkId(id);
			const summary = store.get(id);
			if (!summary) throw new Error("There is no such map.");
			const run = runs.get(id);
			if (run) {
				run.cancelled = true;
				if (run.instanceId !== undefined && deps.agent)
					await deps.agent.stop(run.instanceId).catch(() => undefined);
			}
			await store.remove(id);
			await releaseCommits(summary.repoRoot, id).catch(() => undefined);
			deps.changed(id);
		},

		refs: (cwd, query) => listRefs(cwd, query),

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
