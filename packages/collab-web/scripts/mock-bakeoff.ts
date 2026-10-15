/**
 * The `bakeoff-*` requests for scripts/mock-companion.ts, so the design bake-off can be tried in a browser, built like
 * ./mock-spar and reading the code behind every citation from the same small repository ("interfold") ./mock-quiz embeds.
 *
 * Canned bake-offs: `bk-mock-split`, a finished design bake-off (the original and two challengers) whose reviewer and
 * judge disagree about the best entry (a split verdict, with pairwise answers, two reviewer passes, an entry written by
 * the reviewer's own model and a finding that could not be checked against code); `bk-mock-nojudge`, a finished design
 * bake-off whose judge could not be reached (reviewer only); `bk-mock-impl`, a finished implementation bake-off (the
 * original and three challengers with facts: files, lines, tests, a benchmark; one entry fails its tests, one changed
 * the test script, one has uncommitted changes); `bk-mock-running`, a design bake-off part way through its entries whose
 * progress ticks until it turns ready; and `bk-mock-failed`, a design bake-off whose review failed (Review again works).
 *
 * What a person takes out: the implementation bake-offs answer `bakeoff-patch` with a canned patch per entry (one carries a
 * binary file) and mark `entries[].patch` on `bakeoff-get` (capability `canBakeoffPatch`). `bk-mock-impl-pruned` has lost
 * the code of three challengers (its patch buttons are off, with the reason) and its entry D's patch is over the size cap.
 * `bk-mock-folder` is a finished design bake-off of the scratch folder of the session without a project (`fhe-statistics`,
 * run `mock-companion.ts --topic`): a folder that is not a git repository lists and starts design bake-offs only
 * (`canBakeoffFolder`, `bakeoff-folder`), reading the notes of ./mock-quiz's topic files.
 *
 * A bake-off started from the form (`bakeoff-create`) is checked by the real engine's rules (`checkBakeoffCreate`), then
 * ticks through its stages and turns ready with a verdict built from the request's models and metrics: the entries
 * go waiting, working, writing-up, ready one at a time (an implementation: working, ready, then facts and write-ups), then
 * the reviewer reads and the judge answers. About 3 s per challenger and 2 s more at the default stage length. A model
 * ending in `/fail` makes its entry fail (it is left out of the review), the reviewer `mock/fail` fails the review once.
 *
 * Every entry's code is read from the fixture, so a citation cannot point at a line that is not there. `bakeoff-judge`
 * answers per the `judge` option (the mock companion's `--bakeoff-judge`): `native`, `local`, `endpoint` (default, a usable
 * `laya/mock-judge`), `fallback` (a general model: used only when the request says `judgeAdvisory`), `none` or
 * `unreachable`; a bake-off started while it is not usable ends with no second opinion. Unlike the real companion it does
 * not refuse a second bake-off while one runs.
 */

import type {
	Bakeoff,
	BakeoffEntry,
	BakeoffEntryStatus,
	BakeoffFacts,
	BakeoffFinding,
	BakeoffFolder,
	BakeoffJudgeInfo,
	BakeoffJudgeState,
	BakeoffMetric,
	BakeoffMode,
	BakeoffPair,
	BakeoffRanked,
	BakeoffResult,
	BakeoffScore,
	BakeoffStage,
	BakeoffSummary,
	BakeoffTakeResult,
	BakeoffWriteup,
} from "@oh-my-pi/pi-wire/bakeoff";
import { BAKEOFF_LABELS, BAKEOFF_MAX_PATCH_BYTES, BAKEOFF_VERSION, isMeasuredMetric } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintExcerpt, BlueprintExcerptRef, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { CompanionReply, CompanionRequest, RunTarget } from "../src/lib/companion";
import { checkBakeoffCreate } from "./companion-bakeoff";
import { TOPIC_CWD } from "./fixture-topic";
import { cite, excerptOf, MOCK_QUIZ_ROOT, mockQuizFolder, NOTES, STATS, TOPIC_FILES } from "./mock-quiz";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REPO = { root: MOCK_QUIZ_ROOT, name: "interfold", github: "example/interfold" };
const HEAD_COMMIT = "9c0e5f3b7a14d82e6f0a3c5b1d97e4286a0f3b51";
const BASE_COMMIT = "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22";
const DOC_NAME = "provider-cache-design.md";
const REVIEWER = "anthropic/claude-sonnet-5-5";
const JUDGE_LABEL = "laya/mock-judge";
const FAIL_MODEL = "mock/fail";
const STAGE_ORDER: readonly BakeoffStage[] = ["preparing", "entries", "facts", "writeups", "review", "judge", "done"];

export type MockBakeoffJudge = "native" | "local" | "endpoint" | "fallback" | "none" | "unreachable";

/** What `run-targets` answers in the mock companion: the targets the bake-off form offers as its test and benchmark. */
export const MOCK_RUN_TARGETS: RunTarget[] = [
	{ id: "package:test", source: "package", name: "test", command: "bun run test", detail: "bun test test/" },
	{
		id: "package:bench",
		source: "package",
		name: "bench",
		command: "bun run bench",
		detail: "bun run scripts/bench.ts",
	},
	{ id: "cargo:test", source: "cargo", name: "test", command: "cargo test" },
];

const PC = "crates/evm/src/provider_cache.rs";
const ER = "crates/evm/src/event_reader.rs";
const BUS = "crates/events/src/bus.rs";
const HELPERS = "crates/evm/src/helpers.rs";

/** What an entry is made of, whether it is a design or a change: the write-up the writer would fill, and what the reviewer says of it. */
interface Idea {
	summary: string;
	approach: string;
	tradeoffs: string[];
	risks: string[];
	migration: string;
	/** One line of evidence per preset a person may have chosen. */
	metrics: Record<string, string>;
	diagram?: string;
	refs: BlueprintRef[];
	strength: string;
	weakness: string;
	/** Implementation ideas: what measuring the entry found. */
	facts?: BakeoffFacts;
	flags?: string[];
}

/** The ideas of design entries: the first is the original's, the others the challengers', in order. */
const DESIGN_IDEAS: Idea[] = [
	{
		summary: "One provider per chain, built on first use and shared by every reader.",
		approach:
			"Readers ask a shared cache for the provider of their chain. The first caller connects; later callers get the same connection.\n\nThe cache is one map behind a read-write lock, so reads do not block each other.",
		tradeoffs: ["One type and one map", "Every reader waits for the first connection of a chain"],
		risks: ["A provider that dropped its connection stays in the map until the process restarts"],
		migration: "Replace each call that builds a provider with a call to the cache. No settings change.",
		metrics: {
			simplicity: "One type, one map, one lock.",
			performance: "One connection per chain, shared by all readers.",
			"fewer-parts": "No new files beyond the cache itself.",
			"migration-risk": "Each caller changes one line; roll back by restoring the old helper.",
		},
		diagram: "flowchart LR\n  Reader --> Cache\n  Cache -->|first use| Provider\n  Cache -->|later| Provider",
		refs: [cite(PC, "pub struct ProviderCache"), cite(PC, "pub async fn get")],
		strength: "The cache is small and the lookup path is easy to follow.",
		weakness: "A provider whose connection broke is never replaced.",
	},
	{
		summary: "The same shared cache, plus a check that replaces a provider that stopped answering.",
		approach:
			"Keep one provider per chain, as the original does, and have `get` ask the cached provider for the block number before it returns it.\n\nA provider that fails the check is dropped and rebuilt, once, before the error reaches the reader.",
		tradeoffs: ["Survives a dropped connection without a restart", "One extra request per lookup"],
		risks: ["The check can hide a flaky endpoint behind silent reconnects"],
		migration: "Same callers as the original; the check ships behind a setting that starts off.",
		metrics: {
			simplicity: "The original plus one branch; a reader still sees only `get`.",
			performance: "One extra round trip per lookup unless the check is cached for a few seconds.",
			"fewer-parts": "One new setting and no new types.",
			"migration-risk": "The check is off at first, so turning it on is the only step to undo.",
		},
		diagram:
			"sequenceDiagram\n  Reader->>Cache: get(chain)\n  Cache->>Provider: block number?\n  Provider-->>Cache: no answer\n  Cache->>Provider: reconnect",
		refs: [cite(PC, "pub async fn get"), cite(PC, "ProviderBuilder::new().connect")],
		strength: "It fixes the one real weakness of the shared cache and keeps its shape.",
		weakness: "The lookup path now has two failure modes that a reader cannot tell apart.",
	},
	{
		summary: "A small pool of providers per chain, handed out in turn.",
		approach:
			"Each chain gets a few providers instead of one. `get` returns the next one in turn, so one slow request does not hold up the others.\n\nThe pool grows to its size on demand and never shrinks.",
		tradeoffs: ["Spreads load across connections", "More connections to the endpoint, which may rate-limit"],
		risks: ["Pool size needs tuning per endpoint", "A broken provider in the pool is still handed out"],
		migration: "Callers are unchanged; the pool size defaults to one, which behaves like the original.",
		metrics: {
			simplicity: "A counter and a vector where the original had a single value.",
			performance: "Best under load: requests no longer queue behind one connection.",
			"fewer-parts": "One new setting for the pool size.",
			"migration-risk": "A size of one is the old behaviour, so the first release changes nothing.",
		},
		diagram: "flowchart LR\n  Reader --> Pool\n  Pool --> P1[Provider 1]\n  Pool --> P2[Provider 2]",
		refs: [cite(PC, "providers: RwLock<HashMap"), cite(ER, "cache.get(chain_id")],
		strength: "It is the only entry that helps when many readers hit one chain at once.",
		weakness: "It adds a tuning knob and still never replaces a broken provider.",
	},
	{
		summary: "No shared state: each reader builds and owns its provider.",
		approach:
			"Drop the cache. A reader connects when it attaches and keeps its provider for its lifetime, as the helper that exists today does.\n\nNothing is shared, so nothing can be stale or locked.",
		tradeoffs: ["No locking and no stale entries", "One connection per reader instead of per chain"],
		risks: ["Endpoints that limit connections per client will refuse the extra ones"],
		migration: "Nothing to migrate: this is the code before the cache.",
		metrics: {
			simplicity: "The simplest of all: there is nothing to explain.",
			performance: "The most connections, and a connect cost for every reader.",
			"fewer-parts": "Removes the cache type altogether.",
			"migration-risk": "No change to roll out, but it undoes work other designs depend on.",
		},
		refs: [cite(ER, "pub async fn attach"), cite(HELPERS, "pub async fn create_provider", "base")],
		strength: "It has no moving parts to break.",
		weakness: "It throws away the reason the cache was written: connections per chain.",
	},
	{
		summary: "An actor owns the providers, so the lock goes away.",
		approach:
			"Move the map into an actor that readers message. The actor builds a provider on the first request for a chain and answers later ones from its own map.\n\nThe event bus is already an actor, so readers know the pattern.",
		tradeoffs: ["No lock to reason about", "Every lookup is a message, even a cached one"],
		risks: ["A slow connect blocks every other chain's lookups unless the actor spawns the connect"],
		migration: "Callers change from a method call to a message; the cache type is replaced.",
		metrics: {
			simplicity: "Familiar from the event bus, but it adds a message type and a mailbox.",
			performance: "A message per lookup is slower than a read lock.",
			"fewer-parts": "Adds an actor and a message; removes the lock.",
			"migration-risk": "Every caller changes, so the rollback is a larger revert.",
		},
		refs: [cite(BUS, "impl Actor for EventBus"), cite(ER, "bus: Addr<EventBus>")],
		strength: "It fits how the rest of the crate already passes work around.",
		weakness: "It turns a cheap lookup into a message round trip.",
	},
];

/** The ideas of design entries for a folder that is not a repository: the first is the pasted design's, the others the challengers'. */
const FOLDER_IDEAS: Idea[] = [
	{
		summary: "The server returns the sum and the sum of squares; the client divides and takes the variance.",
		approach:
			"Keep the protocol of the notes. The server adds the column and adds its squares, which costs one multiplication, and the client decrypts and divides by n.\n\nNothing is divided under encryption, so no level is spent on it.",
		tradeoffs: ["Uses one of the two levels", "The client does a little arithmetic"],
		risks: ["A column longer than the slot count needs several ciphertexts"],
		migration: "Nothing to migrate: this is the design the notes describe.",
		metrics: {
			simplicity: "Two server operations and a client that divides.",
			performance: "One multiplication, so a level to spare.",
			"fewer-parts": "No new parts.",
			"migration-risk": "Nothing runs yet, so there is nothing to roll back.",
		},
		refs: [cite(NOTES, "Dividing by n would cost a level"), cite(STATS, "def encrypted_stats")],
		strength: "It spends the single multiplication on the square and keeps a level for headroom.",
		weakness: "The client must know n, which the server never sees.",
	},
	{
		summary: "The server also divides, by multiplying with the plain 1/n.",
		approach:
			"Send n in the clear and let the server multiply the sums by 1/n, so the client decrypts the mean and the variance directly.\n\nThe two multiplications use both levels.",
		tradeoffs: ["The client has nothing to compute", "Both levels are spent"],
		risks: ["No headroom left if the parameters ever shrink", "n is no longer private from the server"],
		migration: "The server gains a step; the client loses one.",
		metrics: {
			simplicity: "The client is trivial, and the server does one more thing.",
			performance: "A second multiplication, and no level left.",
			"fewer-parts": "Moves a step from the client to the server.",
			"migration-risk": "Nothing runs yet.",
		},
		refs: [cite(NOTES, "One multiplication"), cite(STATS, "def decrypt_stats")],
		strength: "The client side shrinks to a decrypt.",
		weakness: "It uses up the headroom the notes keep on purpose.",
	},
	{
		summary: "BFV with the cents scaled to integers.",
		approach:
			"Scale every salary to cents and use BFV, which is exact, with a plaintext modulus large enough to hold the sums.\n\nThe mean is then exact up to the final division on the client.",
		tradeoffs: ["Exact sums, no approximation error", "A larger plaintext modulus and larger ciphertexts"],
		risks: ["The modulus must be chosen for the largest sum, and growing the column may overflow it"],
		migration: "The context and the encoding change; the protocol does not.",
		metrics: {
			simplicity: "Another scheme to learn, though the protocol is the same.",
			performance: "Larger ciphertexts than CKKS for the same column.",
			"fewer-parts": "Adds a scaling step on both sides.",
			"migration-risk": "Nothing runs yet, but the notes would have to be rewritten.",
		},
		refs: [cite(NOTES, "BFV would need the cents scaled")],
		strength: "It removes the approximation the notes accept.",
		weakness: "It needs a modulus the notes already rejected as too large.",
	},
];

/** The ideas of implementation entries: the first is the original's change, the others the challengers' changes. */
const IMPL_IDEAS: Idea[] = [
	{
		summary: "A provider cache keyed by chain id, shared by every reader.",
		approach: "A `ProviderCache` holds a map of chain id to provider behind a read-write lock; readers call `get`.",
		tradeoffs: ["Readable and tested", "Takes the write lock on every miss"],
		risks: ["Two readers that miss at once both connect"],
		migration: "Every caller of the old helper now takes the cache.",
		metrics: {
			simplicity: "One type, one map, one lock.",
			performance: "Cached lookups take a read lock only.",
			"lines-changed": "118 lines added and 22 removed across 4 files.",
		},
		refs: [cite(PC, "pub async fn get"), cite(PC, "pub struct ProviderCache")],
		strength: "The code is plain and every caller passes the cache the same way.",
		weakness: "Two readers that miss together both build a provider; one is thrown away.",
		facts: {
			files: 4,
			added: 118,
			removed: 22,
			tests: { target: "package:test", ok: true },
			bench: { target: "package:bench", better: "lower", runs: [214, 209, 211], value: 211, unit: "ms" },
		},
	},
	{
		summary: "The same cache, trimmed: the lock is taken once and the connect happens under it.",
		approach:
			"`get` takes the write lock before it looks, so only one reader connects per chain; the helper file goes.",
		tradeoffs: ["Smaller change", "Lookups of cached chains now wait for a connect on another chain"],
		risks: ["A slow endpoint blocks every chain"],
		migration: "Same callers as the original; one file fewer.",
		metrics: {
			simplicity: "The fewest branches of the entries: one lock, one path.",
			performance: "No duplicate connects, but a connect blocks every chain.",
			"lines-changed": "71 lines added and 24 removed across 3 files.",
		},
		refs: [cite(PC, "providers: RwLock<HashMap"), cite(ER, "cache.get(chain_id")],
		strength: "It is the smallest change that stops duplicate connections.",
		weakness: "A slow connect holds the lock, so one chain can stall the rest.",
		facts: {
			files: 3,
			added: 71,
			removed: 24,
			deltaFromOriginal: { files: 1, added: 47, removed: 2 },
			tests: { target: "package:test", ok: true },
			bench: { target: "package:bench", better: "lower", runs: [188, 191, 187], value: 188, unit: "ms" },
		},
	},
	{
		summary: "A cache that connects outside the lock and keeps the first provider that arrives.",
		approach:
			"`get` reads under a read lock, connects with no lock held and inserts only if the chain is still empty.",
		tradeoffs: ["No blocking connects", "Duplicate connects are possible and dropped"],
		risks: ["The insert races with a reader on another thread"],
		migration: "Same callers as the original.",
		metrics: {
			simplicity: "Two lock scopes to keep straight.",
			performance: "Connects never block cached lookups.",
			"lines-changed": "96 lines added and 30 removed across 4 files.",
		},
		refs: [cite(PC, "insert(chain_id"), cite(PC, "if let Some(found)")],
		strength: "Cached lookups never wait for a connect.",
		weakness: "Its tests do not pass: three of them time out waiting for the insert.",
		facts: {
			files: 4,
			added: 96,
			removed: 30,
			deltaFromOriginal: { files: 0, added: 21, removed: 8 },
			tests: { target: "package:test", ok: false, reason: "3 tests failed" },
			bench: { target: "package:bench", better: "lower", runs: [172, 169, 175], value: 172, unit: "ms" },
		},
	},
	{
		summary: "Readers keep their provider and the cache only remembers the endpoint.",
		approach: "The cache stores the rpc url per chain; each reader connects on attach and owns its provider.",
		tradeoffs: ["No lock on the hot path", "More connections"],
		risks: ["Endpoints may limit connections per client"],
		migration: "Callers pass the url lookup instead of the provider.",
		metrics: {
			simplicity: "Fewer states, but the idea is harder to explain than a cache.",
			performance: "One connection per reader.",
			"lines-changed": "64 lines added and 40 removed across 3 files.",
		},
		refs: [cite(ER, "pub async fn attach"), cite(PC, "ProviderBuilder::new().connect")],
		strength: "There is no shared lock on the hot path.",
		weakness: "It edited the test script, so its test result cannot be compared with the others.",
		facts: {
			files: 3,
			added: 64,
			removed: 40,
			deltaFromOriginal: { files: 1, added: 14, removed: 20 },
			tests: {
				target: "package:test",
				ok: true,
				note: "The test script was changed in this entry, so the result is not comparable.",
			},
			bench: { target: "package:bench", better: "lower", runs: [240, 236, 244], value: 240, unit: "ms" },
		},
		flags: ["test script changed"],
	},
	{
		summary: "The cache returns a lazily connected provider.",
		approach: "`get` returns at once with a provider that connects on its first request.",
		tradeoffs: ["Fast `get`", "The first request pays the connect and can fail"],
		risks: ["Errors move from `get` to the first use"],
		migration: "Callers handle errors later than they did.",
		metrics: {
			simplicity: "A wrapper type for the lazy connect.",
			performance: "`get` never waits.",
			"lines-changed": "88 lines added and 19 removed across 4 files.",
		},
		refs: [cite(PC, "pub async fn get"), cite(ER, "pub async fn attach")],
		strength: "`get` never waits for the network.",
		weakness: "Errors surface far from the call that caused them.",
		facts: {
			files: 4,
			added: 88,
			removed: 19,
			deltaFromOriginal: { files: 0, added: 6, removed: 3 },
			tests: { target: "package:test", ok: true },
			bench: { target: "package:bench", better: "lower", runs: [199, 204, 201], value: 201, unit: "ms" },
		},
	},
];

// ── result building ──────────────────────────────────────────────────────────

interface Judging {
	label: string;
	kind: BakeoffJudgeState;
	/** The judge's ranking, best first. */
	order: string[];
	/** False for an advisory judge, whose pairwise answers count but whose scores do not. */
	scores: boolean;
	advisory: boolean;
	/** Whether the judge contradicted itself on one pair. */
	inconsistent: boolean;
}

interface Plan {
	/** By entry label. */
	ideas: Map<string, Idea>;
	/** The reviewer's ranking, best first, over the entries that finish. */
	order: string[];
	judging?: Judging;
	judgeNote?: string;
	passes: 1 | 2;
	unsure: string[];
	/** Labels whose weakness the code did not bear out. */
	unverified: string[];
	/** Labels of challengers that fail. */
	failing: Set<string>;
	/** Labels of worktrees with uncommitted changes, which a keep may not remove without `discardDirty`. */
	dirty: Set<string>;
	failReview: boolean;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function evidence(idea: Idea, metric: BakeoffMetric): string {
	return idea.metrics[metric.id] ?? (metric.text ? `Against "${metric.text}": ${idea.summary}` : idea.summary);
}

function writeupOf(idea: Idea, metrics: BakeoffMetric[]): BakeoffWriteup {
	const writeup: BakeoffWriteup = {
		summary: idea.summary,
		approach: idea.approach,
		tradeoffs: [...idea.tradeoffs],
		risks: [...idea.risks],
		migration: idea.migration,
		metrics: Object.fromEntries(metrics.map(metric => [metric.id, evidence(idea, metric)])),
		refs: idea.refs.map(ref => ({ ...ref })),
	};
	if (idea.diagram !== undefined) writeup.diagram = idea.diagram;
	return writeup;
}

const sizeOf = (entry: BakeoffEntry | undefined): number =>
	entry?.facts ? entry.facts.added + entry.facts.removed : 0;

/** The verdict the mock reviewer and judge give: built from the entries and the order they ranked them in, so it is repeatable. */
function resultFor(input: {
	entries: BakeoffEntry[];
	ideas: Map<string, Idea>;
	metrics: BakeoffMetric[];
	reviewer: string;
	plan: Plan;
}): BakeoffResult {
	const { entries, ideas, metrics, reviewer, plan } = input;
	const { order, judging } = plan;
	const byLabel = new Map(entries.map(entry => [entry.label, entry]));
	const entryOf = (label: string): BakeoffEntry => byLabel.get(label)!;
	const ideaOf = (label: string): Idea => ideas.get(label)!;
	/** A 1–5 score by position in a ranking, as 0–1: the top scores 5, and the later a score the more a metric spreads it. */
	const graded = (position: number, metric: number): number =>
		(Math.max(1, 5 - position * (metric % 2 === 0 ? 1 : 0.5)) - 1) / 4;
	const hasBench = order.every(label => typeof entryOf(label).facts?.bench?.value === "number");
	const measured = (metric: BakeoffMetric, label: string): number | undefined => {
		if (!isMeasuredMetric(metric, hasBench)) return undefined;
		if (metric.id === "lines-changed") {
			const sizes = order.map(item => sizeOf(entryOf(item)));
			return round(Math.min(...sizes) / Math.max(1, sizeOf(entryOf(label))));
		}
		const values = order.map(item => entryOf(item).facts!.bench!.value!);
		const value = entryOf(label).facts!.bench!.value!;
		return round(
			entryOf(label).facts!.bench!.better === "lower" ? Math.min(...values) / value : value / Math.max(...values),
		);
	};
	const scores: BakeoffResult["scores"] = {};
	const totals = new Map<string, number>();
	const weights = metrics.reduce((sum, metric) => sum + metric.weight, 0);
	for (const label of order) {
		const row: Record<string, BakeoffScore> = {};
		let total = 0;
		metrics.forEach((metric, at) => {
			const reviewerScore = graded(order.indexOf(label), at);
			const score: BakeoffScore = { reviewer: reviewerScore };
			let base = reviewerScore;
			if (judging?.scores) {
				score.judge = graded(judging.order.indexOf(label), at);
				base = reviewerScore * 0.6 + score.judge * 0.4;
			}
			const own = measured(metric, label);
			if (own !== undefined) score.measured = own;
			score.combined = round(own === undefined ? base : (base + own) / 2);
			row[metric.id] = score;
			total += score.combined * metric.weight;
		});
		scores[label] = row;
		totals.set(label, round(total / weights));
	}
	const originalPasses = entries.find(entry => entry.kind === "original")?.facts?.tests?.ok === true;
	const ranking: BakeoffRanked[] = [...order]
		.sort((a, b) => totals.get(b)! - totals.get(a)! || order.indexOf(a) - order.indexOf(b))
		.map((label, at) => {
			const entry = entryOf(label);
			const byWeight = [...metrics].sort((a, b) => b.weight - a.weight).slice(0, 2);
			const reasons = byWeight.map(metric => `${metric.label}: ${evidence(ideaOf(label), metric)}`);
			const tests = entry.facts?.tests;
			if (tests !== undefined)
				reasons.push(
					tests.ok === true
						? "Tests pass."
						: tests.ok === false
							? `Tests fail${tests.reason ? ` (${tests.reason})` : ""}.`
							: "Tests did not finish.",
				);
			return {
				label,
				rank: at + 1,
				score: totals.get(label)!,
				reasons,
				eligible: !(tests?.ok === false && originalPasses),
				flags: [...entry.flags],
			};
		});
	const cite0 = (label: string, at: number): string => {
		const ref = ideaOf(label).refs[at] ?? ideaOf(label).refs[0]!;
		return `\`${label}/${ref.path}@${ref.line}@${ref.token}\``;
	};
	const verdictOf = (ranked: string[], second: boolean): string =>
		[
			second
				? `Read again with the entries in the reverse order and new letters, the ranking is ${ranked.map(label => `Entry ${label}`).join(", then ")}.`
				: `The ranking is ${ranked.map(label => `Entry ${label}`).join(", then ")}.`,
			...ranked.map((label, at) => {
				const place = at === 0 ? "is the best" : at === ranked.length - 1 ? "comes last" : "is in the middle";
				return `**Entry ${label}** ${place}. ${ideaOf(label).strength} ${cite0(label, 0)} ${ideaOf(label).weakness} ${cite0(label, 1)}`;
			}),
		].join("\n\n");
	const findings: BakeoffFinding[] = order.flatMap((label): BakeoffFinding[] => {
		const idea = ideaOf(label);
		const unverified = plan.unverified.includes(label);
		return [
			{ label, kind: "strength", text: idea.strength, refs: idea.refs.slice(0, 1), verified: true },
			unverified
				? { label, kind: "weakness", text: idea.weakness, verified: false }
				: { label, kind: "weakness", text: idea.weakness, refs: idea.refs.slice(1), verified: true },
		];
	});
	const result: BakeoffResult = {
		ranking,
		verdict: verdictOf(order, false),
		findings,
		scores,
		agreement: judging === undefined ? "reviewer-only" : judging.order[0] === order[0] ? "agreed" : "split",
		reviewerModel: reviewer,
		selfPreference: order.filter(label => entryOf(label).model === reviewer),
		unsure: [...plan.unsure],
	};
	if (plan.passes === 2)
		result.passes = [
			{ ranking: [...order], verdict: result.verdict },
			{ ranking: [...order], verdict: verdictOf(order, true) },
		];
	if (judging === undefined) {
		if (plan.judgeNote !== undefined) result.judgeNote = plan.judgeNote;
		return result;
	}
	result.judgeLabel = `${judging.advisory ? "advisory" : judging.kind === "native" ? "judge model" : "prompted judge"}: ${judging.label}`;
	result.judgeKind = judging.kind;
	const pairs: BakeoffPair[] = [];
	const labels = [...order].sort();
	for (let a = 0; a < labels.length; a++)
		for (let b = a + 1; b < labels.length; b++)
			for (const metric of metrics.slice(0, 2)) {
				const first = labels[a]!;
				const second = labels[b]!;
				const winner = judging.order.indexOf(first) < judging.order.indexOf(second) ? first : second;
				pairs.push({ a: first, b: second, metric: metric.id, winner, consistent: true });
			}
	if (judging.inconsistent && pairs.length > 1) Object.assign(pairs[1]!, { winner: "tie", consistent: false });
	result.pairwise = pairs;
	result.consistency = round(pairs.filter(pair => pair.consistent).length / pairs.length);
	if (result.agreement === "split") {
		const own = result.selfPreference.includes(order[0]!)
			? ` Entry ${order[0]} was written by the reviewer's own model, so its lead deserves a second look.`
			: "";
		result.splitNote = `The reviewer put Entry ${order[0]} first and the judge put Entry ${judging.order[0]} first.${own} The reviewer's order stands because its margin is wider; read both entries before you choose.`;
	}
	return result;
}

// ── building a bake-off ──────────────────────────────────────────────────────

interface EntrySpec {
	label: string;
	kind: "original" | "challenger";
	model?: string;
	status: BakeoffEntryStatus;
	idea: Idea;
}

interface Spec {
	id: string;
	title: string;
	subject: string;
	createdAt: number;
	mode: BakeoffMode;
	metrics: BakeoffMetric[];
	reviewer: string;
	judge: "auto" | "off";
	instructions?: string;
	entries: EntrySpec[];
	/** Where the run is; `done` builds the verdict too. */
	stage: BakeoffStage;
	status: BakeoffSummary["status"];
	plan: Plan;
	error?: string;
	progress?: string;
	maxCostUsd?: number;
	/** The reviewed branch of the original, for an implementation. */
	ref?: string;
	/** A bake-off of a folder that is not a git repository: its path, as the list files it. */
	folder?: true;
	root?: string;
	/** For an implementation: whether the code of the entries is still kept (`kept`, the default) or was pruned. */
	code?: "kept" | "pruned";
}

const stageAt = (stage: BakeoffStage): number => STAGE_ORDER.indexOf(stage);

function entryFrom(spec: Spec, entry: EntrySpec, index: number): BakeoffEntry {
	const impl = spec.mode === "implementation";
	const stage = stageAt(spec.stage);
	const out: BakeoffEntry = { label: entry.label, kind: entry.kind, status: entry.status, flags: [] };
	if (entry.model !== undefined) out.model = entry.model;
	if (impl) {
		const slug = entry.label.toLowerCase();
		if (entry.kind === "original") {
			out.branch = spec.ref ?? "feature/event-replay";
			out.path = MOCK_QUIZ_ROOT;
		} else {
			out.instanceId = `inst-${spec.id}-${slug}`;
			out.branch = `bakeoff/${spec.id}/${slug}`;
			out.path = `/work/worktrees/interfold-${spec.id}-${slug}`;
		}
	}
	const finished = entry.status === "ready";
	if (finished && entry.kind === "challenger") out.costUsd = round(0.31 + 0.07 * index);
	if (finished && (impl ? stage >= stageAt("writeups") : true)) out.writeup = writeupOf(entry.idea, spec.metrics);
	if (finished && impl && stage >= stageAt("facts") && entry.idea.facts !== undefined) {
		out.facts = structuredClone(entry.idea.facts);
		out.flags = [...(entry.idea.flags ?? [])];
	}
	if (entry.status === "failed") {
		out.error = impl
			? "The session ended before it made a change."
			: "The session ended before it produced a design.";
		if (!impl) out.flags = ["no write-up"];
	}
	return out;
}

/** The costs a bake-off has run up so far, from what has been done. */
function costsOf(bakeoff: Bakeoff): Bakeoff["costs"] {
	const written = bakeoff.entries.filter(entry => entry.writeup !== undefined).length;
	const stage = stageAt(bakeoff.stage);
	return {
		entries: round(bakeoff.entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)),
		writeups: round(bakeoff.mode === "design" ? (written > 0 ? 0.07 : 0) : written * 0.05),
		review: stage < stageAt("review") ? 0 : bakeoff.result ? 0.31 : 0.12,
		judge: bakeoff.result?.judgeLabel !== undefined ? 0.04 : stage === stageAt("judge") ? 0.02 : 0,
	};
}

function build(spec: Spec): Bakeoff {
	const entries = spec.entries.map((entry, index) => entryFrom(spec, entry, index));
	const ideas = new Map(spec.entries.map(entry => [entry.label, entry.idea]));
	const bakeoff: Bakeoff = {
		v: BAKEOFF_VERSION,
		id: spec.id,
		title: spec.title,
		repo: { ...REPO },
		createdAt: spec.createdAt,
		mode: spec.mode,
		metrics: spec.metrics.map(metric => ({ ...metric })),
		entries,
		stage: spec.stage,
		warnings: [],
		reviewer: spec.reviewer,
		writer: "@default",
		judge: spec.judge,
		costs: { entries: 0, writeups: 0, review: 0, judge: 0 },
	};
	if (spec.mode === "implementation") {
		bakeoff.start = "original";
		bakeoff.group = `fo-${spec.id}`;
	}
	if (spec.folder) {
		bakeoff.folder = true;
		bakeoff.repo = { root: spec.root!, name: folderOf(spec.root!).name };
	}
	if (spec.instructions !== undefined) bakeoff.instructions = spec.instructions;
	if (spec.stage === "done")
		bakeoff.result = resultFor({ entries, ideas, metrics: spec.metrics, reviewer: spec.reviewer, plan: spec.plan });
	bakeoff.costs = costsOf(bakeoff);
	return bakeoff;
}

function summaryOf(spec: Spec, bakeoff: Bakeoff): BakeoffSummary {
	const summary: BakeoffSummary = {
		id: spec.id,
		title: spec.title,
		repoRoot: spec.root ?? MOCK_QUIZ_ROOT,
		subject: spec.subject,
		createdAt: spec.createdAt,
		status: spec.status,
		mode: spec.mode,
		stage: bakeoff.stage,
		maxCostUsd: spec.maxCostUsd ?? 12,
	};
	if (spec.progress !== undefined) summary.progress = spec.progress;
	if (spec.error !== undefined) summary.error = spec.error;
	return summary;
}

// ── what can be taken out ────────────────────────────────────────────────────

const GONE = "The code of this entry is no longer kept on this computer, so there is nothing to export.";
/** The entry of the pruned bake-off whose patch is over the cap. */
const OVERSIZE_LABEL = "D";

/** The folder a mock companion finds at `cwd`: a scratch folder is no git repository and holds the notes of its session. */
function folderOf(cwd: string): BakeoffFolder {
	const found = mockQuizFolder(cwd);
	return { git: found.git, files: found.git ? 0 : Object.keys(TOPIC_FILES).length, name: found.name };
}

/** The root a bake-off of `cwd` is listed under: the fixture repository, or the scratch folder itself. */
const rootOf = (cwd: string): string => (folderOf(cwd).git ? MOCK_QUIZ_ROOT : cwd);

/** Whether an entry's code can still be exported, as `bakeoff-get` tells; absent for a design and before the entries were made. */
function patchStateOf(item: Stored, entry: BakeoffEntry): BakeoffEntry["patch"] {
	if (item.bakeoff.mode !== "implementation" || stageAt(item.bakeoff.stage) < stageAt("facts")) return undefined;
	return item.spec.code === "pruned" && entry.kind === "challenger" && entry.label !== OVERSIZE_LABEL
		? { ok: false, reason: GONE }
		: { ok: true };
}

/** A file added, as `git diff --binary --full-index` writes it. */
function added(path: string, lines: string[], mode = "100644"): string {
	return [
		`diff --git a/${path} b/${path}`,
		`new file mode ${mode}`,
		`index ${"0".repeat(40)}..${"b".repeat(40)}`,
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map(line => `+${line}`),
		"",
	].join("\n");
}

/** One hunk that replaces `removed` with `inserted` between lines of context. */
function changed(
	path: string,
	at: number,
	lead: string[],
	removed: string[],
	inserted: string[],
	trail: string[],
): string {
	return [
		`diff --git a/${path} b/${path}`,
		`index ${"a".repeat(40)}..${"c".repeat(40)} 100644`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -${at},${lead.length + removed.length + trail.length} +${at},${lead.length + inserted.length + trail.length} @@`,
		...lead.map(line => ` ${line}`),
		...removed.map(line => `-${line}`),
		...inserted.map(line => `+${line}`),
		...trail.map(line => ` ${line}`),
		"",
	].join("\n");
}

/** A 12-byte file as `git diff --binary` carries it. */
const BINARY_HUNK = [
	"diff --git a/docs/replay-flow.png b/docs/replay-flow.png",
	"new file mode 100644",
	`index ${"0".repeat(40)}..de37cb671741b5c50fcca24abb963423d1d399f2`,
	"GIT binary patch",
	"literal 12",
	"TcmeAS@N;MQ|BsQ0p`j4~9qt5h",
	"",
	"literal 0",
	"HcmV?d00001",
	"",
	"",
].join("\n");

/** The patch an implementation entry would give: its change to the provider cache, a test, and for one idea a picture. */
function patchText(entry: EntrySpec): string {
	const at = IMPL_IDEAS.indexOf(entry.idea);
	const note = `// ${entry.idea.summary}`;
	return [
		changed(
			PC,
			12,
			["use tokio::sync::RwLock;", ""],
			["pub struct ProviderCache {", "    providers: HashMap<u64, Provider>,"],
			[note, "pub struct ProviderCache {", "    providers: RwLock<HashMap<u64, Provider>>,"],
			["}", ""],
		),
		added("crates/evm/tests/provider_cache.rs", [
			"use evm::ProviderCache;",
			"",
			"#[tokio::test]",
			`async fn variant_${at}_shares_one_connection_per_chain() {`,
			"    let cache = ProviderCache::default();",
			"    assert!(cache.get(1).await.is_ok());",
			"}",
		]),
		...(at === 0 ? [BINARY_HUNK] : []),
	].join("");
}

// ── canned bake-offs ─────────────────────────────────────────────────────────

const SIMPLICITY: BakeoffMetric = { id: "simplicity", label: "Simplicity", weight: 2 };
const PERFORMANCE: BakeoffMetric = { id: "performance", label: "Performance", weight: 2 };
const FEWER: BakeoffMetric = { id: "fewer-parts", label: "Fewer moving parts", weight: 1 };
const RISK: BakeoffMetric = { id: "migration-risk", label: "Migration risk", weight: 3 };
const LINES: BakeoffMetric = { id: "lines-changed", label: "Lines changed", weight: 1 };

const ready = (label: string, kind: EntrySpec["kind"], idea: Idea, model?: string): EntrySpec => ({
	label,
	kind,
	idea,
	status: "ready",
	...(model === undefined ? {} : { model }),
});

const noPlan = (): Plan => ({
	ideas: new Map(),
	order: [],
	passes: 1,
	unsure: [],
	unverified: [],
	failing: new Set(),
	dirty: new Set(),
	failReview: false,
});

/** The plan of a spec: the ideas of its entries and a ranking over the entries that are or will be ready. */
function planOf(entries: EntrySpec[], rest: Partial<Plan>): Plan {
	return { ...noPlan(), ideas: new Map(entries.map(entry => [entry.label, entry.idea])), ...rest };
}

const CANNED_UNSURE = ["Whether the shared cache holds up when two readers reconnect at once: no entry tested it."];

// ── the mock ─────────────────────────────────────────────────────────────────

interface Stored {
	spec: Spec;
	summary: BakeoffSummary;
	bakeoff: Bakeoff;
	timer?: NodeJS.Timeout;
}

export interface MockBakeoff {
	/** Fields the mock companion's `hosts` frame needs for the app to offer design bake-offs. */
	capabilities: { canBakeoff: true; canBakeoffPatch: true; canBakeoffFolder: true };
	handles(request: CompanionRequest): boolean;
	/** Answers are promises like the real companion's, though nothing here waits. */
	answer(request: CompanionRequest): Promise<CompanionReply>;
	/** Every bake-off timer stops. */
	stop(): void;
}

function judgeInfo(flag: MockBakeoffJudge): BakeoffJudgeInfo {
	switch (flag) {
		case "native":
			return { state: "native", label: "anthropic/claude-haiku-5", reachable: true };
		case "local":
			return { state: "local", label: "ollama/qwen3-8b", reachable: true };
		case "endpoint":
			return { state: "endpoint", label: JUDGE_LABEL, reachable: true };
		case "fallback":
			return {
				state: "fallback",
				label: "openai/gpt-mini",
				reachable: true,
				price: "$0.25 in, $2.00 out per million tokens",
			};
		case "unreachable":
			return { state: "endpoint", label: JUDGE_LABEL, reachable: false, reason: "connection refused" };
		case "none":
			return { state: "none", reason: "No judge model is set up on this computer." };
	}
}

export function createMockBakeoff(options: {
	/** A bake-off was added, changed or removed: pushed to every guest as `bakeoff-changed`. */
	onChanged(id: string): void;
	/** The omp session that a running bake-off is run by, so the app can offer to watch it. */
	instanceId: string;
	/** Milliseconds a step of a running bake-off lasts; tests make it short. */
	stageMs?: number;
	/** What `bakeoff-judge` answers, and so whether a new bake-off gets a second opinion. Default `endpoint`. */
	judge?: MockBakeoffJudge;
}): MockBakeoff {
	const stageMs = options.stageMs ?? 700;
	const judgeFlag = options.judge ?? "endpoint";
	const now = Date.now();
	const all = new Map<string, Stored>();
	let counter = 0;

	const push = (id: string): void => options.onChanged(id);

	/** Bring the summary up to date with the bake-off it describes. */
	const refresh = (stored: Stored): void => {
		const { summary, bakeoff } = stored;
		bakeoff.costs = costsOf(bakeoff);
		summary.stage = bakeoff.stage;
		summary.entryCount = bakeoff.entries.length;
		summary.costUsd = round(
			bakeoff.costs.entries + bakeoff.costs.writeups + bakeoff.costs.review + bakeoff.costs.judge,
		);
		summary.top = bakeoff.result?.ranking[0]?.label;
		summary.taken = bakeoff.result?.taken;
		summary.note = bakeoff.result?.judgeNote;
	};

	const put = (spec: Spec): Stored => {
		const bakeoff = build(spec);
		const stored: Stored = { spec, summary: summaryOf(spec, bakeoff), bakeoff };
		all.set(spec.id, stored);
		refresh(stored);
		return stored;
	};

	const reviewable = (bakeoff: Bakeoff): BakeoffEntry[] => bakeoff.entries.filter(entry => entry.status === "ready");

	const failRun = (stored: Stored, error: string): void => {
		clearInterval(stored.timer);
		stored.timer = undefined;
		Object.assign(stored.summary, { status: "failed", progress: undefined, instanceId: undefined, error });
		refresh(stored);
		push(stored.summary.id);
	};

	const entryNamed = (bakeoff: Bakeoff, label: string): BakeoffEntry => {
		const found = bakeoff.entries.find(entry => entry.label === label);
		if (found === undefined) throw new Error("There is no such entry.");
		return found;
	};

	/** The steps that take a run from where it is to done, one per tick. */
	const stepsFor = (stored: Stored): Array<() => void> => {
		const { bakeoff, spec } = stored;
		const { plan } = spec;
		const impl = bakeoff.mode === "implementation";
		const steps: Array<() => void> = [];
		const enter = (stage: BakeoffStage, progress: string): void => {
			bakeoff.stage = stage;
			stored.summary.progress = progress;
		};
		const ideaOf = (label: string): Idea => plan.ideas.get(label)!;
		const entriesText = impl ? "The challengers are working" : "The challengers are writing their designs";
		if (bakeoff.stage === "preparing")
			steps.push(() => {
				enter("entries", entriesText);
				const original = bakeoff.entries.find(entry => entry.kind === "original")!;
				original.status = "ready";
				if (!impl) original.writeup = writeupOf(ideaOf(original.label), bakeoff.metrics);
			});
		const challengers = bakeoff.entries.filter(entry => entry.kind === "challenger");
		const route: BakeoffEntryStatus[] = impl ? ["working", "ready"] : ["working", "writing-up", "ready"];
		challengers.forEach((entry, index) => {
			const at = entry.status === "waiting" ? 0 : route.indexOf(entry.status) + 1;
			for (const to of route.slice(at)) {
				steps.push(() => {
					if (entry.status === "stopped") return;
					if (to === "writing-up") enter("entries", "Writing up each entry in the same template");
					else enter("entries", entriesText);
					if (to === "ready" && plan.failing.has(entry.label)) {
						entry.status = "failed";
						entry.error = impl
							? "The session ended before it made a change."
							: "The session ended before it produced a design.";
						if (!impl) entry.flags = ["no write-up"];
						return;
					}
					entry.status = to;
					if (to !== "ready") return;
					entry.costUsd = round(0.31 + 0.07 * (index + 1));
					if (!impl) entry.writeup = writeupOf(ideaOf(entry.label), bakeoff.metrics);
				});
			}
		});
		if (impl && stageAt(bakeoff.stage) < stageAt("facts")) {
			steps.push(() => {
				enter("facts", "Measuring each entry");
				for (const entry of reviewable(bakeoff)) {
					const idea = ideaOf(entry.label);
					if (idea.facts !== undefined) entry.facts = structuredClone(idea.facts);
					entry.flags = [...(idea.flags ?? [])];
				}
			});
		}
		if (impl && stageAt(bakeoff.stage) < stageAt("writeups")) {
			steps.push(() => {
				enter("writeups", "Writing up each entry in the same template");
				for (const entry of reviewable(bakeoff)) entry.writeup = writeupOf(ideaOf(entry.label), bakeoff.metrics);
			});
		}
		steps.push(() => {
			if (reviewable(bakeoff).length < 2) return failRun(stored, "Fewer than two entries are left to compare.");
			enter("review", "The reviewer is reading every entry");
			if (plan.failReview) {
				plan.failReview = false;
				failRun(stored, "The reviewer's answer could not be read as a ranking.");
			}
		});
		if (plan.judging !== undefined) steps.push(() => enter("judge", "Asking the judge model for a second opinion"));
		steps.push(() => {
			const ranked = reviewable(bakeoff).map(entry => entry.label);
			const ideas = new Map(ranked.map(label => [label, ideaOf(label)]));
			const order = plan.order.filter(label => ranked.includes(label));
			const judging = plan.judging && {
				...plan.judging,
				order: plan.judging.order.filter(label => ranked.includes(label)),
			};
			bakeoff.result = resultFor({
				entries: reviewable(bakeoff),
				ideas,
				metrics: bakeoff.metrics,
				reviewer: bakeoff.reviewer,
				plan: { ...plan, order, judging },
			});
			bakeoff.stage = "done";
			Object.assign(stored.summary, {
				status: "ready",
				progress: undefined,
				instanceId: undefined,
				error: undefined,
			});
		});
		return steps;
	};

	/** Run the steps, one per `stageMs`, pushing after each; a step that fails the run ends it. */
	const run = (stored: Stored, steps: Array<() => void>): void => {
		const { summary } = stored;
		Object.assign(summary, { status: "running", instanceId: options.instanceId, error: undefined });
		summary.progress ??= "Waiting to start";
		refresh(stored);
		push(summary.id);
		stored.timer = setInterval(() => {
			steps.shift()?.();
			if (stored.summary.status === "failed") return;
			refresh(stored);
			push(summary.id);
			if (steps.length === 0) {
				clearInterval(stored.timer);
				stored.timer = undefined;
			}
		}, stageMs);
	};

	// A finished design bake-off whose reviewer and judge disagree: the reviewer's own model wrote the entry it ranks first.
	{
		const entries = [
			ready("A", "challenger", DESIGN_IDEAS[1]!, "anthropic/claude-haiku-5"),
			ready("B", "original", DESIGN_IDEAS[0]!),
			ready("C", "challenger", DESIGN_IDEAS[2]!, "openai/gpt-mini"),
		];
		put({
			id: "bk-mock-split",
			title: `interfold · ${DOC_NAME}`,
			subject: "a design",
			createdAt: now - 2 * HOUR,
			mode: "design",
			metrics: [SIMPLICITY, RISK, FEWER],
			reviewer: "openai/gpt-mini",
			judge: "auto",
			instructions: "The cache must keep one connection per chain; do not add a service.",
			entries,
			stage: "done",
			status: "ready",
			plan: planOf(entries, {
				order: ["C", "B", "A"],
				judging: {
					label: JUDGE_LABEL,
					kind: "endpoint",
					order: ["B", "C", "A"],
					scores: true,
					advisory: false,
					inconsistent: true,
				},
				passes: 2,
				unverified: ["A"],
				unsure: CANNED_UNSURE,
			}),
		});
	}

	// A finished design bake-off with no second opinion: the judge was unreachable.
	{
		const entries = [
			ready("A", "original", DESIGN_IDEAS[0]!),
			ready("B", "challenger", DESIGN_IDEAS[3]!, "anthropic/claude-haiku-5"),
			ready("C", "challenger", DESIGN_IDEAS[4]!, "google/gemini-flash"),
		];
		put({
			id: "bk-mock-nojudge",
			title: "interfold · PR #2245",
			subject: "PR #2245",
			createdAt: now - DAY,
			mode: "design",
			metrics: [SIMPLICITY, PERFORMANCE],
			reviewer: REVIEWER,
			judge: "auto",
			entries,
			stage: "done",
			status: "ready",
			plan: planOf(entries, {
				order: ["A", "C", "B"],
				judgeNote: `No second opinion: ${JUDGE_LABEL} was unreachable (connection refused)`,
				unsure: ["Whether the endpoint limits connections per client."],
			}),
		});
	}

	// A finished implementation bake-off: worktrees, facts, one entry that fails its tests and one that changed the test script.
	{
		const entries = [
			ready("A", "challenger", IMPL_IDEAS[2]!, "openai/gpt-mini"),
			ready("B", "challenger", IMPL_IDEAS[1]!, "anthropic/claude-haiku-5"),
			ready("C", "original", IMPL_IDEAS[0]!),
			ready("D", "challenger", IMPL_IDEAS[3]!, "google/gemini-flash"),
		];
		put({
			id: "bk-mock-impl",
			title: "interfold · feature/event-replay vs main",
			subject: "feature/event-replay vs main",
			createdAt: now - 3 * HOUR,
			mode: "implementation",
			ref: "feature/event-replay",
			metrics: [SIMPLICITY, PERFORMANCE, LINES],
			reviewer: REVIEWER,
			judge: "auto",
			entries,
			stage: "done",
			status: "ready",
			plan: planOf(entries, {
				order: ["B", "C", "D", "A"],
				judging: {
					label: JUDGE_LABEL,
					kind: "endpoint",
					order: ["B", "C", "D", "A"],
					scores: true,
					advisory: false,
					inconsistent: false,
				},
				dirty: new Set(["D"]),
				unsure: ["Whether the connect under the lock matters with the real endpoints."],
			}),
		});
	}

	// A finished implementation bake-off whose worktrees were removed and whose snapshots were pruned: only the original's
	// code is still on this computer, and the patch of one more is too large to send.
	{
		const entries = [
			ready("A", "challenger", IMPL_IDEAS[1]!, "anthropic/claude-haiku-5"),
			ready("B", "challenger", IMPL_IDEAS[2]!, "openai/gpt-mini"),
			ready("C", "original", IMPL_IDEAS[0]!),
			ready("D", "challenger", IMPL_IDEAS[3]!, "google/gemini-flash"),
		];
		put({
			id: "bk-mock-impl-pruned",
			title: "interfold · feature/provider-cache vs main",
			subject: "feature/provider-cache vs main",
			createdAt: now - 2 * DAY,
			mode: "implementation",
			ref: "feature/provider-cache",
			code: "pruned",
			metrics: [SIMPLICITY, LINES],
			reviewer: REVIEWER,
			judge: "off",
			entries,
			stage: "done",
			status: "ready",
			plan: planOf(entries, {
				order: ["A", "C", "D", "B"],
				judgeNote: "No second opinion: it was turned off.",
				unsure: [],
			}),
		});
	}

	// A finished design bake-off of a folder that is not a git repository: the notes of the session without a project.
	{
		const entries = [
			ready("A", "original", FOLDER_IDEAS[0]!),
			ready("B", "challenger", FOLDER_IDEAS[1]!, "anthropic/claude-haiku-5"),
			ready("C", "challenger", FOLDER_IDEAS[2]!, "openai/gpt-mini"),
		];
		put({
			id: "bk-mock-folder",
			title: `${folderOf(TOPIC_CWD).name} · ${NOTES}`,
			subject: NOTES,
			createdAt: now - 4 * HOUR,
			mode: "design",
			folder: true,
			root: TOPIC_CWD,
			metrics: [SIMPLICITY, PERFORMANCE],
			reviewer: REVIEWER,
			judge: "off",
			entries,
			stage: "done",
			status: "ready",
			plan: planOf(entries, {
				order: ["B", "A", "C"],
				judgeNote: "No second opinion: it was turned off.",
				unsure: ["Whether the cents survive the scaling for salaries above a million."],
			}),
		});
	}

	// A design bake-off part way through: three of its entries at different points, and the rest of the steps still to run.
	{
		const entries: EntrySpec[] = [
			ready("A", "original", DESIGN_IDEAS[0]!),
			ready("B", "challenger", DESIGN_IDEAS[1]!, "anthropic/claude-haiku-5"),
			{ label: "C", kind: "challenger", idea: DESIGN_IDEAS[2]!, status: "writing-up", model: "openai/gpt-mini" },
			{ label: "D", kind: "challenger", idea: DESIGN_IDEAS[3]!, status: "working", model: "google/gemini-flash" },
		];
		const stored = put({
			id: "bk-mock-running",
			title: "interfold · PR #2244",
			subject: "PR #2244",
			createdAt: now - 3 * MINUTE,
			mode: "design",
			metrics: [SIMPLICITY, FEWER, RISK],
			reviewer: REVIEWER,
			judge: "auto",
			entries,
			stage: "entries",
			status: "running",
			progress: "The challengers are writing their designs",
			plan: planOf(entries, {
				order: ["B", "A", "C", "D"],
				judging: {
					label: JUDGE_LABEL,
					kind: "endpoint",
					order: ["B", "A", "C", "D"],
					scores: true,
					advisory: false,
					inconsistent: false,
				},
			}),
		});
		run(stored, stepsFor(stored));
	}

	// A design bake-off whose review failed after the entries were made: Review again runs the review and the judge.
	{
		const entries = [
			ready("A", "challenger", DESIGN_IDEAS[3]!, "openai/gpt-mini"),
			ready("B", "original", DESIGN_IDEAS[0]!),
			ready("C", "challenger", DESIGN_IDEAS[1]!, "anthropic/claude-haiku-5"),
		];
		put({
			id: "bk-mock-failed",
			title: "interfold · PR #2231",
			subject: "PR #2231",
			createdAt: now - 5 * HOUR,
			mode: "design",
			metrics: [SIMPLICITY, RISK],
			reviewer: REVIEWER,
			judge: "auto",
			entries,
			stage: "review",
			status: "failed",
			error: "The reviewer's answer could not be read as a ranking.",
			plan: planOf(entries, {
				order: ["C", "B", "A"],
				judging: {
					label: JUDGE_LABEL,
					kind: "endpoint",
					order: ["C", "B", "A"],
					scores: true,
					advisory: false,
					inconsistent: false,
				},
			}),
		});
	}

	/** Whether the second opinion would run for this request, and the plan's note when it would not. */
	const judgeFor = (
		judge: "auto" | "off",
		advisory: boolean,
		order: string[],
	): Pick<Plan, "judging" | "judgeNote"> => {
		const info = judgeInfo(judgeFlag);
		const label = info.label ?? "the judge";
		if (judge === "off") return { judgeNote: "No second opinion: it was turned off." };
		if (info.state === "none") return { judgeNote: "No second opinion: no judge model is set up on this computer." };
		if (info.reachable === false)
			return { judgeNote: `No second opinion: ${label} was unreachable (${info.reason})` };
		if (info.state === "fallback" && !advisory)
			return { judgeNote: `No second opinion: ${label} was not set up as a judge, so it was not used.` };
		return {
			judging: {
				label,
				kind: info.state,
				order,
				scores: info.state !== "fallback",
				advisory: info.state === "fallback",
				inconsistent: false,
			},
		};
	};

	const stored = (id: string): Stored => {
		const found = all.get(id);
		if (found === undefined) throw new Error("There is no such bake-off.");
		return found;
	};
	const finished = (id: string): Stored & { bakeoff: Bakeoff & { result: BakeoffResult } } => {
		const found = stored(id);
		if (found.summary.status === "running") throw new Error("The bake-off is still running.");
		if (found.bakeoff.result === undefined)
			throw new Error(`The bake-off has no result${found.summary.error ? `: ${found.summary.error}` : ""}.`);
		return found as Stored & { bakeoff: Bakeoff & { result: BakeoffResult } };
	};

	const excerptFor = (ref: BlueprintExcerptRef): BlueprintExcerpt | null => {
		const side = ref.side ?? "head";
		const excerpt = excerptOf(ref, { commit: side === "base" ? BASE_COMMIT : HEAD_COMMIT });
		return excerpt === null || excerpt.lines.length === 0 ? null : excerpt;
	};

	return {
		capabilities: { canBakeoff: true, canBakeoffPatch: true, canBakeoffFolder: true },
		handles: request => request.t.startsWith("bakeoff-"),
		stop() {
			for (const item of all.values()) clearInterval(item.timer);
		},
		async answer(request): Promise<CompanionReply> {
			switch (request.t) {
				case "bakeoff-list": {
					// Every folder of the mock computer is a folder of the fixture repository, except a scratch folder.
					const root = request.cwd === undefined ? undefined : rootOf(request.cwd);
					const rows = [...all.values()]
						.map(item => ({ ...item.summary }))
						.filter(row => root === undefined || row.repoRoot === root)
						.sort((a, b) => b.createdAt - a.createdAt);
					return { t: "bakeoff-list", reqId: request.reqId, bakeoffs: rows };
				}
				case "bakeoff-judge":
					return { t: "bakeoff-judge", reqId: request.reqId, judge: judgeInfo(judgeFlag) };
				case "bakeoff-create": {
					const { t: _t, reqId: _reqId, ...body } = request;
					const folder = !folderOf(body.cwd ?? "").git;
					const checked = checkBakeoffCreate(body, folder);
					const id = `bk-new-${++counter}`;
					const impl = checked.mode === "implementation";
					const pool = folder ? FOLDER_IDEAS : impl ? IMPL_IDEAS : DESIGN_IDEAS;
					const labels = BAKEOFF_LABELS.slice(0, checked.models.length + 1);
					// The original takes a different letter each time, as the real draw does.
					const originalAt = counter % labels.length;
					const challengerLabels = [...labels].filter((_, at) => at !== originalAt);
					const specs: EntrySpec[] = [
						{
							label: labels[originalAt]!,
							kind: "original",
							idea: pool[0]!,
							status: "waiting",
						} satisfies EntrySpec,
						...checked.models.map((model, at): EntrySpec => ({
							label: challengerLabels[at]!,
							kind: "challenger",
							model,
							idea: pool[1 + (at % (pool.length - 1))]!,
							status: "waiting",
						})),
					].sort((a, b) => a.label.localeCompare(b.label));
					const preference = (entry: EntrySpec): number => pool.indexOf(entry.idea);
					// The challengers' ideas rank in the order the pool lists them, the original's after the first.
					const order = [...specs]
						.sort(
							(a, b) =>
								(preference(a) === 0 ? 0.5 : preference(a)) - (preference(b) === 0 ? 0.5 : preference(b)),
						)
						.map(entry => entry.label);
					const subject =
						checked.pr !== undefined
							? `PR #${checked.pr}`
							: checked.ref !== undefined
								? `${checked.ref === "@worktree" ? "worktree" : checked.ref} vs ${checked.base === undefined || checked.base === "@default" ? "main" : checked.base}`
								: checked.sessionId !== undefined
									? "what the session changed"
									: "a design";
					const docName =
						checked.doc === undefined
							? undefined
							: "text" in checked.doc
								? (checked.doc.name ?? "Pasted design")
								: (checked.doc.path.split("/").pop() ?? DOC_NAME);
					const plan = planOf(specs, {
						order,
						...judgeFor(checked.judge, checked.judgeAdvisory, order),
						passes: checked.reviewerPasses,
						failing: new Set(specs.filter(spec => spec.model?.endsWith("/fail")).map(spec => spec.label)),
						dirty: new Set(specs.filter(spec => spec.idea.flags !== undefined).map(spec => spec.label)),
						unsure: CANNED_UNSURE,
						failReview: checked.reviewer === FAIL_MODEL,
					});
					const created = put({
						id,
						title: `${folder ? folderOf(body.cwd!).name : REPO.name} · ${docName ?? subject}`,
						subject: folder ? (docName ?? "a design") : subject,
						createdAt: Date.now(),
						mode: checked.mode,
						metrics: checked.metrics,
						reviewer: checked.reviewer,
						judge: checked.judge,
						entries: specs,
						stage: "preparing",
						status: "running",
						plan,
						maxCostUsd: checked.maxCostUsd,
						ref: checked.ref,
						...(folder ? { folder: true as const, root: body.cwd! } : {}),
						...(impl ? { code: "kept" as const } : {}),
						...(checked.instructions === undefined ? {} : { instructions: checked.instructions }),
					});
					run(created, stepsFor(created));
					return { t: "bakeoff-create", reqId: request.reqId, id };
				}
				case "bakeoff-get": {
					const bakeoff = structuredClone(stored(request.id).bakeoff);
					for (const entry of bakeoff.entries) {
						const patch = patchStateOf(stored(request.id), entry);
						if (patch !== undefined) entry.patch = patch;
					}
					return { t: "bakeoff-get", reqId: request.reqId, bakeoff };
				}
				case "bakeoff-patch": {
					const item = stored(request.id);
					const entry = entryNamed(item.bakeoff, request.entry);
					const state = patchStateOf(item, entry);
					if (state === undefined) throw new Error("Only an implementation has code to export.");
					if (!state.ok) throw new Error(state.reason);
					if (item.spec.code === "pruned" && entry.label === OVERSIZE_LABEL)
						throw new Error(
							`The patch is larger than ${BAKEOFF_MAX_PATCH_BYTES / (1024 * 1024)} MB, so it is not offered. Take this entry and read its worktree instead.`,
						);
					return {
						t: "bakeoff-patch",
						reqId: request.reqId,
						patch: patchText(item.spec.entries.find(spec => spec.label === entry.label)!),
					};
				}
				case "bakeoff-folder":
					return { t: "bakeoff-folder", reqId: request.reqId, folder: folderOf(request.cwd) };
				case "bakeoff-excerpt": {
					const item = stored(request.id);
					entryNamed(item.bakeoff, request.entry);
					return { t: "bakeoff-excerpt", reqId: request.reqId, excerpts: request.refs.map(excerptFor) };
				}
				case "bakeoff-stop": {
					const item = stored(request.id);
					if (item.summary.status !== "running") throw new Error("This bake-off is not running.");
					const live: BakeoffEntryStatus[] = ["waiting", "working", "writing-up"];
					if (request.entry === undefined) {
						for (const entry of item.bakeoff.entries) if (live.includes(entry.status)) entry.status = "stopped";
						failRun(item, "Stopped.");
					} else {
						const entry = item.bakeoff.entries.find(
							candidate => candidate.label === request.entry && candidate.kind === "challenger",
						);
						if (entry === undefined) throw new Error("There is no such entry to stop.");
						if (live.includes(entry.status)) entry.status = "stopped";
						refresh(item);
						push(item.summary.id);
					}
					return { t: "bakeoff-stop", reqId: request.reqId };
				}
				case "bakeoff-take": {
					const item = finished(request.id);
					const entry = item.bakeoff.entries.find(candidate => candidate.label === request.entry);
					if (entry === undefined || entry.status !== "ready") throw new Error("There is no such entry to take.");
					let result: BakeoffTakeResult | undefined;
					if (item.bakeoff.mode === "implementation" && entry.kind === "challenger") {
						if (request.discardDirty && !request.removeOthers) throw new Error("invalid request");
						result = { removed: [], skipped: [] };
						if (request.removeOthers)
							for (const other of item.bakeoff.entries) {
								if (other === entry || other.kind !== "challenger" || other.status !== "ready") continue;
								if (item.spec.plan.dirty.has(other.label) && !request.discardDirty)
									result.skipped.push({ model: other.model!, reason: "it has uncommitted changes" });
								else result.removed.push(other.model!);
							}
					} else if (request.removeOthers) {
						throw new Error("There is no worktree to keep for this entry, so there is nothing to remove.");
					}
					item.bakeoff.result.taken = entry.label;
					refresh(item);
					push(item.summary.id);
					return { t: "bakeoff-take", reqId: request.reqId, ...(result === undefined ? {} : { result }) };
				}
				case "bakeoff-delete": {
					const item = all.get(request.id);
					clearInterval(item?.timer);
					all.delete(request.id);
					push(request.id);
					return { t: "bakeoff-delete", reqId: request.reqId };
				}
				case "bakeoff-review": {
					const item = stored(request.id);
					if (item.summary.status !== "failed")
						throw new Error("Only a bake-off whose review failed can be reviewed again.");
					if (item.bakeoff.stage !== "review" && item.bakeoff.stage !== "judge")
						throw new Error("This bake-off did not fail in the review, so there is nothing to review again.");
					if (reviewable(item.bakeoff).length < 2) throw new Error("Fewer than two entries are left to compare.");
					item.summary.progress = "Waiting to start";
					run(item, stepsFor(item));
					return { t: "bakeoff-review", reqId: request.reqId };
				}
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
