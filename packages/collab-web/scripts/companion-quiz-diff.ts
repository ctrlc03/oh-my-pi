/**
 * The diff of one part of a quiz, as the quiz agent reads it: every line carries its line number, so the agent can
 * cite the code a question is about as `path@line@token` without counting lines itself.
 *
 * Format of {@link numberDiff}: a file starts with `### path (modified|added|removed|renamed from old/path)`, then
 * its hunks. A hunk starts with git's own header (`@@ -10,7 +10,8 @@ section`), then one line per diff line: a marker
 * (` `, `+` or `-`), the line number right-aligned to the widest number of the hunk, two spaces, the text.
 *
 * ```
 * ### src/a.ts (modified)
 * @@ -10,4 +10,4 @@ export function a() {
 *   10  const kept = 1;
 * -11  const old = 2;
 * +11  const now = 3;
 *   12  return kept;
 * ```
 *
 * - ` ` context and `+` added lines carry the line number in the NEW file (the head commit): cite them as
 *   `path@<number>@token`.
 * - `-` removed lines carry the line number in the OLD file (the base commit): cite them as
 *   `base:path@<number>@token`, with the old path for a renamed file.
 *
 * Binary files, lockfiles and generated bundles are left out. A line longer than {@link MAX_LINE_CHARS} is cut.
 */

import { diffStat } from "./companion-blueprint-git";
import { git, gitFailure } from "./companion-git";

/** The smallest share of the budget a file gets: a small file is shown whole, a large one is cut at this size. */
const MIN_SHARE_CHARS = 1_200;
/** Names of omitted files listed in the trailing note. */
const MAX_LISTED_OMITTED = 30;
const MAX_LINE_CHARS = 600;
const MAX_SECTION_CHARS = 80;
/** What a cut file needs for its marker line. */
const MARKER_RESERVE = 64;
const STAT_CHARS = 3_000;
const MAX_GIT_BYTES = 16 * 1024 * 1024;
const MIN_GIT_BYTES = 512 * 1024;

/** Lockfiles and generated bundles add bytes, not meaning. */
const NOISE_FILE_RE =
	/(?:^|\/)(?:[^/]*\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|[^/]*\.min\.(?:js|mjs|css)|[^/]*\.(?:js|css)\.map)$/;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface RenderedHunk {
	/** The header line, then the numbered diff lines. */
	lines: string[];
	/** Added and removed lines among them. */
	changed: number;
	chars: number;
}

interface RenderedFile {
	path: string;
	header: string;
	hunks: RenderedHunk[];
	/** Characters of the whole file as rendered, newlines included. */
	chars: number;
}

/** A path from a diff header: git quotes names with control characters or quotes in them. */
function unquote(name: string): string {
	const plain = name.replace(/\t.*$/, "");
	return plain.startsWith('"') && plain.endsWith('"') && plain.length >= 2
		? plain.slice(1, -1).replace(/\\(["\\])/g, "$1")
		: plain;
}

function stripPrefix(name: string, prefix: string): string {
	const plain = unquote(name);
	return plain.startsWith(prefix) ? plain.slice(prefix.length) : plain;
}

/** The path of `diff --git a/x b/x` when both sides are the same file (a rename has its own header lines). */
function pathFromGitHeader(header: string): string {
	const rest = header.slice("diff --git ".length);
	const half = (rest.length - 5) / 2;
	if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(2 + half, 5 + half) === " b/") {
		return rest.slice(2, 2 + half);
	}
	return /^a\/(.*) b\/(.*)$/.exec(rest)?.[2] ?? "";
}

function clipLine(text: string): string {
	return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

function renderHunk(lines: string[], start: number, match: RegExpExecArray): { hunk: RenderedHunk; next: number } {
	const [, oldStart, oldCount, newStart, newCount, section] = match;
	let oldLine = Number(oldStart);
	let newLine = Number(newStart);
	let oldLeft = oldCount === undefined ? 1 : Number(oldCount);
	let newLeft = newCount === undefined ? 1 : Number(newCount);
	const body: { marker: string; number: number; text: string }[] = [];
	let i = start + 1;
	for (; i < lines.length && (oldLeft > 0 || newLeft > 0); i++) {
		const line = lines[i] as string;
		const marker = line.charAt(0);
		if (marker === "\\") continue;
		if (marker === "+" && newLeft > 0) {
			body.push({ marker, number: newLine++, text: line.slice(1) });
			newLeft--;
		} else if (marker === "-" && oldLeft > 0) {
			body.push({ marker, number: oldLine++, text: line.slice(1) });
			oldLeft--;
		} else if (marker === " " && oldLeft > 0 && newLeft > 0) {
			body.push({ marker, number: newLine++, text: line.slice(1) });
			oldLine++;
			oldLeft--;
			newLeft--;
		} else break;
	}
	while (i < lines.length && (lines[i] as string).startsWith("\\")) i++;
	const width = String(Math.max(newLine, oldLine)).length;
	const header = `@@ -${oldStart}${oldCount === undefined ? "" : `,${oldCount}`} +${newStart}${newCount === undefined ? "" : `,${newCount}`} @@${(section ?? "").slice(0, MAX_SECTION_CHARS)}`;
	const rendered = body.map(item => `${item.marker}${String(item.number).padStart(width)}  ${clipLine(item.text)}`);
	const all = [header, ...rendered];
	return {
		hunk: {
			lines: all,
			changed: body.filter(item => item.marker !== " ").length,
			chars: all.reduce((sum, line) => sum + line.length + 1, 0),
		},
		next: i,
	};
}

/** One file of the diff, rendered; null for binary files, noise, and changes without lines (a mode change). */
function renderFile(section: string): RenderedFile | null {
	const lines = section.split("\n");
	let kind: "modified" | "added" | "removed" | "renamed" = "modified";
	let from = "";
	let to = "";
	let oldName = "";
	let newName = "";
	let firstHunk = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("@@")) {
			firstHunk = i;
			break;
		}
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) return null;
		if (line.startsWith("new file mode")) kind = "added";
		else if (line.startsWith("deleted file mode")) kind = "removed";
		else if (line.startsWith("rename from ")) from = unquote(line.slice("rename from ".length));
		else if (line.startsWith("rename to ")) to = unquote(line.slice("rename to ".length));
		else if (line.startsWith("--- ")) oldName = line.slice(4);
		else if (line.startsWith("+++ ")) newName = line.slice(4);
	}
	if (from && to) kind = "renamed";
	const fallback = pathFromGitHeader(lines[0] as string);
	const path =
		kind === "renamed"
			? to
			: kind === "removed"
				? oldName && oldName !== "/dev/null"
					? stripPrefix(oldName, "a/")
					: fallback
				: newName && newName !== "/dev/null"
					? stripPrefix(newName, "b/")
					: fallback;
	if (!path || NOISE_FILE_RE.test(path) || (from && NOISE_FILE_RE.test(from))) return null;
	const hunks: RenderedHunk[] = [];
	for (let i = firstHunk; i !== -1 && i < lines.length;) {
		const match = HUNK_RE.exec(lines[i] as string);
		if (!match) {
			i++;
			continue;
		}
		const { hunk, next } = renderHunk(lines, i, match);
		hunks.push(hunk);
		i = next;
	}
	if (hunks.length === 0 && kind === "modified") return null;
	const label = kind === "renamed" ? `renamed from ${from}` : kind;
	const header = `### ${path} (${label})`;
	return {
		path,
		header,
		hunks,
		chars: header.length + 1 + hunks.reduce((sum, hunk) => sum + hunk.chars, 0),
	};
}

/** The file cut to `allowance` characters at a hunk boundary; the first hunk alone is cut at a line when it is too big. */
function cutFile(file: RenderedFile, allowance: number): { text: string; cut: boolean } {
	if (file.chars <= allowance)
		return {
			text: render(
				file.header,
				file.hunks.flatMap(hunk => hunk.lines),
			),
			cut: false,
		};
	const room = Math.max(0, allowance - MARKER_RESERVE);
	let used = file.header.length + 1;
	const kept: string[] = [];
	let omitted = 0;
	let stopped = false;
	for (const [index, hunk] of file.hunks.entries()) {
		if (!stopped && used + hunk.chars <= room) {
			kept.push(...hunk.lines);
			used += hunk.chars;
			continue;
		}
		if (stopped || index > 0) {
			stopped = true;
			omitted += hunk.changed;
			continue;
		}
		// The first hunk is too big alone (a new file is one hunk): cut it at a line.
		stopped = true;
		let count = 0;
		for (const line of hunk.lines) {
			if (used + line.length + 1 > room) break;
			kept.push(line);
			used += line.length + 1;
			count++;
		}
		omitted += hunk.lines.slice(count).filter(line => line.charAt(0) === "+" || line.charAt(0) === "-").length;
	}
	const marker = omitted > 0 ? [`[… ${omitted} more changed lines in this file omitted]`] : [];
	return { text: render(file.header, [...kept, ...marker]), cut: true };
}

function render(header: string, lines: readonly string[]): string {
	return `${header}\n${lines.map(line => `${line}\n`).join("")}`;
}

/** Fair shares: small files are shown whole and what they leave is shared by the larger ones, each at least `MIN_SHARE_CHARS`. */
function allowances(files: readonly RenderedFile[], budget: number, perFile: number): Map<RenderedFile, number> {
	const result = new Map<RenderedFile, number>();
	let remaining = budget;
	let left = files.length;
	for (const file of [...files].sort((a, b) => a.chars - b.chars)) {
		const share = Math.max(MIN_SHARE_CHARS, Math.floor(remaining / left));
		const allowance = Math.min(file.chars, share, perFile);
		result.set(file, allowance);
		remaining -= allowance;
		left--;
	}
	return result;
}

function layout(files: readonly RenderedFile[], budget: number, perFile: number) {
	// A file whose minimum share no longer fits is left out whole; the others are tried in diff order.
	const included: RenderedFile[] = [];
	const omitted: string[] = [];
	let reserved = 0;
	for (const file of files) {
		const need = Math.min(file.chars, MIN_SHARE_CHARS, perFile);
		if (reserved + need <= budget) {
			included.push(file);
			reserved += need;
		} else omitted.push(file.path);
	}
	const shares = allowances(included, budget, perFile);
	let truncated = omitted.length > 0;
	const text = included
		.map(file => {
			const piece = cutFile(file, shares.get(file) ?? file.chars);
			truncated ||= piece.cut;
			return piece.text;
		})
		.join("");
	return { text, files: included.length, omitted, truncated };
}

function omittedNote(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	const listed = paths.slice(0, MAX_LISTED_OMITTED).join(", ");
	const more = paths.length > MAX_LISTED_OMITTED ? `, and ${paths.length - MAX_LISTED_OMITTED} more` : "";
	return `[… ${paths.length} more file${paths.length === 1 ? "" : "s"} omitted: ${listed}${more}]\n`;
}

/**
 * Unified diff text (`git diff -U3 -M --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ base head`) as numbered
 * lines (see the format at the top of this file), at most `maxChars` characters including the note about omitted
 * files. Each file gets a fair share of the budget (at least about 1200 characters, `perFileChars` at most): small
 * files are shown whole, a large one is cut at a hunk boundary with a `[… n more changed lines in this file omitted]`
 * marker, and files that no longer fit are left out whole and named in a trailing `[… n more files omitted: …]` line
 * (up to 30 names). `files` counts the files shown, `omittedFiles` the ones left out; `truncated` is true when
 * anything was cut or left out.
 */
export function numberDiff(
	raw: string,
	options: { maxChars: number; perFileChars?: number },
): { text: string; files: number; omittedFiles: number; truncated: boolean } {
	const perFile = options.perFileChars ?? Number.POSITIVE_INFINITY;
	const files = raw
		.split(/^(?=diff --git )/m)
		.filter(section => section.startsWith("diff --git "))
		.map(renderFile)
		.filter((file): file is RenderedFile => file !== null);
	let budget = Math.max(0, options.maxChars);
	for (let attempt = 0; ; attempt++) {
		const laid = layout(files, budget, perFile);
		const note = omittedNote(laid.omitted);
		const overflow = laid.text.length + note.length - options.maxChars;
		if (overflow > 0 && attempt < 4 && budget > 0) {
			budget = Math.max(0, budget - overflow);
			continue;
		}
		return {
			text: laid.text + note,
			files: laid.files,
			omittedFiles: laid.omitted.length,
			truncated: laid.truncated,
		};
	}
}

/**
 * The numbered diff of `base..head` (a part of a quiz) and its `git diff --stat`. `truncated` is also true when git's
 * output itself was too large to read whole.
 */
export async function partDiff(
	root: string,
	base: string,
	head: string,
	options: { maxChars: number },
): Promise<{ stat: string; text: string; files: number; omittedFiles: number; truncated: boolean }> {
	const maxBytes = Math.min(MAX_GIT_BYTES, Math.max(MIN_GIT_BYTES, options.maxChars * 6));
	const [result, stat] = await Promise.all([
		git(
			root,
			[
				"diff",
				"-U3",
				"-M",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				base,
				head,
				"--",
			],
			{ maxBytes },
		),
		diffStat(root, base, head, STAT_CHARS),
	]);
	if (result.code !== 0 && !result.truncated) throw gitFailure(result, "git diff");
	let raw = new TextDecoder().decode(result.out);
	if (result.truncated) raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
	const numbered = numberDiff(raw, options);
	return { stat, ...numbered, truncated: numbered.truncated || result.truncated };
}
