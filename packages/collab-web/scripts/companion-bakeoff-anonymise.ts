/**
 * Blind review: text an entry produced is scrubbed of anything that says who wrote it before the reviewer or the judge
 * reads it (docs/design-review.md, *Blind protocol*). The model selectors, display names and provider names of the
 * entrants, the branch names of their worktrees and the words "the original" and "challenger" each become
 * `[model]` or `[entry]`. Style still carries some signal; that is what the neutral writer and the self-preference note
 * are for.
 */

/** A model as the models list names it. */
export interface NamedModel {
	selector: string;
	name?: string;
	provider?: string;
}

/** Matches anything that is not part of a longer word, so `gpt-4` does not match inside `gpt-45`. */
const BEFORE = "(?<![A-Za-z0-9])";
const AFTER = "(?![A-Za-z0-9])";
const SEPARATORS = "[-_.\\s/:]+";
const MIN_PHRASE_CHARS = 3;

/** A pattern that finds `phrase` however its separators are written (`claude-sonnet 4.5`, `Claude_Sonnet_4_5`). */
function phrasePattern(phrase: string): string {
	return phrase
		.trim()
		.split(/[-_.\s/:]+/)
		.filter(part => part !== "")
		.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(SEPARATORS);
}

/** The phrases that name `model`: its selector, id, display name and provider. */
export function modelPhrases(model: NamedModel): string[] {
	const slash = model.selector.indexOf("/");
	const provider = model.provider ?? (slash > 0 ? model.selector.slice(0, slash) : undefined);
	const id = slash > 0 ? model.selector.slice(slash + 1) : model.selector;
	const phrases = [model.selector, id, model.name, provider].filter((p): p is string => typeof p === "string");
	return phrases.filter(phrase => phrase.replace(/[-_.\s/:]/g, "").length >= MIN_PHRASE_CHARS);
}

export interface Scrubbed {
	text: string;
	/** What was replaced, in the order it was found: for tests and for the log, never shown to the reviewer. */
	hits: number;
}

export type Scrubber = (text: string) => Scrubbed;

/**
 * A scrubber for one bake-off. Longer phrases go first, so `anthropic/claude-sonnet-5` is one hit and not a provider
 * and a model.
 */
export function createScrubber(entrants: readonly NamedModel[], branches: readonly string[]): Scrubber {
	const modelPhrasesSorted = [...new Set(entrants.flatMap(modelPhrases))].sort((a, b) => b.length - a.length);
	const modelRe =
		modelPhrasesSorted.length === 0
			? null
			: new RegExp(`${BEFORE}(?:${modelPhrasesSorted.map(phrasePattern).join("|")})${AFTER}`, "gi");
	// A branch is replaced by its exact name, by the folder name of its worktree (`/` as `-`), and by the shape the
	// companion gives every bake-off branch, so a name the entry only half remembers still goes.
	const branchNames = [...new Set(branches.flatMap(branch => [branch, branch.replaceAll("/", "-")]))]
		.filter(branch => branch.length >= MIN_PHRASE_CHARS)
		.sort((a, b) => b.length - a.length);
	const branchRe = new RegExp(
		`(?:${[...branchNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "[\\w.-]*omp[/-]bake-[\\w./-]+"].join("|")})`,
		"gi",
	);
	const roleRe = /\b(?:the\s+)?original(?:\s+(?:entry|design|author|solution|implementation))?\b|\bchallengers?\b/gi;
	return text => {
		let hits = 0;
		const replace = (token: string) => (): string => {
			hits++;
			return token;
		};
		let out = text.replace(branchRe, replace("[entry]"));
		if (modelRe) out = out.replace(modelRe, replace("[model]"));
		out = out.replace(roleRe, replace("[entry]"));
		return { text: out, hits };
	};
}
