/**
 * The `quiz-*` requests for scripts/mock-companion.ts, so quizzes can be tried in a browser: a finished quiz of a
 * two-part pull request stack with an attempt in the history, a quiz of a session's changes left half answered (it
 * resumes), a failed one and one of another repository; quizzes started from the form tick through their stages and
 * turn ready; the code behind every citation is read from the small repository ("interfold") embedded below, whose
 * citations are placed by finding their token in the source, so the fixture cannot cite a line that is not there.
 *
 * Like the real companion it keeps the rubric of an open question and the right choice out of every reply until the
 * question is answered. A choice is graded by the key, an open answer by keywords (right with two thirds of a
 * question's points found, partly with a third); an answer of `/fail` fails grading once and `/limit` hits the spending
 * limit, to see how the app shows both. Every folder of the computer counts as a folder of the one fixture repository.
 *
 * Topic quizzes (`quiz-create` with `subject: "session"`, `focus`, and `quiz-folder`; capability `canQuizTopic`): a canned quiz on
 * statistics with fully homomorphic encryption, whose questions cite the conversation of the session ./fixture-topic holds (served
 * by `mock-host.ts --topic`), the files `notes/design.md` and `src/stats.py` (read through `quiz-excerpt` like any citation) or
 * nothing (general background). A folder under a `scratch` directory is a session without a project: no git, no code, so
 * the implementation focus is refused; any other folder is the fixture repository.
 */

import type { BlueprintCommit, BlueprintExcerpt, BlueprintExcerptRef, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type {
	Quiz,
	QuizAnswerRecord,
	QuizAttempt,
	QuizCreate,
	QuizFocus,
	QuizFolder,
	QuizPart,
	QuizQuestion,
	QuizSessionRef,
	QuizStackPr,
	QuizSummary,
	QuizVerdict,
} from "@oh-my-pi/pi-wire/quiz";
import {
	QUIZ_DEFAULT_FOCUS,
	QUIZ_FOCUSES,
	QUIZ_MAX_ANSWER_CHARS,
	QUIZ_VERSION,
	scoreAttempt,
} from "@oh-my-pi/pi-wire/quiz";
import type { QuizStakes } from "@oh-my-pi/pi-wire/stakes";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { SCRATCH_DIR, scratchLabel } from "../src/lib/scratch";
import { excerptOf as readExcerpt } from "./companion-excerpt";
import { TOPIC_CWD, TOPIC_SESSION_ID, topicMessage } from "./fixture-topic";

export const MOCK_QUIZ_ROOT = "/work/interfold";
const OTHER_ROOT = "/work/acme-shop";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Side = "head" | "base";

const HEAD_FILES: Record<string, string> = {
	"crates/events/Cargo.toml": `[package]
name = "e3-events"
version = "0.1.0"
edition = "2021"

[dependencies]
actix = { workspace = true }
anyhow = { workspace = true }
serde = { workspace = true }
tracing = { workspace = true }

[dev-dependencies]
e3-test-helpers = { workspace = true }
`,
	"crates/events/src/lib.rs": `//! The event runtime: a bus that routes typed events to subscribers.
mod bus;
mod event;
mod sequencer;

pub use bus::{EventBus, Subscribe};
pub use event::{E3id, EnclaveEvent, EventId};
pub use sequencer::Sequencer;
`,
	"crates/events/src/event.rs": `use actix::Message;

/// Identifies one computation across every node that takes part in it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct E3id(pub String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventId(pub [u8; 32]);

/// Everything that can happen to a computation, in the order it normally happens.
#[derive(Message, Clone, Debug)]
#[rtype(result = "()")]
pub enum EnclaveEvent {
    E3Requested { e3_id: E3id, seed: u64 },
    CiphernodeSelected { e3_id: E3id, node: String },
    KeyshareCreated { e3_id: E3id, node: String },
    PlaintextAggregated { e3_id: E3id, output: Vec<u8> },
}

impl EnclaveEvent {
    /// The name subscribers register for.
    pub fn event_type(&self) -> &'static str {
        match self {
            EnclaveEvent::E3Requested { .. } => "E3Requested",
            EnclaveEvent::CiphernodeSelected { .. } => "CiphernodeSelected",
            EnclaveEvent::KeyshareCreated { .. } => "KeyshareCreated",
            EnclaveEvent::PlaintextAggregated { .. } => "PlaintextAggregated",
        }
    }
}
`,
	"crates/events/src/bus.rs": `use actix::prelude::*;
use std::collections::HashMap;

use crate::event::EnclaveEvent;

/// Routes every published event to the recipients subscribed to its type.
pub struct EventBus {
    listeners: HashMap<String, Vec<Recipient<EnclaveEvent>>>,
    capture_history: bool,
    history: Vec<EnclaveEvent>,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct Subscribe {
    pub event_type: String,
    pub listener: Recipient<EnclaveEvent>,
}

impl EventBus {
    pub fn new(capture_history: bool) -> Self {
        Self { listeners: HashMap::new(), capture_history, history: Vec::new() }
    }
}

impl Actor for EventBus {
    type Context = Context<Self>;
}

impl Handler<Subscribe> for EventBus {
    type Result = ();
    fn handle(&mut self, msg: Subscribe, _: &mut Self::Context) {
        self.listeners.entry(msg.event_type).or_default().push(msg.listener);
    }
}

impl Handler<EnclaveEvent> for EventBus {
    type Result = ();
    fn handle(&mut self, event: EnclaveEvent, _: &mut Self::Context) {
        if self.capture_history {
            self.history.push(event.clone());
        }
        for listener in self.listeners.get(event.event_type()).into_iter().flatten() {
            listener.do_send(event.clone());
        }
    }
}
`,
	"crates/events/src/sequencer.rs": `use actix::prelude::*;

use crate::bus::EventBus;
use crate::event::EnclaveEvent;

/// Gives each event its place in the ordered log before the bus delivers it.
pub struct Sequencer {
    next: u64,
    bus: Addr<EventBus>,
}

impl Sequencer {
    pub fn new(bus: Addr<EventBus>) -> Self {
        Self { next: 0, bus }
    }
}

impl Actor for Sequencer {
    type Context = Context<Self>;
}

impl Handler<EnclaveEvent> for Sequencer {
    type Result = ();
    fn handle(&mut self, event: EnclaveEvent, _: &mut Self::Context) {
        tracing::debug!(position = self.next, "sequenced {}", event.event_type());
        self.next += 1;
        self.bus.do_send(event);
    }
}
`,
	"crates/evm/src/lib.rs": `mod event_reader;
mod provider_cache;

pub use event_reader::EvmEventReader;
pub use provider_cache::ProviderCache;
`,
	"crates/evm/src/provider_cache.rs": `//! Providers, one per chain.
//!
//! Every reader and writer on a chain asks this cache for its provider instead of connecting on its own, so a node
//! that follows five contracts on one chain holds one connection, not five. A provider is created on first use and
//! kept until the process ends or the chain is evicted.
//!
//! The cache does not retry a failed connection: the caller sees the error and decides, because a reader wants to
//! back off while a one-off RPC call wants to give up.
use alloy::providers::{Provider, ProviderBuilder};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// Chains one node follows at most; a node with more is misconfigured, not busy.
pub const MAX_CHAINS: usize = 32;

/// How long a connection may take to open before the caller gets an error.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a provider could not be handed out.
#[derive(Debug)]
pub enum CacheError {
    /// The node already follows [MAX_CHAINS] chains.
    TooManyChains(usize),
    /// The RPC endpoint did not answer in time.
    Timeout(String),
    /// The endpoint answered with something that is not a chain.
    Rejected(String),
}

impl fmt::Display for CacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CacheError::TooManyChains(count) => write!(f, "already following {count} chains"),
            CacheError::Timeout(url) => write!(f, "{url} did not answer in {CONNECT_TIMEOUT:?}"),
            CacheError::Rejected(url) => write!(f, "{url} is not an RPC endpoint"),
        }
    }
}

impl std::error::Error for CacheError {}

/// Counters the node's status page shows.
#[derive(Default, Debug, Clone, Copy)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// One connected provider per chain, shared by every reader and writer.
#[derive(Default)]
pub struct ProviderCache {
    providers: RwLock<HashMap<u64, Arc<dyn Provider>>>,
}

impl ProviderCache {
    pub async fn get(&self, chain_id: u64, rpc_url: &str) -> anyhow::Result<Arc<dyn Provider>> {
        if let Some(found) = self.providers.read().await.get(&chain_id) {
            return Ok(found.clone());
        }
        let provider = ProviderBuilder::new().connect(rpc_url).await?;
        let provider: Arc<dyn Provider> = Arc::new(provider);
        self.providers.write().await.insert(chain_id, provider.clone());
        Ok(provider)
    }

    /// Chains with a provider right now.
    pub async fn len(&self) -> usize {
        self.providers.read().await.len()
    }

    /// Drops a chain's provider; the next get connects again.
    pub async fn evict(&self, chain_id: u64) -> bool {
        self.providers.write().await.remove(&chain_id).is_some()
    }

    /// Drops every provider, for a node that is shutting down or changing its endpoints.
    pub async fn clear(&self) {
        self.providers.write().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn starts_empty() {
        let cache = ProviderCache::default();
        assert_eq!(cache.len().await, 0);
    }

    #[tokio::test]
    async fn evicting_a_chain_that_is_not_there_is_not_an_error() {
        let cache = ProviderCache::default();
        assert!(!cache.evict(1).await);
    }

    #[tokio::test]
    async fn clear_leaves_nothing() {
        let cache = ProviderCache::default();
        cache.clear().await;
        assert_eq!(cache.len().await, 0);
    }

    #[test]
    fn errors_name_the_endpoint() {
        let error = CacheError::Timeout("http://localhost:8545".into());
        assert!(error.to_string().contains("localhost:8545"));
    }

    #[test]
    fn stats_start_at_zero() {
        let stats = CacheStats::default();
        assert_eq!((stats.hits, stats.misses, stats.evictions), (0, 0, 0));
    }
}
`,
	"crates/evm/src/event_reader.rs": `use actix::Addr;
use alloy::primitives::Address;
use e3_events::{E3id, EnclaveEvent, EventBus};
use std::sync::Arc;

use crate::provider_cache::ProviderCache;

/// Follows one contract's logs and republishes them on the bus as events.
pub struct EvmEventReader {
    provider: Arc<dyn alloy::providers::Provider>,
    bus: Addr<EventBus>,
    contract: Address,
}

impl EvmEventReader {
    pub async fn attach(
        cache: &ProviderCache,
        chain_id: u64,
        rpc_url: &str,
        bus: Addr<EventBus>,
        contract: Address,
    ) -> anyhow::Result<Self> {
        let provider = cache.get(chain_id, rpc_url).await?;
        Ok(Self { provider, bus, contract })
    }

    fn publish_requested(&self, e3_id: String, seed: u64) {
        self.bus.do_send(EnclaveEvent::E3Requested { e3_id: E3id(e3_id), seed });
    }
}
`,
	"crates/sortition/src/committee.rs": `use crate::registry::Registry;
use e3_events::E3id;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// The ciphernodes chosen for one computation, in the order they were drawn.
pub struct Committee {
    pub e3_id: E3id,
    pub nodes: Vec<String>,
}

pub fn select(registry: &Registry, e3_id: E3id, seed: u64, threshold: usize) -> Committee {
    let mut ranked: Vec<(u64, &String)> = registry
        .nodes()
        .iter()
        .map(|node| (score(node, seed), node))
        .collect();
    ranked.sort_by_key(|(score, _)| *score);
    let nodes = ranked.into_iter().take(threshold).map(|(_, node)| node.clone()).collect();
    Committee { e3_id, nodes }
}

fn score(node: &str, seed: u64) -> u64 {
    let mut hasher = DefaultHasher::new();
    (node, seed).hash(&mut hasher);
    hasher.finish()
}
`,
};

/** The files before the stack: one crate, a provider built on every call, committees picked from a plain list. */
const BASE_FILES: Record<string, string> = {
	"crates/enclave-core/Cargo.toml": `[package]
name = "e3-core"
version = "0.1.0"
edition = "2021"

[dependencies]
actix = { workspace = true }
anyhow = { workspace = true }
serde = { workspace = true }

[dev-dependencies]
e3-data = { workspace = true }
`,
	"crates/evm/src/helpers.rs": `//! Small helpers the EVM code reaches for; none of them keeps state.
use alloy::primitives::{Address, B256};
use alloy::providers::{Provider, ProviderBuilder};
use std::time::Duration;

/// How many times a read is tried before the caller sees the error.
pub const READ_ATTEMPTS: usize = 3;

/// Pause between two tries of the same read.
pub const READ_BACKOFF: Duration = Duration::from_millis(250);

/// The chain a well-known id belongs to, for log lines; unknown ids are shown as numbers.
pub fn chain_name(chain_id: u64) -> String {
    match chain_id {
        1 => "mainnet".to_string(),
        10 => "optimism".to_string(),
        137 => "polygon".to_string(),
        8453 => "base".to_string(),
        42161 => "arbitrum".to_string(),
        11155111 => "sepolia".to_string(),
        other => format!("chain {other}"),
    }
}

/// Shortens an address to \`0x1234…abcd\` for log lines.
pub fn short_address(address: &Address) -> String {
    let full = address.to_string();
    format!("{}…{}", &full[..6], &full[full.len() - 4..])
}

/// Shortens a hash the same way.
pub fn short_hash(hash: &B256) -> String {
    let full = hash.to_string();
    format!("{}…{}", &full[..6], &full[full.len() - 4..])
}

/// Whether an endpoint looks like one we can speak to, before spending a connection on it.
pub fn is_rpc_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("ws://") || url.starts_with("wss://")
}

/// Waits before the next try of a read: a fixed pause, longer for each earlier failure.
pub fn backoff(attempt: usize) -> Duration {
    READ_BACKOFF * (attempt as u32 + 1)
}

/// Runs \`read\` up to [\`READ_ATTEMPTS\`] times, pausing between failures, and returns the last error.
pub async fn with_retries<T, F, Fut>(mut read: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut last = None;
    for attempt in 0..READ_ATTEMPTS {
        match read().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                last = Some(error);
                tokio::time::sleep(backoff(attempt)).await;
            }
        }
    }
    Err(last.expect("READ_ATTEMPTS is not zero"))
}

/// Connects to the chain's RPC endpoint; called wherever a provider is needed.
pub async fn create_provider(rpc_url: &str) -> anyhow::Result<impl Provider> {
    let provider = ProviderBuilder::new().connect(rpc_url).await?;
    Ok(provider)
}
`,
	"crates/sortition/src/committee.rs": `use e3_core::E3id;

pub struct Committee {
    pub e3_id: E3id,
    pub nodes: Vec<String>,
}

pub fn select(nodes: &[String], e3_id: E3id, seed: u64, threshold: usize) -> Committee {
    let mut ranked: Vec<&String> = nodes.iter().collect();
    ranked.sort_by_key(|node| (node.len() as u64) ^ seed);
    let nodes = ranked.into_iter().take(threshold).cloned().collect();
    Committee { e3_id, nodes }
}
`,
};

const NOTES = "notes/design.md";
const STATS = "src/stats.py";

/**
 * The files of the session without a project (and, for a topic quiz of a git folder, of its working tree): what a topic
 * quiz cites besides the conversation. A folder that is not a git repository has these stored with the quiz.
 */
const TOPIC_FILES: Record<string, string> = {
	[NOTES]: `# Encrypted salary statistics

## Goal
The server computes the mean and variance of a salary column and never sees a salary.

## Scheme
CKKS, not BFV. Salaries carry cents and the mean is wanted to two decimals, so an error near 1e-6 is acceptable.
BFV would need the cents scaled to integers and a larger plaintext modulus to hold the sums.

## Parameters
- Ring dimension 8192 (4096 slots). 16384 would double every ciphertext for no gain at this depth.
- Coefficient modulus bits 60, 40, 40, 60: two usable levels.
- Scale 2^40.

## Noise budget
One multiplication (the square for the variance) uses one level. The second level is headroom.
Additions are nearly free. Dividing by n would cost a level, so the client divides.

## Protocol
1. The client encrypts the column and sends it with the public context.
2. The server returns the encrypted sum and the encrypted sum of squares.
3. The client decrypts, divides by n and computes variance = E[x^2] - E[x]^2.
`,
	[STATS]: `"""Encrypted mean and variance of a column with CKKS (TenSEAL)."""

import tenseal as ts

POLY_MODULUS = 8192
COEFF_BITS = [60, 40, 40, 60]
SCALE = 2**40


def make_context() -> ts.Context:
    ctx = ts.context(ts.SCHEME_TYPE.CKKS, POLY_MODULUS, coeff_mod_bit_sizes=COEFF_BITS)
    ctx.global_scale = SCALE
    # sum() rotates the slots, which needs Galois keys.
    ctx.generate_galois_keys()
    return ctx


def encrypt_column(ctx: ts.Context, values: list[float]) -> ts.CKKSVector:
    return ts.ckks_vector(ctx, values)


def encrypted_stats(column: ts.CKKSVector) -> tuple[ts.CKKSVector, ts.CKKSVector]:
    """The server's half: the sum and the sum of squares, one multiplication in all."""
    total = column.sum()
    squares = column.square().sum()
    return total, squares


def decrypt_stats(total: ts.CKKSVector, squares: ts.CKKSVector, n: int) -> tuple[float, float]:
    """The client's half: divide by n here, where it costs no level."""
    mean = total.decrypt()[0] / n
    variance = squares.decrypt()[0] / n - mean * mean
    return mean, variance
`,
};

function sourceOf(path: string, side: Side): string | undefined {
	const files = side === "base" ? BASE_FILES : HEAD_FILES;
	if (Object.hasOwn(files, path)) return files[path];
	return side === "head" && Object.hasOwn(TOPIC_FILES, path) ? TOPIC_FILES[path] : undefined;
}

/** A citation of the first line of `path` holding `token`. */
export function cite(path: string, token: string, side: Side = "head"): BlueprintRef {
	const text = sourceOf(path, side);
	if (text === undefined) throw new Error(`mock quiz: no file ${path} (${side})`);
	const index = text.split("\n").findIndex(line => line.includes(token));
	if (index === -1) throw new Error(`mock quiz: ${path} has no "${token}" (${side})`);
	const ref: BlueprintRef = { path, line: index + 1, token };
	if (side === "base") ref.side = "base";
	return ref;
}

const LANGUAGES: Record<string, string> = { rs: "rust", toml: "ini", py: "python", md: "markdown" };

/** The code a ref cites, cut the way the real companion cuts it (default window, or the range the ref asks for). */
export function excerptOf(ref: BlueprintExcerptRef, commit: BlueprintCommit | undefined): BlueprintExcerpt | null {
	const side = ref.side ?? "head";
	const text = sourceOf(ref.path, side);
	if (text === undefined) return null;
	const excerpt = readExcerpt(text.split("\n"), ref, side, commit?.commit ?? "");
	return excerpt === null ? null : { ...excerpt, language: LANGUAGES[ref.path.split(".").pop() ?? ""] };
}

/** What the real companion keeps back until a question is answered. */
export type Secret =
	| { kind: "choice"; answer: string; explanation: string; refs: BlueprintRef[] }
	| { kind: "open"; points: { text: string; keywords: string[] }[]; explanation: string; refs: BlueprintRef[] };

export interface QuestionSpec {
	question: Omit<QuizQuestion, "id" | "part">;
	secret: Secret;
}

const EVENTS_CARGO = "crates/events/Cargo.toml";

/** The questions of each pull request of the stack, in stack order. */
const PARTS: { pr: QuizStackPr; commit: string; specs: QuestionSpec[] }[] = [
	{
		pr: {
			number: 2243,
			title: "refactor(event-system): the event runtime gets its own crate",
			head: "refactor/event-runtime",
			base: "main",
			url: "https://github.com/example/interfold/pull/2243",
		},
		commit: "9c41e07b3a5d2f86c1e04a7d5b93f2a1d60e8c47",
		specs: [
			{
				question: {
					kind: "open",
					prompt:
						"`e3-core` listed `e3-data` as a **dev-dependency** while `e3-data` depends on `e3-core`. The new `e3-events` crate drops that line. Why would a dev-dependency cycle like that cause trouble even though Cargo accepts it?",
					reminder:
						"A dev-dependency is only built for tests and examples, so Cargo allows it to point back at a crate that depends on the current one. That does not make the two crates the same compilation unit.",
					topic: "Dev-dependency cycles",
					refs: [cite(EVENTS_CARGO, "e3-test-helpers"), cite("crates/enclave-core/Cargo.toml", "e3-data", "base")],
				},
				secret: {
					kind: "open",
					points: [
						{
							text: "In a test build the crate is compiled twice: once as the crate under test and once as the dependency of `e3-data`.",
							keywords: ["twice", "two copies", "two versions", "built again", "compiled again", "duplicate"],
						},
						{
							text: "The two copies have different types, so an `EnclaveEvent` from one is not the `EnclaveEvent` of the other and trait impls do not line up.",
							keywords: [
								"different type",
								"not the same type",
								"mismatch",
								"doesn't match",
								"does not match",
								"unify",
								"distinct",
							],
						},
						{
							text: "The fix is to move what both need into a leaf crate (here `e3-test-helpers`) so nothing points back.",
							keywords: ["leaf", "helpers", "separate crate", "extract", "move"],
						},
					],
					explanation:
						"Under `cargo test` the crate under test is built as a test binary **and** again as the library that `e3-data` links against, so two copies of every type exist and `Recipient<EnclaveEvent>` from one is not accepted by the other. The error reads `expected EnclaveEvent, found EnclaveEvent`.\n\n```toml\n[dev-dependencies]\ne3-test-helpers = { workspace = true }\n```\n\nThe helpers now live in a crate that depends on nothing of ours, so the cycle is gone.",
					refs: [cite(EVENTS_CARGO, "[dev-dependencies]")],
				},
			},
			{
				question: {
					kind: "choice",
					prompt: "Which event starts the flow that ends in `PlaintextAggregated`?",
					topic: "Event flow",
					refs: [cite("crates/events/src/event.rs", "pub enum EnclaveEvent")],
					choices: [
						{ id: "a", text: "`KeyshareCreated`, published by each selected node" },
						{ id: "b", text: "`E3Requested`, published when a computation is requested on chain" },
						{ id: "c", text: "`CiphernodeSelected`, published by the sortition" },
						{ id: "d", text: "`PlaintextAggregated` itself, which then asks for key shares" },
					],
				},
				secret: {
					kind: "choice",
					answer: "b",
					explanation:
						"`E3Requested` is the first variant and the only one carrying a `seed`; the sortition uses that seed to pick the committee, whose members then publish `KeyshareCreated`.",
					refs: [cite("crates/events/src/event.rs", "E3Requested { e3_id")],
				},
			},
			{
				question: {
					kind: "open",
					prompt:
						"`EventBus::new` takes a `capture_history` flag, and `handle` records events only when it is set. Why is the history opt-in rather than always on?",
					topic: "Bus history",
					refs: [cite("crates/events/src/bus.rs", "capture_history: bool")],
				},
				secret: {
					kind: "open",
					points: [
						{
							text: "The history is never trimmed, so on a long-running node it would grow without bound.",
							keywords: ["memory", "grow", "unbounded", "never trimmed", "leak", "forever"],
						},
						{
							text: "Every event is cloned into it, which costs on every publish.",
							keywords: ["clone", "copy", "cost", "overhead", "performance"],
						},
						{
							text: "Tests turn it on to assert the order of events; production has no reader for it.",
							keywords: ["test", "assert", "order", "no reader"],
						},
					],
					explanation:
						"The history is a `Vec` that is only ever pushed to, and each push clones the event:\n\n```rust\nif self.capture_history {\n    self.history.push(event.clone());\n}\n```\n\nA node that runs for weeks would keep every event it ever saw, so only tests, which assert on the order of events, switch it on.",
					refs: [cite("crates/events/src/bus.rs", "self.history.push")],
				},
			},
			{
				question: {
					kind: "choice",
					prompt: "What does `Sequencer` do with an event before the bus delivers it?",
					topic: "Ordering of events",
					refs: [cite("crates/events/src/sequencer.rs", "impl Handler<EnclaveEvent> for Sequencer")],
					choices: [
						{ id: "a", text: "Writes it to disk so the node can replay it after a crash" },
						{ id: "b", text: "Signs it with the node's key" },
						{ id: "c", text: "Gives it the next position in the log, then forwards it to the bus" },
						{ id: "d", text: "Drops events it has seen before" },
					],
				},
				secret: {
					kind: "choice",
					answer: "c",
					explanation:
						"It only counts: `self.next` becomes the event's position and is incremented, then the event goes to the bus unchanged. Persistence and signing are not in this crate.",
					refs: [cite("crates/events/src/sequencer.rs", "self.next += 1")],
				},
			},
		],
	},
	{
		pr: {
			number: 2244,
			title: "refactor(evm): move the provider cache",
			head: "refactor/provider-cache",
			base: "refactor/event-runtime",
			url: "https://github.com/example/interfold/pull/2244",
		},
		commit: "a77f31c0d9e24b58163fc0a9d84e7b215c3f6e90",
		specs: [
			{
				question: {
					kind: "open",
					prompt:
						"`ProviderCache::get` looks under a read lock first and takes the write lock only on a miss. What can go wrong between the two, and why is that acceptable here?",
					reminder: "A `RwLock` lets many readers in at once but a writer needs to be alone.",
					topic: "Locking in the provider cache",
					refs: [cite("crates/evm/src/provider_cache.rs", "self.providers.read().await")],
				},
				secret: {
					kind: "open",
					points: [
						{
							text: "Two tasks can both miss before either writes, so both build a provider.",
							keywords: ["both", "two tasks", "race", "twice", "miss"],
						},
						{
							text: "The second insert replaces the first, so one connection is wasted but nothing is corrupted.",
							keywords: ["replace", "overwrite", "last", "wasted", "extra connection", "harmless"],
						},
						{
							text: "Holding the write lock across the connect would block every reader of every chain while it waits on the network.",
							keywords: ["block", "network", "every chain", "all readers", "slow"],
						},
					],
					explanation:
						"Between dropping the read lock and taking the write lock another task can fill the same entry. The cost is one extra connection that the later `insert` replaces:\n\n```rust\nlet provider = ProviderBuilder::new().connect(rpc_url).await?;\nlet provider: Arc<dyn Provider> = Arc::new(provider);\nself.providers.write().await.insert(chain_id, provider.clone());\n```\n\nThe alternative, holding the write lock across `connect`, would stop every reader of every chain while one handshake is in flight.",
					refs: [cite("crates/evm/src/provider_cache.rs", "insert(chain_id")],
				},
			},
			{
				question: {
					kind: "choice",
					prompt:
						"A reader and a writer both need chain 1. With the cache, how many provider connections to chain 1 are opened?",
					topic: "Provider reuse",
					refs: [
						cite("crates/evm/src/provider_cache.rs", "pub async fn get"),
						cite("crates/evm/src/event_reader.rs", "cache.get(chain_id"),
					],
					choices: [
						{ id: "a", text: "One for the reader and one for the writer" },
						{ id: "b", text: "One, shared through an `Arc`" },
						{ id: "c", text: "One per call to `get`" },
						{ id: "d", text: "None until the first event arrives" },
					],
				},
				secret: {
					kind: "choice",
					answer: "b",
					explanation:
						"The cache returns a clone of the same `Arc<dyn Provider>` for a chain id, so the reader and the writer share one connection.",
					refs: [cite("crates/evm/src/provider_cache.rs", "return Ok(found.clone())")],
				},
			},
			{
				question: {
					kind: "open",
					prompt:
						"Before this change `create_provider` connected on every call. What problem did that cause when a burst of events arrived?",
					topic: "Provider reuse",
					refs: [cite("crates/evm/src/helpers.rs", "ProviderBuilder::new()", "base")],
				},
				secret: {
					kind: "open",
					points: [
						{
							text: "Each call opened a new connection, paying a handshake every time.",
							keywords: ["handshake", "new connection", "every call", "each call", "each event", "every event"],
						},
						{
							text: "A burst could hit the RPC provider's rate limit or connection limit.",
							keywords: ["rate limit", "rate-limit", "limit", "throttl", "429"],
						},
						{
							text: "Connections were not reused or closed deliberately, so they piled up.",
							keywords: ["reuse", "pile", "leak", "too many", "open connections"],
						},
					],
					explanation:
						"The old helper built a fresh provider each time it was called:\n\n```rust\npub async fn create_provider(rpc_url: &str) -> anyhow::Result<impl Provider> {\n    let provider = ProviderBuilder::new().connect(rpc_url).await?;\n    Ok(provider)\n}\n```\n\nA burst of events meant a burst of handshakes and open connections, which public RPC endpoints throttle.",
					refs: [cite("crates/evm/src/provider_cache.rs", "ProviderBuilder::new()")],
				},
			},
		],
	},
	{
		pr: {
			number: 2245,
			title: "refactor(sortition): read committees from the registry",
			head: "refactor/sortition-registry",
			base: "refactor/provider-cache",
			url: "https://github.com/example/interfold/pull/2245",
		},
		commit: "c3d58a6e1f0b9247d85e6a31b0c47f92e8d15a63",
		specs: [
			{
				question: {
					kind: "choice",
					prompt: "Why must `select` give the same committee for the same seed on every node?",
					topic: "Deterministic selection",
					refs: [cite("crates/sortition/src/committee.rs", "fn score")],
					choices: [
						{ id: "a", text: "So nodes can agree on the committee without talking to each other" },
						{ id: "b", text: "So the committee can be cached on disk" },
						{ id: "c", text: "So hashing never collides" },
						{ id: "d", text: "So the sort stays stable" },
					],
				},
				secret: {
					kind: "choice",
					answer: "a",
					explanation:
						"Each node runs `select` locally with the seed from `E3Requested`; because the score depends only on the node and the seed, they all arrive at the same committee.",
					refs: [cite("crates/sortition/src/committee.rs", "(node, seed).hash")],
				},
			},
			{
				question: {
					kind: "open",
					prompt:
						"`select` used to take `nodes: &[String]` and now takes `registry: &Registry`. What does that type change decide about who is eligible?",
					topic: "Type change at the boundary",
					refs: [cite("crates/sortition/src/committee.rs", "registry: &Registry")],
				},
				secret: {
					kind: "open",
					points: [
						{
							text: "Eligibility now comes from the registry, one source of truth, instead of whatever list the caller built.",
							keywords: ["registry", "source of truth", "one source", "single source"],
						},
						{
							text: "Callers can no longer pass a hand-picked or stale list.",
							keywords: ["caller", "stale", "hand-picked", "arbitrary", "any list"],
						},
					],
					explanation:
						"A slice made every caller responsible for deciding who counts as a ciphernode. With a `Registry` the sortition reads the nodes from it itself:\n\n```rust\npub fn select(registry: &Registry, e3_id: E3id, seed: u64, threshold: usize) -> Committee\n```\n\nSo two callers cannot pick from different lists and end up with different committees.",
					refs: [cite("crates/sortition/src/committee.rs", "fn select(nodes", "base")],
				},
			},
			{
				question: {
					kind: "choice",
					prompt: "What happens when fewer than `threshold` nodes are registered?",
					topic: "Short committees",
					refs: [cite("crates/sortition/src/committee.rs", ".take(threshold)")],
					choices: [
						{ id: "a", text: "`select` panics" },
						{ id: "b", text: "It returns a committee with fewer nodes than the threshold" },
						{ id: "c", text: "It repeats nodes until the threshold is reached" },
						{ id: "d", text: "It waits for more nodes to register" },
					],
				},
				secret: {
					kind: "choice",
					answer: "b",
					explanation:
						"`take(threshold)` stops when the iterator runs out, so the committee is simply shorter; the caller has to compare its length with the threshold.",
					refs: [cite("crates/sortition/src/committee.rs", "Committee { e3_id, nodes }")],
				},
			},
		],
	},
];

/** A passage of a message of the session ./fixture-topic holds, checked to be in it like the real companion checks one. */
function said(entry: string, quote: string): QuizSessionRef {
	const message = topicMessage(entry);
	if (message === undefined) throw new Error(`mock quiz: no message ${entry} in the session`);
	if (!message.text.replace(/\s+/g, " ").includes(quote))
		throw new Error(`mock quiz: ${entry} does not say "${quote}"`);
	return { entry, role: message.role, quote };
}

/** What a topic question leans on; a question of `implementation` cites the code, so a folder without code has none. */
type TopicLean = Exclude<QuizFocus, "mixed">;

interface TopicSpec extends QuestionSpec {
	leans: TopicLean;
	/** Asked by a quiz of the default (`mixed`) focus. */
	mixed: boolean;
}

/**
 * The questions of a topic quiz about statistics on encrypted data, the session ./fixture-topic and the files above:
 * understanding (two of them general background, none cited), design (cited in the conversation and the notes) and
 * implementation (cited in the code). Every kind of citation is here: the conversation, a file and none.
 */
const TOPIC_SPECS: TopicSpec[] = [
	{
		leans: "understanding",
		mixed: true,
		question: {
			kind: "choice",
			prompt: "What does the noise budget of a homomorphic ciphertext tell you?",
			topic: "Noise budget",
			refs: [],
			background: true,
			choices: [
				{ id: "a", text: "How many bits of the plaintext the server can learn" },
				{ id: "b", text: "How much more computation the ciphertext can take before decryption returns garbage" },
				{ id: "c", text: "How many ciphertexts one key may encrypt" },
				{ id: "d", text: "How large the ciphertext is in bytes" },
			],
		},
		secret: {
			kind: "choice",
			answer: "b",
			explanation:
				"Every operation adds noise to a ciphertext, multiplications far more than additions. The budget is what is left before the noise swamps the message and decryption fails.",
			refs: [],
		},
	},
	{
		leans: "understanding",
		mixed: false,
		question: {
			kind: "open",
			prompt: "CKKS results are approximate. Why is that acceptable for statistics, and when is it not?",
			topic: "Approximate arithmetic",
			refs: [],
			background: true,
		},
		secret: {
			kind: "open",
			points: [
				{
					text: "The error is tiny next to the data, like floating-point rounding, so a mean or a variance is still right to the digits anyone needs.",
					keywords: ["small", "tiny", "rounding", "floating", "negligible"],
				},
				{
					text: "It is not acceptable where a result must be exact: money to the cent in a ledger, identifiers, equality tests.",
					keywords: ["exact", "equal", "ledger", "identifier", "id", "money"],
				},
				{
					text: "The error grows with every operation, so the depth of the computation has to be budgeted.",
					keywords: ["grow", "accumulate", "depth", "multiplication", "budget"],
				},
			],
			explanation:
				"CKKS treats the noise of the encryption as part of the number's rounding error, the way a float does. That suits means, variances and model scores. It does not suit anything that must be exact, and the error grows with each multiplication, so plan the depth.",
			refs: [],
		},
	},
	{
		leans: "understanding",
		mixed: true,
		question: {
			kind: "open",
			prompt:
				"After two CKKS ciphertexts are multiplied their scale is squared. What brings it back, and what does that cost?",
			reminder:
				"A CKKS ciphertext carries a scale: the factor a real number was multiplied by to become an integer.",
			topic: "Rescaling",
			refs: [],
			session: [said("t02", "a rescale step drops one prime from the modulus chain")],
		},
		secret: {
			kind: "open",
			points: [
				{ text: "A rescale step divides the scale back down.", keywords: ["rescale", "rescaling", "divide"] },
				{
					text: "It drops one prime from the modulus chain, which uses up one level.",
					keywords: ["prime", "level", "modulus chain", "chain"],
				},
				{
					text: "The chain is finite, so it limits how many multiplications in a row the parameters allow.",
					keywords: ["finite", "limit", "depth", "run out", "in a row"],
				},
			],
			explanation:
				"A rescale divides the ciphertext by the prime at the end of the modulus chain and so brings the scale back near its original value. The prime is gone afterwards: one level used. A chain of n primes allows about n-1 multiplications in a row.",
			refs: [cite(NOTES, "Coefficient modulus bits")],
		},
	},
	{
		leans: "understanding",
		mixed: true,
		question: {
			kind: "choice",
			prompt: "How many multiplications in a row do the parameters in the design notes allow?",
			topic: "Modulus chain",
			refs: [cite(NOTES, "Coefficient modulus bits")],
			choices: [
				{ id: "a", text: "One" },
				{ id: "b", text: "Two" },
				{ id: "c", text: "Four" },
				{ id: "d", text: "As many as fit in memory" },
			],
		},
		secret: {
			kind: "choice",
			answer: "b",
			explanation:
				"The notes list two usable levels. The variance needs one of them for the square; the other is headroom.",
			refs: [cite(NOTES, "One multiplication")],
		},
	},
	{
		leans: "design",
		mixed: true,
		question: {
			kind: "choice",
			prompt: "Why did the session pick CKKS rather than BFV for the salary column?",
			topic: "Choosing a scheme",
			refs: [],
			session: [
				said("t03", "I only need the mean to a couple of decimals"),
				said("t04", "An error around one part in a million is far below a cent"),
			],
			choices: [
				{ id: "a", text: "CKKS is faster for every workload" },
				{
					id: "b",
					text: "A tiny error is fine for a mean to a couple of decimals, and BFV would need the cents scaled into large integers",
				},
				{ id: "c", text: "BFV cannot add ciphertexts" },
				{ id: "d", text: "CKKS results are exact, unlike BFV's" },
			],
		},
		secret: {
			kind: "choice",
			answer: "b",
			explanation:
				"The trade was exactness for cost: an error of about one part in a million is far below a cent, and CKKS works on real numbers directly instead of cents scaled into big integers.",
			refs: [cite(NOTES, "CKKS, not BFV")],
		},
	},
	{
		leans: "design",
		mixed: true,
		question: {
			kind: "open",
			prompt: "The server returns the sum, not the mean. What was the reasoning, and what did it buy?",
			topic: "Where to divide",
			refs: [],
			session: [
				said("t05", "Should the server divide the sum by the number of rows"),
				said("t06", "Dividing by n is a multiplication by 1/n, which spends a level"),
			],
		},
		secret: {
			kind: "open",
			points: [
				{
					text: "Dividing by n is a multiplication by 1/n, so it would spend a level of the chain.",
					keywords: ["multiplication", "multiply", "level", "spends", "costs"],
				},
				{
					text: "n is not a secret, so the client can divide after decrypting at no cost.",
					keywords: ["not a secret", "public", "client", "after decrypt"],
				},
				{
					text: "A shorter chain allows a smaller ring dimension: smaller ciphertexts and faster operations.",
					keywords: ["shorter", "smaller", "faster", "ring", "chain"],
				},
			],
			explanation:
				"The server only adds and squares. The division by n, a multiplication by a plaintext, would use a level for something the client does for free after decrypting. Keeping the chain short is what allowed the smaller ring dimension.",
			refs: [cite(NOTES, "Dividing by n")],
		},
	},
	{
		leans: "design",
		mixed: false,
		question: {
			kind: "open",
			prompt:
				"The notes keep the ring dimension at 8192 rather than 16384. What does that save, and what does it cost?",
			topic: "Ring dimension",
			refs: [cite(NOTES, "Ring dimension 8192")],
		},
		secret: {
			kind: "open",
			points: [
				{
					text: "Ciphertexts are half the size and every operation is faster.",
					keywords: ["half", "smaller", "faster", "size", "speed"],
				},
				{
					text: "There are fewer slots (4096), so a longer column needs several ciphertexts.",
					keywords: ["slot", "4096", "several", "more ciphertexts", "batch"],
				},
			],
			explanation:
				"The ring dimension fixes both the size of a ciphertext and the number of values it packs. 8192 gives 4096 slots, enough per ciphertext here, at half the cost of 16384; a longer table is split across ciphertexts.",
			refs: [cite(NOTES, "Ring dimension 8192")],
		},
	},
	{
		leans: "implementation",
		mixed: true,
		question: {
			kind: "choice",
			prompt: "Which constant decides how many multiplications in a row the computation can afford?",
			topic: "Modulus chain",
			refs: [cite(STATS, "COEFF_BITS = [60")],
			choices: [
				{ id: "a", text: "`POLY_MODULUS`, the ring dimension" },
				{ id: "b", text: "`COEFF_BITS`, the primes of the modulus chain" },
				{ id: "c", text: "`SCALE`, the factor numbers are multiplied by" },
				{ id: "d", text: "None: the loop in `encrypted_stats` checks it at run time" },
			],
		},
		secret: {
			kind: "choice",
			answer: "b",
			explanation:
				"Each prime between the first and the last is one level; a multiplication rescales and uses one up.",
			refs: [cite(STATS, "COEFF_BITS = [60")],
		},
	},
	{
		leans: "implementation",
		mixed: true,
		question: {
			kind: "open",
			prompt: "Where does `encrypted_stats` multiply, and where is the division by n done instead?",
			topic: "One multiplication",
			refs: [cite(STATS, "column.square()"), cite(STATS, "decrypt()[0] / n")],
		},
		secret: {
			kind: "open",
			points: [
				{
					text: "`square()` is the only multiplication, so the computation uses one level.",
					keywords: ["square", "only multiplication", "one level", "once"],
				},
				{
					text: "The division by n is in `decrypt_stats`, on the client, after decrypting.",
					keywords: ["decrypt_stats", "client", "after decrypt", "decrypt"],
				},
				{
					text: "The variance is the mean of the squares minus the square of the mean.",
					keywords: ["mean of the squares", "e[x^2]", "minus the square", "mean * mean", "squares"],
				},
			],
			explanation:
				"`column.square()` is the single multiplication. `decrypt_stats` divides both decrypted sums by n and takes the variance as the mean of the squares minus the square of the mean, in plain floats.",
			refs: [cite(STATS, "column.square()")],
		},
	},
	{
		leans: "implementation",
		mixed: false,
		question: {
			kind: "choice",
			prompt: "Why does `make_context` call `generate_galois_keys`?",
			topic: "Galois keys",
			refs: [cite(STATS, "generate_galois_keys")],
			choices: [
				{ id: "a", text: "To let the server decrypt the sum" },
				{ id: "b", text: "`sum()` rotates the slots, and a rotation needs a Galois key" },
				{ id: "c", text: "To set the scale of the ciphertexts" },
				{ id: "d", text: "To make the ciphertexts smaller" },
			],
		},
		secret: {
			kind: "choice",
			answer: "b",
			explanation:
				"Adding the slots of one ciphertext together means rotating it and adding the rotations; each rotation is a key switch with a Galois key.",
			refs: [cite(STATS, "Galois keys")],
		},
	},
];

/** The topic questions a quiz of `focus` asks of a folder (`code`: it has source code), in the order they are asked. */
function topicSpecsFor(focus: QuizFocus, code: boolean): TopicSpec[] {
	return TOPIC_SPECS.filter(
		spec => (focus === "mixed" ? spec.mixed : spec.leans === focus) && (code || spec.leans !== "implementation"),
	);
}

function questionsOf(
	parts: { specs: QuestionSpec[] }[],
	first = 1,
): { questions: QuizQuestion[]; secrets: Map<string, Secret> } {
	const questions: QuizQuestion[] = [];
	const secrets = new Map<string, Secret>();
	let n = first;
	parts.forEach((part, index) => {
		for (const spec of part.specs) {
			const id = `q${n++}`;
			questions.push({ id, part: index, ...spec.question });
			secrets.set(id, spec.secret);
		}
	});
	return { questions, secrets };
}

interface StoredQuiz {
	summary: QuizSummary;
	quiz: Quiz | null;
	secrets: Map<string, Secret>;
	attempts: QuizAttempt[];
	timer?: NodeJS.Timeout;
	/** An answer of `/fail` fails once, then goes through. */
	failedOnce: boolean;
}

/** An answer's verdict: a choice by the key, an open answer by the keywords of the rubric. */
export function gradeAnswer(secret: Secret, given: { text?: string; choice?: string }): QuizVerdict {
	if (secret.kind === "choice") {
		const kind = given.choice === secret.answer ? "right" : "wrong";
		return {
			kind,
			explanation: `${kind === "right" ? "Yes." : "Not this one."} ${secret.explanation}`,
			refs: secret.refs,
			answer: secret.answer,
			graded: "local",
		};
	}
	const text = (given.text ?? "").toLowerCase();
	const hit = secret.points.map(point => point.keywords.some(word => text.includes(word)));
	const found = hit.filter(Boolean).length;
	const share = found / secret.points.length;
	const kind = share >= 2 / 3 ? "right" : share >= 1 / 3 ? "partly" : "wrong";
	const missing = secret.points.filter((_, at) => !hit[at]);
	const lead =
		kind === "right"
			? "That covers it."
			: kind === "partly"
				? `You have part of it. What is missing: ${missing.map(point => point.text).join(" ")}`
				: secret.refs.length === 0
					? "That misses the idea."
					: "That is not what the code does.";
	return {
		kind,
		explanation: `${lead}\n\n${secret.explanation}`,
		refs: secret.refs,
		keyPoints: secret.points.map(point => point.text),
		graded: "model",
	};
}

const NO_CODE = "Implementation questions need code, and this folder has none.";
const FOCUS_LABELS: Record<QuizFocus, string> = {
	mixed: "Mixed",
	understanding: "Understanding",
	design: "Design",
	implementation: "Implementation",
};

/** A session without a project works in a folder under a `scratch` directory. */
function isScratch(cwd: string): boolean {
	return cwd.split("/").includes(SCRATCH_DIR);
}

/** What a topic quiz can draw on in `cwd`: a scratch folder is no git repository and holds notes only; any other folder is the fixture repository. */
export function mockQuizFolder(cwd: string): QuizFolder {
	if (isScratch(cwd))
		return {
			git: false,
			code: false,
			files: 1,
			name: scratchLabel(cwd) ?? cwd.split("/").filter(Boolean).pop() ?? cwd,
		};
	return {
		git: true,
		code: true,
		files: Object.keys(HEAD_FILES).length + Object.keys(TOPIC_FILES).length,
		name: "interfold",
	};
}

/** The list row's words for a quiz on a session's topic. */
function topicSummary(focus: QuizFocus): Pick<QuizSummary, "subject" | "about" | "focus"> {
	return { subject: `Session topic · ${FOCUS_LABELS[focus]}`, about: "session", focus };
}

/** The quiz on the topic of the session ./fixture-topic holds, for the folder `cwd`, as the companion would write it: refused for the implementation focus when the folder has no code. */
function topicQuizOf(
	id: string,
	createdAt: number,
	cwd: string,
	focus: QuizFocus,
	sessionId: string | undefined,
): { quiz: Quiz; secrets: Map<string, Secret> } {
	const folder = mockQuizFolder(cwd);
	if (focus === "implementation" && !folder.code) throw new Error(NO_CODE);
	const { questions, secrets } = questionsOf([{ specs: topicSpecsFor(focus, folder.code) }]);
	const quiz: Quiz = {
		v: QUIZ_VERSION,
		id,
		title: `${folder.name} · session topic`,
		repo: { root: folder.git ? MOCK_QUIZ_ROOT : cwd, name: folder.name },
		createdAt,
		model: "anthropic/claude-sonnet-5-5",
		about: "session",
		focus,
		parts: [
			{
				index: 0,
				title: "Statistics on encrypted data",
				head: folder.git
					? { commit: "e41b09d7a2c8135f6b0e94a7d3c15882f60b7d19", ref: "@worktree" }
					: { commit: "folder" },
			},
		],
		questions,
		warnings: [],
	};
	if (sessionId !== undefined) quiz.sessionId = sessionId;
	return { quiz, secrets };
}

const TOPIC_STAGES = [
	"Reading the conversation of the session",
	"Reading the files of the folder",
	"Writing the questions (3 of 8)",
	"Writing the questions (8 of 8)",
	"Checking every citation",
];

const STAGES = [
	"Reading the changes",
	"Reading the conversation of the session",
	"Writing the questions (3 of 8)",
	"Writing the questions (8 of 8)",
	"Checking every citation against the commit",
];
const STAGE_MS = 1200;
const OPEN_COST_USD = 0.012;
const STAKES_QUESTIONS = 10;

/** What the high-stakes mock (./mock-stakes) adds to quizzes: the stakes facts of a quiz, and the news of a finished attempt. */
export interface MockQuizStakes {
	/** The stakes facts of a quiz; undefined for one that was not made for a high-stakes session. */
	of(id: string): QuizStakes | undefined;
	/** An attempt that asks every question was finished (every question answered). */
	finished(quiz: Quiz, attempt: QuizAttempt): void;
}

export interface MockQuiz {
	/** Fields the mock companion's `hosts` frame needs for the app to offer quizzes. */
	capabilities: { canQuiz: true; canQuizTopic: true };
	/** Make a ready quiz of {@link STAKES_QUESTIONS} choice questions (`a` is right in each) for a high-stakes session's push, with an open first attempt. */
	addStakesQuiz(id: string, sessionId: string, delta: boolean): void;
	handles(request: CompanionRequest): boolean;
	/** Open answers wait for the "model", so the reply is a promise. */
	answer(request: CompanionRequest): Promise<CompanionReply>;
	/** Every quiz timer stops. */
	stop(): void;
}

export function createMockQuiz(options: {
	/** A quiz was added, changed or removed: pushed to every guest as `quiz-changed`. */
	onChanged(id: string): void;
	/** The omp session that a running quiz is written by, so the app can offer to watch it. */
	instanceId: string;
	/** Milliseconds a stage of writing lasts; tests make it short. */
	stageMs?: number;
	/** Milliseconds the "model" takes to grade an open answer. */
	gradeMs?: number;
	/** Set when the quizzes are those of high-stakes sessions. */
	stakes?: MockQuizStakes;
}): MockQuiz {
	const stageMs = options.stageMs ?? STAGE_MS;
	const gradeMs = options.gradeMs ?? 700;
	const now = Date.now();
	const quizzes = new Map<string, StoredQuiz>();
	let counter = 0;

	const refreshSummary = (stored: StoredQuiz): void => {
		const { summary, quiz, attempts } = stored;
		if (quiz === null) return;
		const latest = attempts.reduce<QuizAttempt | undefined>(
			(best, attempt) => (best === undefined || attempt.startedAt >= best.startedAt ? attempt : best),
			undefined,
		);
		summary.attemptCount = attempts.length;
		summary.partCount = quiz.parts.length;
		summary.questionCount = quiz.questions.length;
		summary.latest =
			latest === undefined
				? undefined
				: {
						points: latest.score.points,
						total: latest.score.total,
						percent: latest.score.percent,
						finished: latest.finishedAt !== undefined,
						at: latest.finishedAt ?? latest.startedAt,
					};
	};

	const attemptOf = (
		quiz: Quiz,
		id: string,
		startedAt: number,
		questions: string[],
		answers: Record<string, QuizAnswerRecord>,
		retryOf?: string,
	): QuizAttempt => {
		const attempt: QuizAttempt = {
			id,
			startedAt,
			questions,
			answers,
			score: { points: 0, total: 0, percent: 0, byPart: [], revisit: [] },
		};
		if (retryOf !== undefined) attempt.retryOf = retryOf;
		attempt.score = scoreAttempt(quiz.questions, attempt);
		if (questions.every(question => Object.hasOwn(answers, question))) {
			attempt.finishedAt = Math.max(startedAt, ...Object.values(answers).map(answer => answer.at));
		}
		return attempt;
	};

	const stackQuiz = (
		id: string,
		title: string,
		parts: typeof PARTS,
		createdAt: number,
	): { quiz: Quiz; secrets: Map<string, Secret> } => {
		const { questions, secrets } = questionsOf(parts);
		const quizParts: QuizPart[] = parts.map((part, index) => ({
			index,
			title: part.pr.title,
			pr: { number: part.pr.number, url: part.pr.url, head: part.pr.head, base: part.pr.base },
			head: { commit: part.commit, ref: `pr/${part.pr.number}`, subject: part.pr.title },
			base: { commit: "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22", ref: part.pr.base },
		}));
		return {
			quiz: {
				v: QUIZ_VERSION,
				id,
				title,
				repo: { root: MOCK_QUIZ_ROOT, name: "interfold", github: "example/interfold" },
				createdAt,
				model: "anthropic/claude-sonnet-5-5",
				parts: quizParts,
				questions,
				warnings: ["One question was dropped: none of its citations were in the commit."],
			},
			secrets,
		};
	};

	const changesQuiz = (
		id: string,
		createdAt: number,
		sessionId?: string,
	): { quiz: Quiz; secrets: Map<string, Secret> } => {
		// One part: the session's own work, asking about a few of the same files.
		const specs = [PARTS[1]!.specs[0]!, PARTS[0]!.specs[2]!, PARTS[1]!.specs[2]!];
		const { questions, secrets } = questionsOf([{ specs }]);
		const quiz: Quiz = {
			v: QUIZ_VERSION,
			id,
			title: "interfold @ worktree vs main",
			repo: { root: MOCK_QUIZ_ROOT, name: "interfold", github: "example/interfold" },
			createdAt,
			model: "anthropic/claude-sonnet-5-5",
			parts: [
				{
					index: 0,
					title: "What the session changed",
					head: { commit: "e41b09d7a2c8135f6b0e94a7d3c15882f60b7d19", ref: "@worktree" },
					base: { commit: "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22", ref: "main" },
				},
			],
			questions,
			warnings: [],
		};
		if (sessionId !== undefined) quiz.sessionId = sessionId;
		return { quiz, secrets };
	};

	const put = (stored: StoredQuiz): StoredQuiz => {
		quizzes.set(stored.summary.id, stored);
		refreshSummary(stored);
		return stored;
	};

	const readyStored = (
		built: { quiz: Quiz; secrets: Map<string, Secret> },
		over: Partial<QuizSummary>,
		attempts: QuizAttempt[],
	): StoredQuiz =>
		put({
			summary: {
				id: built.quiz.id,
				title: built.quiz.title,
				repoRoot: built.quiz.repo.root,
				subject: "",
				createdAt: built.quiz.createdAt,
				status: "ready",
				maxCostUsd: 1,
				...over,
			},
			quiz: built.quiz,
			secrets: built.secrets,
			attempts,
			failedOnce: false,
		});

	// A finished stack quiz with one finished attempt: five of seven points, three topics to revisit.
	{
		const built = stackQuiz("qz-stack", "interfold · PRs #2243–#2244", PARTS.slice(0, 2), now - 2 * DAY);
		const sample: Record<string, { text?: string; choice?: string }> = {
			q1: { text: "Because the crate gets built twice in tests, so the two copies don't match." },
			q2: { choice: "b" },
			q3: { text: "I think it saves some disk space." },
			q4: { choice: "c" },
			q5: {
				text: "Two tasks can both miss and both connect; the later insert overwrites the first, which is harmless.",
			},
			q6: { choice: "b" },
			q7: { text: "Every call did a new handshake." },
		};
		const answers: Record<string, QuizAnswerRecord> = {};
		let at = now - 2 * DAY + 10 * 60_000;
		for (const question of built.quiz.questions) {
			const secret = built.secrets.get(question.id)!;
			const given = sample[question.id]!;
			answers[question.id] = { ...given, verdict: gradeAnswer(secret, given), at };
			at += 90_000;
		}
		readyStored(built, { subject: "PRs #2243–#2244", costUsd: 0.64 }, [
			attemptOf(
				built.quiz,
				"a1",
				now - 2 * DAY + 5 * 60_000,
				built.quiz.questions.map(q => q.id),
				answers,
			),
		]);
	}
	// A quiz of a session's changes, two of three questions answered: opening it resumes at the third.
	{
		const built = changesQuiz("qz-session", now - 3 * HOUR, "session-7");
		const answers: Record<string, QuizAnswerRecord> = {};
		const sample: Record<string, { text: string }> = {
			q1: { text: "Two tasks may both miss and connect twice; the second insert replaces the first." },
			q2: { text: "It would use memory forever." },
		};
		let at = now - 2 * HOUR;
		for (const [id, given] of Object.entries(sample)) {
			answers[id] = { ...given, verdict: gradeAnswer(built.secrets.get(id)!, given), at };
			at += 60_000;
		}
		readyStored(built, { subject: "worktree vs main", costUsd: 0.41, sessionId: "session-7" }, [
			attemptOf(
				built.quiz,
				"a1",
				now - 2 * HOUR - 60_000,
				built.quiz.questions.map(q => q.id),
				answers,
			),
		]);
	}
	quizzes.set("qz-failed", {
		summary: {
			id: "qz-failed",
			title: "interfold · PR #2231",
			repoRoot: MOCK_QUIZ_ROOT,
			subject: "PR #2231",
			createdAt: now - 5 * HOUR,
			status: "failed",
			error: "Stopped at the $1.00 cost limit before the questions were checked.",
			costUsd: 1,
			maxCostUsd: 1,
		},
		quiz: null,
		secrets: new Map(),
		attempts: [],
		failedOnce: false,
	});
	// Another repository's quiz, listed only when every repository is.
	{
		const built = changesQuiz("qz-other", now - 9 * DAY);
		built.quiz.title = "acme-shop @ feature/refunds vs main";
		built.quiz.repo = { root: OTHER_ROOT, name: "acme-shop" };
		readyStored(built, { subject: "feature/refunds vs main", repoRoot: OTHER_ROOT, costUsd: 0.52 }, [
			attemptOf(
				built.quiz,
				"a1",
				now - 9 * DAY,
				built.quiz.questions.map(q => q.id),
				{},
			),
		]);
	}
	// A quiz on the topic of the session without a project, one question answered: its folder's list and a verdict of a background question.
	{
		const built = topicQuizOf("qz-topic", now - HOUR, TOPIC_CWD, "understanding", TOPIC_SESSION_ID);
		const given = { choice: "b" };
		const answers: Record<string, QuizAnswerRecord> = {
			q1: { ...given, verdict: gradeAnswer(built.secrets.get("q1")!, given), at: now - HOUR + 60_000 },
		};
		readyStored(built, { ...topicSummary("understanding"), sessionId: TOPIC_SESSION_ID, costUsd: 0.21 }, [
			attemptOf(
				built.quiz,
				"a1",
				now - HOUR,
				built.quiz.questions.map(q => q.id),
				answers,
			),
		]);
	}

	const push = (id: string): void => options.onChanged(id);

	/** Tick a quiz through its stages, pushing each, then finish it as ready (or as failed when asked to). */
	const run = (
		stored: StoredQuiz,
		request: QuizCreate,
		finish: () => { quiz: Quiz; secrets: Map<string, Secret> },
		topic = false,
	): void => {
		let stage = 0;
		const { summary } = stored;
		const stages = topic
			? TOPIC_STAGES
			: request.sessionId === undefined
				? STAGES.filter(name => !name.includes("conversation"))
				: STAGES;
		summary.status = "running";
		summary.instanceId = options.instanceId;
		summary.progress = stages[0];
		push(summary.id);
		stored.timer = setInterval(() => {
			stage++;
			if (request.model === "mock/fail" && stage === 2) {
				clearInterval(stored.timer);
				Object.assign(summary, {
					status: "failed",
					progress: undefined,
					instanceId: undefined,
					error: "The agent stopped before it wrote any question: the model refused the request.",
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
			stored.quiz = built.quiz;
			stored.secrets = built.secrets;
			const first = built.quiz.questions.map(question => question.id);
			stored.attempts = [attemptOf(built.quiz, "a1", Date.now(), first, {})];
			Object.assign(summary, { status: "ready", progress: undefined, instanceId: undefined, costUsd: 0.38 });
			refreshSummary(stored);
			push(summary.id);
		}, stageMs);
	};

	const need = (id: string): StoredQuiz => {
		const stored = quizzes.get(id);
		if (stored === undefined) throw new Error(`no quiz ${id}`);
		return stored;
	};
	const ready = (id: string): StoredQuiz & { quiz: Quiz } => {
		const stored = need(id);
		if (stored.quiz === null) throw new Error(`The quiz ${id} is not ready.`);
		return stored as StoredQuiz & { quiz: Quiz };
	};
	const attemptById = (stored: StoredQuiz, id: string): QuizAttempt => {
		const attempt = stored.attempts.find(item => item.id === id);
		if (attempt === undefined) throw new Error(`no attempt ${id}`);
		return attempt;
	};

	const stackFor = (pr: number): { stack: QuizStackPr[]; source: "branches" | "none" } => {
		const at = PARTS.findIndex(part => part.pr.number === pr);
		if (at !== -1) return { stack: PARTS.map(part => part.pr), source: "branches" };
		return {
			stack: [{ number: pr, title: `Pull request #${pr}`, head: `feature/pr-${pr}`, base: "main" }],
			source: "none",
		};
	};

	const withStakes = (summary: QuizSummary): QuizSummary => {
		const stakes = options.stakes?.of(summary.id);
		return stakes === undefined
			? { ...summary }
			: { ...summary, stakes: { delta: stakes.delta, passed: stakes.passedAttempt !== undefined } };
	};

	const addStakesQuiz = (id: string, sessionId: string, delta: boolean): void => {
		const specs = Array.from({ length: STAKES_QUESTIONS }, (_, at): QuestionSpec => ({
			question: {
				kind: "choice",
				prompt: `What does the event bus do with an event? (${at + 1} of ${STAKES_QUESTIONS})`,
				topic: `Event routing ${at + 1}`,
				refs: [cite("crates/events/src/lib.rs", "pub use bus")],
				choices: [
					{ id: "a", text: "It routes the event to its subscribers" },
					{ id: "b", text: "It drops the event" },
					{ id: "c", text: "It writes the event to a database" },
				],
			},
			secret: {
				kind: "choice",
				answer: "a",
				explanation: "The bus routes every typed event to the subscribers that asked for it.",
				refs: [cite("crates/events/src/lib.rs", "pub use bus")],
			},
		}));
		const { questions, secrets } = questionsOf([{ specs }]);
		const quiz: Quiz = {
			v: QUIZ_VERSION,
			id,
			title: delta ? "interfold · changes since your last pass" : "interfold @ worktree vs main",
			repo: { root: MOCK_QUIZ_ROOT, name: "interfold", github: "example/interfold" },
			createdAt: Date.now(),
			model: "anthropic/claude-sonnet-5-5",
			sessionId,
			parts: [
				{
					index: 0,
					title: "What the session changed",
					head: { commit: "e41b09d7a2c8135f6b0e94a7d3c15882f60b7d19", ref: "@worktree" },
					base: { commit: "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22", ref: "main" },
				},
			],
			questions,
			warnings: [],
		};
		readyStored(
			{ quiz, secrets },
			{ subject: delta ? "changes since your last pass" : "worktree vs main", sessionId, costUsd: 0.2 },
			[
				attemptOf(
					quiz,
					"a1",
					Date.now(),
					questions.map(question => question.id),
					{},
				),
			],
		);
		push(id);
	};

	return {
		capabilities: { canQuiz: true, canQuizTopic: true },
		addStakesQuiz,
		handles: request => request.t.startsWith("quiz-"),
		stop() {
			for (const stored of quizzes.values()) clearInterval(stored.timer);
		},
		async answer(request): Promise<CompanionReply> {
			switch (request.t) {
				case "quiz-list": {
					// Every folder of the mock computer is a folder of the fixture repository, but a session's scratch folder is its own.
					const rows = [...quizzes.values()]
						.map(stored => withStakes(stored.summary))
						.filter(
							summary =>
								request.cwd === undefined ||
								summary.repoRoot === (isScratch(request.cwd) ? request.cwd : MOCK_QUIZ_ROOT),
						)
						.sort((a, b) => b.createdAt - a.createdAt);
					return { t: "quiz-list", reqId: request.reqId, quizzes: rows };
				}
				case "quiz-create": {
					const focus = request.focus ?? QUIZ_DEFAULT_FOCUS;
					if (!QUIZ_FOCUSES.includes(focus)) throw new Error(`Unknown focus ${String(focus)}.`);
					if (request.subject === "session") {
						if (request.sessionId === undefined)
							throw new Error("A quiz on a session's topic needs the session.");
						const topicId = `qz-new-${++counter}`;
						const built = topicQuizOf(topicId, Date.now(), request.cwd, focus, request.sessionId);
						const summary: QuizSummary = {
							id: topicId,
							title: built.quiz.title,
							repoRoot: built.quiz.repo.root,
							...topicSummary(focus),
							createdAt: built.quiz.createdAt,
							status: "running",
							maxCostUsd: request.maxCostUsd ?? 1,
							sessionId: request.sessionId,
						};
						const stored: StoredQuiz = {
							summary,
							quiz: null,
							secrets: new Map(),
							attempts: [],
							failedOnce: false,
						};
						quizzes.set(topicId, stored);
						run(stored, request, () => built, true);
						return { t: "quiz-create", reqId: request.reqId, id: topicId };
					}
					const id = `qz-new-${++counter}`;
					const parts =
						request.stack !== undefined
							? PARTS.filter(part => request.stack!.includes(part.pr.number))
							: request.pr !== undefined
								? PARTS.filter(part => part.pr.number === request.pr)
								: [];
					const subject =
						request.stack !== undefined && request.stack.length > 1
							? `PRs #${request.stack[0]}–#${request.stack[request.stack.length - 1]}`
							: request.pr !== undefined || request.stack !== undefined
								? `PR #${request.pr ?? request.stack?.[0]}`
								: "worktree vs main";
					const summary: QuizSummary = {
						id,
						title: `interfold · ${subject}`,
						repoRoot: MOCK_QUIZ_ROOT,
						subject,
						createdAt: Date.now(),
						status: "running",
						maxCostUsd: request.maxCostUsd ?? 1,
					};
					if (request.sessionId !== undefined) summary.sessionId = request.sessionId;
					if (request.focus !== undefined) summary.focus = request.focus;
					const stored: StoredQuiz = { summary, quiz: null, secrets: new Map(), attempts: [], failedOnce: false };
					quizzes.set(id, stored);
					run(stored, request, () => {
						const built =
							parts.length > 0
								? stackQuiz(id, summary.title, parts, Date.now())
								: changesQuiz(id, Date.now(), request.sessionId);
						if (request.focus !== undefined) built.quiz.focus = request.focus;
						return built;
					});
					return { t: "quiz-create", reqId: request.reqId, id };
				}
				case "quiz-get": {
					const stored = ready(request.id);
					// The quiz as stored has no rubric: the secrets are a separate table, never part of the reply.
					return {
						t: "quiz-get",
						reqId: request.reqId,
						quiz: stored.quiz,
						attempts: stored.attempts,
						stakes: options.stakes?.of(stored.summary.id),
					};
				}
				case "quiz-answer": {
					const stored = ready(request.id);
					const attempt = attemptById(stored, request.attempt);
					if (!attempt.questions.includes(request.question))
						throw new Error(`The attempt does not ask ${request.question}.`);
					if (Object.hasOwn(attempt.answers, request.question))
						throw new Error("That question was already answered in this attempt.");
					const question = stored.quiz.questions.find(item => item.id === request.question)!;
					if (question.kind === "open") {
						const text = request.text ?? "";
						if (text.trim() === "") throw new Error("An open question needs an answer.");
						if (text.length > QUIZ_MAX_ANSWER_CHARS)
							throw new Error(`The answer is longer than ${QUIZ_MAX_ANSWER_CHARS} characters.`);
						if (text.trim() === "/limit")
							throw new Error(
								`The quiz reached its spending limit of $${stored.summary.maxCostUsd?.toFixed(2) ?? "1.00"}; grading stopped.`,
							);
						if (text.trim() === "/fail" && !stored.failedOnce) {
							stored.failedOnce = true;
							await Bun.sleep(gradeMs);
							throw new Error("Grading failed: the model did not answer in time. Try again.");
						}
						await Bun.sleep(gradeMs);
					} else if (!(question.choices ?? []).some(item => item.id === request.choice)) {
						throw new Error("Pick one of the choices.");
					}
					const given = question.kind === "choice" ? { choice: request.choice } : { text: request.text };
					const verdict = gradeAnswer(stored.secrets.get(question.id)!, given);
					const record: QuizAnswerRecord = { ...given, verdict, at: Date.now() };
					const answers = { ...attempt.answers, [question.id]: record };
					const updated = attemptOf(
						stored.quiz,
						attempt.id,
						attempt.startedAt,
						attempt.questions,
						answers,
						attempt.retryOf,
					);
					stored.attempts = stored.attempts.map(item => (item.id === updated.id ? updated : item));
					if (question.kind === "open") stored.summary.costUsd = (stored.summary.costUsd ?? 0) + OPEN_COST_USD;
					refreshSummary(stored);
					if (updated.finishedAt !== undefined) options.stakes?.finished(stored.quiz, updated);
					push(stored.summary.id);
					return { t: "quiz-answer", reqId: request.reqId, verdict, attempt: updated };
				}
				case "quiz-retry": {
					const stored = ready(request.id);
					const from =
						request.from === undefined
							? stored.attempts.reduce((best, item) => (item.startedAt >= best.startedAt ? item : best))
							: attemptById(stored, request.from);
					const only = request.only ?? "all";
					const questions =
						only === "all"
							? stored.quiz.questions.map(question => question.id)
							: from.questions.filter(id => {
									const kind = Object.hasOwn(from.answers, id) ? from.answers[id]!.verdict.kind : "wrong";
									return kind !== "right";
								});
					if (questions.length === 0) throw new Error("Nothing was missed in that attempt.");
					const fresh = attemptOf(
						stored.quiz,
						`a${stored.attempts.length + 1}`,
						Date.now(),
						questions,
						{},
						from.id,
					);
					stored.attempts = [...stored.attempts, fresh];
					refreshSummary(stored);
					push(stored.summary.id);
					return { t: "quiz-retry", reqId: request.reqId, attempt: fresh };
				}
				case "quiz-excerpt": {
					const stored = ready(request.id);
					const part = stored.quiz.parts[request.part];
					if (part === undefined) throw new Error(`The quiz has no part ${request.part}.`);
					return {
						t: "quiz-excerpt",
						reqId: request.reqId,
						excerpts: request.refs.map(ref => excerptOf(ref, ref.side === "base" ? part.base : part.head)),
					};
				}
				case "quiz-delete": {
					const stored = quizzes.get(request.id);
					clearInterval(stored?.timer);
					quizzes.delete(request.id);
					push(request.id);
					return { t: "quiz-delete", reqId: request.reqId };
				}
				case "quiz-folder":
					return { t: "quiz-folder", reqId: request.reqId, folder: mockQuizFolder(request.cwd) };
				case "quiz-stack":
					return { t: "quiz-stack", reqId: request.reqId, ...stackFor(request.pr) };
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}

/** The pull requests of the fixture stack, bottom first: the mock companion lists them with its canned pull requests. */
export function mockStackPrs(): QuizStackPr[] {
	return PARTS.map(part => ({ ...part.pr }));
}

/** The fixture's questions with their hidden parts, for tests of grading. */
export function mockQuestionSpecs(): QuestionSpec[] {
	return PARTS.flatMap(part => part.specs);
}

/** The topic quiz's questions with their hidden parts, for tests of grading. */
export function mockTopicSpecs(): QuestionSpec[] {
	return [...TOPIC_SPECS];
}
