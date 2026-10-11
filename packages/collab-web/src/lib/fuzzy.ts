/**
 * Fuzzy matching for the command palette: a query is split into words, and every word must appear in
 * the text as a subsequence (`gsh` finds `Open GitHub sheet`). Contiguous runs and word starts score
 * highest, so `git` ranks `GitHub` above `Digital inspector` and an exact prefix above both.
 */

export interface FuzzyMatch {
	/** Higher is better; comparable only between matches of the same query. */
	score: number;
	/** Indices (UTF-16 code units) of the matched characters in the text, ascending. */
	positions: number[];
}

const MATCH = 16;
const CONSECUTIVE = 14;
const BOUNDARY = 10;
const CAMEL = 7;
const FIRST = 6;
const GAP_START = 5;
const GAP_EXTEND = 1.5;
const LEAD_MAX = 10;
/** Added once per word that is a prefix of the whole text (or of one of its words), whatever the alignment found. */
const PREFIX = 18;
const NEG = Number.NEGATIVE_INFINITY;

const SEPARATORS = " -_/\\.:,;()[]{}'\"@#";

function boundaryBonus(text: string, at: number): number {
	if (at === 0) return BOUNDARY + FIRST;
	const before = text[at - 1]!;
	if (SEPARATORS.includes(before)) return BOUNDARY;
	const here = text[at]!;
	if (before === before.toLowerCase() && before !== before.toUpperCase() && here !== here.toLowerCase()) return CAMEL;
	return 0;
}

/** Best alignment of `word` (already lower-case) as a subsequence of `text`; null when it is not one. */
function matchWord(word: string, text: string, lower: string): FuzzyMatch | null {
	const n = word.length;
	const m = text.length;
	if (n === 0 || n > m) return null;
	// ended[i][j]: best score with word[i] matched at text[j]; gap[i][j]: best score of word[0..i] matched
	// somewhere at or before j, less the gap since. `via` remembers where each gap's best match ended.
	const ended: number[][] = [];
	const gap: number[][] = [];
	const via: number[][] = [];
	for (let i = 0; i < n; i++) {
		const rowEnded = Array.from({ length: m }, () => NEG);
		const rowGap = Array.from({ length: m }, () => NEG);
		const rowVia = Array.from({ length: m }, () => -1);
		const prevEnded = i > 0 ? ended[i - 1]! : null;
		const prevGap = i > 0 ? gap[i - 1]! : null;
		for (let j = 0; j < m; j++) {
			if (lower[j] === word[i]) {
				const here = MATCH + boundaryBonus(text, j);
				if (prevEnded === null || prevGap === null) rowEnded[j] = here - Math.min(j, LEAD_MAX);
				else if (j > 0) {
					const run = prevEnded[j - 1]! + CONSECUTIVE;
					const skip = j > 1 ? prevGap[j - 2]! : NEG;
					const best = Math.max(run, skip);
					if (best > NEG) rowEnded[j] = here + best;
				}
			}
			const carried = j > 0 ? rowGap[j - 1]! - GAP_EXTEND : NEG;
			const started = rowEnded[j]! - GAP_START;
			if (started >= carried) {
				rowGap[j] = started;
				rowVia[j] = j;
			} else {
				rowGap[j] = carried;
				rowVia[j] = rowVia[j - 1]!;
			}
		}
		ended.push(rowEnded);
		gap.push(rowGap);
		via.push(rowVia);
	}
	const last = ended[n - 1]!;
	let end = -1;
	let score = NEG;
	for (let j = 0; j < m; j++) {
		if (last[j]! > score) {
			score = last[j]!;
			end = j;
		}
	}
	if (end < 0) return null;
	const positions = Array.from({ length: n }, () => 0);
	let at = end;
	for (let i = n - 1; i >= 0; i--) {
		positions[i] = at;
		if (i === 0) break;
		// Consecutive with the previous character, or the best earlier match the gap carried.
		const run = at > 0 ? ended[i - 1]![at - 1]! + CONSECUTIVE : NEG;
		const skip = at > 1 ? gap[i - 1]![at - 2]! : NEG;
		at = run >= skip ? at - 1 : via[i - 1]![at - 2]!;
	}
	return { score, positions };
}

/** The words of a query, lower-case, without duplicates. */
export function queryWords(query: string): string[] {
	const words: string[] = [];
	for (const word of query.toLowerCase().split(/\s+/)) if (word !== "" && !words.includes(word)) words.push(word);
	return words;
}

/**
 * Match `query` against `text`: every word of the query must be found, in any order. An empty query
 * matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
	const words = queryWords(query);
	if (words.length === 0) return { score: 0, positions: [] };
	const lower = text.toLowerCase();
	// toLowerCase can change the length of a string (İ); positions would then point at the wrong characters.
	if (lower.length !== text.length) return null;
	let score = 0;
	const positions = new Set<number>();
	for (const word of words) {
		const found = matchWord(word, text, lower);
		if (found === null) return null;
		score += found.score;
		if (found.positions[0] !== undefined && boundaryBonus(text, found.positions[0]) > 0) {
			const start = found.positions[0];
			if (lower.startsWith(word, start)) score += PREFIX;
		}
		for (const position of found.positions) positions.add(position);
	}
	// A shorter text is the more specific answer to the same words.
	score -= text.length * 0.05;
	return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** `text` cut into runs, each marked when it holds matched characters. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
	if (positions.length === 0) return [{ text, hit: false }];
	const marked = new Set(positions);
	const runs: { text: string; hit: boolean }[] = [];
	for (let i = 0; i < text.length; i++) {
		const hit = marked.has(i);
		const run = runs[runs.length - 1];
		if (run !== undefined && run.hit === hit) run.text += text[i];
		else runs.push({ text: text[i]!, hit });
	}
	return runs;
}

/**
 * Looser text such as a description or a keyword list: every word of the query must occur in it as a whole
 * substring (`mod` finds "Switch the model"). A subsequence match across a sentence finds nearly anything.
 */
export function substringMatch(query: string, text: string): FuzzyMatch | null {
	const words = queryWords(query);
	if (words.length === 0) return { score: 0, positions: [] };
	const lower = text.toLowerCase();
	if (lower.length !== text.length) return null;
	let score = 0;
	for (const word of words) {
		let best = -1;
		let bestBonus = -1;
		for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) {
			const bonus = boundaryBonus(text, at);
			if (bonus > bestBonus) {
				best = at;
				bestBonus = bonus;
			}
		}
		if (best < 0) return null;
		const end = best + word.length;
		const whole =
			(best === 0 || SEPARATORS.includes(text[best - 1]!)) &&
			(end === text.length || SEPARATORS.includes(text[end]!));
		score += MATCH * word.length + bestBonus + (whole ? PREFIX : 0);
	}
	return { score: score - text.length * 0.05, positions: [] };
}
