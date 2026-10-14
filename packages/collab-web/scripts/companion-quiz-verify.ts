/**
 * Checks a quiz before it is stored (see ./companion-quiz): the agent's JSON is parsed into questions with unknown
 * fields stripped, every citation is checked against the commit of the part it belongs to (the rules of
 * ./companion-citations), and a question left without a citation is dropped, so a stored quiz never shows code that is
 * not there. Pure over a file reader, so the rules are testable without git.
 *
 * The answer key (the rubric of an open question, the right choice of a choice question) is split off here: it is
 * stored beside the quiz and reaches a device only inside the verdict of an answered question.
 */

import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { QuizChoice, QuizQuestion } from "@oh-my-pi/pi-wire/quiz";
import { isRecord } from "../src/tool-render/util";
import {
	type CitationStats,
	checkCitations,
	parseRefs,
	readCitedFiles,
	type Side,
	str,
	Warnings,
} from "./companion-citations";
import { seeded } from "./companion-seed";

const MAX_PROMPT_CHARS = 700;
const MAX_REMINDER_CHARS = 900;
const MAX_TOPIC_CHARS = 60;
const MAX_POINT_CHARS = 400;
const MAX_POINTS = 8;
const MAX_MISCONCEPTIONS = 5;
const MAX_MODEL_ANSWER_CHARS = 1_400;
const MAX_CHOICE_CHARS = 300;
const MAX_EXPLANATION_CHARS = 700;
const MIN_CHOICES = 2;
const MAX_CHOICES = 5;
/** Questions of one part kept; the brief asks for fewer, this only stops a runaway file. */
export const MAX_QUESTIONS_PER_PART = 8;
const CHOICE_IDS = "abcde";

/** The hidden half of a question: what grading compares an answer with. */
export interface QuizKey {
	/** Open questions. */
	rubric?: { points: string[]; misconceptions: string[]; modelAnswer?: string };
	/** Choice questions: the id of the right choice. */
	answer?: string;
	/** Choice questions: why the right choice is right and the tempting one is not. */
	explanation?: string;
}

/** A question as the agent wrote it, checked for shape but not yet for its citations. */
export interface ParsedQuestion {
	/** Index of its part, from 0. */
	part: number;
	kind: "open" | "choice";
	prompt: string;
	reminder?: string;
	topic: string;
	refs: BlueprintRef[];
	rubric?: { points: string[]; misconceptions: string[]; modelAnswer?: string };
	/** Choice questions: the options as written, and the index of the right one. */
	choices?: string[];
	answer?: number;
	explanation?: string;
}

function strings(value: unknown, max: number, count: number): string[] {
	const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return list
		.map(item => str(item, max))
		.filter((item): item is string => item !== undefined)
		.slice(0, count);
}

/** `answer` as an index into `choices`: a letter (`b`), a number (0-based or `"2"`), or the text of the choice. */
function answerIndex(value: unknown, choices: readonly string[]): number | undefined {
	if (typeof value === "number" && Number.isInteger(value))
		return value >= 0 && value < choices.length ? value : undefined;
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (/^[a-e]$/i.test(text)) {
		const index = CHOICE_IDS.indexOf(text.toLowerCase());
		return index < choices.length ? index : undefined;
	}
	if (/^\d$/.test(text)) {
		const index = Number(text);
		return index < choices.length ? index : undefined;
	}
	const exact = choices.findIndex(choice => choice.toLowerCase() === text.toLowerCase());
	return exact === -1 ? undefined : exact;
}

/**
 * The questions in the agent's JSON: `{ parts: [{ part: 1, questions: [...] }] }`, or a flat `{ questions: [{ part: 1, … }] }`;
 * parts are numbered from 1 as in the brief. Questions that cannot be used (no prompt, an open one without a rubric, a
 * choice one without a clear right answer, a part that does not exist) are left out and reported in `warnings`.
 * @throws Error when the JSON is not an object or holds no question at all.
 */
export function parseQuizOutput(raw: unknown, partCount: number, warnings: string[]): ParsedQuestion[] {
	if (!isRecord(raw)) throw new Error("The agent's file is not a JSON object.");
	const found: { part: unknown; value: unknown }[] = [];
	if (Array.isArray(raw.parts)) {
		raw.parts.forEach((part, index) => {
			if (!isRecord(part)) return;
			for (const value of Array.isArray(part.questions) ? part.questions : [])
				found.push({ part: part.part ?? index + 1, value });
		});
	}
	if (Array.isArray(raw.questions)) {
		for (const value of raw.questions) found.push({ part: isRecord(value) ? value.part : undefined, value });
	}
	if (found.length === 0) throw new Error("The agent's file has no questions.");
	const log = new Warnings();
	const out: ParsedQuestion[] = [];
	const perPart = new Map<number, number>();
	for (const { part: rawPart, value } of found) {
		if (!isRecord(value)) continue;
		const number = typeof rawPart === "number" ? rawPart : Number(rawPart);
		const part = Number.isInteger(number) ? number - 1 : -1;
		const prompt = str(value.prompt ?? value.question, MAX_PROMPT_CHARS);
		if (part < 0 || part >= partCount || prompt === undefined) {
			log.add(
				"shape",
				part < 0 || part >= partCount
					? `Skipped a question for part ${String(rawPart)}: the quiz has no such part.`
					: "Skipped a question without a prompt.",
				n => `Skipped ${n} more malformed questions.`,
			);
			continue;
		}
		if ((perPart.get(part) ?? 0) >= MAX_QUESTIONS_PER_PART) {
			log.add(
				"cap",
				`Part ${part + 1} has more than ${MAX_QUESTIONS_PER_PART} questions; the rest were cut.`,
				n => `${n} more questions over the limit were cut.`,
			);
			continue;
		}
		const topic = str(value.topic, MAX_TOPIC_CHARS) ?? prompt.slice(0, MAX_TOPIC_CHARS);
		const common = {
			part,
			prompt,
			topic,
			...(str(value.reminder, MAX_REMINDER_CHARS) ? { reminder: str(value.reminder, MAX_REMINDER_CHARS) } : {}),
			refs: parseRefs(value.refs),
		};
		const choiceTexts = Array.isArray(value.choices)
			? value.choices
					.map(choice => str(isRecord(choice) ? choice.text : choice, MAX_CHOICE_CHARS))
					.filter((choice): choice is string => choice !== undefined)
			: undefined;
		if (value.kind === "choice" || choiceTexts !== undefined) {
			const index = choiceTexts === undefined ? undefined : answerIndex(value.answer, choiceTexts);
			if (
				choiceTexts === undefined ||
				choiceTexts.length < MIN_CHOICES ||
				choiceTexts.length > MAX_CHOICES ||
				index === undefined
			) {
				log.add(
					"choice",
					`Skipped the multiple-choice question "${prompt.slice(0, 60)}": it needs ${MIN_CHOICES}–${MAX_CHOICES} choices and a clear right one.`,
					n => `Skipped ${n} more malformed multiple-choice questions.`,
				);
				continue;
			}
			out.push({
				...common,
				kind: "choice",
				choices: choiceTexts,
				answer: index,
				...(str(value.explanation, MAX_EXPLANATION_CHARS)
					? { explanation: str(value.explanation, MAX_EXPLANATION_CHARS) }
					: {}),
			});
		} else {
			const rubric = isRecord(value.rubric) ? value.rubric : { points: value.rubric };
			const points = strings(rubric.points ?? rubric.key_points ?? rubric.keyPoints, MAX_POINT_CHARS, MAX_POINTS);
			if (points.length === 0) {
				log.add(
					"rubric",
					`Skipped the question "${prompt.slice(0, 60)}": it has no rubric to grade an answer against.`,
					n => `Skipped ${n} more questions without a rubric.`,
				);
				continue;
			}
			const modelAnswer = str(
				value.model_answer ?? value.modelAnswer ?? rubric.model_answer ?? rubric.modelAnswer,
				MAX_MODEL_ANSWER_CHARS,
			);
			out.push({
				...common,
				kind: "open",
				rubric: {
					points,
					misconceptions: strings(rubric.misconceptions, MAX_POINT_CHARS, MAX_MISCONCEPTIONS),
					...(modelAnswer ? { modelAnswer } : {}),
				},
			});
		}
		perPart.set(part, (perPart.get(part) ?? 0) + 1);
	}
	warnings.push(...log.list());
	if (out.length === 0) throw new Error("None of the agent's questions could be used.");
	return out;
}

export interface QuizVerifyIo {
	/** Lines of a file at the commit of `part` (its head, or its base for `side: "base"`); null when it is missing, binary or too large. */
	lines(part: number, side: Side, path: string): Promise<string[] | null>;
}

export interface QuizVerifyStats extends CitationStats {
	questionsDropped: number;
}

/**
 * Verify the citations of parsed questions, drop those left with none, shuffle the choices (agents put the right one
 * first or second far too often), number the survivors `q1`, `q2`… in part order, and split off the answer keys.
 * @param seed makes the shuffle repeatable (the quiz's id).
 */
export async function verifyQuiz(
	parsed: readonly ParsedQuestion[],
	io: QuizVerifyIo,
	seed: string,
	options: { readConcurrency?: number } = {},
): Promise<{ questions: QuizQuestion[]; keys: Record<string, QuizKey>; warnings: string[]; stats: QuizVerifyStats }> {
	const log = new Warnings();
	const stats: QuizVerifyStats = { verified: 0, moved: 0, dropped: 0, questionsDropped: 0 };
	const ordered = [...parsed].sort((a, b) => a.part - b.part);
	const questions: QuizQuestion[] = [];
	const keys: Record<string, QuizKey> = {};
	const random = seeded(seed);
	for (const part of new Set(ordered.map(question => question.part))) {
		const ofPart = ordered.filter(question => question.part === part);
		const files = await readCitedFiles(
			ofPart.flatMap(question => question.refs.map(ref => ({ side: ref.side ?? "head", path: ref.path }))),
			(side, path) => io.lines(part, side, path),
			options.readConcurrency,
		);
		for (const question of ofPart) {
			const where = `part ${part + 1}, question "${question.prompt.slice(0, 50)}"`;
			const refs = checkCitations(question.refs, where, ref => ref.side ?? "head", files, stats, log);
			if (refs.length === 0) {
				stats.questionsDropped++;
				log.add(
					"uncited",
					`Dropped the question "${question.prompt.slice(0, 60)}" (part ${part + 1}): ${question.refs.length === 0 ? "it cites no code" : "none of its citations held"}.`,
					n => `${n} more questions were dropped for lack of a citation.`,
				);
				continue;
			}
			const id = `q${questions.length + 1}`;
			let choices: QuizChoice[] | undefined;
			if (question.kind === "choice" && question.choices && question.answer !== undefined) {
				const order = question.choices.map((_, index) => index);
				for (let i = order.length - 1; i > 0; i--) {
					const j = Math.floor(random() * (i + 1));
					[order[i], order[j]] = [order[j]!, order[i]!];
				}
				choices = order.map((index, position) => ({ id: CHOICE_IDS[position]!, text: question.choices![index]! }));
				keys[id] = {
					answer: CHOICE_IDS[order.indexOf(question.answer)]!,
					...(question.explanation ? { explanation: question.explanation } : {}),
				};
			} else if (question.rubric) {
				keys[id] = { rubric: question.rubric };
			}
			questions.push({
				id,
				part,
				kind: question.kind,
				prompt: question.prompt,
				...(question.reminder ? { reminder: question.reminder } : {}),
				topic: question.topic,
				refs,
				...(choices ? { choices } : {}),
			});
		}
	}
	const warnings = log.list();
	if (stats.moved > 0 || stats.dropped > 0)
		warnings.push(
			`Citations checked against the commit: ${stats.verified} correct, ${stats.moved} moved to the right line, ${stats.dropped} dropped.`,
		);
	return { questions, keys, warnings, stats };
}
