/**
 * The partner's answer to a defence (see ./companion-spar): one headless `omp -p` run per round (the default model role,
 * no tools, no session, a spend cap; see ./companion-headless) is given the point, its hidden case file, the thread, the
 * new defence and excerpts of the code, and returns a move: concede, partly, or push back. The run's cost is read from
 * omp's own JSON events so the spar's spending limit counts it. The round rule (a push on the last round closes the point
 * as open) is applied here, not by the model.
 */

import * as os from "node:os";
import type { BlueprintExcerpt, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	SPAR_MAX_ROUNDS,
	type SparMove,
	type SparOutcomeBy,
	type SparOutcomeKind,
	type SparPoint,
	type SparTurn,
} from "@oh-my-pi/pi-wire/spar";
import { isRecord } from "../src/tool-render/util";
import { fillTemplate, parseAgentJson } from "./companion-agent";
import { parseRefs, str } from "./companion-citations";
import { headlessOmpArgs, type RunOmp, type RunResult } from "./companion-headless";
import { parseJsonRun, renderExcerpts } from "./companion-quiz-grade";
import replyPromptTemplate from "./companion-spar-reply-prompt.md" with { type: "text" };
import replySystemPrompt from "./companion-spar-reply-system.md" with { type: "text" };
import type { SparCase } from "./companion-spar-verify";

/** The role a reply runs on when the request names none: the model a session would use (not the quiz grader's `@smol`). */
export const DEFAULT_REPLY_MODEL = "@default";
/** The most one reply may spend, USD (also capped by what is left of the spar's limit). */
export const MAX_SPAR_REPLY_COST_USD = 0.5;
/** Less than this left of the spar's limit and a defence is not answered, USD. */
export const MIN_REPLY_BUDGET_USD = 0.002;
export const REPLY_TIMEOUT_MS = 120_000;

const MAX_MESSAGE_CHARS = 2_400;
const MAX_CLAIM_CHARS = 240;
const MAX_CHECKED = 6;
/** Excerpts the reply sees: the point's own refs, then at most this many more for code the defence mentions. */
export const MAX_MENTIONED_EXCERPTS = 3;
const MAX_POINT_EXCERPTS = 3;
const MAX_THREAD_TURN_CHARS = 1_600;

export const REPLY_SYSTEM_PROMPT: string = replySystemPrompt.trim();

const MOVES: Record<string, SparMove> = {
	push: "push",
	"push back": "push",
	"pushes back": "push",
	partly: "partly",
	partial: "partly",
	"partly concede": "partly",
	concede: "concede",
	concedes: "concede",
	conceded: "concede",
};

export interface ParsedReply {
	move: SparMove;
	message: string;
	refs: BlueprintRef[];
	checked: { claim: string; holds: boolean }[];
}

/**
 * The reply's JSON: `{ "move": "push" | "partly" | "concede", "message": "…", "refs": [...], "checked": [...] }`, with or
 * without a markdown fence.
 * @throws Error when it is not that.
 */
export function parseSparReply(raw: string): ParsedReply {
	let value: unknown;
	try {
		value = parseAgentJson(raw);
	} catch {
		// A model that wrapped its JSON in prose: take the outermost braces.
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("the reply was not JSON");
		value = JSON.parse(raw.slice(start, end + 1));
	}
	if (!isRecord(value)) throw new Error("the reply was not a JSON object");
	const word = typeof value.move === "string" ? value.move.trim().toLowerCase() : "";
	const move = Object.hasOwn(MOVES, word) ? MOVES[word] : undefined;
	if (move === undefined) throw new Error("the reply made no usable move");
	const message = str(value.message, MAX_MESSAGE_CHARS);
	if (message === undefined) throw new Error("the reply had no message");
	const checked: ParsedReply["checked"] = [];
	for (const item of Array.isArray(value.checked) ? value.checked : []) {
		if (!isRecord(item) || checked.length >= MAX_CHECKED) continue;
		const claim = str(item.claim, MAX_CLAIM_CHARS);
		if (claim !== undefined && typeof item.holds === "boolean") checked.push({ claim, holds: item.holds });
	}
	return { move, message, refs: parseRefs(value.refs), checked };
}

/**
 * What the move does to the point. A concession or a partial one closes it at once; a push on the last round closes it as
 * open, by the limit; a push before that leaves it open for another round.
 * @param round the round just answered, from 1.
 */
export function applyRound(move: SparMove, round: number): { kind: SparOutcomeKind; by: SparOutcomeBy } | undefined {
	if (move === "concede") return { kind: "held", by: "partner" };
	if (move === "partly") return { kind: "partly", by: "partner" };
	return round >= SPAR_MAX_ROUNDS ? { kind: "open", by: "limit" } : undefined;
}

/**
 * The code a defence mentions, as `path:line`, `path@line` or `path#L12` (a file with an extension, or the design as
 * `@design:12`), the first few, without those already in `known`.
 */
export function defenceMentions(text: string, known: readonly { path: string; line: number }[] = []): BlueprintRef[] {
	const found: BlueprintRef[] = [];
	const seen = new Set(known.map(ref => `${ref.path}:${ref.line}`));
	const re = /(?:^|[\s`'"(,[])(@design|(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?::|@|#L)(\d{1,6})\b/g;
	for (const match of text.matchAll(re)) {
		const path = match[1]!;
		const line = Number(match[2]);
		if (line < 1 || seen.has(`${path}:${line}`)) continue;
		seen.add(`${path}:${line}`);
		found.push({ path, line, token: "" });
		if (found.length >= MAX_MENTIONED_EXCERPTS) break;
	}
	return found;
}

export interface SparReplyInput {
	point: SparPoint;
	partTitle: string;
	case: SparCase;
	/** The turns so far, oldest first. */
	thread: readonly SparTurn[];
	/** The new defence, trimmed. */
	defence: string;
	/** The round this defence is, from 1. */
	round: number;
	/** The point's own excerpts, then those of code the defence mentions (null: not found). */
	excerpts: { own: readonly (BlueprintExcerpt | null)[]; mentioned: readonly (BlueprintExcerpt | null)[] };
	/** What the defence mentioned that could not be found, as `path:line`. */
	notFound: readonly string[];
}

function bullets(items: readonly string[]): string {
	return items.length > 0 ? items.map(item => `- ${item}`).join("\n") : "- (none listed)";
}

function renderThread(thread: readonly SparTurn[]): string {
	if (thread.length === 0) return "(no replies yet: this is the first defence)";
	return thread
		.map(turn => {
			const who = turn.by === "you" ? "Developer" : `Partner (${turn.move ?? "push"})`;
			const text =
				turn.text.length > MAX_THREAD_TURN_CHARS ? `${turn.text.slice(0, MAX_THREAD_TURN_CHARS)} […]` : turn.text;
			return `${who}:\n${text}`;
		})
		.join("\n\n");
}

/** The message the partner is given. The defence is quoted as data, never as instructions. */
export function buildReplyPrompt(input: SparReplyInput): string {
	const last = input.round >= SPAR_MAX_ROUNDS;
	const code = [
		renderExcerpts(input.excerpts.own, MAX_POINT_EXCERPTS),
		...(input.excerpts.mentioned.some(excerpt => excerpt !== null)
			? [renderExcerpts(input.excerpts.mentioned, MAX_MENTIONED_EXCERPTS)]
			: []),
	].join("\n\n");
	return fillTemplate(replyPromptTemplate, {
		part: input.partTitle,
		kind: input.point.kind,
		title: input.point.title,
		challenge: input.point.challenge,
		strongestDefence: input.case.strongestDefence,
		concedeWhen: bullets(input.case.concedeWhen),
		counters:
			input.case.counters.length > 0
				? input.case.counters
						.map(item => `- If the defence is: ${item.ifDefence}\n  Say: ${item.counter}`)
						.join("\n")
				: "- (none listed)",
		thread: renderThread(input.thread),
		round: String(input.round),
		maxRounds: String(SPAR_MAX_ROUNDS),
		roundNote: last
			? "This is the last round. If the defence does not meet a concede condition, push: the point closes as open and your message is your closing statement."
			: "You may push, concede or partly concede.",
		code,
		notFound:
			input.notFound.length > 0
				? `The defence cites code that was not found: ${input.notFound.join(", ")}. Treat those claims as unverified.`
				: "",
		defence: input.defence.replaceAll("</defence", "<\\/defence"),
	}).trim();
}

export interface ReplyOptions {
	ompBin: string;
	model: string;
	run: RunOmp;
	/** What is left of the spar's spending limit, USD. */
	budgetUsd: number;
	input: SparReplyInput;
}

export interface ReplyResult {
	reply: ParsedReply;
	costUsd?: number;
}

/** Why a defence could not be answered: the run failed, or what it said was not a move. */
export class ReplyError extends Error {
	constructor(
		message: string,
		/** What the failed run spent anyway, USD. */
		readonly costUsd?: number,
	) {
		super(message);
	}
}

/**
 * Answer a defence with one model call.
 * @throws ReplyError when the run fails, times out, hits its spend cap or answers with something that is not a move.
 */
export async function replyToDefence(options: ReplyOptions): Promise<ReplyResult> {
	const maxCostUsd = Math.round(Math.min(options.budgetUsd, MAX_SPAR_REPLY_COST_USD) * 10_000) / 10_000;
	const argv = headlessOmpArgs({
		ompBin: options.ompBin,
		model: options.model,
		systemPrompt: REPLY_SYSTEM_PROMPT,
		maxCostUsd,
		extra: ["--mode", "json"],
	});
	let result: RunResult;
	try {
		// A neutral folder: the project's own context files and settings have no part in this.
		result = await options.run(argv, buildReplyPrompt(options.input), os.tmpdir());
	} catch (err) {
		throw new ReplyError(`the reply run failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const run = parseJsonRun(result.out);
	try {
		// omp exits non-zero once its spend cap is reached, but only after the turn is complete: an answer it printed is good.
		return { reply: parseSparReply(run.text), costUsd: run.costUsd };
	} catch (err) {
		if (result.code === 0) throw new ReplyError(err instanceof Error ? err.message : String(err), run.costUsd);
		const reason =
			result.err
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.pop() ?? `exit ${result.code}`;
		throw new ReplyError(`omp exited with ${result.code}: ${reason}`, run.costUsd);
	}
}
