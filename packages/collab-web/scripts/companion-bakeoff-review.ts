/**
 * The reviewer's verdict of a bake-off (docs/design-review.md, *Reviewer verdict*): the JSON file it writes, checked
 * for shape (a ranking that lists every label exactly once, scores on a 1–5 scale), and every citation checked against
 * the commit of the entry its label prefix names (`A/path@line@token`). A finding keeps its text whether or not its
 * citations hold, but is stored unverified when none survive; a label that does not exist drops the citation.
 */

import type { BakeoffFinding } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import { checkCitations, parseRefText, readCitedFiles, str, Warnings } from "./companion-citations";
import { isRecord } from "../src/tool-render/util";

const MAX_VERDICT_CHARS = 20_000;
const MAX_FINDINGS_PER_ENTRY = 6;
const MAX_FINDING_CHARS = 700;
const MAX_UNSURE = 8;

export interface ParsedFinding {
	text: string;
	/** `A/path@line@token` as the reviewer wrote them. */
	refs: string[];
}

/** The reviewer's file as it came, in the labels the reviewer read. */
export interface ParsedReview {
	ranking: string[];
	entries: Record<string, { scores: Record<string, number>; strengths: ParsedFinding[]; weaknesses: ParsedFinding[] }>;
	verdict: string;
	unsure: string[];
}

function findings(value: unknown): ParsedFinding[] {
	if (!Array.isArray(value)) return [];
	const out: ParsedFinding[] = [];
	for (const item of value) {
		const text = isRecord(item) ? str(item.text, MAX_FINDING_CHARS) : str(item, MAX_FINDING_CHARS);
		if (text === undefined) continue;
		const refs =
			isRecord(item) && Array.isArray(item.refs) ? item.refs.filter((r): r is string => typeof r === "string") : [];
		out.push({ text, refs: refs.slice(0, 6) });
		if (out.length >= MAX_FINDINGS_PER_ENTRY) break;
	}
	return out;
}

/**
 * @param labels the labels the reviewer read, in any order.
 * @throws Error in plain words when the ranking does not list every label exactly once, or there is no verdict.
 */
export function parseReview(raw: unknown, labels: readonly string[], metricIds: readonly string[]): ParsedReview {
	if (!isRecord(raw)) throw new Error("The review is not a JSON object.");
	const ranking = Array.isArray(raw.ranking) ? raw.ranking.map(item => String(item).trim().toUpperCase()) : [];
	const wanted = new Set(labels);
	if (
		ranking.length !== labels.length ||
		new Set(ranking).size !== ranking.length ||
		ranking.some(label => !wanted.has(label))
	)
		throw new Error(`The ranking must list every entry (${labels.join(", ")}) exactly once.`);
	const verdict = str(raw.verdict, MAX_VERDICT_CHARS);
	if (verdict === undefined) throw new Error("The review has no verdict.");
	const entries: ParsedReview["entries"] = {};
	const given = isRecord(raw.entries) ? raw.entries : {};
	for (const label of labels) {
		const entry = isRecord(given[label]) ? (given[label] as Record<string, unknown>) : {};
		const scores: Record<string, number> = {};
		if (isRecord(entry.scores)) {
			for (const id of metricIds) {
				const score = Number(entry.scores[id]);
				if (Number.isFinite(score) && score >= 1 && score <= 5) scores[id] = score;
			}
		}
		entries[label] = { scores, strengths: findings(entry.strengths), weaknesses: findings(entry.weaknesses) };
	}
	const unsure = Array.isArray(raw.unsure)
		? raw.unsure.flatMap(item => {
				const text = str(item, MAX_FINDING_CHARS);
				return text === undefined ? [] : [text];
			})
		: [];
	return { ranking, entries, verdict, unsure: unsure.slice(0, MAX_UNSURE) };
}

/** A citation as the reviewer writes it: the label of an entry, a slash, then `path@line@token`. */
export function splitLabeledRef(
	text: string,
	labels: ReadonlySet<string>,
): { label: string; ref: BlueprintRef } | null {
	const match = /^\s*([A-Z])\/(.+)$/s.exec(text);
	if (!match || !labels.has(match[1]!)) return null;
	const ref = parseRefText(match[2]!);
	return ref ? { label: match[1]!, ref } : null;
}

/** Where the code of an entry is read from, by the label that is stored with the bake-off. */
export interface ReviewIo {
	lines(entryLabel: string, path: string): Promise<string[] | null>;
}

export interface VerifiedReview {
	/** Entry labels (stored), best first. */
	ranking: string[];
	/** `[entry label][metric id]`: 0–1, from the 1–5 scale. */
	scores: Record<string, Record<string, number>>;
	findings: BakeoffFinding[];
	/** The verdict with its citations checked: one that does not hold is written without its line, "(not checked against the code)". */
	verdict: string;
	unsure: string[];
}

/** `Entry X`, lists such as `Entries X, Y and Z`, and the `X/` of a citation in `text`, rewritten from the labels the reviewer read to the stored labels. */
export function remapLabels(text: string, toEntry: Readonly<Record<string, string>>): string {
	return text
		.replace(
			/\b(Entries|Entry)\s+([A-E](?:(?:,\s*|\s+and\s+|\s+or\s+)[A-E]\b)*)\b/g,
			(_, word: string, labels: string) => {
				const mapped = labels.replace(/[A-E]/g, label => toEntry[label] ?? label);
				return `${word} ${mapped}`;
			},
		)
		.replace(/`([A-E])\//g, (_, label: string) => `\`${toEntry[label] ?? label}/`);
}

/**
 * Check every citation of a review against the commit of the entry it names. `toEntry` maps the labels the reviewer
 * read to the stored labels (they differ on a second pass); everything that leaves is in stored labels.
 */
export async function verifyReview(
	parsed: ParsedReview,
	toEntry: Readonly<Record<string, string>>,
	io: ReviewIo,
	warnings: string[],
): Promise<VerifiedReview> {
	const readLabels = new Set(Object.keys(toEntry));
	// Every citation of the review, once each, so each file is read once.
	const cited: { label: string; ref: BlueprintRef }[] = [];
	const collect = (text: string): { label: string; ref: BlueprintRef } | null => {
		const found = splitLabeledRef(text, readLabels);
		if (found) cited.push(found);
		return found;
	};
	const spans = [...parsed.verdict.matchAll(/`([A-E]\/[^`\n]+@\d+@[^`\n]+)`/g)].map(match => match[1]!);
	for (const span of spans) collect(span);
	for (const entry of Object.values(parsed.entries))
		for (const finding of [...entry.strengths, ...entry.weaknesses]) for (const ref of finding.refs) collect(ref);

	const files = await readCitedFiles(
		cited.map(({ label, ref }) => ({ side: "head" as const, path: `${toEntry[label]}\0${ref.path}` })),
		async (_side, key) => {
			const [entryLabel, path] = key.split("\0") as [string, string];
			return await io.lines(entryLabel, path);
		},
	);
	const found = new Warnings();
	const check = (label: string, ref: BlueprintRef, where: string): BlueprintRef | undefined => {
		const entryLabel = toEntry[label]!;
		const [kept] = checkCitations(
			[ref],
			where,
			() => "head",
			new Map([[`head\0${ref.path}`, files.get(`head\0${entryLabel}\0${ref.path}`) ?? null]]),
			{ verified: 0, moved: 0, dropped: 0 },
			found,
		);
		return kept;
	};

	const checkedVerdict = parsed.verdict.replace(/`([A-E]\/[^`\n]+@\d+@[^`\n]+)`/g, (whole, text: string) => {
		const split = splitLabeledRef(text, readLabels);
		if (!split) return "(a citation that names no entry)";
		const kept = check(split.label, split.ref, "the verdict");
		// Still in the labels the reviewer read: `remapLabels` below moves the whole verdict to the stored ones.
		const label = split.label;
		return kept
			? `\`${label}/${kept.path}@${kept.line}@${kept.token}\``
			: `\`${label}/${split.ref.path}\` (not checked against the code)`;
	});

	const out: BakeoffFinding[] = [];
	const scores: VerifiedReview["scores"] = {};
	for (const [read, entry] of Object.entries(parsed.entries)) {
		const label = toEntry[read]!;
		scores[label] = Object.fromEntries(Object.entries(entry.scores).map(([id, score]) => [id, (score - 1) / 4]));
		for (const [kind, list] of [
			["strength", entry.strengths],
			["weakness", entry.weaknesses],
		] as const) {
			for (const finding of list) {
				const refs: BlueprintRef[] = [];
				for (const text of finding.refs) {
					const split = splitLabeledRef(text, readLabels);
					if (!split) {
						found.add(
							"label",
							`Dropped citation ${text} (a finding): it names no entry.`,
							n => `${n} more citations named no entry.`,
						);
						continue;
					}
					const kept = check(split.label, split.ref, "a finding");
					if (kept) refs.push(kept);
				}
				out.push({
					label,
					kind,
					text: remapLabels(finding.text, toEntry),
					...(refs.length > 0 ? { refs } : {}),
					verified: refs.length > 0,
				});
			}
		}
	}
	warnings.push(...found.list());
	return {
		ranking: parsed.ranking.map(label => toEntry[label]!),
		scores,
		findings: out,
		verdict: remapLabels(checkedVerdict, toEntry),
		unsure: parsed.unsure.map(text => remapLabels(text, toEntry)),
	};
}
