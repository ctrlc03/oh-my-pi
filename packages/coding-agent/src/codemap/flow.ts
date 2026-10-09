/**
 * `flow`: answer "what happens when / how does A lead to B" by walking the
 * codemap graph instead of reading files. One shared core for the tool and the
 * CLI.
 *
 * 1. Entries: the definitions of `from`, else the union of codemap full-text
 *    hits for the question and the symbols overlapping the best `find`
 *    cascade hits; the judge keeps those that are a step of the question.
 * 2. Walk: breadth-first over every {@link CodemapQuery.flowNeighbors} edge in
 *    both directions (publishes/handled-by, emits/decoded-by/becomes,
 *    converts, calls-contract, callers/callees, proves-with). Each frontier is
 *    one batch of cards for the judge; low-probability nodes are not expanded.
 * 3. Report: ordered steps with the edge that reached each, then plausible
 *    pruned nodes as "also consider".
 *
 * Without a judge the same walk runs structurally: fan-out caps, no pruning.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Judge, NoulQuestion } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import flowQuestionTemplate from "../prompts/tools/flow-question.md" with { type: "text" };
import { resolveSearchResultPath } from "../tools/path-utils";
import { runCascade } from "../tools/jfind/cascade";
import type { SearchRoot } from "../tools/jfind/tree";
import type { Request } from "../tools/jfind/questions";
import { throwIfAborted } from "../tools/tool-errors";
import type { FlowEdge, FlowNode } from "./query";
import { isTestPath } from "./rows";
import type { Codemap } from "./index";

const DEFAULT_HOPS = 5;
const MAX_HOPS = 8;
/** Cards per judge request. */
const CARDS_PER_REQUEST = 64;
/** Requests in flight at once. */
const PARALLEL = 8;
/** Entry candidates before judging. */
const ENTRY_CANDIDATES = 24;
/** Full-text hits among the entry candidates. */
const SEARCH_CANDIDATES = 16;
/** Cascade hits whose ranges are mapped back to symbols, and symbols taken per range. */
const CASCADE_HITS = 6;
const CASCADE_SYMBOLS_PER_RANGE = 2;
const CASCADE_CANDIDATES = 12;
/** Entries kept at or above {@link ENTRY_CUTOFF}, at most {@link ENTRIES_MAX}. */
const ENTRY_CUTOFF = 0.5;
const ENTRIES_MAX = 4;
/** When nothing clears {@link ENTRY_CUTOFF}, the best entries at or above this are kept anyway. */
const WEAK_ENTRY_CUTOFF = 0.3;
const WEAK_ENTRIES_MAX = 2;
/** Probability a reached node needs to become a step and be expanded. */
const STEP_CUTOFF = 0.45;
/** Probability from which a pruned node is reported as "also consider". */
const CONSIDER_CUTOFF = 0.3;
const STEPS_PER_HOP = 10;
/** Slots per hop reserved for event and cross-language edges. */
const LEAD_STEPS_PER_HOP = 7;
const CONSIDER_MAX = 8;
/** Nodes judged per hop; the best-ranked edges (bridges first) are judged, the rest are skipped. */
const HOP_CANDIDATES = 96;
/** Structural entries when no judge can rank them. */
const STRUCTURAL_ENTRIES = 3;
const CARD_CHARS = 420;
/** Added to a bridge step's probability when output limits force dropping steps. */
const BRIDGE_BONUS = 0.15;
/** Rendered output ceiling, in bytes. */
const OUTPUT_BYTES = 8000;
/** Distinct judge failure messages retained for the report. */
const FAILURES_KEPT = 5;

const TASK =
	"Follow a multi-step flow through a codebase that crosses language boundaries (Solidity contracts, Rust services, Noir circuits). Each card is one code symbol reached by following a call, event, decode, conversion, or proof edge; judge whether it is a step of the flow described by `question`.";

const CRITERIA = {
	no: "Unrelated to the flow, or a generic helper, test, or type that merely shares names or keywords with it.",
	yes: "This code performs, forwards, converts, emits, decodes, or reacts to something on the path the question describes. A helper implementing one step counts.",
};

export interface FlowOptions {
	question: string;
	/** Symbol (`name` or `Owner::name`) to start from instead of discovering entries. */
	from?: string;
	/** Edges followed from the entries; default {@link DEFAULT_HOPS}. */
	hops?: number;
	/** Judges entries and steps; undefined walks structurally. */
	judge?: Judge;
	/** Directory the entry-discovery `find` cascade searches (the index root or a scope inside it). Needed with `judge`. */
	searchRoot?: string;
	filesystem?: InternalUrlFilesystem;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** A reached node: why it was reached, and how relevant the judge found it. */
export interface FlowStep {
	/** 1-based position in the report. */
	n: number;
	node: FlowNode;
	/** Probability from the judge; undefined when unjudged (structural walk or failed request). */
	p?: number;
	/** Step number this node was reached from; absent for entries. */
	from?: number;
	/** Edge label from that step (`decoded by`, `calls contract`, …). */
	label?: string;
	/** 0-1 for event and cross-language edges, 2 for plain calls; absent for entries. */
	rank?: number;
}

export interface FlowCandidate {
	node: FlowNode;
	p: number;
	from: number;
	label: string;
}

export interface FlowStats {
	/** Nodes sent to the judge, entry candidates included. */
	judged: number;
	/** Judge requests, the `find` cascade's included. */
	requests: number;
	errors: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	apiMs: number;
	elapsedMs: number;
	failures: string[];
}

export interface FlowResult {
	question: string;
	mode: "judged" | "structural";
	/** Why the walk was not judged, or how entries were chosen when it matters. */
	notes: string[];
	steps: FlowStep[];
	alsoConsider: FlowCandidate[];
	stats: FlowStats;
}

/** One reached node waiting for judgment. */
interface Pending {
	node: FlowNode;
	from: FlowStep | undefined;
	label: string | undefined;
	rank: number;
}

interface Judged<T> {
	item: T;
	p: number | undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
	return out;
}

/** Stable card text: the same node reached the same way always judges the same, so the answer cache can hit. */
function cardText(node: FlowNode, label: string | undefined): string {
	const lines = [`${node.lang} ${node.kind} ${node.name}`, `${node.path}:${node.startLine}-${node.endLine}`];
	if (node.signature) lines.push(node.signature);
	if (node.doc) lines.push(node.doc);
	if (label) lines.push(`reached via: ${label}`);
	const text = lines.join("\n");
	return text.length <= CARD_CHARS ? text : `${text.slice(0, CARD_CHARS - 1)}…`;
}

function cardKey(i: number): string {
	return `c${String(i).padStart(3, "0")}`;
}

class FlowRun {
	readonly #codemap: Codemap;
	readonly #options: FlowOptions;
	readonly #started = performance.now();
	/** Probabilities already assigned, so a node reached twice is judged once. */
	readonly #judged = new Map<number, number | undefined>();
	readonly stats: FlowStats = {
		judged: 0,
		requests: 0,
		errors: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		apiMs: 0,
		elapsedMs: 0,
		failures: [],
	};
	readonly notes: string[] = [];

	constructor(codemap: Codemap, options: FlowOptions) {
		this.#codemap = codemap;
		this.#options = options;
	}

	#fail(error: unknown, phase: string): void {
		const message = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
		const { failures } = this.stats;
		if (failures.length < FAILURES_KEPT && !failures.includes(message)) failures.push(message);
	}

	/**
	 * Judge `items` as cards against the question, one request per {@link CARDS_PER_REQUEST}.
	 * Unjudged items (failed request) come back with `p` undefined.
	 */
	async #judge<T extends { node: FlowNode; label: string | undefined }>(
		items: T[],
		phase: string,
	): Promise<Array<Judged<T>>> {
		const { judge, signal, question } = this.#options;
		if (!judge) return items.map(item => ({ item, p: undefined }));
		const sorted = [...items]
			.map(item => ({ item, text: cardText(item.node, item.label) }))
			.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
		const jobs = chunks(sorted, CARDS_PER_REQUEST).map(batch => {
			const cards: Record<string, string> = {};
			const questions: Record<string, NoulQuestion> = {};
			batch.forEach((entry, i) => {
				const key = cardKey(i);
				cards[key] = entry.text;
				questions[key] = {
					type: "noul",
					instructions: prompt.render(flowQuestionTemplate, { key, question }).trim(),
				};
			});
			const request: Request = { state: { cards, criteria: CRITERIA, question, task: TASK }, questions };
			return { batch, request };
		});
		const answers = new Map<T, number | undefined>();
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < jobs.length) {
				throwIfAborted(signal);
				const job = jobs[next++]!;
				const started = performance.now();
				try {
					const result = await judge.judge(job.request, { signal });
					this.stats.requests++;
					this.stats.apiMs += performance.now() - started;
					this.stats.inputTokens += result.usage.input;
					this.stats.outputTokens += result.usage.output;
					this.stats.cost += result.usage.cost.total;
					job.batch.forEach((entry, i) => {
						const p = result.answers[cardKey(i)]?.noul;
						answers.set(entry.item, p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined);
					});
				} catch (error) {
					throwIfAborted(signal);
					this.stats.requests++;
					this.stats.errors++;
					this.stats.apiMs += performance.now() - started;
					this.#fail(error, phase);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
		this.stats.judged += items.length;
		return items.map(item => ({ item, p: answers.get(item) }));
	}

	/** Entry candidates: `from` definitions, else cascade hits mapped to symbols plus full-text hits. */
	async #entryCandidates(): Promise<FlowNode[]> {
		const { question, from, judge, searchRoot, filesystem, signal, onProgress } = this.#options;
		const { query, root } = this.#codemap;
		if (from !== undefined) {
			const defs = query.flowDefinitions(from);
			const real = defs.filter(node => !isTestPath(node.rel));
			return (real.length > 0 ? real : defs).slice(0, ENTRIES_MAX);
		}
		const candidates = new Map<number, FlowNode>();
		if (judge && searchRoot && filesystem) {
			onProgress?.("searching for entry points");
			try {
				// The index root is realpathed; hits are mapped back to it, so the search root must be too.
				const real = fs.realpathSync(searchRoot);
				const stat = fs.statSync(real);
				const cascadeRoot: SearchRoot = stat.isDirectory()
					? { path: real, type: "directory" }
					: { path: real, type: "file", size: stat.size };
				const cascade = await runCascade({
					root: cascadeRoot,
					filesystem,
					query: question,
					extraKeywords: [],
					judge,
					includeHidden: false,
					signal,
				});
				this.stats.requests += cascade.stats.requests;
				this.stats.errors += cascade.stats.errors;
				this.stats.inputTokens += cascade.stats.inputTokens;
				this.stats.outputTokens += cascade.stats.outputTokens;
				this.stats.cost += cascade.stats.cost;
				this.stats.apiMs += cascade.stats.apiMs;
				for (const failure of cascade.stats.failures) this.#fail(new Error(failure), "find");
				for (const hit of cascade.hits.slice(0, CASCADE_HITS)) {
					const rel = path
						.relative(root, resolveSearchResultPath(cascadeRoot.path, hit.rel))
						.split(path.sep)
						.join("/");
					for (const range of hit.ranges.slice(0, 2)) {
						for (const node of query.flowOverlapping(rel, range.start, range.end, CASCADE_SYMBOLS_PER_RANGE)) {
							if (candidates.size < CASCADE_CANDIDATES) candidates.set(node.id, node);
						}
					}
				}
			} catch (error) {
				throwIfAborted(signal);
				this.stats.requests++;
				this.stats.errors++;
				this.#fail(error, "find");
			}
		}
		for (const node of query.flowSearch(question, SEARCH_CANDIDATES)) {
			if (candidates.size < ENTRY_CANDIDATES) candidates.set(node.id, node);
		}
		return [...candidates.values()];
	}

	async run(): Promise<FlowResult> {
		const { question, from, judge, signal, onProgress } = this.#options;
		const hops = Math.min(MAX_HOPS, Math.max(1, Math.floor(this.#options.hops ?? DEFAULT_HOPS)));
		const { query } = this.#codemap;
		const steps: FlowStep[] = [];
		const consider: FlowCandidate[] = [];
		const seen = new Set<number>();
		const push = (
			node: FlowNode,
			p: number | undefined,
			parent?: FlowStep,
			label?: string,
			rank?: number,
		): FlowStep => {
			const step: FlowStep = { n: steps.length + 1, node, p, from: parent?.n, label, rank };
			steps.push(step);
			seen.add(node.id);
			return step;
		};

		const candidates = await this.#entryCandidates();
		let frontier: FlowStep[] = [];
		if (candidates.length === 0) {
			this.notes.push(
				from === undefined
					? "no entry candidates: the index has no symbol matching the question"
					: `no symbol named ${from} in the index`,
			);
		} else if (from !== undefined) {
			frontier = candidates.map(node => push(node, undefined));
			if (judge) {
				const judged = await this.#judge(
					frontier.map(step => ({ node: step.node, label: undefined as string | undefined, step })),
					"entries",
				);
				for (const { item, p } of judged) item.step.p = p;
			}
		} else if (!judge) {
			frontier = candidates.slice(0, STRUCTURAL_ENTRIES).map(node => push(node, undefined));
		} else {
			onProgress?.(`judging ${candidates.length} entry candidates`);
			const judged = await this.#judge(
				candidates.map(node => ({ node, label: undefined as string | undefined })),
				"entries",
			);
			const ranked = judged
				.flatMap(entry => (entry.p === undefined ? [] : [{ node: entry.item.node, p: entry.p }]))
				.sort((a, b) => b.p - a.p);
			if (ranked.length === 0) {
				this.notes.push("entry judgment failed; starting from the best full-text matches, unjudged");
				frontier = candidates.slice(0, STRUCTURAL_ENTRIES).map(node => push(node, undefined));
			} else {
				let kept = ranked.filter(entry => entry.p >= ENTRY_CUTOFF).slice(0, ENTRIES_MAX);
				if (kept.length === 0) {
					kept = ranked.filter(entry => entry.p >= WEAK_ENTRY_CUTOFF).slice(0, WEAK_ENTRIES_MAX);
					if (kept.length > 0)
						this.notes.push(`no entry reached p ≥ ${ENTRY_CUTOFF}; starting from the best weak match`);
				}
				frontier = kept.map(entry => push(entry.node, entry.p));
			}
			for (const entry of judged) this.#judged.set(entry.item.node.id, entry.p);
			if (frontier.length === 0) this.notes.push("no entry point looked like a step of the question");
		}

		for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
			throwIfAborted(signal);
			const pending = new Map<number, Pending>();
			for (const step of frontier) {
				const edges: FlowEdge[] = query.flowNeighbors(step.node);
				for (const edge of edges) {
					if (seen.has(edge.to.id) || this.#judged.has(edge.to.id)) continue;
					const known = pending.get(edge.to.id);
					if (!known || edge.rank < known.rank)
						pending.set(edge.to.id, { node: edge.to, from: step, label: edge.label, rank: edge.rank });
				}
			}
			if (pending.size === 0) break;
			// Bridges lead; ties keep discovery order (earlier steps first).
			const reached = [...pending.values()]
				.sort((a, b) => a.rank - b.rank || a.from!.n - b.from!.n)
				.slice(0, HOP_CANDIDATES);
			onProgress?.(`hop ${hop}: ${reached.length} nodes`);
			const judged = await this.#judge(reached, `hop ${hop}`);
			for (const { item, p } of judged) this.#judged.set(item.node.id, p);

			// Unjudged nodes (structural walk, failed request) rank behind judged ones and are kept up to the cap.
			const order = [...judged].sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || a.item.rank - b.item.rank);
			// Event and cross-language edges (rank 0-1) hold most slots: plain calls are what a grep finds anyway.
			const eligible = order.filter(entry => entry.p === undefined || entry.p >= STEP_CUTOFF);
			const lead = eligible.filter(entry => entry.item.rank <= 1).slice(0, LEAD_STEPS_PER_HOP);
			const keep = [...lead, ...eligible.filter(entry => !lead.includes(entry))].slice(0, STEPS_PER_HOP);
			const kept = new Set(keep.map(entry => entry.item.node.id));
			for (const entry of order) {
				if (kept.has(entry.item.node.id) || entry.p === undefined || entry.p < CONSIDER_CUTOFF) continue;
				consider.push({ node: entry.item.node, p: entry.p, from: entry.item.from!.n, label: entry.item.label! });
			}
			// Report order is discovery order: by the step each node was reached from, then strongest first.
			keep.sort((a, b) => a.item.from!.n - b.item.from!.n || (b.p ?? -1) - (a.p ?? -1));
			frontier = keep.map(entry =>
				push(entry.item.node, entry.p, entry.item.from, entry.item.label, entry.item.rank),
			);
		}

		this.stats.elapsedMs = performance.now() - this.#started;
		if (!judge) {
			this.notes.unshift(
				"structural walk: no native judge is available, so every edge is followed with fan-out caps and nothing is pruned by relevance",
			);
		}
		const alsoConsider = consider.sort((a, b) => b.p - a.p).slice(0, CONSIDER_MAX);
		return {
			question,
			mode: judge ? "judged" : "structural",
			notes: this.notes,
			steps,
			alsoConsider,
			stats: this.stats,
		};
	}
}

/** Walk the flow behind `options.question` through `codemap`. Judge failures degrade to unjudged steps and are reported in `stats.failures`. */
export function runFlow(codemap: Codemap, options: FlowOptions): Promise<FlowResult> {
	return new FlowRun(codemap, options).run();
}

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function range(node: FlowNode): string {
	return `${node.path}:${node.startLine === node.endLine ? node.startLine : `${node.startLine}-${node.endLine}`}`;
}

function bytesOf(lines: readonly string[]): number {
	return lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

/**
 * Steps that fit `budget` bytes: the strongest by probability (earliest, when unjudged) plus the chain of steps
 * each was reached through, so every kept step still names a kept parent. Order is discovery order.
 */
function fitSteps(steps: readonly FlowStep[], size: (step: FlowStep) => number, budget: number): FlowStep[] {
	const kept = new Set<number>();
	let used = 0;
	const strength = (step: FlowStep): number =>
		(step.p ?? 1 - step.n / 1000) + (step.rank !== undefined && step.rank <= 1 ? BRIDGE_BONUS : 0);
	const byStrength = [...steps].sort((a, b) => strength(b) - strength(a));
	for (const step of byStrength) {
		if (kept.has(step.n)) continue;
		const chain: FlowStep[] = [];
		for (
			let at: FlowStep | undefined = step;
			at && !kept.has(at.n);
			at = at.from === undefined ? undefined : steps[at.from - 1]
		) {
			chain.push(at);
		}
		const cost = chain.reduce((sum, link) => sum + size(link), 0);
		if (used + cost > budget) continue;
		used += cost;
		for (const link of chain) kept.add(link.n);
	}
	return steps.filter(step => kept.has(step.n));
}

/** Text report: ordered steps, then pruned-but-plausible nodes, then stats; clipped under ~8 KB keeping the strongest steps. */
export function renderFlow(result: FlowResult): string {
	const head = [`flow: ${result.question}`, ...result.notes];
	const { stats } = result;
	const tail = [
		`judged ${stats.judged} nodes · ${stats.requests} requests · ${formatTokens(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${(stats.elapsedMs / 1000).toFixed(1)}s wall`,
	];
	if (stats.errors > 0) {
		tail.push(
			`${stats.errors} of ${stats.requests} requests failed:`,
			...stats.failures.map(failure => `  ${failure}`),
		);
	}
	tail.push(
		"Locations to read, not proof: links are by name and heuristics; read the ranges before relying on a step.",
	);
	const consider: string[] = result.alsoConsider.map(c => {
		const parent = result.steps[c.from - 1]?.node.name ?? "?";
		return `  [${c.node.lang}] ${c.node.name}  ${range(c.node)}  — ${c.label} from ${parent}  p=${c.p.toFixed(2)}`;
	});

	const stepText = (step: FlowStep, number: number, parent: number | undefined): string[] => {
		const via = parent === undefined ? "entry" : `edge from step ${parent} (${step.label})`;
		const p = step.p === undefined ? "" : `  p=${step.p.toFixed(2)}`;
		const lines = [`${number}. [${step.node.lang}] ${step.node.name}  ${range(step.node)}  — ${via}${p}`];
		if (step.node.signature) lines.push(`     ${step.node.signature}`);
		return lines;
	};
	const reserve = bytesOf(consider.slice(0, 4)) + 40;
	const budget = OUTPUT_BYTES - bytesOf([...head, "", "", ...tail]) - reserve;
	const fitted = fitSteps(result.steps, step => bytesOf(stepText(step, step.n, step.from)), budget);
	const renumbered = new Map(fitted.map((step, i) => [step.n, i + 1]));
	const body: string[] = [];
	for (const step of fitted) {
		body.push(
			...stepText(step, renumbered.get(step.n)!, step.from === undefined ? undefined : renumbered.get(step.from)),
		);
	}
	if (fitted.length < result.steps.length) {
		body.push(
			`… ${result.steps.length - fitted.length} weaker steps omitted (output limit); narrow with \`from\`, \`path\`, or fewer hops`,
		);
	}
	let bytes = bytesOf([...head, "", ...body, "", ...tail]);
	const room: string[] = [];
	for (const line of consider) {
		bytes += Buffer.byteLength(line) + 1;
		if (bytes > OUTPUT_BYTES) break;
		room.push(line);
	}
	if (room.length > 0) body.push("", "Also consider (plausible, not expanded):", ...room);
	if (result.steps.length === 0) body.push("no steps found");
	return [...head, "", ...body, "", ...tail].join("\n");
}
