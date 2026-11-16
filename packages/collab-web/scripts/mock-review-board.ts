/**
 * The review board's requests for scripts/mock-companion.ts: `pr-stack`, `pr-own-diff` and `review-notes`, canned, so the
 * board (palette → Review board, or Review board on a pull request) can be tried in a browser without a repository,
 * `gh` or a model.
 *
 * The three pull requests of the quiz's fixture stack (#2243, #2244, #2245, bottom first) each have their own diff; any
 * other number is a pull request alone (one file, two hunks). `review-notes` answers for whatever files the board sends
 * (a branch or a session's changes too), by the hunk's place in its file: the first has a note quoted from a session, the
 * second one that is *weak* (a remark that is not about the change: it counts as unexplained until generated), the third
 * on has none. With `generate: true` the weak note is rewritten (a *generated* note that keeps the session it came from)
 * and the rest are written, so nothing is left unexplained; the generate takes a moment, as a model would.
 */

import type { BoardFile, HunkNote, PrOwnDiff, ReviewNotesReply, StackPr } from "../src/lib/review-board";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { mockStackPrs } from "./mock-quiz";

/** How long a canned `generate` takes. */
const GENERATE_MS = 900;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** A hunk of canned lines (` ` context, `-` removed, `+` added), its header counted from them. */
function hunk(oldStart: number, newStart: number, section: string, lines: string[]): string[] {
	const before = lines.filter(line => !line.startsWith("+")).length;
	const after = lines.filter(line => !line.startsWith("-")).length;
	return [`@@ -${oldStart},${before} +${newStart},${after} @@${section === "" ? "" : ` ${section}`}`, ...lines];
}

function file(path: string, status: BoardFile["status"], hunks: string[][]): BoardFile {
	const body = hunks.flat();
	const header = [
		`diff --git a/${path} b/${path}`,
		`--- ${status === "added" ? "/dev/null" : `a/${path}`}`,
		`+++ b/${path}`,
	];
	return {
		path,
		status,
		diff: `${[...header, ...body].join("\n")}\n`,
		added: body.filter(line => line.startsWith("+")).length,
		removed: body.filter(line => line.startsWith("-")).length,
	};
}

interface CannedPr {
	head: string;
	/** The commit `against` names: the base branch's tip, or the head of the pull request below. */
	baseSha: string;
	files: BoardFile[];
}

const SHA = (seed: string): string => seed.repeat(40).slice(0, 40);

const OWN_DIFFS = new Map<number, CannedPr>([
	[
		2243,
		{
			head: SHA("9c41e07b"),
			baseSha: SHA("5be29d0c"),
			files: [
				file("crates/events/Cargo.toml", "added", [
					hunk(0, 1, "", [
						"+[package]",
						'+name = "e3-events"',
						"+version.workspace = true",
						"+edition.workspace = true",
						"+",
						"+[dependencies]",
						'+tokio = { workspace = true, features = ["sync"] }',
					]),
				]),
				file("crates/events/src/runtime.rs", "modified", [
					hunk(12, 12, "use std::sync::Arc;", [
						" use tokio::sync::broadcast;",
						" ",
						"-pub struct EventRuntime {",
						"-    bus: broadcast::Sender<Event>,",
						"+/// Owns the event bus; every subscriber gets its own receiver.",
						"+pub struct EventRuntime {",
						"+    bus: broadcast::Sender<Event>,",
						"+    capacity: usize,",
						" }",
					]),
					hunk(41, 43, "impl EventRuntime {", [
						"     pub fn new() -> Self {",
						"-        let (bus, _) = broadcast::channel(64);",
						"-        Self { bus }",
						"+        let capacity = 1024;",
						"+        let (bus, _) = broadcast::channel(capacity);",
						"+        Self { bus, capacity }",
						"     }",
					]),
				]),
			],
		},
	],
	[
		2244,
		{
			head: SHA("a77f31c0"),
			baseSha: SHA("9c41e07b"),
			files: [
				file("crates/evm/src/provider_cache.rs", "modified", [
					hunk(8, 8, "use alloy::providers::Provider;", [
						" use std::collections::HashMap;",
						"-use std::sync::Mutex;",
						"+use tokio::sync::RwLock;",
						" ",
						" pub struct ProviderCache {",
					]),
					hunk(27, 27, "impl ProviderCache {", [
						"-    pub fn get(&self, chain: u64) -> Option<Arc<dyn Provider>> {",
						"-        self.inner.lock().unwrap().get(&chain).cloned()",
						"+    pub async fn get(&self, chain: u64) -> Option<Arc<dyn Provider>> {",
						"+        self.inner.read().await.get(&chain).cloned()",
						"     }",
					]),
				]),
			],
		},
	],
	[
		2245,
		{
			head: SHA("c3d58a6e"),
			baseSha: SHA("a77f31c0"),
			files: [
				file("crates/sortition/src/committee.rs", "modified", [
					hunk(15, 15, "pub struct Committee {", [
						"     pub members: Vec<Address>,",
						"-    pub threshold: usize,",
						"+    pub threshold: u32,",
						" }",
					]),
					hunk(33, 33, "impl Committee {", [
						"-    pub fn load(db: &Db, round: u64) -> Self {",
						"-        db.committees().get(round).unwrap()",
						"+    pub fn load(registry: &Registry, round: u64) -> Result<Self> {",
						"+        registry.committee(round).ok_or(Error::UnknownRound(round))",
						"     }",
					]),
					hunk(58, 58, "", [
						"     fn quorum(&self) -> usize {",
						"-        self.threshold + 1",
						"+        self.threshold as usize + 1",
						"     }",
					]),
				]),
			],
		},
	],
]);

/** A pull request nobody canned: alone, one file, two hunks. */
function aloneDiff(): CannedPr {
	return {
		head: SHA("7d02f4a9"),
		baseSha: SHA("5be29d0c"),
		files: [
			file("src/auth/refresh.ts", "modified", [
				hunk(21, 21, "export async function refresh(token: string) {", [
					"   const record = await store.find(token);",
					"-  if (!record) return null;",
					'+  if (!record || record.revoked) throw new AuthError("unknown refresh token");',
					"   const next = rotate(record);",
				]),
				hunk(44, 44, "function rotate(record: Record) {", [
					"-  return { ...record, used: true };",
					"+  return { ...record, used: true, rotatedAt: Date.now() };",
					" }",
				]),
			]),
		],
	};
}

const SESSION_TITLE = "Event runtime in its own crate";

/** What a file's hunks have, by place: a session quote for the first, a weak remark for the second, a model's words. */
interface CannedNotes {
	said?: string;
	weak?: string;
	intent: string[];
	generated: string[];
}

const NOTES = new Map<string, CannedNotes>([
	[
		"crates/events/src/runtime.rs",
		{
			said: "The bus capacity was a magic number inside `new`; it is a field now so the runtime can report it, and the default is raised because a burst of events was dropping slow subscribers.",
			weak: "Cwd is the repo root; use absolute paths.",
			intent: ["Make bus capacity explicit", "Raise the default capacity"],
			generated: [
				"Documents the runtime and stores the channel capacity on it, so callers can read it back.",
				"Builds the channel from a named capacity of 1024 instead of the literal 64 and keeps it on the runtime.",
			],
		},
	],
	[
		"crates/events/Cargo.toml",
		{
			said: "The runtime moves into its own crate, `e3-events`, so the crates that only publish events no longer pull in the whole node; it needs nothing but tokio's sync feature.",
			intent: ["Create the events crate"],
			generated: ["Declares the new crate with workspace versioning and tokio's sync feature."],
		},
	],
	[
		"crates/evm/src/provider_cache.rs",
		{
			weak: "Switch to the async lock.",
			intent: ["Use async lock", "Make get async"],
			generated: [
				"Swaps the blocking mutex for tokio's RwLock, so a slow chain lookup does not block the executor thread.",
				"Makes `get` async and takes the read lock, which lets concurrent lookups of cached providers proceed together.",
			],
		},
	],
	[
		"crates/sortition/src/committee.rs",
		{
			said: "The committee's threshold is a `u32` now because it is read from the on-chain registry, where it is stored as one; `quorum` casts it back where a length is needed.",
			weak: "Updated the loader.",
			intent: ["Make threshold u32", "Read from the registry", "Cast in quorum"],
			generated: [
				"Changes the threshold type to the registry's `u32`.",
				"Loads a committee from the registry and returns an error for an unknown round instead of unwrapping.",
				"Casts the `u32` threshold to `usize` where the quorum is computed.",
			],
		},
	],
	[
		"src/auth/refresh.ts",
		{
			said: "A revoked refresh token used to look the same as an unknown one and returned `null`, which callers then treated as a logged-out user; it now throws an AuthError so they can tell the two apart.",
			weak: "Add the timestamp.",
			intent: ["Reject revoked tokens", "Record rotation time"],
			generated: [
				"Throws an AuthError for an unknown or revoked token instead of returning null.",
				"Stores the time of each rotation next to the `used` flag, which the audit log reads.",
			],
		},
	],
]);

/** What a file the canned notes do not know (a branch's, a session's) has: nothing from a session, a model's words. */
function genericNotes(path: string): CannedNotes {
	const name = path.split("/").at(-1) ?? path;
	return { intent: [], generated: [`Changes ${name} as the diff shows.`] };
}

/** The hunk headers (`@@ -a,b +c,d @@`) of a file's diff, in order. */
function headers(diff: string): string[] {
	return diff.split("\n").flatMap(line => HUNK_RE.exec(line)?.[0] ?? []);
}

export interface MockReviewBoard {
	/** Fields the mock companion's `hosts` frame needs for the app to offer the board. */
	capabilities: { canReviewBoard: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

export function createMockReviewBoard(
	/** Titles of the pull requests the mock lists, by number. */
	titleOf: (number: number) => string | undefined,
): MockReviewBoard {
	const now = Date.now();
	const stack = mockStackPrs();
	const stackOf = (number: number): StackPr[] =>
		(stack.some(pr => pr.number === number)
			? stack
			: [
					{
						number,
						head: `feature/pr-${number}`,
						base: "main",
						url: `https://github.com/example/app/pull/${number}`,
						title: titleOf(number) ?? `Pull request #${number}`,
					},
				]
		).map(pr => ({
			number: pr.number,
			title: pr.title,
			head: pr.head,
			base: pr.base,
			url: pr.url ?? `https://github.com/example/app/pull/${pr.number}`,
			state: "open",
		}));

	function ownDiff(number: number): PrOwnDiff {
		const below = stack[stack.findIndex(pr => pr.number === number) - 1];
		const canned = OWN_DIFFS.get(number) ?? aloneDiff();
		return {
			number,
			head: canned.head,
			against: { ref: below?.head ?? "main", sha: canned.baseSha },
			files: canned.files,
		};
	}

	function notes(query: Extract<CompanionRequest, { t: "review-notes" }>["query"]): ReviewNotesReply {
		const notes: HunkNote[] = [];
		let unexplained = 0;
		for (const { path, diff } of query.files) {
			const canned = NOTES.get(path) ?? genericNotes(path);
			headers(diff).forEach((hunkHeader, at) => {
				const anchor = { path, hunk: hunkHeader };
				const session = {
					sessionId: "mock-collab-session",
					sessionTitle: SESSION_TITLE,
					turn: 3 + at,
					at: now - (at + 1) * 60_000,
					intent: canned.intent[at] ?? "Edit",
				};
				const written = canned.generated[at] ?? canned.generated.at(-1) ?? "Changes the code as the diff shows.";
				if (at === 0 && canned.said !== undefined) {
					notes.push({ ...anchor, text: canned.said, source: "session", ...session });
				} else if (at === 1 && canned.weak !== undefined) {
					// A remark that is not about this change: unexplained until a model has rewritten it.
					if (query.generate) notes.push({ ...anchor, text: written, source: "generated", ...session, at: now });
					else notes.push({ ...anchor, text: canned.weak, source: "session", ...session, weak: true });
					if (!query.generate) unexplained++;
				} else if (query.generate) {
					notes.push({ ...anchor, text: written, source: "generated", at: now });
				} else {
					unexplained++;
				}
			});
		}
		return { notes, unexplained, canGenerate: true };
	}

	return {
		capabilities: { canReviewBoard: true },
		handles: request => request.t === "pr-stack" || request.t === "pr-own-diff" || request.t === "review-notes",
		async answer(request) {
			switch (request.t) {
				case "pr-stack":
					return { t: "pr-stack", reqId: request.reqId, stack: stackOf(request.number) };
				case "pr-own-diff":
					return { t: "pr-own-diff", reqId: request.reqId, diff: ownDiff(request.number) };
				case "review-notes":
					if (request.query.generate) await Bun.sleep(GENERATE_MS);
					return { t: "review-notes", reqId: request.reqId, reply: notes(request.query) };
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
