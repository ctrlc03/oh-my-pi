/**
 * Shell output in markdown commands (`!`cmd``, OpenCode's syntax): a command or prompt template that
 * contains `!`git diff --stat`` has the snippet replaced by the command's output when it runs.
 *
 * Expansion is two-phase so the rest of template rendering stays synchronous. {@link CommandShellExpansion.capture}
 * runs while the template is being rendered: it swaps each snippet for an opaque placeholder (so neither
 * argument substitution nor Handlebars sees the snippet or, later, its output) and records the command with the
 * invocation's arguments turned into environment-variable references: the argument values travel in the command's
 * environment and never become shell source. {@link CommandShellExpansion.resolve} then runs the recorded commands
 * through the bash executor and fills the placeholders in.
 *
 * Project command files can ship snippets, so `commands.shellExpansion` decides which origins may run them;
 * a snippet that may not run stays in the text verbatim.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { executeBash } from "../exec/bash-executor";
import { cfgCommandsShellExpansion, cfgCommandsShellTimeoutMs } from "../extensibility/settings";
import { substituteArgs } from "../utils/command-args";
import type { Settings } from "./settings";

export type ShellExpansionMode = "off" | "user" | "all";

/** Where a command file came from: `project` files travel with a repository and are not the user's own. */
export type CommandOrigin = "user" | "project";

/** Longest output spliced into a prompt; the rest is cut so one noisy command cannot flood the context. */
export const MAX_SHELL_OUTPUT_CHARS = 20_000;

const SNIPPET_PATTERN = /!`([^`]+)`/g;
const PLACEHOLDER_OPEN = "\uE000";
const PLACEHOLDER_CLOSE = "\uE001";
const COMMAND_PREVIEW_CHARS = 80;

function globalMode(settings: Settings): ShellExpansionMode | undefined {
	let node: unknown = settings.getGlobalSettings();
	for (const segment of cfgCommandsShellExpansion.segments) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return node === "off" || node === "user" || node === "all" ? node : undefined;
}

/**
 * Effective `commands.shellExpansion`. The switch arms project-controlled code, so a project layer must not
 * supply it: a repository could otherwise allow its own commands to run shell. A project-sourced value is
 * ignored and the user-level value, or the default, applies.
 */
export function resolveShellExpansionMode(settings: Settings): ShellExpansionMode {
	if (settings.getProvenance(cfgCommandsShellExpansion) !== "project") return cfgCommandsShellExpansion.get(settings);
	logger.warn("Ignoring project-level commands.shellExpansion; set it in the user config");
	return globalMode(settings) ?? "user";
}

/** Whether `origin`'s snippets may run under `mode`. */
export function shellExpansionAllows(mode: ShellExpansionMode, origin: CommandOrigin): boolean {
	return mode === "all" || (mode === "user" && origin === "user");
}

const ARG_ENV_PREFIX = "OMP_COMMAND_ARG_";

/**
 * Which quoting the shell is in at `offset` of `command`; an approximation of POSIX word parsing. A `$( … )`
 * command substitution starts a fresh context, so `"$(printf %s $1)"` reads as bare there, not as inside `"…"`.
 */
function quoteContextAt(command: string, offset: number): "none" | "single" | "double" {
	const frames: Array<"none" | "single" | "double"> = ["none"];
	for (let i = 0; i < offset; i++) {
		const char = command[i];
		const context = frames[frames.length - 1];
		if (context === "single") {
			if (char === "'") frames[frames.length - 1] = "none";
		} else if (char === "\\") {
			i++;
		} else if (char === "$" && command[i + 1] === "(") {
			frames.push("none");
			i++;
		} else if (context === "double") {
			if (char === '"') frames[frames.length - 1] = "none";
		} else if (char === "'") {
			frames[frames.length - 1] = "single";
		} else if (char === '"') {
			frames[frames.length - 1] = "double";
		} else if (char === ")" && frames.length > 1) {
			frames.pop();
		}
	}
	return frames[frames.length - 1];
}

/**
 * How {@link substituteArgs} renders an argument placeholder into `command`: as a reference to the environment
 * variable carrying the value (`names` are those variable names), never as the value itself. The values never become
 * shell source, so no quoting context (`$(…)`, a heredoc, backticks, the author's own quotes) can turn one into code.
 * The quoting scan only decides how the reference is spelled so it reads as one word: bare it is `"$VAR"`, inside
 * `"…"` it is `$VAR`, inside `'…'` it is `'"$VAR"'`. A scan that guesses wrong can change word splitting or
 * leave the text of a reference literal, but cannot execute an argument.
 */
function envReferenceFormatter(command: string): (names: string[], offset: number) => string {
	return (names, offset) => {
		switch (quoteContextAt(command, offset)) {
			case "single":
				return names.map(name => `'"$${name}"'`).join(" ");
			case "double":
				return names.map(name => `$${name}`).join(" ");
			default:
				return names.map(name => `"$${name}"`).join(" ");
		}
	};
}

function preview(command: string): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length <= COMMAND_PREVIEW_CHARS ? flat : `${flat.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`;
}

function capOutput(output: string): string {
	return output.length <= MAX_SHELL_OUTPUT_CHARS
		? output
		: `${output.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n… (output truncated)`;
}

export interface CommandShellOptions {
	mode: ShellExpansionMode;
	/** Directory the commands run in: the session's working directory. */
	cwd: string;
	/** Deadline per command. */
	timeoutMs: number;
	/** Isolates the persistent shell the executor reuses; one per session. */
	sessionKey: string;
	signal?: AbortSignal;
}

export interface CommandShellNotice {
	level: "info" | "warning";
	message: string;
}

/** One captured snippet: the command text, with argument references, and the environment carrying the values. */
interface ShellSnippet {
	source: string;
	env: Record<string, string>;
}

/** Shell expansion of one command invocation. Create one per prompt, `capture` while rendering, then `resolve`. */
export class CommandShellExpansion {
	readonly #options: CommandShellOptions;
	readonly #nonce = Math.random().toString(36).slice(2, 10);
	readonly #commands: ShellSnippet[] = [];
	readonly #skipped: string[] = [];
	#ran: ShellSnippet[] = [];

	constructor(options: CommandShellOptions) {
		this.#options = options;
	}

	/** Build from the session's settings. */
	static fromSettings(
		settings: Settings,
		session: { cwd: string; sessionKey: string; signal?: AbortSignal },
	): CommandShellExpansion {
		return new CommandShellExpansion({
			mode: resolveShellExpansionMode(settings),
			timeoutMs: cfgCommandsShellTimeoutMs.get(settings),
			...session,
		});
	}

	/**
	 * Replace the snippets in `content` with placeholders, queuing each command with its `$1`/`$@`/`$ARGUMENTS`
	 * placeholders rewritten to environment-variable references; the values travel in the environment, not the source.
	 * Content from an origin the mode excludes comes back unchanged.
	 */
	capture(content: string, args: string[], origin: CommandOrigin, commandName: string): string {
		if (!content.includes("!`")) return content;
		if (!shellExpansionAllows(this.#options.mode, origin)) {
			if (/!`[^`]+`/.test(content)) this.#skipped.push(commandName);
			return content;
		}
		const env = Object.fromEntries(args.map((value, index) => [`${ARG_ENV_PREFIX}${index + 1}`, value]));
		const names = Object.keys(env);
		return content.replace(SNIPPET_PATTERN, (_match, command: string) => {
			const source = substituteArgs(command, names, envReferenceFormatter(command));
			const index = this.#commands.push({ source, env }) - 1;
			return `${PLACEHOLDER_OPEN}${this.#nonce}:${index}${PLACEHOLDER_CLOSE}`;
		});
	}

	/** Run the captured commands and splice their output into `text`. A failed command contributes its error text. */
	async resolve(text: string): Promise<string> {
		if (this.#commands.length === 0) return text;
		const outputs: string[] = [];
		for (const command of this.#commands) outputs.push(await this.#run(command));
		this.#ran = [...this.#commands];
		const pattern = new RegExp(`${PLACEHOLDER_OPEN}${this.#nonce}:(\\d+)${PLACEHOLDER_CLOSE}`, "g");
		return text.replace(pattern, (_match, index: string) => outputs[Number(index)] ?? "");
	}

	/** Notices describing what ran and what was held back; empty when the expansion touched no shell. */
	notices(): CommandShellNotice[] {
		const notices: CommandShellNotice[] = [];
		if (this.#ran.length > 0) {
			notices.push({
				level: "info",
				message: `Ran shell from command template: ${this.#ran.map(command => `\`${preview(command.source)}\``).join(", ")}`,
			});
		}
		if (this.#skipped.length > 0) {
			const names = [...new Set(this.#skipped)].map(name => `/${name}`).join(", ");
			notices.push({
				level: "warning",
				message: `Shell expansion skipped in ${names} (commands.shellExpansion is ${this.#options.mode}); the !\`…\` text was left as written.`,
			});
		}
		return notices;
	}

	async #run(command: ShellSnippet): Promise<string> {
		const { cwd, timeoutMs, sessionKey, signal } = this.#options;
		const label = `\`${preview(command.source)}\``;
		try {
			const result = await executeBash(command.source, {
				cwd,
				timeout: timeoutMs,
				sessionKey,
				signal,
				env: command.env,
			});
			const output = capOutput(result.output.replace(/\s+$/, ""));
			let failure: string | undefined;
			if (result.timedOut) failure = `timed out after ${timeoutMs}ms`;
			else if (result.cancelled) failure = "was cancelled";
			else if (result.exitCode !== 0) failure = `exited with code ${result.exitCode ?? "unknown"}`;
			if (failure === undefined) return output;
			logger.warn("command shell snippet failed", { command: command.source, failure });
			return output ? `Error running ${label}: ${failure}\n${output}` : `Error running ${label}: ${failure}`;
		} catch (error) {
			logger.warn("command shell snippet could not run", { command: command.source, error: String(error) });
			return `Error running ${label}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
