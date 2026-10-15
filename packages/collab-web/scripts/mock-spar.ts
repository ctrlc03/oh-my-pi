/**
 * The `spar-*` requests for scripts/mock-companion.ts, so the sparring partner can be tried in a browser, built like
 * ./mock-quiz and reading the code behind every citation from the same small repository ("interfold") it embeds.
 *
 * Canned spars: `sp-mock-finished`, a finished spar on two pull requests whose five points show every way a point can
 * end (held after a pushed-back round, partly held, conceded by you, open at the round limit, open because you accepted
 * the risk); `sp-mock-doc`, a spar on a design document whose four points are all still new; `sp-mock-failed`; and
 * `sp-mock-running`, whose progress ticks and which turns ready after a few seconds. A spar started from the form
 * (`spar-create`) ticks through three stages and turns ready with three points (about 2 s with the default stage length);
 * a design document alone gives the canned design spar's points, `model: "mock/fail"` fails it, and `/fail` as a defence
 * fails one reply once.
 *
 * Like the real companion it keeps each point's case file (strongest defence, counters, suggestion) out of every reply,
 * and sends the strongest defence and the suggestion only once the point is closed. The partner's logic is fixed so a
 * browser session is repeatable:
 *   - a defence containing the word `because` is conceded to (the point is held);
 *   - else one containing `partly` gets a `partly` move (the point ends partly held, with a suggestion);
 *   - else the partner pushes back with its counter and the point stays open, up to the third defence: a push on
 *     round 3 closes the point as open by the round limit.
 * Every `spar-reply` is one round and costs $0.09 against the spar's limit; `/limit` as a defence hits the limit too.
 * `spar-close` never calls the "model": `lost` is "you conceded", `open` is "accept the risk".
 */

import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import type { QuizPart, QuizRef, QuizStackPr } from "@oh-my-pi/pi-wire/quiz";
import type {
	Spar,
	SparKind,
	SparMove,
	SparPoint,
	SparRecord,
	SparRun,
	SparSummary,
	SparTurn,
} from "@oh-my-pi/pi-wire/spar";
import {
	SPAR_DEFAULT_MAX_COST_USD,
	SPAR_DESIGN_PATH,
	SPAR_MAX_REPLY_CHARS,
	SPAR_MAX_ROUNDS,
	SPAR_VERSION,
	scoreSpar,
} from "@oh-my-pi/pi-wire/spar";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { excerptOf as readExcerpt } from "./companion-excerpt";
import { cite, excerptOf, MOCK_QUIZ_ROOT, mockStackPrs } from "./mock-quiz";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REPLY_COST_USD = 0.09;
const WRITE_COST_USD = 0.74;
const BASE_COMMIT = "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22";
const HEAD_COMMITS = ["9c0e5f3b7a14d82e6f0a3c5b1d97e4286a0f3b51", "e41b09d7a2c8135f6b0e94a7d3c15882f60b7d19"];
const REPO = { root: MOCK_QUIZ_ROOT, name: "interfold", github: "example/interfold" };
const DESIGN_NAME = "provider-cache-design.md";
const LIMIT_LINE = "That was your last answer on this point, so it stays open.";

const STAGES = ["Reading the changes", "Writing the points", "Checking every citation against the commit"];
const RUNNING_STAGES = [
	"Reading the changes",
	"Reading the conversation of the session",
	"Writing the points (2 of 6)",
	"Writing the points (6 of 6)",
	"Checking every citation against the commit",
];

/** The design document the doc spars challenge; its lines are what `@design` citations point at. */
const DESIGN_TEXT = `${[
	"# Shared provider per chain",
	"",
	"## Problem",
	"Every reader opens its own connection to the chain's RPC endpoint.",
	"A node that follows eight contracts holds eight connections to one endpoint.",
	"Each connection repeats the handshake when it starts.",
	"",
	"## Proposal",
	"Keep one connected provider per chain id in a process-wide cache.",
	"A reader asks the cache for its chain and gets the provider that already exists.",
	"The first reader to ask for a chain connects it; every later one reuses it.",
	"",
	"## Lifetime",
	"A provider stays in the cache until the process stops.",
	"If the endpoint address changes, the operator restarts the node.",
	"",
	"## Failure handling",
	"A provider that loses its connection reconnects itself.",
	"Readers do not check whether the provider is healthy before using it.",
	"",
	"## Rollout",
	"Readers move to the cache one crate at a time.",
	"The old helper stays until the last reader has moved.",
	"No data format changes.",
].join("\n")}\n`;

/** A citation of the first line of the design document holding `token`. */
function designCite(token: string): QuizRef {
	const index = DESIGN_TEXT.split("\n").findIndex(line => line.includes(token));
	if (index === -1) throw new Error(`mock spar: the design has no "${token}"`);
	return { path: SPAR_DESIGN_PATH, line: index + 1, token };
}

function designExcerpt(ref: BlueprintExcerptRef, text: string): BlueprintExcerpt | null {
	const excerpt = readExcerpt(text.split("\n"), ref, "head", "");
	return excerpt === null ? null : { ...excerpt, language: "markdown" };
}

/** What the real companion keeps back from the device until a point is closed. */
interface Case {
	strongestDefence: string;
	suggestion: string;
	/** The partner's push; on round 3 it is followed by the closing line. */
	counter: string;
	concession: string;
	/** The objection that stands when the partner concedes only partly. */
	residual: string;
}

interface PointSpec {
	/** Index into the parts; clamped to the last part when a spar has fewer. */
	part: number;
	kind: SparKind;
	severity: SparPoint["severity"];
	title: string;
	challenge: string;
	refs: QuizRef[];
	case: Case;
}

const PROVIDER_CACHE = "crates/evm/src/provider_cache.rs";
const COMMITTEE = "crates/sortition/src/committee.rs";

/** Points about the provider cache (the first pull request) and the committee hashing (the second). */
const CHANGE_SPECS: PointSpec[] = [
	{
		part: 0,
		kind: "alternative",
		severity: 2,
		title: "Why a cache per chain instead of one provider built at startup?",
		challenge:
			"The old `create_provider` built a new connection on every call. This change fixes that with a `ProviderCache` keyed by chain id.\n\nThe simpler fix is to build the provider once when the node starts and hand it to each reader: no lock, no map, no async `get`. What does the cache buy that a single provider would not?",
		refs: [cite(PROVIDER_CACHE, "providers: RwLock"), cite("crates/evm/src/helpers.rs", "create_provider", "base")],
		case: {
			strongestDefence:
				"The chain a reader needs is not known at startup. A reader learns its chain id and RPC address from the contract it is told to follow, so the first reader for each chain has to be the one that connects. A provider built at startup would have to guess the chains in advance.",
			suggestion: "Keep the cache and say in its doc comment why it connects lazily: readers join after startup.",
			counter:
				"A startup provider is still simpler: one value, no lock. Unless readers appear after the node starts, I do not see what the map is for. What makes the chain unknown at startup?",
			concession:
				"That settles it: the chain is only known when a reader is attached, so the cache has to connect lazily. Fair.",
			residual:
				"Lazy connecting is fair for readers that join late, but the chains configured at startup could still be connected up front. That part of the objection stands.",
		},
	},
	{
		part: 0,
		kind: "failure",
		severity: 3,
		title: "What happens when two readers ask for the same new chain at once?",
		challenge:
			"`get` takes the read lock, finds nothing, drops it, connects, and only then takes the write lock to insert.\n\nTwo readers that arrive together for the same chain both miss, both connect, and the second `insert` replaces the first. One connection is built and thrown away, and a reader may keep using a provider that is no longer in the map.",
		refs: [cite(PROVIDER_CACHE, "if let Some(found)"), cite(PROVIDER_CACHE, "insert(chain_id")],
		case: {
			strongestDefence:
				"The race is real but harmless: both providers talk to the same endpoint and are interchangeable, so the loser is dropped when its last reader finishes. The cost is one extra handshake on the first burst, which the old code paid on every call.",
			suggestion:
				"Check again under the write lock and insert only if the chain is still missing, so a burst makes one connection. A `OnceCell` per chain does the same without holding the lock across the connect.",
			counter:
				"Interchangeable is a claim about today's providers. Nothing in the code says the loser is dropped, and the lock is not held across the connect. Where does the second connection end?",
			concession:
				"If every provider is interchangeable and the loser is simply dropped, the race costs one handshake and nothing else. Fair.",
			residual:
				"Harmless in effect, yes. But the handshake is still paid twice on a burst, and nothing stops a reader from holding the replaced provider. That small risk stands.",
		},
	},
	{
		part: 0,
		kind: "assumption",
		severity: 2,
		title: "What keeps a cached provider right when the RPC address changes?",
		challenge:
			"The cache is keyed by chain id alone: a hit returns the stored provider and ignores the `rpc_url` the caller passed.\n\nIf an operator changes the endpoint, or two readers are configured with different endpoints for one chain, every reader silently keeps the first one. What makes that safe?",
		refs: [
			cite(PROVIDER_CACHE, "pub async fn get"),
			cite("crates/evm/src/event_reader.rs", "cache.get(chain_id, rpc_url)"),
		],
		case: {
			strongestDefence:
				"One chain has one endpoint per node, set in the node's config and read once. A change needs a restart anyway, and the cache lives only as long as the process.",
			suggestion:
				"Key the cache by chain id and address, or return an error when a caller passes an address that differs from the cached one, so a mismatch is loud.",
			counter:
				"The code does not say the address is read once, and `get` still takes an `rpc_url` it then ignores. A second address is dropped without a word. What about two readers configured differently?",
			concession: "One endpoint per chain per node, read once: then ignoring the argument is harmless. Fair.",
			residual:
				"A restart covers a changed address, but two readers configured differently still get the first one silently. That part stands.",
		},
	},
	{
		part: 1,
		kind: "failure",
		severity: 3,
		title: "Will every node pick the same committee?",
		challenge:
			"`score` hashes the node name and the seed with `DefaultHasher`. Its algorithm is not specified and may change between Rust releases.\n\nNodes built with different compilers could rank the same registry differently and each pick a different committee for one computation. How do you know they agree?",
		refs: [cite(COMMITTEE, "DefaultHasher::new()"), cite(COMMITTEE, "hasher.finish()")],
		case: {
			strongestDefence:
				"Every node in a deployment runs the same release binary, so the hasher is the same everywhere. A mixed-version network is not supported during an upgrade window, and the committee is checked against the on-chain registry anyway.",
			suggestion:
				"Use a hash with a fixed specification, for example SHA-256 over the node name and seed, so the ranking does not depend on the compiler.",
			counter:
				"Same binary is a deployment promise, not something the code checks. `DefaultHasher` documents that its output may change, and a rolling upgrade is exactly when versions mix.",
			concession: "If the binaries are identical by construction, the ranking is identical too. Fair.",
			residual: "Identical binaries cover steady state, but not a rolling upgrade. That part stands.",
		},
	},
	{
		part: 1,
		kind: "migration",
		severity: 2,
		title: "What happens to computations in flight when the committee rule changes?",
		challenge:
			"The old `select` ordered nodes by name length XOR seed; this one orders them by hash. The same seed now gives a different committee.\n\nA computation that already started with the old committee and selects again, for a retry or a late join, gets different nodes. What is the rollback, and what happens to work in progress?",
		refs: [cite(COMMITTEE, "node.len() as u64", "base"), cite(COMMITTEE, "ranked.sort_by_key")],
		case: {
			strongestDefence:
				"A computation keeps its committee once chosen: `select` runs at the request event and the result is stored with the computation, so nothing selects twice. Rolling back is reverting the commit; no data format changes.",
			suggestion: "Store the rule version with the committee so a retry can tell which rule picked it.",
			counter:
				"Nothing in this diff stores the committee. If a retry calls `select` again with the same seed it gets different nodes. Where is the result kept?",
			concession:
				"If the committee is stored with the computation, a changed rule never reaches work in flight. Fair.",
			residual: "Stored committees protect running work, but a retry still has no way to tell which rule chose it.",
		},
	},
];

/** Points about the design document; the second also cites the code the design is checked against. */
const DOC_SPECS: PointSpec[] = [
	{
		part: 0,
		kind: "alternative",
		severity: 2,
		title: "Why a process-wide cache instead of handing one provider to each reader?",
		challenge:
			"The proposal keeps one provider per chain in a cache that every reader reaches by name.\n\nPassing the provider into each reader when it is built needs no shared state and no lock, and the code already builds readers in one place. What does a shared cache make possible that passing the provider would not?",
		refs: [
			designCite("one connected provider per chain id"),
			cite("crates/evm/src/event_reader.rs", "pub async fn attach"),
		],
		case: {
			strongestDefence:
				"Readers are attached one at a time as contracts are added, long after the first has started, so there is no single place that could hand out the provider. The cache is how a later reader finds the one that exists.",
			suggestion:
				"Say in the design that readers join over time, and that this is why a lookup beats passing a value.",
			counter:
				"The code builds readers through `attach`, which takes the cache as an argument. Passing a provider there is the same signature with a different type. Why is a lookup needed?",
			concession: "If readers really are attached over time with no common owner, a lookup is the only way. Fair.",
			residual:
				"A lookup is needed for late readers, but the design does not say so, and it reads as if one owner existed.",
		},
	},
	{
		part: 0,
		kind: "failure",
		severity: 3,
		title: "What does a reader do when its provider has lost the connection?",
		challenge:
			"The design says a provider reconnects itself, and that readers do not check its health before using it.\n\nWhile it reconnects, every call on it fails or waits. Several readers share it, so one outage stops all of them at once, with no one responsible for noticing. What happens to a log the reader misses in the gap?",
		refs: [designCite("reconnects itself"), designCite("do not check")],
		case: {
			strongestDefence:
				"A reader follows logs from a stored block number, so a gap is closed by catching up from the last block it saw once the provider is back. Nothing is lost, only delayed.",
			suggestion:
				"Write the catch-up rule into the design: the reader resumes from its last block and says so when it lags.",
			counter:
				"The design never says readers resume from a stored block. Without that, a reader that fails a call may skip the logs of that gap. Where is the catch-up written?",
			concession: "Resuming from the last seen block makes the outage a delay, not a loss. Fair.",
			residual: "Catch-up covers lost logs, but the design still gives nobody the job of noticing a long outage.",
		},
	},
	{
		part: 0,
		kind: "assumption",
		severity: 2,
		title: "Who restarts the node when an endpoint address changes?",
		challenge:
			"The design keeps a provider until the process stops, and says the operator restarts the node if the address changes.\n\nThat makes every endpoint change an outage of the whole node, including its other chains. It also assumes the operator knows the address is held until restart. Is that acceptable?",
		refs: [designCite("until the process stops"), designCite("restarts the node")],
		case: {
			strongestDefence:
				"Endpoints change a few times a year and the node already restarts for every release. A restart is cheap, and it is the only way an address change can be applied everywhere at the same moment.",
			suggestion: "Let the cache drop a provider on a config reload, so a changed address does not need a restart.",
			counter:
				"A few times a year is a guess. A provider outage on a public endpoint can force an address change at any hour, and a restart stops every other chain too.",
			concession: "If it is rare and the node restarts regularly anyway, a restart is a reasonable price. Fair.",
			residual:
				"Rare, yes, but an outage forces the change at a bad moment and stops every chain. That part stands.",
		},
	},
	{
		part: 0,
		kind: "migration",
		severity: 1,
		title: "What stops two readers using different providers during the rollout?",
		challenge:
			"Readers move to the cache one crate at a time, and the old helper stays until the last one has moved.\n\nDuring that time a node holds both the old per-call connections and the new shared one. What is the rollback if the cache misbehaves half way?",
		refs: [designCite("old helper stays"), designCite("one crate at a time")],
		case: {
			strongestDefence:
				"Each reader is switched by one commit that only changes where it gets its provider, so a rollback is reverting that commit. The old helper keeps working beside the cache because it shares no state with it.",
			suggestion: "Add a line to the rollout section saying each move is its own commit and can be reverted alone.",
			counter: "Neither the design nor the plan says a move is one commit. Without that, the rollback is not clear.",
			concession: "One commit per reader makes each step reversible on its own. Fair.",
			residual:
				"Reversible per reader, but the design still does not say so, and the half-moved state is undefined.",
		},
	},
];

function pointsOf(specs: PointSpec[], parts: number): { points: SparPoint[]; cases: Map<string, Case> } {
	const cases = new Map<string, Case>();
	const points = specs.map((spec, at): SparPoint => {
		const id = `p${at + 1}`;
		cases.set(id, spec.case);
		return {
			id,
			part: Math.min(spec.part, parts - 1),
			kind: spec.kind,
			title: spec.title,
			challenge: spec.challenge,
			severity: spec.severity,
			refs: spec.refs,
		};
	});
	return { points, cases };
}

interface Built {
	spar: Spar;
	cases: Map<string, Case>;
	/** The design document, kept for `@design` excerpts. */
	docText?: string;
}

function build(
	id: string,
	title: string,
	createdAt: number,
	parts: QuizPart[],
	specs: PointSpec[],
	options: { warnings?: string[]; doc?: { name: string }; sessionId?: string } = {},
): Built {
	const { points, cases } = pointsOf(specs, parts.length);
	const spar: Spar = {
		v: SPAR_VERSION,
		id,
		title,
		repo: REPO,
		createdAt,
		model: "anthropic/claude-sonnet-5-5",
		parts,
		points,
		warnings: options.warnings ?? [],
	};
	if (options.sessionId !== undefined) spar.sessionId = options.sessionId;
	if (options.doc === undefined) return { spar, cases };
	spar.doc = { name: options.doc.name, chars: DESIGN_TEXT.length };
	return { spar, cases, docText: DESIGN_TEXT };
}

function prPart(pr: QuizStackPr, index: number): QuizPart {
	return {
		index,
		title: pr.title,
		pr: { number: pr.number, url: pr.url, head: pr.head, base: pr.base },
		head: { commit: HEAD_COMMITS[index % HEAD_COMMITS.length]!, ref: `pr/${pr.number}`, subject: pr.title },
		base: { commit: BASE_COMMIT, ref: pr.base },
	};
}

/** The one part of a change that is not a pull request: a branch, or what a session changed. */
function changePart(title: string, ref: string, base: string): QuizPart {
	return { index: 0, title, head: { commit: HEAD_COMMITS[1]!, ref }, base: { commit: BASE_COMMIT, ref: base } };
}

/** The part of a design document: no base, only the commit its claims are checked against. */
const DOC_PART: QuizPart = {
	index: 0,
	title: "Design checked against the code",
	head: { commit: HEAD_COMMITS[0]!, ref: "main" },
};

// ── rounds and outcomes ──────────────────────────────────────────────────────

function revealOf(point: SparPoint, c: Case, withSuggestion: boolean): NonNullable<SparRecord["reveal"]> {
	return withSuggestion
		? { strongestDefence: c.strongestDefence, suggestion: c.suggestion, refs: point.refs }
		: { strongestDefence: c.strongestDefence };
}

/** The record after one more defence: the partner's move by the rules in the header, and the outcome when it closes the point. */
function defend(record: SparRecord, point: SparPoint, c: Case, defence: string, at: number): SparRecord {
	const round = record.turns.filter(turn => turn.by === "you").length + 1;
	const move: SparMove = /\bbecause\b/i.test(defence) ? "concede" : /\bpartly\b/i.test(defence) ? "partly" : "push";
	const text = move === "concede" ? c.concession : move === "partly" ? c.residual : c.counter;
	const turns: SparTurn[] = [
		...record.turns,
		{ by: "you", text: defence, at },
		{
			by: "partner",
			text: move === "push" && round >= SPAR_MAX_ROUNDS ? `${text} ${LIMIT_LINE}` : text,
			move,
			refs: [point.refs[0]!],
			checked: [{ claim: defence.length > 80 ? `${defence.slice(0, 79)}…` : defence, holds: move === "concede" }],
			at,
		},
	];
	if (move === "concede")
		return { turns, outcome: { kind: "held", by: "partner" }, reveal: revealOf(point, c, false) };
	if (move === "partly")
		return { turns, outcome: { kind: "partly", by: "partner" }, reveal: revealOf(point, c, true) };
	if (round >= SPAR_MAX_ROUNDS)
		return { turns, outcome: { kind: "open", by: "limit" }, reveal: revealOf(point, c, false) };
	return { turns };
}

function closeRecord(record: SparRecord, point: SparPoint, c: Case, as: "lost" | "open", note: string): SparRecord {
	return {
		turns: record.turns,
		outcome: note === "" ? { kind: as, by: "you" } : { kind: as, by: "you", note },
		reveal: revealOf(point, c, as === "lost"),
	};
}

function newRun(id: string, startedAt: number, points: string[], retryOf?: string): SparRun {
	const run: SparRun = { id, startedAt, points, records: {}, result: scoreSpar({ points, records: {} }) };
	if (retryOf !== undefined) run.retryOf = retryOf;
	return run;
}

/** The run with `record` stored for the point, its result recomputed and, once every point is closed, its end time set. */
function withRecord(run: SparRun, id: string, record: SparRecord, at: number): SparRun {
	const records = { ...run.records, [id]: record };
	const next: SparRun = { ...run, records, result: scoreSpar({ points: run.points, records }) };
	const closed = run.points.every(point => Object.hasOwn(records, point) && records[point]!.outcome !== undefined);
	if (closed) next.finishedAt = run.finishedAt ?? at;
	return next;
}

interface StoredSpar {
	summary: SparSummary;
	spar: Spar | null;
	cases: Map<string, Case>;
	runs: SparRun[];
	docText?: string;
	timer?: NodeJS.Timeout;
	/** A defence of `/fail` fails one reply, then goes through. */
	failedOnce: boolean;
}

export interface MockSpar {
	/** Fields the mock companion's `hosts` frame needs for the app to offer sparring. */
	capabilities: { canSpar: true };
	handles(request: CompanionRequest): boolean;
	/** Replies wait for the "model", so the answer is a promise. */
	answer(request: CompanionRequest): Promise<CompanionReply>;
	/** Every spar timer stops. */
	stop(): void;
}

export function createMockSpar(options: {
	/** A spar was added, changed or removed: pushed to every guest as `spar-changed`. */
	onChanged(id: string): void;
	/** The omp session that a running spar is written by, so the app can offer to watch it. */
	instanceId: string;
	/** Milliseconds a stage of writing lasts; tests make it short. */
	stageMs?: number;
	/** Milliseconds the "model" takes to answer a defence. */
	replyMs?: number;
}): MockSpar {
	const stageMs = options.stageMs ?? 700;
	const replyMs = options.replyMs ?? 700;
	const now = Date.now();
	const spars = new Map<string, StoredSpar>();
	let counter = 0;

	const refreshSummary = (stored: StoredSpar): void => {
		const { summary, spar, runs } = stored;
		if (spar === null) return;
		const latest = runs.reduce<SparRun | undefined>(
			(best, run) => (best === undefined || run.startedAt >= best.startedAt ? run : best),
			undefined,
		);
		summary.partCount = spar.parts.length;
		summary.pointCount = spar.points.length;
		summary.runCount = runs.length;
		summary.latest =
			latest === undefined
				? undefined
				: {
						held: latest.result.held.length,
						asked: latest.points.length,
						percentHeld: latest.result.percentHeld,
						finished: latest.finishedAt !== undefined,
						at: latest.finishedAt ?? latest.startedAt,
					};
	};

	const put = (stored: StoredSpar): StoredSpar => {
		spars.set(stored.summary.id, stored);
		refreshSummary(stored);
		return stored;
	};

	const readyStored = (built: Built, over: Partial<SparSummary>, runs: SparRun[]): StoredSpar =>
		put({
			summary: {
				id: built.spar.id,
				title: built.spar.title,
				repoRoot: built.spar.repo.root,
				subject: "",
				createdAt: built.spar.createdAt,
				status: "ready",
				maxCostUsd: SPAR_DEFAULT_MAX_COST_USD,
				...over,
			},
			spar: built.spar,
			cases: built.cases,
			runs,
			docText: built.docText,
			failedOnce: false,
		});

	// A finished spar of two pull requests, one point ending each way.
	{
		const built = build(
			"sp-mock-finished",
			"interfold · PRs #2244–#2245",
			now - 2 * DAY,
			mockStackPrs().slice(1, 3).map(prPart),
			CHANGE_SPECS,
			{ warnings: ["One point was dropped: none of its citations were in the commit."] },
		);
		const ids = built.spar.points.map(point => point.id);
		const start = now - 2 * DAY + 5 * MINUTE;
		const point = (id: string): SparPoint => built.spar.points.find(item => item.id === id)!;
		const played = (id: string, defences: string[], at: number): SparRecord =>
			defences.reduce<SparRecord>(
				(record, defence, round) =>
					defend(record, point(id), built.cases.get(id)!, defence, at + round * 3 * MINUTE),
				{ turns: [] },
			);
		let run = newRun("r1", start, ids);
		run = withRecord(
			run,
			"p1",
			played(
				"p1",
				[
					"It is faster than building a provider on every call.",
					"Because the chain is not known at startup: a reader learns it from the contract it follows, so the first reader for each chain has to connect.",
				],
				start + 2 * MINUTE,
			),
			start + 8 * MINUTE,
		);
		run = withRecord(
			run,
			"p2",
			played(
				"p2",
				["It is partly fine: both providers are interchangeable and the loser is dropped."],
				start + 10 * MINUTE,
			),
			start + 12 * MINUTE,
		);
		run = withRecord(
			run,
			"p3",
			closeRecord(
				played("p3", ["I assumed the address never changes."], start + 14 * MINUTE),
				point("p3"),
				built.cases.get("p3")!,
				"lost",
				"",
			),
			start + 17 * MINUTE,
		);
		run = withRecord(
			run,
			"p4",
			played(
				"p4",
				["Everyone runs the same binary.", "We always deploy all nodes together.", "It has worked so far."],
				start + 19 * MINUTE,
			),
			start + 26 * MINUTE,
		);
		run = withRecord(
			run,
			"p5",
			closeRecord(
				{ turns: [] },
				point("p5"),
				built.cases.get("p5")!,
				"open",
				"We stop requests during an upgrade, so nothing is in flight. Accepting this.",
			),
			start + 28 * MINUTE,
		);
		readyStored(built, { subject: "PRs #2244–#2245", costUsd: 1.84 }, [run]);
	}
	// A spar on a design document: every point still new, so opening it lands on the first.
	{
		const built = build(
			"sp-mock-doc",
			"interfold · provider-cache-design.md",
			now - 3 * HOUR,
			[DOC_PART],
			DOC_SPECS,
			{
				doc: { name: DESIGN_NAME },
			},
		);
		const run = newRun(
			"r1",
			now - 3 * HOUR + MINUTE,
			built.spar.points.map(point => point.id),
		);
		readyStored(built, { subject: "a design document", costUsd: WRITE_COST_USD }, [run]);
	}
	spars.set("sp-mock-failed", {
		summary: {
			id: "sp-mock-failed",
			title: "interfold · PR #2231",
			repoRoot: MOCK_QUIZ_ROOT,
			subject: "PR #2231",
			createdAt: now - 5 * HOUR,
			status: "failed",
			error: "None of the agent's points held up against the code.",
			costUsd: 0.9,
			maxCostUsd: SPAR_DEFAULT_MAX_COST_USD,
		},
		spar: null,
		cases: new Map(),
		runs: [],
		failedOnce: false,
	});

	const push = (id: string): void => options.onChanged(id);

	/** Tick a spar through its stages, pushing each, then finish it as ready (or as failed for the model `mock/fail`). */
	const run = (stored: StoredSpar, stages: string[], model: string | undefined, finish: () => Built): void => {
		let stage = 0;
		const { summary } = stored;
		summary.status = "running";
		summary.instanceId = options.instanceId;
		summary.progress = stages[0];
		push(summary.id);
		stored.timer = setInterval(() => {
			stage++;
			if (model === "mock/fail" && stage === 2) {
				clearInterval(stored.timer);
				Object.assign(summary, {
					status: "failed",
					progress: undefined,
					instanceId: undefined,
					error: "The agent stopped before it wrote any point: the model refused the request.",
				});
				push(summary.id);
				return;
			}
			if (stage < stages.length) {
				summary.progress = stages[stage];
				push(summary.id);
				return;
			}
			clearInterval(stored.timer);
			const built = finish();
			stored.spar = built.spar;
			stored.cases = built.cases;
			stored.docText = built.docText;
			stored.runs = [
				newRun(
					"r1",
					Date.now(),
					built.spar.points.map(point => point.id),
				),
			];
			Object.assign(summary, {
				status: "ready",
				progress: undefined,
				instanceId: undefined,
				costUsd: WRITE_COST_USD,
			});
			refreshSummary(stored);
			push(summary.id);
		}, stageMs);
	};

	// A spar still being written when the mock starts: its progress ticks and it turns ready after a few seconds.
	{
		const stored: StoredSpar = {
			summary: {
				id: "sp-mock-running",
				title: "interfold · feature/event-replay vs main",
				repoRoot: MOCK_QUIZ_ROOT,
				subject: "feature/event-replay vs main",
				createdAt: now - MINUTE,
				status: "running",
				maxCostUsd: SPAR_DEFAULT_MAX_COST_USD,
			},
			spar: null,
			cases: new Map(),
			runs: [],
			failedOnce: false,
		};
		spars.set("sp-mock-running", stored);
		run(stored, RUNNING_STAGES, undefined, () =>
			build(
				"sp-mock-running",
				stored.summary.title,
				stored.summary.createdAt,
				[changePart("feature/event-replay", "feature/event-replay", "main")],
				[CHANGE_SPECS[0]!, CHANGE_SPECS[1]!, CHANGE_SPECS[3]!],
			),
		);
	}

	const need = (id: string): StoredSpar => {
		const stored = spars.get(id);
		if (stored === undefined) throw new Error(`no spar ${id}`);
		return stored;
	};
	const ready = (id: string): StoredSpar & { spar: Spar } => {
		const stored = need(id);
		if (stored.spar === null) throw new Error(`The spar ${id} is not ready.`);
		return stored as StoredSpar & { spar: Spar };
	};
	const runById = (stored: StoredSpar, id: string): SparRun => {
		const found = stored.runs.find(item => item.id === id);
		if (found === undefined) throw new Error(`no run ${id}`);
		return found;
	};
	const replaceRun = (stored: StoredSpar, next: SparRun): void => {
		stored.runs = stored.runs.map(item => (item.id === next.id ? next : item));
		refreshSummary(stored);
		push(stored.summary.id);
	};
	/** The point, its case file and its record in the run, for a point the run asks and has not closed. */
	const openPoint = (
		stored: StoredSpar & { spar: Spar },
		runId: string,
		pointId: string,
	): { run: SparRun; point: SparPoint; c: Case; record: SparRecord } => {
		const found = runById(stored, runId);
		const point = stored.spar.points.find(item => item.id === pointId);
		if (point === undefined || !found.points.includes(pointId)) throw new Error(`The run does not ask ${pointId}.`);
		const record = Object.hasOwn(found.records, pointId) ? found.records[pointId]! : { turns: [] };
		if (record.outcome !== undefined) throw new Error("That point is already closed.");
		return { run: found, point, c: stored.cases.get(pointId)!, record };
	};

	return {
		capabilities: { canSpar: true },
		handles: request => request.t.startsWith("spar-"),
		stop() {
			for (const stored of spars.values()) clearInterval(stored.timer);
		},
		async answer(request): Promise<CompanionReply> {
			switch (request.t) {
				case "spar-list": {
					// Every folder of the mock computer is a folder of the fixture repository.
					const rows = [...spars.values()]
						.map(stored => ({ ...stored.summary }))
						.filter(summary => request.cwd === undefined || summary.repoRoot === MOCK_QUIZ_ROOT)
						.sort((a, b) => b.createdAt - a.createdAt);
					return { t: "spar-list", reqId: request.reqId, spars: rows };
				}
				case "spar-create": {
					const numbers = request.stack ?? (request.pr === undefined ? [] : [request.pr]);
					const hasChange = numbers.length > 0 || request.ref !== undefined || request.base !== undefined;
					if (!hasChange && request.doc === undefined)
						throw new Error("Choose what to challenge: a change or a design document.");
					const id = `sp-new-${++counter}`;
					const prs = numbers.map(
						number =>
							mockStackPrs().find(pr => pr.number === number) ?? {
								number,
								title: `Pull request #${number}`,
								head: `feature/pr-${number}`,
								base: "main",
							},
					);
					const docName =
						request.doc === undefined
							? DESIGN_NAME
							: "text" in request.doc
								? (request.doc.name ?? "Pasted design")
								: (request.doc.path.split("/").pop() ?? DESIGN_NAME);
					const subject = !hasChange
						? "a design document"
						: prs.length > 1
							? `PRs #${prs[0]!.number}–#${prs[prs.length - 1]!.number}`
							: prs.length === 1
								? `PR #${prs[0]!.number}`
								: request.ref === undefined
									? "worktree vs main"
									: `${request.ref} vs ${request.base ?? "main"}`;
					const summary: SparSummary = {
						id,
						title: `interfold · ${!hasChange ? docName : subject}`,
						repoRoot: MOCK_QUIZ_ROOT,
						subject,
						createdAt: Date.now(),
						status: "running",
						maxCostUsd: request.maxCostUsd ?? SPAR_DEFAULT_MAX_COST_USD,
					};
					if (request.sessionId !== undefined) summary.sessionId = request.sessionId;
					const stored: StoredSpar = { summary, spar: null, cases: new Map(), runs: [], failedOnce: false };
					spars.set(id, stored);
					run(stored, STAGES, request.model, () => {
						if (!hasChange)
							return build(id, summary.title, Date.now(), [DOC_PART], DOC_SPECS, { doc: { name: docName } });
						const parts =
							prs.length > 0
								? prs.map(prPart)
								: [
										changePart(
											request.ref ?? "What the session changed",
											request.ref ?? "@worktree",
											request.base ?? "main",
										),
									];
						return build(
							id,
							summary.title,
							Date.now(),
							parts,
							[CHANGE_SPECS[0]!, CHANGE_SPECS[1]!, CHANGE_SPECS[3]!],
							{
								sessionId: request.sessionId,
							},
						);
					});
					return { t: "spar-create", reqId: request.reqId, id };
				}
				case "spar-get": {
					const stored = ready(request.id);
					// The spar as stored has no case files: they are a separate table, never part of the reply.
					return { t: "spar-get", reqId: request.reqId, spar: stored.spar, runs: stored.runs };
				}
				case "spar-reply": {
					const stored = ready(request.id);
					if (request.text.trim() === "") throw new Error("Write your defence first.");
					if (request.text.length > SPAR_MAX_REPLY_CHARS)
						throw new Error(`The defence is longer than ${SPAR_MAX_REPLY_CHARS} characters.`);
					const limit = stored.summary.maxCostUsd ?? SPAR_DEFAULT_MAX_COST_USD;
					if (request.text.trim() === "/limit" || (stored.summary.costUsd ?? 0) >= limit)
						throw new Error(
							`The spar reached its spending limit of $${limit.toFixed(2)}; replies stopped. You can still close points.`,
						);
					if (request.text.trim() === "/fail" && !stored.failedOnce) {
						stored.failedOnce = true;
						await Bun.sleep(replyMs);
						throw new Error("The reply could not be read. Try again: this round was not used.");
					}
					await Bun.sleep(replyMs);
					const { run: current, point, c, record } = openPoint(stored, request.run, request.point);
					const at = Date.now();
					const next = defend(record, point, c, request.text, at);
					const updated = withRecord(current, point.id, next, at);
					stored.summary.costUsd = (stored.summary.costUsd ?? 0) + REPLY_COST_USD;
					replaceRun(stored, updated);
					return {
						t: "spar-reply",
						reqId: request.reqId,
						turn: next.turns[next.turns.length - 1]!,
						record: next,
						run: updated,
					};
				}
				case "spar-close": {
					const stored = ready(request.id);
					if (request.as !== "lost" && request.as !== "open") throw new Error("Close a point as lost or open.");
					const note = (request.note ?? "").trim();
					if (note.length > SPAR_MAX_REPLY_CHARS)
						throw new Error(`The note is longer than ${SPAR_MAX_REPLY_CHARS} characters.`);
					const { run: current, point, c, record } = openPoint(stored, request.run, request.point);
					const next = closeRecord(record, point, c, request.as, note);
					const updated = withRecord(current, point.id, next, Date.now());
					replaceRun(stored, updated);
					return { t: "spar-close", reqId: request.reqId, record: next, run: updated };
				}
				case "spar-again": {
					const stored = ready(request.id);
					const from =
						request.from === undefined
							? stored.runs.reduce((best, item) => (item.startedAt >= best.startedAt ? item : best))
							: runById(stored, request.from);
					const points =
						request.only === "all"
							? stored.spar.points.map(point => point.id)
							: from.points.filter(id => {
									const record = Object.hasOwn(from.records, id) ? from.records[id]! : undefined;
									return record?.outcome?.kind !== "held";
								});
					if (points.length === 0) throw new Error("Every point was held in that run.");
					const fresh = newRun(`r${stored.runs.length + 1}`, Date.now(), points, from.id);
					stored.runs = [...stored.runs, fresh];
					refreshSummary(stored);
					push(stored.summary.id);
					return { t: "spar-again", reqId: request.reqId, run: fresh };
				}
				case "spar-excerpt": {
					const stored = ready(request.id);
					const part = stored.spar.parts[request.part];
					if (part === undefined) throw new Error(`The spar has no part ${request.part}.`);
					return {
						t: "spar-excerpt",
						reqId: request.reqId,
						excerpts: request.refs.map(ref => {
							if (ref.path === SPAR_DESIGN_PATH)
								return stored.docText === undefined ? null : designExcerpt(ref, stored.docText);
							return excerptOf(ref, ref.side === "base" ? part.base : part.head);
						}),
					};
				}
				case "spar-delete": {
					const stored = spars.get(request.id);
					clearInterval(stored?.timer);
					spars.delete(request.id);
					push(request.id);
					return { t: "spar-delete", reqId: request.reqId };
				}
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
