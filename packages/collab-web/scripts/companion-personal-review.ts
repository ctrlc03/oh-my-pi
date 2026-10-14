/**
 * The Personal agent's nightly review (docs/personal-agent.md "Learning loop"): once a day, after `review.time`, a short
 * headless run in the Personal profile reads the day's record, stores clear-cut facts, proposes About-you lines and
 * writes the digest. This module decides whether the run is due and allowed, builds its prompt, starts it through
 * {@link ReviewDeps.runOmp} and records what happened in `reviews.jsonl`. It owns no timer: the companion's poll calls
 * {@link PersonalReview.tick}.
 *
 * A due review is attempted once per local day. A skip (no login, spend limit, nothing new) is recorded and marks the
 * day too, so it is not retried; a busy live session is the one exception and is retried for an hour.
 */

import * as fs from "node:fs/promises";
import type { AdminDayRecord, MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import type {
	PersonalChangeKind,
	PersonalProposal,
	PersonalReviewStatus,
	PersonalSettings,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalProfile } from "./companion-personal-profile";
import { OMP_EXIT_BUDGET, type PersonalOmpResult, type PersonalOmpRun } from "./companion-personal-run";
import type {
	JsonlStore,
	PersonalPaths,
	PersonalRejected,
	PersonalReviewRecord,
	PersonalStateStore,
} from "./companion-personal-store";
import promptTemplate from "./companion-personal-review.md" with { type: "text" };

/** How much of the day's record goes into the prompt. */
export const MAX_RECORD_CHARS = 24_000;
/** A run that takes longer is killed. */
export const REVIEW_TIMEOUT_MS = 20 * 60_000;
/** A due review waits this long for a busy live session before it is skipped for the day. */
export const BUSY_RETRY_MS = 60 * 60_000;

const MAX_LISTED_PENDING = 30;
const MAX_LISTED_REJECTED = 50;
const MAX_LISTED_TEXT_CHARS = 300;
const MAX_ERROR_CHARS = 300;

type ReviewSkip = NonNullable<PersonalReviewStatus["skipped"]>;

export interface ReviewDeps {
	paths: PersonalPaths;
	now(): number;
	settings(): PersonalSettings;
	state: PersonalStateStore;
	reviews: JsonlStore<PersonalReviewRecord>;
	proposals: JsonlStore<PersonalProposal>;
	rejected: JsonlStore<PersonalRejected>;
	/**
	 * Called after every run that started omp, ok or not: the inbox module counts the proposals and finds the digest the
	 * run made since `since` and records the cost on the digest.
	 */
	finishReview(arg: { since: number; costUsd: number | null }): Promise<{ proposals: number; digestId?: string }>;
	profile: Pick<PersonalProfile, "writeOverlay">;
	ompBin: string;
	openAdmin(options?: { readOnly?: boolean }): MemoryAdmin;
	loginReady(): Promise<boolean>;
	/** The day and month spend windows allow another run. */
	limitsAllow(): Promise<boolean>;
	/** The live Personal session is working; null when there is no live session. */
	sessionBusy(): boolean | null;
	runOmp(run: PersonalOmpRun): Promise<PersonalOmpResult>;
	/** Where the review's config overlay is written (`runKind: review`). */
	overlayFile: string;
	changed(what: PersonalChangeKind[]): void;
	alert(alert: { title: string; body: string; tag: string }): Promise<unknown>;
}

export interface PersonalReview {
	/** Start the day's review when it is due. Single-flight; returns at once while a run is in progress. */
	tick(): Promise<void>;
	/** Review today now, whatever the time and the day mark say. Login, limits, a busy session and nothing new still stop it. */
	runNow(): Promise<PersonalReviewStatus>;
	status(): Promise<PersonalReviewStatus>;
}

/** Local `YYYY-MM-DD`. */
export function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The local moment `time` (`HH:MM`) falls on the day of `ms`; null for a malformed time. */
export function reviewTimeOn(ms: number, time: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes).getTime();
}

/** The next local `time` strictly after `ms`; null for a malformed time. */
export function nextReviewAt(ms: number, time: string): number | null {
	const today = reviewTimeOn(ms, time);
	if (today === null) return null;
	if (today > ms) return today;
	const d = new Date(ms);
	return reviewTimeOn(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime(), time);
}

/**
 * Text of a proposal or a rejection, made safe to sit in the prompt: the fence markers are broken so the text
 * cannot open or close an `<<<UNTRUSTED` block, newlines are folded, and the whole is a quoted, bounded string.
 */
function quoted(text: string): string {
	const clipped = text.length > MAX_LISTED_TEXT_CHARS ? `${text.slice(0, MAX_LISTED_TEXT_CHARS)}…` : text;
	return JSON.stringify(clipped.replaceAll("<<<", "\u2039\u2039\u2039").replaceAll(">>>", "\u203a\u203a\u203a"));
}

function pendingLine(proposal: PersonalProposal): string {
	const where = [
		proposal.section ? `section ${quoted(proposal.section)}` : "",
		proposal.target ? `line ${quoted(proposal.target)}` : "",
	]
		.filter(part => part !== "")
		.join(", ");
	return `- ${proposal.op}${where === "" ? "" : ` (${where})`}: ${quoted(proposal.text)}`;
}

/** Fill `{{name}}` placeholders in one pass, so a value is never searched for placeholders itself. */
function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (Object.hasOwn(values, name) ? values[name]! : ""));
}

/** The last few lines of a child's stderr, for the failure shown to the owner. */
function stderrTail(result: PersonalOmpResult): string {
	const tail = result.stderr.trim();
	const short = tail.length > MAX_ERROR_CHARS ? `…${tail.slice(-MAX_ERROR_CHARS)}` : tail;
	if (result.timedOut) return short === "" ? "timed out" : `timed out: ${short}`;
	return short === "" ? `omp exited with status ${result.exitCode}` : short;
}

/** What a finished attempt records; `costUsd` and the counts come from the run, the rest from the decision. */
type Outcome = Pick<
	PersonalReviewRecord,
	"ok" | "costUsd" | "proposals" | "digestId" | "error" | "skipped" | "covered"
>;

export function createPersonalReview(deps: ReviewDeps): PersonalReview {
	let inFlight: Promise<PersonalReviewStatus> | null = null;

	async function status(): Promise<PersonalReviewStatus> {
		const rows = await deps.reviews.list();
		let last: PersonalReviewRecord | undefined;
		for (const row of rows) if (last === undefined || row.at >= last.at) last = row;
		const review = deps.settings().review;
		return {
			lastAt: last?.at ?? null,
			ok: last?.ok ?? null,
			costUsd: last?.costUsd ?? null,
			proposals: last?.proposals ?? 0,
			...(last?.digestId === undefined ? {} : { digestId: last.digestId }),
			...(last?.error === undefined ? {} : { error: last.error }),
			...(last?.skipped === undefined ? {} : { skipped: last.skipped }),
			nextAt: review.enabled ? nextReviewAt(deps.now(), review.time) : null,
		};
	}

	/** Why a review must not run now, before the record is even read. */
	async function blocker(manual: boolean): Promise<ReviewSkip | undefined> {
		const review = deps.settings().review;
		if (manual && (!review.enabled || review.budgetUsd <= 0)) return "disabled";
		if (!(await deps.loginReady())) return "no-login";
		if (!(await deps.limitsAllow())) return "spend-limit";
		if (deps.sessionBusy() === true) return "agent-busy";
		return undefined;
	}

	/** Memories an earlier review of `day` was shown (a run that finished, or stopped at its budget). */
	async function coveredBefore(day: string): Promise<Set<string>> {
		const covered = new Set<string>();
		for (const row of await deps.reviews.list()) {
			if (row.day !== day || row.skipped !== undefined) continue;
			if (!row.ok && row.error !== "budget") continue;
			for (const id of row.covered ?? []) covered.add(id);
		}
		return covered;
	}

	async function buildPrompt(day: string, record: string): Promise<string> {
		const pending = (await deps.proposals.list())
			.filter(proposal => proposal.status === "pending")
			.slice(-MAX_LISTED_PENDING)
			.map(pendingLine);
		const rejected = (await deps.rejected.list())
			.slice(-MAX_LISTED_REJECTED)
			.map(row => `- ${quoted(row.normalised)} (rejected ${localDay(row.at)})`);
		return fill(promptTemplate, {
			day,
			budget: String(deps.settings().review.budgetUsd),
			record: record.trim() === "" ? "(nothing was recorded)" : record.trim(),
			pending: pending.length === 0 ? "(none)" : pending.join("\n"),
			rejected: rejected.length === 0 ? "(none)" : rejected.join("\n"),
		}).trim();
	}

	/**
	 * Cost of the run: the ledger lines appended during `[startedAt, endedAt]` by any session but the live one. An
	 * approximation: another headless run (a source poll) overlapping the window is counted too, and so is the live
	 * session's own spend when it is not the one `state.session` names.
	 */
	async function ledgerCost(startedAt: number, endedAt: number): Promise<number | null> {
		let text: string;
		try {
			text = await fs.readFile(deps.paths.ledgerFile, "utf8");
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
		}
		const live = deps.state.read().session?.sessionId;
		let total = 0;
		for (const line of text.split("\n")) {
			if (!line.startsWith("{")) continue;
			try {
				const row = JSON.parse(line) as Partial<Record<"at" | "sessionId" | "costUsd", unknown>>;
				if (typeof row.at !== "number" || row.at < startedAt || row.at > endedAt) continue;
				if (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0) continue;
				if (live !== undefined && row.sessionId === live) continue;
				total += row.costUsd;
			} catch {
				// a torn last line
			}
		}
		return total;
	}

	/** Start the run for `day` and say what came of it. */
	async function runReview(day: string, record: AdminDayRecord): Promise<Outcome> {
		const startedAt = deps.now();
		const covered = record.memoryIds;
		let result: PersonalOmpResult;
		try {
			const prompt = await buildPrompt(day, record.text);
			await deps.profile.writeOverlay("review", deps.overlayFile);
			result = await deps.runOmp({
				ompBin: deps.ompBin,
				prompt,
				maxCostUsd: deps.settings().review.budgetUsd,
				overlayFile: deps.overlayFile,
				cwd: deps.paths.workspace,
				timeoutMs: REVIEW_TIMEOUT_MS,
			});
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { ok: false, costUsd: null, proposals: 0, error };
		}
		const costUsd = await ledgerCost(startedAt, deps.now());
		const made = { costUsd, covered, ...(await deps.finishReview({ since: startedAt, costUsd })) };
		if (!result.timedOut && result.exitCode === OMP_EXIT_BUDGET) return { ok: false, ...made, error: "budget" };
		if (result.timedOut || result.exitCode !== 0) return { ok: false, ...made, error: stderrTail(result) };
		return { ok: true, ...made };
	}

	/** Append the attempt's record, mark the day, tell the devices; a failed run alerts the owner. */
	async function conclude(day: string, outcome: Outcome): Promise<PersonalReviewStatus> {
		const at = deps.now();
		const record: PersonalReviewRecord = {
			id: `review-${day}-${at}`,
			day,
			at,
			ok: outcome.ok,
			costUsd: outcome.costUsd,
			proposals: outcome.proposals,
			...(outcome.digestId === undefined ? {} : { digestId: outcome.digestId }),
			...(outcome.error === undefined ? {} : { error: outcome.error }),
			...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
			...(outcome.covered === undefined ? {} : { covered: outcome.covered }),
		};
		await deps.reviews.put(record);
		await deps.state.update(state => ({ ...state, reviewDay: day }));
		deps.changed(["status"]);
		if (!outcome.ok && outcome.skipped === undefined && outcome.error !== "budget") {
			try {
				await deps.alert({
					title: "Nightly review failed",
					body: outcome.error ?? "The review run failed.",
					tag: "personal-review",
				});
			} catch {
				// the record is written and the status shows the failure; a failed push must not fail the review
			}
		}
		return status();
	}

	/** The attempt for `day`; `due` is when the scheduled time fell, for a tick (a manual run has none). */
	async function attempt(day: string, due: number | null): Promise<PersonalReviewStatus> {
		const manual = due === null;
		const skip = async (reason: ReviewSkip): Promise<PersonalReviewStatus> => {
			if (manual) return { ...(await status()), skipped: reason };
			return conclude(day, { ok: false, costUsd: null, proposals: 0, skipped: reason });
		};

		const blocked = await blocker(manual);
		if (blocked === "agent-busy" && due !== null && deps.now() < due + BUSY_RETRY_MS) return status();
		if (blocked !== undefined) return skip(blocked);

		let record: AdminDayRecord;
		try {
			const admin = deps.openAdmin({ readOnly: true });
			try {
				record = admin.recordForDay(day, MAX_RECORD_CHARS);
			} finally {
				admin.close();
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return conclude(day, { ok: false, costUsd: null, proposals: 0, error });
		}
		const seen = await coveredBefore(day);
		if (record.memoryIds.every(id => seen.has(id))) return skip("nothing-new");

		return conclude(day, await runReview(day, record));
	}

	function single(work: () => Promise<PersonalReviewStatus>): Promise<PersonalReviewStatus> {
		const run = work().finally(() => {
			inFlight = null;
		});
		inFlight = run;
		return run;
	}

	return {
		async tick() {
			if (inFlight !== null) return;
			const review = deps.settings().review;
			if (!review.enabled || review.budgetUsd <= 0) return;
			const now = deps.now();
			const due = reviewTimeOn(now, review.time);
			if (due === null || now < due) return;
			const day = localDay(now);
			if (deps.state.read().reviewDay === day) return;
			await single(() => attempt(day, due));
		},
		runNow() {
			return inFlight ?? single(() => attempt(localDay(deps.now()), null));
		},
		status,
	};
}
