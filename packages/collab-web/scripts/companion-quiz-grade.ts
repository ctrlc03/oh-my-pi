/**
 * Grading of quiz answers (see ./companion-quiz). A choice answer is graded on the spot against its key, with no
 * model. An open answer goes to a small headless `omp -p` run (the cheap `smol` role, no tools, no session, a spend cap;
 * see ./companion-headless): it is given the question, the hidden rubric, the cited code and the answer, and returns a
 * verdict with an explanation in the tone of a patient reviewer. The run's cost is read from omp's own JSON events so the
 * quiz's spending limit counts it.
 */

import * as os from "node:os";
import type { BlueprintExcerpt, BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { QuizQuestion, QuizVerdict, QuizVerdictKind } from "@oh-my-pi/pi-wire/quiz";
import { isRecord } from "../src/tool-render/util";
import { fillTemplate, parseAgentJson } from "./companion-agent";
import { parseRefs, str } from "./companion-citations";
import { headlessOmpArgs, type RunOmp, type RunResult } from "./companion-headless";
import gradePromptTemplate from "./companion-quiz-grade-prompt.md" with { type: "text" };
import gradeSystemPrompt from "./companion-quiz-grade-system.md" with { type: "text" };
import type { QuizKey } from "./companion-quiz-verify";

/** Cheap model role by default: `@smol` resolves to the role's default even when settings do not configure it. */
export const DEFAULT_GRADE_MODEL = "@smol";
/** The most one grading call may spend, USD (also capped by what is left of the quiz's limit). */
export const MAX_GRADE_CALL_COST_USD = 0.25;
/** Less than this left of the quiz's limit and an open answer is not graded, USD. */
export const MIN_GRADE_BUDGET_USD = 0.002;
export const GRADE_TIMEOUT_MS = 120_000;

const MAX_EXPLANATION_CHARS = 2_400;
/** Lines of cited code the grader sees per citation, and citations per question. */
const GRADE_EXCERPT_LINES = 24;
const GRADE_MAX_EXCERPTS = 3;

/** The verdict of a choice answer. @throws Error when `choice` is not one of the question's choices. */
export function gradeChoice(question: QuizQuestion, key: QuizKey, choice: string): QuizVerdict {
	const picked = question.choices?.find(candidate => candidate.id === choice);
	if (picked === undefined || key.answer === undefined) throw new Error("invalid choice");
	const right = question.choices?.find(candidate => candidate.id === key.answer);
	const why = key.explanation ? ` ${key.explanation}` : "";
	return picked.id === key.answer
		? { kind: "right", explanation: `That is the one.${why}`, answer: key.answer, graded: "local" }
		: {
				kind: "wrong",
				explanation: `The right answer is **${key.answer.toUpperCase()}**${right ? `: ${right.text}` : ""}.${why}`,
				answer: key.answer,
				graded: "local",
			};
}

/** Cited code as the grader reads it: the lines around each citation, numbered, the cited line marked. */
export function renderExcerpts(excerpts: readonly (BlueprintExcerpt | null)[]): string {
	const blocks: string[] = [];
	for (const excerpt of excerpts) {
		if (excerpt === null || blocks.length >= GRADE_MAX_EXCERPTS) continue;
		const half = Math.floor(GRADE_EXCERPT_LINES / 2);
		const from = Math.max(excerpt.start, excerpt.line - half);
		const to = Math.min(excerpt.start + excerpt.lines.length - 1, excerpt.line + half);
		const body = excerpt.lines
			.slice(from - excerpt.start, to - excerpt.start + 1)
			.map((line, i) => `${from + i === excerpt.line ? ">" : " "} ${String(from + i).padStart(4)}  ${line}`)
			.join("\n");
		blocks.push(`${excerpt.side === "base" ? "base:" : ""}${excerpt.path}:${excerpt.line}\n${body}`);
	}
	return blocks.length > 0 ? blocks.join("\n\n") : "(no code excerpt was available)";
}

export interface GradeInput {
	question: Pick<QuizQuestion, "prompt" | "reminder" | "topic">;
	partTitle: string;
	rubric: NonNullable<QuizKey["rubric"]>;
	excerpts: string;
	answer: string;
}

function bullets(items: readonly string[]): string {
	return items.length > 0 ? items.map(item => `- ${item}`).join("\n") : "- (none listed)";
}

/** The message the grader is given. The answer is quoted as data, never as instructions. */
export function buildGradePrompt(input: GradeInput): string {
	return fillTemplate(gradePromptTemplate, {
		part: input.partTitle,
		topic: input.question.topic,
		prompt: input.question.prompt,
		reminder: input.question.reminder ?? "",
		points: bullets(input.rubric.points),
		misconceptions: bullets(input.rubric.misconceptions),
		modelAnswer: input.rubric.modelAnswer ?? "(none given)",
		code: input.excerpts,
		answer: input.answer,
	}).trim();
}

export const GRADE_SYSTEM_PROMPT: string = gradeSystemPrompt.trim();

const VERDICTS: Record<string, QuizVerdictKind> = {
	right: "right",
	correct: "right",
	partly: "partly",
	"partly right": "partly",
	partial: "partly",
	"mostly right": "partly",
	wrong: "wrong",
	"not quite": "wrong",
	incorrect: "wrong",
	"right idea, wrong direction": "partly",
};

export interface ParsedGrade {
	kind: QuizVerdictKind;
	explanation: string;
	refs: BlueprintRef[];
}

/**
 * The grader's JSON: `{ "verdict": "right" | "partly" | "wrong", "explanation": "…", "refs": ["path@line@token"] }`,
 * with or without a markdown fence.
 * @throws Error when it is not that.
 */
export function parseGrade(raw: string): ParsedGrade {
	let value: unknown;
	try {
		value = parseAgentJson(raw);
	} catch {
		// A model that wrapped its JSON in prose: take the outermost braces.
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("the grader did not answer with JSON");
		value = JSON.parse(raw.slice(start, end + 1));
	}
	if (!isRecord(value)) throw new Error("the grader did not answer with a JSON object");
	const word = typeof value.verdict === "string" ? value.verdict.trim().toLowerCase() : "";
	const kind = Object.hasOwn(VERDICTS, word) ? VERDICTS[word] : undefined;
	const explanation = str(value.explanation, MAX_EXPLANATION_CHARS);
	if (kind === undefined) throw new Error("the grader gave no usable verdict");
	if (explanation === undefined) throw new Error("the grader gave no explanation");
	return { kind, explanation, refs: parseRefs(value.refs) };
}

/** What a headless `omp -p --mode json` run said and cost, from its JSON event lines. */
export interface JsonRun {
	text: string;
	/** Spend of the run's assistant messages, USD; undefined when omp reported none. */
	costUsd?: number;
	model?: string;
}

/** The final assistant text and the total spend in the event stream of `omp -p --mode json`. */
export function parseJsonRun(out: string): JsonRun {
	let text = "";
	let cost: number | undefined;
	let model: string | undefined;
	for (const line of out.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			!isRecord(event) ||
			event.type !== "message_end" ||
			!isRecord(event.message) ||
			event.message.role !== "assistant"
		)
			continue;
		const message = event.message;
		const parts = Array.isArray(message.content) ? message.content : [];
		const answer = parts
			.filter(
				(part): part is { type: "text"; text: string } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map(part => part.text)
			.join("");
		if (answer !== "") text = answer;
		if (typeof message.model === "string") model = message.model;
		const total = isRecord(message.usage) && isRecord(message.usage.cost) ? message.usage.cost.total : undefined;
		if (typeof total === "number" && Number.isFinite(total)) cost = (cost ?? 0) + total;
	}
	return { text, costUsd: cost, model };
}

export interface GradeOpenOptions {
	ompBin: string;
	model: string;
	run: RunOmp;
	/** What is left of the quiz's spending limit, USD. */
	budgetUsd: number;
	input: GradeInput;
}

export interface GradeOpenResult {
	grade: ParsedGrade;
	costUsd?: number;
}

/** Why an answer could not be graded: the run failed, or what it said was not a verdict. */
export class GradeError extends Error {
	constructor(
		message: string,
		/** What the failed run spent anyway, USD. */
		readonly costUsd?: number,
	) {
		super(message);
	}
}

/**
 * Grade an open answer with one small model call.
 * @throws GradeError when the run fails, times out, hits its spend cap or answers with something that is not a verdict.
 */
export async function gradeOpen(options: GradeOpenOptions): Promise<GradeOpenResult> {
	const maxCostUsd = Math.round(Math.min(options.budgetUsd, MAX_GRADE_CALL_COST_USD) * 10_000) / 10_000;
	const argv = headlessOmpArgs({
		ompBin: options.ompBin,
		model: options.model,
		systemPrompt: GRADE_SYSTEM_PROMPT,
		maxCostUsd,
		extra: ["--mode", "json"],
	});
	let result: RunResult;
	try {
		// A neutral folder: the project's own context files and settings have no part in this.
		result = await options.run(argv, buildGradePrompt(options.input), os.tmpdir());
	} catch (err) {
		throw new GradeError(`the grading run failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const run = parseJsonRun(result.out);
	try {
		// omp exits non-zero once its spend cap is reached, but only after the turn is complete: an answer it printed is good.
		return { grade: parseGrade(run.text), costUsd: run.costUsd };
	} catch (err) {
		if (result.code === 0) throw new GradeError(err instanceof Error ? err.message : String(err), run.costUsd);
		const reason =
			result.err
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.pop() ?? `exit ${result.code}`;
		throw new GradeError(`omp exited with ${result.code}: ${reason}`, run.costUsd);
	}
}
