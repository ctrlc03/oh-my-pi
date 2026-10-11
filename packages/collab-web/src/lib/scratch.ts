/**
 * Scratch folders: where the companion starts a session that has no project (`<omp config dir>/scratch/`).
 * One folder per session, named `<YYYY-MM-DD>-<first words of the prompt>-<short id>`. The companion builds
 * the names (scripts/companion-scratch.ts); the app reads them back to label such a folder in its lists.
 */

/** Folder of the omp config dir that holds them. */
export const SCRATCH_DIR = "scratch";
/** Words of the prompt that go into the folder name, at most. */
const MAX_WORDS = 6;
/** Characters (code points) of the prompt's slug, at most: with the date and id a name stays far below the 255 bytes a file name may take. */
export const MAX_SLUG_CHARS = 40;
/** Characters of the prompt read for the slug; the rest cannot show up in it. */
const HINT_CHARS = 200;
/** What the name holds when the prompt gives no word. */
export const EMPTY_SLUG = "session";
/** Hex digits of the id that tells two folders of the same day and prompt apart. */
export const SCRATCH_ID_CHARS = 6;

const NAME_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-(.+)-([0-9a-f]{${SCRATCH_ID_CHARS}})$`, "u");
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * The first words of `prompt` as a file name part: lowercase, in any script, everything else (punctuation,
 * emoji, symbols, separators) read as a break. `session` when no word is left.
 */
export function scratchSlug(prompt: string | undefined): string {
	const words = (prompt ?? "").slice(0, HINT_CHARS).normalize("NFKC").toLowerCase().match(WORD_RE) ?? [];
	const kept: string[] = [];
	let used = 0;
	for (const word of words) {
		if (kept.length === MAX_WORDS) break;
		const chars = Array.from(word);
		const cost = chars.length + (kept.length > 0 ? 1 : 0);
		if (used + cost > MAX_SLUG_CHARS) {
			// A first word that alone is too long is cut; later words that no longer fit are left out.
			if (kept.length === 0) kept.push(chars.slice(0, MAX_SLUG_CHARS).join(""));
			break;
		}
		kept.push(word);
		used += cost;
	}
	return kept.length === 0 ? EMPTY_SLUG : kept.join("-");
}

/** `<YYYY-MM-DD>-<slug>-<id>`: the day is the computer's local one. */
export function scratchFolderName(now: Date, prompt: string | undefined, id: string): string {
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${now.getFullYear()}-${month}-${day}`;
	return `${date}-${scratchSlug(prompt)}-${id}`;
}

/** "Scratch · convert pngs" for a folder the companion made under a `scratch` directory; null for any other path. */
export function scratchLabel(folder: string): string | null {
	const parts = folder.replace(/\/+$/, "").split("/");
	if (parts.length < 2 || parts[parts.length - 2] !== SCRATCH_DIR) return null;
	const match = NAME_RE.exec(parts[parts.length - 1] as string);
	return match ? `Scratch · ${(match[2] as string).replaceAll("-", " ")}` : null;
}
