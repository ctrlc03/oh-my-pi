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
	BLUEPRINT_EXCERPT_CONTEXT,
	BLUEPRINT_VERSION,
	type BlueprintCreate,
	type BlueprintDiagram,
	type BlueprintExcerpt,
	type BlueprintRef,
	type BlueprintRefsAnswer,
	type BlueprintSummary,
} from "@oh-my-pi/pi-wire/blueprint";
import { MODEL_SELECTOR_RE } from "../src/lib/fanout";
import {
	type AgentWatchOptions,
	agentOutputFile,
	BLUEPRINT_TOOLS,
	blueprintOverlayYaml,
	buildBrief,
	DEFAULT_MAX_COST_USD,
	DEFAULT_WATCH,
	sessionFolderName,
	waitForAgent,
} from "./companion-blueprint-agent";
import {
	addWorktree,
	changedFiles,
	checkRefName,
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
import { checkBlueprintId, createBlueprintStore, newBlueprintId } from "./companion-blueprint-store";
import {
	type AgentOutput,
	normalizeRepoPath,
	parseAgentOutput,
	type Side,
	verifyBlueprint,
	type VerifyIo,
} from "./companion-blueprint-verify";

/** Maps generated at once; the rest wait their turn (indexing a large repository is heavy). */
const MAX_CONCURRENT_RUNS = 2;
/** References one excerpt request may carry (the HTML export asks for every ref of a map at once). */
const MAX_EXCERPT_REFS = 20_000;
const EXCERPT_CONCURRENCY = 8;
const MAX_EXCERPT_LINE_CHARS = 400;
const MAX_COST_LIMIT_USD = 100;
/** Changed files whose symbols are listed in the agent's brief. */
const MAX_BRIEF_FILES = 80;

/** What the agent session is started with; the companion starts it like any other session, read-only. */
export interface AgentLaunch {
	/** The head checkout. */
	cwd: string;
	prompt: string;
	maxCostUsd: number;
	model?: string;
	outFile: string;
	/** Overlay file this launch writes (the manager removes it). */
	overlayPath: string;
	overlayYaml: string;
	tools: readonly string[];
}

/** A listed omp session, as far as a run needs to know. */
export interface AgentSession {
	instanceId: string;
	sessionId: string;
	model: string | null;
	busy: boolean | null;
}

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
	agent: {
		start(launch: AgentLaunch): Promise<string>;
		hosts(): Promise<AgentSession[]>;
		stop(instanceId: string): Promise<void>;
		/** Spend of a session so far, USD. */
		cost(sessionId: string): Promise<number | undefined>;
	} | null;
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
	excerpt(id: string, refs: readonly BlueprintRef[]): Promise<(BlueprintExcerpt | null)[]>;
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

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	mts: "ts",
	cts: "ts",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	rs: "rs",
	sol: "sol",
	nr: "noir",
	py: "py",
	go: "go",
	java: "java",
	kt: "kt",
	swift: "swift",
	rb: "rb",
	php: "php",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "cs",
	json: "json",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	md: "md",
	html: "html",
	css: "css",
	sh: "sh",
	sql: "sql",
};

/** Language of a path for highlighting, from its extension. */
export function languageOf(file: string): string | undefined {
	const ext = path.posix.extname(file).slice(1).toLowerCase();
	return Object.hasOwn(LANGUAGE_BY_EXTENSION, ext) ? LANGUAGE_BY_EXTENSION[ext] : undefined;
}

/** Lines around a cited line, as {@link BlueprintExcerpt}; null when the line is not in the file. */
export function excerptOf(
	lines: readonly string[],
	ref: { path: string; line: number },
	side: Side,
	commit: string,
): BlueprintExcerpt | null {
	if (ref.line < 1 || ref.line > lines.length) return null;
	const start = Math.max(1, ref.line - BLUEPRINT_EXCERPT_CONTEXT);
	const end = Math.min(lines.length, ref.line + BLUEPRINT_EXCERPT_CONTEXT);
	return {
		path: ref.path,
		start,
		lines: lines
			.slice(start - 1, end)
			.map(line => (line.length > MAX_EXCERPT_LINE_CHARS ? `${line.slice(0, MAX_EXCERPT_LINE_CHARS - 1)}…` : line)),
		line: ref.line,
		side,
		commit,
		language: languageOf(ref.path),
	};
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
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

/** The JSON in the agent's file, tolerating a markdown fence around it. */
export function parseAgentJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
	return JSON.parse(fenced ? fenced[1]! : trimmed);
}

function parseCreate(request: BlueprintCreate): {
	cwd: string;
	ref?: string;
	base?: string;
	refresh?: string;
	maxCostUsd: number;
	model?: string;
} {
	if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd) || request.cwd.includes("\0"))
		throw new Error("invalid folder");
	if (request.ref !== undefined) checkRefName(request.ref, "ref");
	if (request.base !== undefined) checkRefName(request.base, "base");
	if (request.refresh !== undefined) checkBlueprintId(request.refresh);
	const maxCostUsd = request.maxCostUsd ?? DEFAULT_MAX_COST_USD;
	if (
		typeof maxCostUsd !== "number" ||
		!Number.isFinite(maxCostUsd) ||
		maxCostUsd <= 0 ||
		maxCostUsd > MAX_COST_LIMIT_USD
	)
		throw new Error("invalid spending limit");
	if (request.model !== undefined && (typeof request.model !== "string" || !MODEL_SELECTOR_RE.test(request.model)))
		throw new Error("invalid model");
	return {
		cwd: request.cwd,
		ref: request.ref,
		base: request.base,
		refresh: request.refresh,
		maxCostUsd,
		model: request.model,
	};
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
		await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
		// The session's write rule names this file; omp judges a path by its real location too, so the rule needs the real one.
		const outFile = agentOutputFile(await fs.realpath(outDir), job.id);
		const overlayPath = path.join(overlayDir, `${job.id}.yml`);
		await fs.rm(outFile, { force: true });
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
		let instanceId: string | undefined;
		let lastHost: AgentSession | undefined;
		try {
			await progress(run, "Starting the agent");
			instanceId = await agent.start({
				cwd: job.headDir,
				prompt,
				maxCostUsd: job.maxCostUsd,
				model: job.model,
				outFile,
				overlayPath,
				overlayYaml: blueprintOverlayYaml(outFile),
				tools: BLUEPRINT_TOOLS,
			});
			run.instanceId = instanceId;
			await update(run, { instanceId, progress: "The agent is reading the code and drawing the system diagram" });
			const outcome = await waitForAgent(
				{
					host: async () => {
						const host = (await agent.hosts()).find(h => h.instanceId === instanceId) ?? null;
						if (host) lastHost = host;
						return host;
					},
					output: async () => {
						try {
							const [text, stat] = await Promise.all([fs.readFile(outFile, "utf8"), fs.stat(outFile)]);
							return { text, signature: `${stat.size}:${stat.mtimeMs}` };
						} catch {
							return null;
						}
					},
					now: deps.now,
					sleep: ms => Bun.sleep(ms),
					cancelled: () => run.cancelled,
				},
				{ ...DEFAULT_WATCH, ...deps.watch },
			);
			if (outcome.kind === "cancelled") throw new Cancelled();
			const costUsd = lastHost ? await agent.cost(lastHost.sessionId).catch(() => undefined) : undefined;
			const model = lastHost?.model ?? undefined;
			if (outcome.kind !== "done") {
				const why =
					outcome.kind === "ended"
						? costUsd !== undefined && costUsd >= job.maxCostUsd * 0.98
							? "it reached its spending limit before writing the diagrams"
							: "its session ended before it wrote the diagrams"
						: outcome.kind === "stalled"
							? "it stopped without writing the diagrams"
							: "it ran out of time";
				warnings.push(`The agent diagrams are missing: ${why}. The map shows the code-index levels only.`);
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
			warnings.push(`The agent diagrams are missing: ${errorText(err)}. The map shows the code-index levels only.`);
			return { warnings };
		} finally {
			if (instanceId !== undefined)
				await agent.stop(instanceId).catch(err => log(`stopping the agent session failed: ${errorText(err)}`));
			await Promise.all([
				fs.rm(outFile, { force: true }),
				fs.rm(overlayPath, { force: true }),
				previousFile ? fs.rm(previousFile, { force: true }) : undefined,
			]);
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
		const folder = sessionFolderName(info.name, target.label);
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
			await store.writeMap(map);
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
				Array.from({ length: Math.min(EXCERPT_CONCURRENCY, checks.length) }, async () => {
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
			const parsed = parseCreate(request);
			const info = await repoInfo(parsed.cwd);
			let previous: Blueprint | undefined;
			let ref = parsed.ref;
			let base = parsed.base;
			if (parsed.refresh !== undefined) {
				const earlier = await store.readMap(parsed.refresh);
				if (!earlier) throw new Error("There is no finished map to refresh.");
				if (earlier.repo.root !== info.root) throw new Error("That map belongs to a different repository.");
				previous = earlier;
				ref ??= earlier.head.ref;
				base ??= earlier.base === undefined ? undefined : (earlier.base.ref ?? "@default");
			}
			const target = await resolveTarget(info.root, { ref, base });
			if (previous && previous.head.commit === target.head.commit && previous.base?.commit === target.base?.commit)
				throw new Error("The map is already up to date with that commit.");
			const id = newBlueprintId();
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
			const summary = store.get(checkBlueprintId(id));
			if (!summary) throw new Error("There is no such map.");
			if (summary.status === "running") throw new Error("The map is still being made.");
			if (summary.status === "failed") throw new Error(`The map failed: ${summary.error ?? "unknown error"}`);
			const map = await store.readMap(id);
			if (!map) throw new Error("The map file is missing.");
			return map;
		},

		async excerpt(id, refs) {
			if (refs.length > MAX_EXCERPT_REFS) throw new Error("too many references");
			const map = await store.readMap(checkBlueprintId(id));
			if (!map) throw new Error("There is no such map.");
			const files = new Map<string, Promise<string[] | null>>();
			const read = (commit: string, file: string): Promise<string[] | null> => {
				const key = `${commit}\0${file}`;
				let cached = files.get(key);
				if (!cached) {
					cached = readBlob(map.repo.root, commit, file).then(text => (text === null ? null : splitLines(text)));
					files.set(key, cached);
				}
				return cached;
			};
			const wanted = refs.map(ref => {
				const file = normalizeRepoPath(ref?.path);
				const side: Side = ref?.side === "base" ? "base" : "head";
				const commit = side === "base" ? map.base?.commit : map.head.commit;
				const line = typeof ref?.line === "number" && Number.isSafeInteger(ref.line) ? ref.line : 0;
				return file === undefined || commit === undefined ? null : { file, side, commit, line };
			});
			// Warm the cache a few files at a time; the answers below then only slice.
			const unique = [...new Map(wanted.flatMap(w => (w ? [[`${w.commit}\0${w.file}`, w] as const] : []))).values()];
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(EXCERPT_CONCURRENCY, unique.length) }, async () => {
					while (next < unique.length) {
						const item = unique[next++]!;
						await read(item.commit, item.file);
					}
				}),
			);
			return await Promise.all(
				wanted.map(async w => {
					if (w === null) return null;
					const lines = await read(w.commit, w.file);
					return lines === null ? null : excerptOf(lines, { path: w.file, line: w.line }, w.side, w.commit);
				}),
			);
		},

		async remove(id) {
			checkBlueprintId(id);
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
