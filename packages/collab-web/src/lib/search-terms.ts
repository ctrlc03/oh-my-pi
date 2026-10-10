/** The shortest message search the companion answers. */
export const MIN_QUERY_CHARS = 2;

/** A message search is worth sending: at least {@link MIN_QUERY_CHARS} characters once trimmed. */
export function searchable(query: string): boolean {
	return [...query.trim()].length >= MIN_QUERY_CHARS;
}

/** The lowercase words of a query, as the companion splits it (an entry must contain every one). */
export function queryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const term of query.toLowerCase().split(/\s+/)) {
		if (term !== "" && !terms.includes(term)) terms.push(term);
	}
	return terms;
}

export interface TextPart {
	text: string;
	/** The part is one of the search terms. */
	hit: boolean;
}

/** `text` cut into parts so that every occurrence of a term (any case) is its own `hit` part. */
export function splitMatches(text: string, terms: readonly string[]): TextPart[] {
	if (terms.length === 0 || text === "") return [{ text, hit: false }];
	const longestFirst = [...terms].sort((a, b) => b.length - a.length);
	const pattern = new RegExp(longestFirst.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
	const parts: TextPart[] = [];
	let from = 0;
	for (const match of text.matchAll(pattern)) {
		if (match[0] === "") continue;
		if (match.index > from) parts.push({ text: text.slice(from, match.index), hit: false });
		parts.push({ text: match[0], hit: true });
		from = match.index + match[0].length;
	}
	if (from < text.length) parts.push({ text: text.slice(from), hit: false });
	return parts;
}

/** Items grouped by `sessionId`, groups in order of first appearance and items in their given order. */
export function groupBySession<T extends { sessionId: string }>(items: readonly T[]): T[][] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = groups.get(item.sessionId);
		if (group) group.push(item);
		else groups.set(item.sessionId, [item]);
	}
	return [...groups.values()];
}
