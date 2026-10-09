/** Words a search query is matched on; filler that would otherwise dominate OR-ranked results. */
const STOPWORDS: Record<string, true> = {
	a: true,
	an: true,
	and: true,
	are: true,
	as: true,
	at: true,
	by: true,
	for: true,
	from: true,
	how: true,
	in: true,
	is: true,
	of: true,
	on: true,
	or: true,
	the: true,
	to: true,
	what: true,
	where: true,
	which: true,
	with: true,
};

/** One word per camelCase/PascalCase hump (acronyms stay whole), lowercase run, or digit run. */
const WORD_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/**
 * Lowercased words of an identifier or path: split on non-alphanumerics
 * (snake_case, `::`, `/`), camelCase/PascalCase boundaries, and digit runs.
 * `E3Requested` → `["e", "3", "requested"]`, `HTTPServer_v2` → `["http", "server", "v", "2"]`.
 */
export function splitWords(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(WORD_RE)) out.push(match[0].toLowerCase());
	return out;
}

/** {@link splitWords} of a free-text query without stopwords, duplicates removed (order kept). */
export function queryWords(text: string): string[] {
	const words = splitWords(text).filter(word => !Object.hasOwn(STOPWORDS, word));
	return [...new Set(words)];
}
