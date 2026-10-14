/**
 * Checks a spar before it is stored (see ./companion-spar): the agent's JSON is parsed into points with unknown fields
 * stripped, every citation is checked against the commit of the part it belongs to (the rules of ./companion-citations;
 * a line of the design document is cited as `@design@line@token`), and a point left without a citation is dropped, so a
 * stored spar never shows code that is not there. Pure over a file reader, so the rules are testable without git.
 *
 * The case file of a point (the strongest defence, when to concede, counters, the suggestion) is split off here: it is
 * stored beside the spar and never reaches a device; the reply model reads it (./companion-spar-reply).
 */

import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { SPAR_MAX_POINTS, type SparKind, type SparPoint } from "@oh-my-pi/pi-wire/spar";
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

const MAX_TITLE_CHARS = 160;
const MAX_CHALLENGE_CHARS = 2_400;
const MAX_DEFENCE_CHARS = 1_200;
const MAX_CONDITION_CHARS = 300;
const MAX_CONDITIONS = 3;
const MAX_COUNTERS = 4;
const MAX_IF_DEFENCE_CHARS = 300;
const MAX_COUNTER_CHARS = 700;
const MAX_SUGGESTION_CHARS = 900;
/** Points of one part kept; the brief asks for 4 to 6, this only stops a runaway file. */
export const MAX_POINTS_PER_PART = 6;

const KINDS: readonly SparKind[] = ["alternative", "failure", "cost", "assumption", "migration"];

/** The hidden half of a point: what the partner argues from. Never sent to a device. */
export interface SparCase {
	/** What a good answer says; shown once the point is closed. */
	strongestDefence: string;
	/** Concrete conditions under which the partner must concede. */
	concedeWhen: string[];
	/** The likeliest defences and what the partner says to each, with the code that backs it. */
	counters: { ifDefence: string; counter: string; refs: BlueprintRef[] }[];
	/** The change the partner would suggest if the point is lost. */
	suggestion?: string;
	suggestionRefs: BlueprintRef[];
}

/** A point as the agent wrote it, checked for shape but not yet for its citations. */
export interface ParsedPoint {
	/** Index of its part, from 0. */
	part: number;
	kind: SparKind;
	title: string;
	challenge: string;
	severity: 1 | 2 | 3;
	refs: BlueprintRef[];
	case: SparCase;
}

function strings(value: unknown, max: number, count: number): string[] {
	const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return list
		.map(item => str(item, max))
		.filter((item): item is string => item !== undefined)
		.slice(0, count);
}

function severityOf(value: unknown): 1 | 2 | 3 {
	const number = typeof value === "number" ? value : Number(value);
	return number === 1 || number === 3 ? number : 2;
}

/** The case file of a point, or undefined when it has no strongest defence or no condition to concede on. */
function parseCase(value: unknown): SparCase | undefined {
	if (!isRecord(value)) return undefined;
	const strongestDefence = str(value.strongestDefence ?? value.strongest_defence, MAX_DEFENCE_CHARS);
	const concedeWhen = strings(value.concedeWhen ?? value.concede_when, MAX_CONDITION_CHARS, MAX_CONDITIONS);
	if (strongestDefence === undefined || concedeWhen.length === 0) return undefined;
	const counters: SparCase["counters"] = [];
	for (const raw of Array.isArray(value.counters) ? value.counters : []) {
		if (!isRecord(raw) || counters.length >= MAX_COUNTERS) continue;
		const ifDefence = str(raw.ifDefence ?? raw.if_defence, MAX_IF_DEFENCE_CHARS);
		const counter = str(raw.counter, MAX_COUNTER_CHARS);
		if (ifDefence === undefined || counter === undefined) continue;
		counters.push({ ifDefence, counter, refs: parseRefs(raw.refs) });
	}
	const suggestion = str(value.suggestion, MAX_SUGGESTION_CHARS);
	return {
		strongestDefence,
		concedeWhen,
		counters,
		...(suggestion ? { suggestion } : {}),
		suggestionRefs: parseRefs(value.suggestionRefs ?? value.suggestion_refs),
	};
}

/**
 * The points in the agent's JSON: `{ parts: [{ part: 1, points: [...] }] }`, or a flat `{ points: [{ part: 1, … }] }`;
 * parts are numbered from 1 as in the brief. Points that cannot be used (no title or challenge, an unknown kind, no case
 * file, a part that does not exist) are left out and reported in `warnings`.
 * @throws Error when the JSON is not an object or holds no usable point at all.
 */
export function parseSparOutput(raw: unknown, partCount: number, warnings: string[]): ParsedPoint[] {
	if (!isRecord(raw)) throw new Error("The agent's file is not a JSON object.");
	const found: { part: unknown; value: unknown }[] = [];
	if (Array.isArray(raw.parts)) {
		raw.parts.forEach((part, index) => {
			if (!isRecord(part)) return;
			for (const value of Array.isArray(part.points) ? part.points : [])
				found.push({ part: part.part ?? index + 1, value });
		});
	}
	if (Array.isArray(raw.points)) {
		for (const value of raw.points) found.push({ part: isRecord(value) ? value.part : undefined, value });
	}
	if (found.length === 0) throw new Error("The agent's file has no points.");
	const log = new Warnings();
	const out: ParsedPoint[] = [];
	const perPart = new Map<number, number>();
	for (const { part: rawPart, value } of found) {
		if (!isRecord(value)) continue;
		const number = typeof rawPart === "number" ? rawPart : Number(rawPart ?? 1);
		const part = Number.isInteger(number) ? number - 1 : -1;
		if (part < 0 || part >= partCount) {
			log.add(
				"shape",
				`Skipped a point for part ${String(rawPart)}: the spar has no such part.`,
				n => `Skipped ${n} more malformed points.`,
			);
			continue;
		}
		const title = str(value.title, MAX_TITLE_CHARS);
		const challenge = str(value.challenge, MAX_CHALLENGE_CHARS);
		const kind =
			typeof value.kind === "string" ? KINDS.find(item => item === value.kind!.toString().toLowerCase()) : undefined;
		if (title === undefined || challenge === undefined || kind === undefined) {
			log.add(
				"shape",
				`Skipped a point${title === undefined ? "" : ` "${title.slice(0, 50)}"`}: it needs a title, a challenge and one of the kinds ${KINDS.join(", ")}.`,
				n => `Skipped ${n} more malformed points.`,
			);
			continue;
		}
		const caseFile = parseCase(value.case ?? value.caseFile ?? value.case_file);
		if (caseFile === undefined) {
			log.add(
				"case",
				`Skipped the point "${title.slice(0, 50)}": it has no case file (a strongest defence and a condition to concede on) to argue from.`,
				n => `Skipped ${n} more points without a case file.`,
			);
			continue;
		}
		if ((perPart.get(part) ?? 0) >= MAX_POINTS_PER_PART) {
			log.add(
				"cap",
				`Part ${part + 1} has more than ${MAX_POINTS_PER_PART} points; the rest were cut.`,
				n => `${n} more points over the limit were cut.`,
			);
			continue;
		}
		perPart.set(part, (perPart.get(part) ?? 0) + 1);
		out.push({
			part,
			kind,
			title,
			challenge,
			severity: severityOf(value.severity),
			refs: parseRefs(value.refs),
			case: caseFile,
		});
	}
	warnings.push(...log.list());
	if (out.length === 0) throw new Error("None of the agent's points could be used.");
	return out;
}

export interface SparVerifyIo {
	/** Lines of a file at the commit of `part` (its head, or its base for `side: "base"`) or of the design document (`@design`); null when it is missing, binary or too large. */
	lines(part: number, side: Side, path: string): Promise<string[] | null>;
}

export interface SparVerifyStats extends CitationStats {
	pointsDropped: number;
}

/**
 * The points kept to `max`, the strongest of every part first: the agent writes each part's points strongest first, so
 * taking them in turns across the parts keeps every part represented. Original order is kept.
 */
export function capPoints<T extends { part: number }>(points: readonly T[], max: number): T[] {
	if (points.length <= max) return [...points];
	const byPart = new Map<number, T[]>();
	for (const point of points) byPart.set(point.part, [...(byPart.get(point.part) ?? []), point]);
	const chosen = new Set<T>();
	for (let round = 0; chosen.size < max; round++) {
		let took = false;
		for (const list of byPart.values()) {
			const point = list[round];
			if (point === undefined || chosen.size >= max) continue;
			chosen.add(point);
			took = true;
		}
		if (!took) break;
	}
	return points.filter(point => chosen.has(point));
}

/**
 * Verify the citations of parsed points, drop those left with none, keep at most {@link SPAR_MAX_POINTS} (the strongest of
 * each part), number the survivors `p1`, `p2`… in part order, and split off the case files. Counters and the suggestion
 * lose the citations that fail but are kept.
 */
export async function verifySpar(
	parsed: readonly ParsedPoint[],
	io: SparVerifyIo,
	options: { readConcurrency?: number } = {},
): Promise<{
	points: SparPoint[];
	cases: Record<string, SparCase>;
	warnings: string[];
	stats: SparVerifyStats;
}> {
	const log = new Warnings();
	const stats: SparVerifyStats = { verified: 0, moved: 0, dropped: 0, pointsDropped: 0 };
	const ordered = [...parsed].sort((a, b) => a.part - b.part);
	const kept: { point: ParsedPoint; refs: BlueprintRef[]; case: SparCase }[] = [];
	for (const part of new Set(ordered.map(point => point.part))) {
		const ofPart = ordered.filter(point => point.part === part);
		const wanted = ofPart.flatMap(point => [
			...point.refs,
			...point.case.suggestionRefs,
			...point.case.counters.flatMap(counter => counter.refs),
		]);
		const files = await readCitedFiles(
			wanted.map(ref => ({ side: ref.side ?? "head", path: ref.path })),
			(side, path) => io.lines(part, side, path),
			options.readConcurrency,
		);
		const check = (refs: readonly BlueprintRef[], where: string): BlueprintRef[] =>
			checkCitations(refs, where, ref => ref.side ?? "head", files, stats, log);
		for (const point of ofPart) {
			const where = `part ${part + 1}, point "${point.title.slice(0, 50)}"`;
			const refs = check(point.refs, where);
			if (refs.length === 0) {
				stats.pointsDropped++;
				log.add(
					"uncited",
					`Dropped the point "${point.title.slice(0, 60)}" (part ${part + 1}): ${point.refs.length === 0 ? "it cites no code" : "none of its citations held"}.`,
					n => `${n} more points were dropped for lack of a citation.`,
				);
				continue;
			}
			kept.push({
				point,
				refs,
				case: {
					...point.case,
					counters: point.case.counters.map(counter => ({ ...counter, refs: check(counter.refs, where) })),
					suggestionRefs: check(point.case.suggestionRefs, where),
				},
			});
		}
	}
	const chosen = capPoints(
		kept.map(item => ({ ...item, part: item.point.part })),
		SPAR_MAX_POINTS,
	);
	if (chosen.length < kept.length)
		log.add("cap", `Only the ${SPAR_MAX_POINTS} strongest points were kept.`, n => `${n} more points were cut.`);
	const points: SparPoint[] = [];
	const cases: Record<string, SparCase> = {};
	for (const item of chosen) {
		const id = `p${points.length + 1}`;
		points.push({
			id,
			part: item.point.part,
			kind: item.point.kind,
			title: item.point.title,
			challenge: item.point.challenge,
			severity: item.point.severity,
			refs: item.refs,
		});
		cases[id] = item.case;
	}
	const warnings = log.list();
	if (stats.moved > 0 || stats.dropped > 0)
		warnings.push(
			`Citations checked against the commit: ${stats.verified} correct, ${stats.moved} moved to the right line, ${stats.dropped} dropped.`,
		);
	return { points, cases, warnings, stats };
}
