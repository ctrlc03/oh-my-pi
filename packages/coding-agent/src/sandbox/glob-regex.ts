/**
 * Glob → POSIX-style regex source, for sandbox profiles that match paths with a
 * regex (Seatbelt `(regex #"…")`). Mirrors the `tools.pathRules` glob dialect
 * closely enough for deny rules: `*` and `?` stay inside one path segment, `**`
 * crosses segments, `[...]` is a character class, `{a,b}` alternates.
 */

const REGEX_SPECIALS: Record<string, true> = {
	".": true,
	"[": true,
	"]": true,
	"{": true,
	"}": true,
	"(": true,
	")": true,
	"*": true,
	"+": true,
	"?": true,
	"^": true,
	$: true,
	"|": true,
	"\\": true,
};

/** Escape literal text for use inside a regex. */
export function escapeRegexLiteral(text: string): string {
	let out = "";
	for (const char of text) out += Object.hasOwn(REGEX_SPECIALS, char) ? `\\${char}` : char;
	return out;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function findClosingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let i = open; i < glob.length; i++) {
		const char = glob[i];
		if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Split `body` on top-level commas. */
function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const char = body[i];
		if (char === "{") depth++;
		else if (char === "}") depth--;
		else if (char === "," && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}

/**
 * Convert a glob (forward slashes only) to an unanchored regex source. A `**`
 * segment followed by `/` also matches zero segments, so a glob like
 * `src/**` + `/x` matches `src/x`.
 */
export function globToRegexSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					out += "(.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close < 0) {
				out += "\\[";
			} else {
				let body = glob.slice(i + 1, close);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				out += `[${body.replaceAll("\\", "\\\\")}]`;
				i = close;
			}
		} else if (char === "{") {
			const close = findClosingBrace(glob, i);
			if (close < 0) {
				out += "\\{";
			} else {
				const alternatives = splitAlternatives(glob.slice(i + 1, close)).map(globToRegexSource);
				out += `(${alternatives.join("|")})`;
				i = close;
			}
		} else {
			out += escapeRegexLiteral(char);
		}
	}
	return out;
}
