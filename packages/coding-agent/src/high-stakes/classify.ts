/**
 * Publish classifier for high-stakes sessions: reads a shell command (or the source of an `eval` cell) and reports
 * the things in it that publish work: pushes, pull requests, and API writes that create or move refs, commits or
 * file contents. Pure: no I/O, no clock; git aliases from the user's config come in through an injected resolver.
 * The command gate ({@link ./gate}) decides what a finding means; this file only says what is there.
 *
 * Finding kinds:
 * - `git-push`     `git push` in any form (`git send-pack`, `git http-push`, `git subtree push`, `git svn dcommit`,
 *                  `hub push`, dashed `git-push`, an alias that expands to one), also a dry run.
 * - `no-verify`    a push with `--no-verify` (or an unambiguous abbreviation), which skips the pre-push hook.
 * - `hooks-bypass` a push that overrides git's configuration (`-c core.hooksPath=…`, `--config-env=core.hooksPath=…`,
 *                  `GIT_CONFIG_*`, `HOME=`/`XDG_CONFIG_HOME=`), or a command that sets that up for later pushes
 *                  (`git config core.hooksPath <dir>`, a bare `export GIT_CONFIG_COUNT=…`).
 * - `pr`           `gh pr create|merge|close`, `hub pull-request`, `glab mr create|merge|close`.
 * - `api-write`    a write to a pull request, merge, ref, commit, tree, tag or file-contents endpoint through
 *                  `gh api`, `hub api`, `glab api`, `curl`/`wget`/`http`/`xh`, or a GraphQL mutation of the same.
 * - `unreadable`   a command nested too deeply to inspect.
 *
 * The command is parsed with {@link tokenizeShellSegments}: words with quotes removed, segments split on
 * `; && || | & ( ) \n`. On top of that this file follows `cd` across segments, unwraps `env`, `sudo`, `time`,
 * `xargs`, … , recurses into `bash -c '…'`, `eval`, `$(…)`, backticks, here-strings and heredocs fed to a shell
 * or interpreter, and expands git aliases.
 *
 * What it cannot see: a command built at run time (`$(printf …)`, `$VAR push`, `eval "$x"`), a script or binary that
 * pushes by itself (`bash push.sh`, `make deploy`, `npm run release`), other launchers it does not know
 * (`parallel`, `mise exec`, `docker run`), a git client other than git/hub, pushes made from another process, and
 * `gh` aliases. A shell that was handed `GIT_CONFIG_*` in an earlier call keeps it, and that is only noticed when
 * the `export` itself is in a command. The pre-push hook and the shell sandbox are the layers for those.
 */
import * as path from "node:path";
import { tokenizeShellSegments } from "../tools/shell-tokenize";

export type PublishKind = "git-push" | "no-verify" | "hooks-bypass" | "pr" | "api-write" | "unreadable";

export interface PublishFinding {
	kind: PublishKind;
	/** Short description for the refusal: `git push`, `gh pr merge`, `curl POST api.github.com/repos/o/r/pulls`. */
	what: string;
	/** Folder the command ran in when it differs from the session's: `cd`/`git -C`/`--work-tree`, as spelled (relative to the session folder when not absolute). */
	dir?: string;
}

export interface ClassifyOptions {
	/**
	 * The value of git alias `name` from the user's configuration (as `git config alias.<name>` would print it), run
	 * from `dir` (relative to the session folder when not absolute; undefined = the session folder). Only asked for a
	 * subcommand that is not a built-in git command and was not defined earlier in the same command.
	 */
	resolveAlias?: (name: string, dir: string | undefined) => string | undefined;
}

const MAX_DEPTH = 6;
const MAX_ALIAS_DEPTH = 5;
const MAX_LITERALS = 4000;
const MAX_LITERAL_CHARS = 50_000;

interface Ctx {
	opts: ClassifyOptions;
	findings: PublishFinding[];
	/** Folder after the `cd`s so far; undefined = the session folder. */
	dir: string | undefined;
	/** Aliases defined earlier in this command (`git config alias.p push`), shared with nested commands. */
	aliases: Map<string, string>;
	/** An earlier segment made git skip its hooks for later pushes. */
	hooksOff: boolean;
	/** Text of the latest `echo`/`printf`, which a bare shell later in the pipeline would run. */
	echoed: string;
	depth: number;
}

/** Findings for a shell command; empty when it publishes nothing we can read. */
export function classifyPublish(command: string, opts: ClassifyOptions = {}): PublishFinding[] {
	const ctx: Ctx = {
		opts,
		findings: [],
		dir: undefined,
		aliases: new Map(),
		hooksOff: false,
		echoed: "",
		depth: 0,
	};
	classifyText(command, ctx);
	return dedupe(ctx.findings);
}

function dedupe(findings: PublishFinding[]): PublishFinding[] {
	const seen = new Set<string>();
	const out: PublishFinding[] = [];
	for (const finding of findings) {
		const key = `${finding.kind}\0${finding.what}\0${finding.dir ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(finding);
	}
	return out;
}

function add(ctx: Ctx, kind: PublishKind, what: string, dir: string | undefined): void {
	ctx.findings.push(dir === undefined ? { kind, what } : { kind, what, dir });
}

function child(ctx: Ctx, dir: string | undefined = ctx.dir): Ctx {
	return { ...ctx, dir, depth: ctx.depth + 1 };
}

function joinDir(base: string | undefined, next: string): string {
	if (next.startsWith("/") || next.startsWith("~")) return next;
	return base === undefined ? next : path.posix.join(base, next);
}

function baseName(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash === -1 ? word : word.slice(slash + 1);
}

// ── text level: heredocs, substitutions, segments ───────────────────────────────────────────────

const SHELL_NAME = /^(?:ba|z|da|k|a|mk|c|tc)?sh$|^fish$/;
const INTERPRETER_NAME = /^(?:python[\d.]*|pypy[\d.]*|node(?:js)?|bun|deno|ruby|perl|php|osascript)$/;

interface Heredoc {
	delim: string;
	strip: boolean;
	/** Delimiter was quoted: the body is not expanded. */
	quoted: boolean;
	/** The line the `<<` is on. */
	line: string;
	body: string;
}

/** Cut heredoc bodies out of `text`; they are classified separately, by what reads them. */
function splitHeredocs(text: string): { masked: string; bodies: Heredoc[] } {
	if (!text.includes("<<")) return { masked: text, bodies: [] };
	const bodies: Heredoc[] = [];
	let pending: Heredoc[] = [];
	let masked = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (inSingle) {
			masked += ch;
			if (ch === "'") inSingle = false;
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < n) {
				masked += ch + text[i + 1];
				i += 2;
				continue;
			}
			masked += ch;
			if (ch === '"') inDouble = false;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < n) {
			masked += ch + text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "'") inSingle = true;
		else if (ch === '"') inDouble = true;
		if (ch === "\n" && pending.length > 0) {
			masked += "\n";
			i++;
			for (const doc of pending) {
				const lines: string[] = [];
				while (i <= n) {
					const end = text.indexOf("\n", i);
					const line = end === -1 ? text.slice(i) : text.slice(i, end);
					i = end === -1 ? n + 1 : end + 1;
					if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
					lines.push(line);
				}
				doc.body = lines.join("\n");
				bodies.push(doc);
			}
			pending = [];
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const lineStart = text.lastIndexOf("\n", i - 1) + 1;
			const lineEndAt = text.indexOf("\n", i);
			const lineText = text.slice(lineStart, lineEndAt === -1 ? n : lineEndAt);
			const parsed = parseHeredocOperator(text, i, text.slice(lineStart, i));
			if (parsed) {
				pending.push({ delim: parsed.delim, strip: parsed.strip, quoted: parsed.quoted, line: lineText, body: "" });
				masked += text.slice(i, parsed.end);
				i = parsed.end;
				continue;
			}
		}
		masked += ch;
		i++;
	}
	return { masked, bodies };
}

function parseHeredocOperator(
	text: string,
	at: number,
	linePrefix: string,
): { delim: string; strip: boolean; quoted: boolean; end: number } | undefined {
	// `$((1<<2))` and `(( a << b ))` are arithmetic.
	if (/\(\([^)]*$/.test(linePrefix)) return undefined;
	let j = at + 2;
	let strip = false;
	if (text[j] === "-") {
		strip = true;
		j++;
	}
	while (text[j] === " " || text[j] === "\t") j++;
	const first = text[j];
	if (first === undefined || !/[A-Za-z_'"\\]/.test(first)) return undefined;
	let delim = "";
	let quoted = false;
	while (j < text.length) {
		const c = text[j];
		if (c === "'" || c === '"') {
			quoted = true;
			const close = text.indexOf(c, j + 1);
			if (close === -1) return undefined;
			delim += text.slice(j + 1, close);
			j = close + 1;
		} else if (c === "\\" && j + 1 < text.length) {
			quoted = true;
			delim += text[j + 1];
			j += 2;
		} else if (/[\s;|&()<>]/.test(c)) {
			break;
		} else {
			delim += c;
			j++;
		}
	}
	if (delim === "") return undefined;
	return { delim, strip, quoted, end: j };
}

/** Index of the `)` that closes the `$(` whose body starts at `from`, or -1. */
function matchParen(text: string, from: number): number {
	let depth = 1;
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const close = text.indexOf("'", i + 1);
			if (close === -1) return -1;
			i = close + 1;
			continue;
		}
		if (ch === '"') {
			i = skipDouble(text, i + 1);
			if (i < 0) return -1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

/** Index after the `"` that closes a double-quoted string whose body starts at `from`, or -1. */
function skipDouble(text: string, from: number): number {
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i + 1;
		if (ch === "$" && text[i + 1] === "(") {
			const close = matchParen(text, i + 2);
			if (close === -1) return -1;
			i = close + 1;
			continue;
		}
		i++;
	}
	return -1;
}

/** Pull `$(…)` and backtick bodies out of `text`, leaving a plain word in their place. Single-quoted text is left alone. */
function extractSubstitutions(text: string): { outer: string; subs: string[] } {
	if (!text.includes("$(") && !text.includes("`")) return { outer: text, subs: [] };
	const subs: string[] = [];
	let outer = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inSingle) {
			outer += ch;
			if (ch === "'") inSingle = false;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			outer += ch + text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = true;
			outer += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = !inDouble;
			outer += ch;
			i++;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const close = matchParen(text, i + 2);
			const end = close === -1 ? text.length : close;
			subs.push(text.slice(i + 2, end));
			outer += "__sub__";
			i = close === -1 ? text.length : close + 1;
			continue;
		}
		if (ch === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
			subs.push(text.slice(i + 1, Math.min(j, text.length)).replace(/\\`/g, "`"));
			outer += "__sub__";
			i = j + 1;
			continue;
		}
		outer += ch;
		i++;
	}
	return { outer, subs };
}

function tooDeep(ctx: Ctx): boolean {
	if (ctx.depth <= MAX_DEPTH) return false;
	add(ctx, "unreadable", "a command nested too deeply to inspect", ctx.dir);
	return true;
}

function classifyText(text: string, ctx: Ctx): void {
	if (tooDeep(ctx)) return;
	const { masked, bodies } = splitHeredocs(text);
	const { outer, subs } = extractSubstitutions(masked);
	for (const sub of subs) classifyText(sub, child(ctx));
	for (const doc of bodies) classifyHeredocBody(doc, ctx);
	for (const segment of tokenizeShellSegments(outer)) classifySegment(segment, ctx);
}

function classifyHeredocBody(doc: Heredoc, ctx: Ctx): void {
	const words = tokenizeShellSegments(doc.line.replace(/<<-?\s*\S+/g, " ")).flat();
	const names = words.map(baseName);
	if (names.some(name => SHELL_NAME.test(name))) {
		classifyText(doc.body, child(ctx));
	} else if (names.some(name => INTERPRETER_NAME.test(name))) {
		for (const finding of classifyScript(doc.body, ctx.opts)) ctx.findings.push(finding);
	} else if (!doc.quoted) {
		for (const sub of extractSubstitutions(doc.body).subs) classifyText(sub, child(ctx));
	}
}

// ── segments ────────────────────────────────────────────────────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Static name tables: `Record` lookups through {@link has}. */
function table(names: readonly string[]): Record<string, true> {
	return Object.fromEntries(names.map(name => [name, true]));
}
function has(names: Record<string, true>, name: string): boolean {
	return Object.hasOwn(names, name);
}

const KEYWORDS = table(["if", "then", "else", "elif", "do", "while", "until", "{", "!", "coproc"]);
const WRAPPERS = table([
	"env",
	"command",
	"builtin",
	"exec",
	"sudo",
	"doas",
	"time",
	"nohup",
	"nice",
	"timeout",
	"xargs",
	"stdbuf",
	"ionice",
	"setsid",
	"unbuffer",
	"caffeinate",
	"watch",
	"noglob",
	"nocorrect",
	"arch",
]);

function envName(assignment: string): string {
	return assignment.slice(0, assignment.indexOf("=")).replace(/\+$/, "");
}

function classifySegment(words: string[], ctx: Ctx): void {
	let i = 0;
	let dir = ctx.dir;
	const env: string[] = [];
	for (;;) {
		while (i < words.length && ASSIGNMENT.test(words[i])) env.push(words[i++]);
		while (i < words.length && has(KEYWORDS, words[i])) i++;
		if (i >= words.length) {
			// Only assignments: a `GIT_CONFIG_*` set here reaches the pushes after it.
			noteBareEnv(env, ctx, dir);
			return;
		}
		const name = baseName(words[i]);
		if (!has(WRAPPERS, name)) break;
		const next = unwrap(name, words, i);
		if (next === undefined) return;
		if ("inner" in next) {
			classifyText(next.inner, child(ctx, dir));
			return;
		}
		if (next.dir !== undefined) dir = joinDir(dir, next.dir);
		i = next.next;
	}
	const name = baseName(words[i]);
	const args = words.slice(i + 1);
	if (name === "export" || name === "declare" || name === "typeset" || name === "readonly" || name === "local") {
		noteBareEnv(
			args.filter(arg => ASSIGNMENT.test(arg)),
			ctx,
			dir,
		);
		return;
	}
	dispatch(name, args, env, ctx, dir);
}

/** `export GIT_CONFIG_COUNT=1` and the like: not a push, but it switches git's hooks off for the ones that follow. */
function noteBareEnv(assignments: string[], ctx: Ctx, dir: string | undefined): void {
	for (const assignment of assignments) {
		const name = envName(assignment);
		if (!/^GIT_CONFIG(?:_|$)/.test(name)) continue;
		ctx.hooksOff = true;
		add(ctx, "hooks-bypass", `setting ${name}, which can switch git's hooks off`, dir);
	}
}

type Unwrapped = { next: number; dir?: string } | { inner: string } | undefined;

/** The index of the command a wrapper runs, `{ inner }` for a wrapper that takes a command string, undefined for none. */
function unwrap(name: string, words: string[], at: number): Unwrapped {
	let j = at + 1;
	const skipFlags = (withValue: readonly string[]): void => {
		while (j < words.length) {
			const word = words[j];
			if (word === "--") {
				j++;
				return;
			}
			if (!word.startsWith("-") || word === "-") return;
			j += withValue.includes(word) ? 2 : 1;
		}
	};
	switch (name) {
		case "command": {
			while (j < words.length && words[j].startsWith("-") && words[j] !== "--") {
				if (/^-[a-zA-Z]*[vV]/.test(words[j])) return undefined;
				j++;
			}
			if (words[j] === "--") j++;
			return { next: j };
		}
		case "builtin":
		case "noglob":
		case "nocorrect":
		case "nohup":
			return { next: j };
		case "exec":
			skipFlags(["-a"]);
			return { next: j };
		case "arch":
			skipFlags(["-e"]);
			return { next: j };
		case "time":
			skipFlags(["-f", "-o", "--format", "--output"]);
			return { next: j };
		case "setsid":
		case "unbuffer":
			skipFlags([]);
			return { next: j };
		case "stdbuf":
			skipFlags(["-i", "-o", "-e", "--input", "--output", "--error"]);
			return { next: j };
		case "ionice":
			skipFlags(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]);
			return { next: j };
		case "nice":
			skipFlags(["-n", "--adjustment"]);
			return { next: j };
		case "caffeinate":
			skipFlags(["-t", "-w"]);
			return { next: j };
		case "sudo":
		case "doas":
			skipFlags(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host"]);
			return { next: j };
		case "timeout": {
			skipFlags(["-s", "-k", "--signal", "--kill-after"]);
			// The duration.
			return { next: j + 1 };
		}
		case "env": {
			let dir: string | undefined;
			while (j < words.length) {
				const word = words[j];
				if (word === "--") {
					j++;
					break;
				}
				if (word === "-S" || word === "--split-string") {
					return { inner: [words[j + 1] ?? "", ...words.slice(j + 2)].join(" ") };
				}
				if (word.startsWith("-S") && word.length > 2) {
					return { inner: [word.slice(2), ...words.slice(j + 1)].join(" ") };
				}
				if (word === "-C" || word === "--chdir") {
					dir = words[j + 1];
					j += 2;
					continue;
				}
				if (word.startsWith("--chdir=")) {
					dir = word.slice("--chdir=".length);
					j++;
					continue;
				}
				if (word === "-u" || word === "--unset") {
					j += 2;
					continue;
				}
				if (word.startsWith("-") && word !== "-") {
					j++;
					continue;
				}
				break;
			}
			return dir === undefined ? { next: j } : { next: j, dir };
		}
		case "xargs": {
			const withValue = [
				"-I",
				"-n",
				"-P",
				"-d",
				"-L",
				"-s",
				"-E",
				"-a",
				"--max-args",
				"--max-procs",
				"--delimiter",
				"--max-lines",
				"--max-chars",
				"--arg-file",
				"--replace",
				"--eof",
			];
			skipFlags(withValue);
			return j < words.length ? { next: j } : undefined;
		}
		case "watch": {
			const withValue = ["-n", "--interval", "-w", "--no-wait"];
			while (j < words.length) {
				const word = words[j];
				if (word === "--") {
					j++;
					break;
				}
				if (!word.startsWith("-") || word === "-") break;
				j += withValue.includes(word) ? 2 : 1;
			}
			return j < words.length ? { inner: words.slice(j).join(" ") } : undefined;
		}
	}
	return { next: j };
}

function dispatch(name: string, args: string[], env: string[], ctx: Ctx, dir: string | undefined): void {
	if (SHELL_NAME.test(name)) return classifyShell(args, ctx, dir);
	if (INTERPRETER_NAME.test(name)) return classifyInterpreter(args, ctx);
	switch (name) {
		case "eval":
			return classifyText(args.join(" "), child(ctx, dir));
		case "cd":
		case "pushd": {
			let k = 0;
			while (k < args.length && args[k].startsWith("-") && args[k] !== "-") k++;
			const target = args[k] ?? "~";
			if (target !== "-") ctx.dir = joinDir(dir, target);
			return;
		}
		case "echo":
		case "printf":
			ctx.echoed = args.filter(arg => !arg.startsWith("-")).join(" ");
			return;
		case "su": {
			const at = args.findIndex(arg => arg === "-c" || arg === "--command");
			if (at !== -1 && args[at + 1] !== undefined) classifyText(args[at + 1], child(ctx, dir));
			return;
		}
		case "find":
			return classifyFind(args, ctx, dir);
		case "git":
		case "hub":
			return classifyGit(args, ctx, dir, env, name === "hub");
		case "gh":
		case "glab":
			return classifyForge(name, args, ctx, dir);
		case "curl":
		case "wget":
		case "http":
		case "https":
		case "xh":
		case "xhs":
			return classifyHttp(name, args, ctx, dir);
	}
	if (name.startsWith("git-") && name.length > 4) {
		return classifyGit([name.slice(4), ...args], ctx, dir, env, false);
	}
}

function classifyFind(args: string[], ctx: Ctx, dir: string | undefined): void {
	for (let k = 0; k < args.length; k++) {
		if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k])) continue;
		let end = k + 1;
		while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
		classifySegment(args.slice(k + 1, end), child(ctx, dir));
		k = end;
	}
}

function classifyShell(args: string[], ctx: Ctx, dir: string | undefined): void {
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (arg === "--") break;
		if (arg === "<<<" && args[k + 1] !== undefined) return classifyText(args[k + 1], child(ctx, dir));
		if (arg.startsWith("<<<")) return classifyText(arg.slice(3), child(ctx, dir));
		if (["-o", "-O", "--rcfile", "--init-file"].includes(arg)) {
			k++;
			continue;
		}
		if (arg.startsWith("--")) continue;
		if (arg.startsWith("-") && arg.length > 1) {
			if (arg.includes("c")) {
				const code = args[k + 1];
				if (code !== undefined) classifyText(code, child(ctx, dir));
				return;
			}
			continue;
		}
		// A script file: its content is not ours to read.
		return;
	}
	// A bare shell reads its commands from stdin: what an `echo` before it in the pipeline said.
	if (ctx.echoed !== "") classifyText(ctx.echoed, child(ctx, dir));
}

const INLINE_CODE_FLAGS = ["-c", "-e", "-E", "-r", "-p", "--eval", "--print", "-pe", "-ne", "-lne", "-ple"];

function classifyInterpreter(args: string[], ctx: Ctx): void {
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (INLINE_CODE_FLAGS.includes(arg) || (arg === "eval" && k === 0)) {
			const code = args[k + 1];
			if (code !== undefined) for (const finding of classifyScript(code, ctx.opts)) ctx.findings.push(finding);
			return;
		}
		if (!arg.startsWith("-")) return;
	}
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────

/** Built-in git commands: an alias never overrides one, so the alias resolver is not asked about them. */
const GIT_BUILTINS = table(
	(
		"add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format " +
		"checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects " +
		"credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch " +
		"fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init " +
		"instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file " +
		"merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs " +
		"patch-id prune prune-packed pull range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore " +
		"rev-list rev-parse revert rm scalar send-email shortlog show show-branch show-index show-ref sparse-checkout stash status " +
		"stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info " +
		"upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree " +
		"push send-pack http-push subtree svn lfs flow p4 receive-pack imap-send daemon"
	).split(" "),
);

const NO_VERIFY = /^--no-v(?:e(?:r(?:i(?:f(?:y)?)?)?)?)?$/;
const HOOKS_KEY = "core.hookspath";

interface GitState {
	ctx: Ctx;
	dir: string | undefined;
	hooksOff: boolean;
	/** `-c alias.x=…` of this command. */
	aliases: Map<string, string>;
	hub: boolean;
}

function classifyGit(args: string[], ctx: Ctx, dir: string | undefined, env: string[], hub: boolean): void {
	const state: GitState = { ctx, dir, hooksOff: ctx.hooksOff, aliases: new Map(), hub };
	for (const assignment of env) {
		const name = envName(assignment);
		const value = assignment.slice(assignment.indexOf("=") + 1);
		if (/^GIT_CONFIG(?:_|$)/.test(name) || name === "HOME" || name === "XDG_CONFIG_HOME") state.hooksOff = true;
		if (name === "GIT_WORK_TREE" && value) state.dir = joinDir(state.dir, value);
		else if (name === "GIT_DIR" && value) state.dir = gitDirParent(state.dir, value);
	}
	runGit(args, state, 0);
}

function gitDirParent(base: string | undefined, gitDir: string): string {
	const full = joinDir(base, gitDir);
	return baseName(full) === ".git" ? path.posix.dirname(full) : full;
}

function noteConfigKv(kv: string, state: GitState, viaEnv: boolean): void {
	const eq = kv.indexOf("=");
	const key = (eq === -1 ? kv : kv.slice(0, eq)).toLowerCase();
	const value = eq === -1 ? "" : kv.slice(eq + 1);
	if (key === HOOKS_KEY) state.hooksOff = true;
	else if (!viaEnv && key.startsWith("alias.")) state.aliases.set(kv.slice(6, eq === -1 ? undefined : eq), value);
}

function runGit(args: string[], state: GitState, aliasDepth: number): void {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i];
		if (arg === "-C") {
			if (args[i + 1] !== undefined) state.dir = joinDir(state.dir, args[i + 1]);
			i += 2;
		} else if (arg === "-c") {
			if (args[i + 1] !== undefined) noteConfigKv(args[i + 1], state, false);
			i += 2;
		} else if (arg === "--config-env") {
			if (args[i + 1] !== undefined) noteConfigKv(args[i + 1], state, true);
			i += 2;
		} else if (arg.startsWith("--config-env=")) {
			noteConfigKv(arg.slice("--config-env=".length), state, true);
			i++;
		} else if (arg === "--git-dir") {
			if (args[i + 1] !== undefined) state.dir = gitDirParent(state.dir, args[i + 1]);
			i += 2;
		} else if (arg.startsWith("--git-dir=")) {
			state.dir = gitDirParent(state.dir, arg.slice("--git-dir=".length));
			i++;
		} else if (arg === "--work-tree") {
			if (args[i + 1] !== undefined) state.dir = joinDir(state.dir, args[i + 1]);
			i += 2;
		} else if (arg.startsWith("--work-tree=")) {
			state.dir = joinDir(state.dir, arg.slice("--work-tree=".length));
			i++;
		} else if (arg === "--namespace" || arg === "--super-prefix" || arg === "--attr-source") {
			i += 2;
		} else {
			// `--exec-path[=…]`, `--no-pager`, `-p`, `-P`, `--bare`, `--no-replace-objects`, `--literal-pathspecs`, `--html-path`, …
			i++;
		}
	}
	const sub = args[i];
	if (sub === undefined) return;
	const rest = args.slice(i + 1);
	classifyGitSub(sub, rest, state, aliasDepth);
}

function addPush(label: string, rest: string[], state: GitState): void {
	const { ctx, dir } = state;
	add(ctx, "git-push", label, dir);
	if (label === "git push" && rest.some(arg => NO_VERIFY.test(arg))) {
		add(ctx, "no-verify", "git push --no-verify", dir);
	}
	if (state.hooksOff) {
		add(ctx, "hooks-bypass", "a push that overrides git's configuration (core.hooksPath, GIT_CONFIG_*)", dir);
	}
}

function classifyGitSub(sub: string, rest: string[], state: GitState, aliasDepth: number): void {
	const { ctx, dir } = state;
	switch (sub) {
		case "push":
			return addPush("git push", rest, state);
		case "send-pack":
		case "http-push":
			return addPush(`git ${sub}`, rest, state);
		case "subtree":
			if (rest.find(arg => !arg.startsWith("-")) === "push") addPush("git subtree push", rest, state);
			return;
		case "svn":
			if (rest.includes("dcommit")) addPush("git svn dcommit", rest, state);
			return;
		case "config":
			return classifyGitConfig(rest, state);
		case "submodule": {
			const at = rest.indexOf("foreach");
			if (at === -1) return;
			const command = rest.slice(at + 1).filter(arg => !["-q", "--quiet", "--recursive"].includes(arg));
			classifyText(command.join(" "), child(ctx, dir));
			return;
		}
		case "rebase": {
			for (let k = 0; k < rest.length; k++) {
				const arg = rest[k];
				if ((arg === "-x" || arg === "--exec") && rest[k + 1] !== undefined)
					classifyText(rest[k + 1], child(ctx, dir));
				else if (arg.startsWith("--exec=")) classifyText(arg.slice("--exec=".length), child(ctx, dir));
			}
			return;
		}
		case "bisect":
			if (rest[0] === "run") classifySegment(rest.slice(1), child(ctx, dir));
			return;
	}
	if (state.hub) {
		if (sub === "pull-request") return add(ctx, "pr", "hub pull-request", dir);
		if (sub === "api") return classifyApi(rest, "hub api", ctx, dir);
	}
	if (has(GIT_BUILTINS, sub)) return;
	if (aliasDepth >= MAX_ALIAS_DEPTH) return;
	const value = state.aliases.get(sub) ?? ctx.aliases.get(sub) ?? ctx.opts.resolveAlias?.(sub, dir);
	if (value === undefined || value === "") return;
	if (value.startsWith("!")) {
		classifyText([value.slice(1), ...rest].join(" "), child(ctx, dir));
		return;
	}
	const words = tokenizeShellSegments(value).flat();
	runGit([...words, ...rest], state, aliasDepth + 1);
}

const CONFIG_VALUE_OPTIONS = ["-f", "--file", "--blob", "--type", "--default", "--comment"];
const CONFIG_READ_WORDS = ["get", "unset", "list", "edit", "rename-section", "remove-section"];

/** `git config [opts] key value`: remember aliases for later in the command; setting `core.hooksPath` is a hooks bypass. */
function classifyGitConfig(rest: string[], state: GitState): void {
	const { ctx, dir } = state;
	if (rest.some(arg => /^(?:--get|--unset|--list|--remove-section|--rename-section|--edit|-l$|-e$)/.test(arg))) return;
	const words: string[] = [];
	for (let k = 0; k < rest.length; k++) {
		const arg = rest[k];
		if (CONFIG_VALUE_OPTIONS.includes(arg)) k++;
		else if (!arg.startsWith("-")) words.push(arg);
	}
	if (words[0] === "set") words.shift();
	else if (words[0] !== undefined && CONFIG_READ_WORDS.includes(words[0])) return;
	const [key, value] = words;
	if (key === undefined || value === undefined) return;
	const lower = key.toLowerCase();
	if (lower.startsWith("alias.")) ctx.aliases.set(key.slice(6), value);
	else if (lower === HOOKS_KEY) {
		ctx.hooksOff = true;
		add(ctx, "hooks-bypass", "git config core.hooksPath, which switches git's hooks off", dir);
	}
}

// ── gh / glab / hub api / http clients ──────────────────────────────────────────────────────────

const PR_ACTIONS = ["create", "merge", "close"];

function classifyForge(name: "gh" | "glab", args: string[], ctx: Ctx, dir: string | undefined): void {
	let i = 0;
	const skipFlags = (): void => {
		while (i < args.length && args[i].startsWith("-")) {
			i += args[i] === "-R" || args[i] === "--repo" || args[i] === "--hostname" ? 2 : 1;
		}
	};
	skipFlags();
	const sub = args[i++];
	if (sub === undefined) return;
	if (name === "gh" && sub === "pr") {
		skipFlags();
		const action = args[i];
		if (action !== undefined && PR_ACTIONS.includes(action)) add(ctx, "pr", `gh pr ${action}`, dir);
		return;
	}
	if (name === "glab" && (sub === "mr" || sub === "merge-request")) {
		skipFlags();
		const action = args[i];
		if (action !== undefined && PR_ACTIONS.includes(action)) add(ctx, "pr", `glab mr ${action}`, dir);
		return;
	}
	if (sub === "api") classifyApi(args.slice(i), `${name} api`, ctx, dir);
}

const GRAPHQL_PUBLISH =
	/\b(?:createPullRequest|mergePullRequest|closePullRequest|updatePullRequest|enablePullRequestAutoMerge|createRef|updateRef|createCommitOnBranch|mergeBranch)\b/;
const API_VALUE_OPTIONS = [
	"-H",
	"--header",
	"-q",
	"--jq",
	"-t",
	"--template",
	"--hostname",
	"--cache",
	"-p",
	"--preview",
];

/** `gh api`, `hub api`, `glab api`: a non-GET call to a publishing endpoint, or a GraphQL mutation that publishes. */
function classifyApi(args: string[], label: string, ctx: Ctx, dir: string | undefined): void {
	let method: string | undefined;
	let hasBody = false;
	let opaque = false;
	let endpoint: string | undefined;
	const fields: string[] = [];
	const field = (value: string | undefined): void => {
		hasBody = true;
		if (value === undefined) return;
		fields.push(value);
		if (value.startsWith("query=@") || value === "query=-") opaque = true;
	};
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (arg === "-X" || arg === "--method") method = args[++k];
		else if (arg.startsWith("--method=")) method = arg.slice("--method=".length);
		else if (arg.startsWith("-X") && !arg.startsWith("--")) method = arg.slice(2);
		else if (arg === "-f" || arg === "-F" || arg === "--raw-field" || arg === "--field") field(args[++k]);
		else if (arg.startsWith("--raw-field=")) field(arg.slice("--raw-field=".length));
		else if (arg.startsWith("--field=")) field(arg.slice("--field=".length));
		else if ((arg.startsWith("-f") || arg.startsWith("-F")) && !arg.startsWith("--") && arg.length > 2)
			field(arg.slice(2));
		else if (arg === "--input") {
			hasBody = true;
			opaque = true;
			k++;
		} else if (arg.startsWith("--input=")) {
			hasBody = true;
			opaque = true;
		} else if (API_VALUE_OPTIONS.includes(arg)) k++;
		else if (arg.startsWith("-")) continue;
		else endpoint ??= arg;
	}
	if (endpoint === undefined) return;
	const verb = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
	if (verb === "GET" || verb === "HEAD") return;
	const route = normalizeEndpoint(endpoint);
	if (route === "graphql") {
		if (opaque) add(ctx, "api-write", `${label} graphql with a query that cannot be read`, dir);
		else if (GRAPHQL_PUBLISH.test(fields.join("\n"))) add(ctx, "api-write", `${label} graphql mutation`, dir);
		return;
	}
	if (isPublishPath(route)) add(ctx, "api-write", `${label} ${verb} ${route}`, dir);
}

function normalizeEndpoint(endpoint: string): string {
	return endpoint
		.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
		.replace(/[?#].*$/, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

const PLACEHOLDER = /^(?:\d+|\$?\{[^}]*\}|:[A-Za-z_]\w*)$/;

/** An endpoint path (GitHub or GitLab REST) whose non-GET calls create, merge or close pull requests, or write refs, commits or files. */
export function isPublishPath(route: string): boolean {
	const parts = route.split("/").filter(Boolean);
	for (let k = 0; k < parts.length; k++) {
		const part = parts[k];
		const rest = parts.slice(k + 1);
		if (part === "pulls" || part === "merge_requests") {
			if (rest.length === 0) return true;
			if (rest.length === 1 && PLACEHOLDER.test(rest[0])) return true;
			if (rest.length === 2 && PLACEHOLDER.test(rest[0]) && /^(?:merge|update-branch|rebase)$/.test(rest[1]))
				return true;
		}
		if (part === "merges" || part === "merge-upstream" || part === "contents") return true;
		if (part === "git" && /^(?:refs|commits|trees|tags)$/.test(rest[0] ?? "")) return true;
		if (part === "repository" && /^(?:commits|branches|tags|files)$/.test(rest[0] ?? "")) return true;
	}
	return false;
}

function isForgeHost(host: string, route: string): boolean {
	return /github|gitlab/i.test(host) || /(?:^|\/)api\/v[34]\//.test(route);
}

const DATA_FLAGS = [
	"-d",
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"--data-ascii",
	"--json",
	"-F",
	"--form",
	"--form-string",
	"-T",
	"--upload-file",
	"--post-data",
	"--post-file",
	"--body-data",
	"--body-file",
];
const HTTPIE_BODY_FLAGS = ["--form", "-f", "--json", "-j", "--multipart"];
const HTTP_METHODS = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
const HTTPIE_ITEM = /^[\w.[\]-]+:?=(?!=)/;

/** `curl`, `wget`, `httpie`, `xh`: a write to a publishing endpoint on a GitHub or GitLab host. */
function classifyHttp(name: string, args: string[], ctx: Ctx, dir: string | undefined): void {
	const httpie = name === "http" || name === "https" || name === "xh" || name === "xhs";
	let method: string | undefined;
	let body = false;
	let get = false;
	const urls: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (httpie) {
			if (HTTP_METHODS.test(arg) && urls.length === 0 && method === undefined) method = arg;
			else if (HTTPIE_BODY_FLAGS.includes(arg)) body = true;
			else if (arg.startsWith("-")) continue;
			else if (HTTPIE_ITEM.test(arg)) body = true;
			else urls.push(arg);
			continue;
		}
		if (arg === "-X" || arg === "--request" || arg === "--method") method = args[++k];
		else if (arg.startsWith("--request=") || arg.startsWith("--method=")) method = arg.slice(arg.indexOf("=") + 1);
		else if (arg.startsWith("-X") && !arg.startsWith("--")) method = arg.slice(2);
		else if (arg === "-G" || arg === "--get") get = true;
		else if (arg === "--url") urls.push(args[++k] ?? "");
		else if (DATA_FLAGS.includes(arg)) {
			body = true;
			k++;
		} else if (
			/^--(?:data(?:-[a-z]+)?|json|form(?:-string)?|upload-file|post-data|post-file|body-data|body-file)=/.test(arg)
		) {
			body = true;
		} else if (/^-[dFT]./.test(arg)) body = true;
		else if (arg.startsWith("-")) continue;
		else urls.push(arg);
	}
	const verb = (method ?? (body && !get ? "POST" : "GET")).toUpperCase();
	if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return;
	for (const url of urls) {
		const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s]+)(\/[^\s]*)?$/i.exec(url);
		if (!match) continue;
		const route = normalizeEndpoint(match[2] ?? "");
		if (!isForgeHost(match[1], route) || !isPublishPath(route)) continue;
		add(ctx, "api-write", `${name} ${verb} ${match[1]}/${route}`, dir);
	}
}

// ── eval cells ──────────────────────────────────────────────────────────────────────────────────

interface Literal {
	text: string;
	start: number;
	end: number;
}

/** String literals of Python or JavaScript source (quotes ' " `, triple quotes), ignoring whole-line comments. */
function extractLiterals(code: string): Literal[] {
	const literals: Literal[] = [];
	let i = 0;
	const n = code.length;
	while (i < n && literals.length < MAX_LITERALS) {
		const ch = code[i];
		if (ch === "#" || (ch === "/" && code[i + 1] === "/")) {
			const lineStart = code.lastIndexOf("\n", i - 1) + 1;
			if (code.slice(lineStart, i).trim() === "") {
				const end = code.indexOf("\n", i);
				i = end === -1 ? n : end;
				continue;
			}
		}
		if (ch === "/" && code[i + 1] === "*") {
			const end = code.indexOf("*/", i + 2);
			i = end === -1 ? n : end + 2;
			continue;
		}
		if (ch !== "'" && ch !== '"' && ch !== "`") {
			i++;
			continue;
		}
		const triple = ch !== "`" && code.startsWith(ch.repeat(3), i);
		const quote = triple ? ch.repeat(3) : ch;
		const bodyStart = i + quote.length;
		let j = bodyStart;
		while (j < n) {
			if (code[j] === "\\") {
				j += 2;
				continue;
			}
			if (code.startsWith(quote, j)) break;
			if (code[j] === "\n" && !triple && ch !== "`") break;
			j++;
		}
		const bodyEnd = Math.min(j, n);
		const raw = code.slice(bodyStart, bodyEnd);
		const text = raw.replace(/\\(.)/gs, (_, c: string) =>
			c === "n" ? "\n" : c === "t" ? "\t" : c === '"' || c === "'" || c === "\\" || c === "`" ? c : `\\${c}`,
		);
		literals.push({ text, start: i, end: bodyEnd });
		i = code.startsWith(quote, j) ? j + quote.length : bodyEnd + 1;
	}
	return literals;
}

const COMMAND_WORDS = table(["git", "gh", "hub", "glab", "curl", "wget", "http", "https", "xh", "xhs"]);
/** What may sit between two literals of one argument list or one concatenation: commas, brackets, `+`, names, simple calls. */
const LITERAL_GAP = /^(?:[\s,[\]+*.]|[A-Za-z_$][\w$]*(?:\([^()'"`\n]*\))?|\d+)*$/;
const GAP_NAME = /[A-Za-z_$\d]/;
const SCRIPT_WRITE_EVIDENCE = /\b(?:post|put|patch|delete)\b|\b(?:data|json|body)\s*[=:]/i;
const OCTOKIT_PUBLISH =
	/\b(?:pulls\.(?:create|merge|update)|git\.(?:createRef|updateRef|deleteRef|createCommit|createTree|createTag)|repos\.(?:merge|mergeUpstream|createOrUpdateFileContents|deleteFile))\b|\.(?:create_pull|create_git_ref|create_git_commit|create_git_tree|create_file|update_file|delete_file)\s*\(/;

/**
 * Findings for the source of an `eval` cell (Python or JavaScript): a loose scan over its string literals, with no
 * attempt to run or even parse the language. A literal is classified as a shell command; an argument list written as
 * adjacent literals (`["git", "-C", repo, "push"]`, `run("git", ["push"])`) or a concatenation (`"git -C " + d + " push"`)
 * is classified as the command it spells, with a placeholder for each name between the pieces; a literal that names a
 * publishing REST path next to a write verb is an `api-write`, and so are Octokit/PyGithub write calls.
 *
 * It may refuse code that merely contains those forms (a docstring about `git push` in a string); it cannot see a
 * command built from variables, read from a file or assembled character by character.
 */
export function classifyScript(code: string, opts: ClassifyOptions = {}): PublishFinding[] {
	const findings: PublishFinding[] = [];
	const push = (found: PublishFinding[]): void => {
		for (const finding of found) findings.push(finding);
	};
	for (const line of code.split("\n")) {
		const bang = /^\s*!\s*([A-Za-z].*)$/.exec(line);
		if (bang) push(classifyPublish(bang[1], opts));
	}
	const literals = extractLiterals(code);
	for (let k = 0; k < literals.length; k++) {
		const literal = literals[k];
		if (literal.text.length > MAX_LITERAL_CHARS) continue;
		if (/\s/.test(literal.text.trim()) || literal.text.startsWith("git-")) push(classifyPublish(literal.text, opts));
		if (GRAPHQL_PUBLISH.test(literal.text) && /\bmutation\b/.test(literal.text)) {
			findings.push({ kind: "api-write", what: "a GraphQL mutation that publishes" });
		}
		const route = literalRoute(literal.text);
		if (route !== undefined && isPublishPath(route)) {
			const from = Math.max(0, literal.start - 300);
			const around = code.slice(from, Math.min(code.length, literal.end + 300));
			if (SCRIPT_WRITE_EVIDENCE.test(around)) findings.push({ kind: "api-write", what: `a write to ${route}` });
		}
		const first = literal.text.trim().split(/\s+/)[0] ?? "";
		const startsArgv = has(COMMAND_WORDS, baseName(literal.text.trim()));
		const startsConcat = has(COMMAND_WORDS, baseName(first));
		if (!startsArgv && !startsConcat) continue;
		const argv: string[] = [];
		let concat = "";
		let previous = literal;
		const pieces = [literal];
		for (let m = k + 1; m < literals.length && pieces.length < 24; m++) {
			const gap = code.slice(previous.end + 1, literals[m].start);
			if (!LITERAL_GAP.test(gap)) break;
			pieces.push(literals[m]);
			previous = literals[m];
		}
		let before: Literal | undefined;
		for (const piece of pieces) {
			const named = before !== undefined && GAP_NAME.test(code.slice(before.end + 1, piece.start));
			if (named) {
				argv.push("__x__");
				concat += " __x__ ";
			}
			argv.push(`'${piece.text.replace(/'/g, `'\\''`)}'`);
			concat += piece.text;
			before = piece;
		}
		if (startsArgv) push(classifyPublish(argv.join(" "), opts));
		if (startsConcat && pieces.length > 1) push(classifyPublish(concat, opts));
	}
	if (OCTOKIT_PUBLISH.test(code))
		findings.push({
			kind: "api-write",
			what: "an Octokit/PyGithub call that writes pull requests, refs, commits or files",
		});
	return dedupe(findings);
}

/** The REST path of a literal that looks like a URL or a `METHOD /path` route; undefined for anything else. */
function literalRoute(text: string): string | undefined {
	const trimmed = text.trim().replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/i, "");
	const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s]*)(\/[^\s]*)$/i.exec(trimmed);
	if (!match) return undefined;
	const route = normalizeEndpoint(match[2]);
	if (match[1] === "") return route;
	return isForgeHost(match[1], route) ? route : undefined;
}
