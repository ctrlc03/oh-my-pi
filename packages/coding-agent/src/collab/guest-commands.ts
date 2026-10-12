/**
 * Slash commands a collab writer may run from its composer.
 *
 * A guest prompt that starts with `/` is normally a literal message. The host
 * lists the commands below in `welcome.commands`, and routes a prompt naming one
 * of them through the same machinery the TUI editor uses (prompt-template and
 * file-command expansion, `/skill:<name>` loading, the builtin dispatcher), so
 * the result is attributed to the guest instead of the host.
 *
 * Runnable set: skills, markdown file commands, prompt templates (all expand to
 * text and nothing more), plus the builtins in {@link COLLAB_RUNNABLE_BUILTINS}.
 * Deliberately outside it: extension commands, TypeScript custom commands and
 * MCP prompts (their handlers get a command context that can shut the host
 * down, replace its session, or open host UI, and nothing says which ones only
 * produce a prompt), and every builtin that exits, signs in, edits settings or
 * credentials, or opens a host selector. {@link COLLAB_RUNNABLE_BUILTINS} says
 * which builtins stay and why the session-replacing ones are conditional.
 */
import type { CollabCommand, CollabCommandChoice, SessionCommand } from "@oh-my-pi/pi-wire";
import type { CommandShellExpansion } from "../config/command-shell";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { BUILTIN_SLASH_COMMAND_DEFS, lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";

/** How a writer may follow a builtin's name. */
export interface CollabRunnableBuiltin {
	/** Replaces the registry's description where its wording would mislead a guest. */
	description?: string;
	/** Argument hint shown after the name; the registry's inline hint when absent. */
	args?: string;
	/**
	 * `none` refuses any argument, `required` refuses the bare name (its bare form
	 * opens a selector on the host, or does something the guest did not ask for),
	 * `optional` takes either. Absent: whatever the registry's `allowArgs` says.
	 */
	takes?: "none" | "optional" | "required";
	/** Running it replaces the host's session, and with it the room: listed only where the host reopens one. */
	switchesSession?: true;
	/** Runs, but is not listed in `welcome.commands` (an alias of a listed command). */
	unlisted?: true;
	/** The guest session control (`session-cmd`) that runs it, with the same validation and refusals. */
	sessionCmd?: SessionCommand;
}

/**
 * Builtins a writer may run, keyed by canonical name.
 *
 * - `plan`: enters plan mode, optionally with a first prompt. Session-scoped and
 *   reversible, no credentials or settings. Leaving it can open a confirm dialog
 *   on the host terminal, so the host refuses `/plan` while plan mode is on.
 * - `retry`: re-runs the last failed turn; no UI, no arguments.
 * - `clear`: drops the conversation context in place and keeps the session (the host's own
 *   `/clear`). It appends a `reset_boundary` entry, which guests replicate and show as a divider.
 *   The host refuses it while a response streams or a compaction runs, rather than abort either.
 * - `compact`, `model` / `switch`, `effort`, `rename`, `undo`, `redo`: the guest session controls
 *   (`session-cmd`) with a slash spelling. `/model` is the session-only switch
 *   (what `/switch` does): the host's `/model` opens a selector that can also
 *   change saved defaults, which a guest never reaches.
 * - `new`, `resume`, `fork`: replace the session; see ./guest-session-commands.
 *
 * Not here, on purpose: `/shake` rewrites what the model sees without the transcript guests
 * replicate showing it; `/handoff`, `/fresh`, `/branch`,
 * `/tree` and `/delete` have a host selector or confirm in their way or destroy
 * the host's work; the rest edit settings, accounts, files or the host process.
 */
export const COLLAB_RUNNABLE_BUILTINS: Record<string, CollabRunnableBuiltin> = {
	plan: { description: "Enter plan mode: the agent plans before executing" },
	retry: {},
	clear: { description: "Clear the conversation context; the session continues", takes: "none" },
	compact: {
		description: "Compact the conversation to free context",
		args: "[instructions]",
		takes: "optional",
		sessionCmd: "compact",
	},
	model: { description: "Switch this session's model", args: "<provider/id>", takes: "required", sessionCmd: "model" },
	switch: {
		description: "Switch this session's model",
		args: "<provider/id>",
		takes: "required",
		sessionCmd: "model",
		unlisted: true,
	},
	effort: {
		description: "Set the thinking level for this session",
		args: "<level>",
		takes: "required",
		sessionCmd: "thinking",
	},
	rename: { description: "Rename this session", args: "<title>", takes: "required", sessionCmd: "rename" },
	undo: {
		description: "Undo the last turn: rewind before your last prompt and restore its files",
		takes: "none",
		sessionCmd: "undo",
	},
	redo: { description: "Redo the turn the last /undo removed", takes: "none", sessionCmd: "redo" },
	new: { description: "Start a new session; the room follows it", takes: "none", switchesSession: true },
	resume: {
		description: "Resume another session from this folder",
		args: "<session>",
		takes: "required",
		switchesSession: true,
	},
	fork: { description: "Fork this session into a new one", takes: "none", switchesSession: true },
};

/** The host state command routing and listing read; the host builds it from its live session. */
export interface GuestCommandSource {
	/** `skill:<name>` → skill, as the TUI's `ctx.skillCommands`. */
	skills: ReadonlyMap<string, { description?: string }>;
	fileCommands: readonly FileSlashCommand[];
	promptTemplates: readonly PromptTemplate[];
	/** An extension, TypeScript custom or MCP prompt command named `name` exists: the host runs it, guests may not. */
	hasHostOnlyCommand(name: string): boolean;
	/** Shell expansion for one guest invocation; `!`cmd`` snippets in commands and templates run under the host's `commands.shellExpansion`. */
	createShell(): CommandShellExpansion;
	/** Run what `shell` captured and splice the output into `text`, telling the host what ran. */
	resolveShell(shell: CommandShellExpansion, text: string): Promise<string>;
	/** The host reopens a control room after its session switches, so a guest can follow `/new`, `/resume` and `/fork`. */
	keepsGuestsAcrossSwitch: boolean;
	/** Suggested `/resume` arguments: the folder's recent sessions. */
	resumeChoices: readonly CollabCommandChoice[];
}

export type GuestCommandRoute =
	/** Not a command the host knows: send the text as a normal prompt. */
	| { kind: "literal" }
	/** A host command guests may not run, or a runnable one used wrongly. */
	| { kind: "refused"; message: string }
	/** Template or file command: `text` is the expansion to send as the guest's prompt. */
	| { kind: "expanded"; text: string }
	/** `/skill:<name>`: the host loads the skill file and sends its prompt. */
	| { kind: "skill" }
	/** Allowlisted builtin; `args` is what followed it (never handed to the builtin: the host treats it as the guest's own prompt). */
	| { kind: "builtin"; name: string; args: string };

const MAX_WELCOME_COMMANDS = 300;
const MAX_DESCRIPTION_CHARS = 160;

/** One line, bounded: a welcome frame must stay small and a popup row is one line. */
function oneLine(text: string | undefined, limit: number): string | undefined {
	const flat = text?.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** The commands a writer's welcome lists, in the TUI picker's precedence: builtins, file commands, templates, skills. */
export function buildGuestCommands(source: GuestCommandSource): CollabCommand[] {
	const commands: CollabCommand[] = [];
	const seen: Record<string, true> = {};
	const add = (
		name: string,
		description: string | undefined,
		args: string | undefined,
		extra?: Pick<CollabCommand, "choices" | "switchesSession">,
	): void => {
		if (commands.length >= MAX_WELCOME_COMMANDS || Object.hasOwn(seen, name) || /\s/.test(name)) return;
		seen[name] = true;
		const entry: CollabCommand = { name };
		const desc = oneLine(description, MAX_DESCRIPTION_CHARS);
		const hint = oneLine(args, 64);
		if (desc) entry.description = desc;
		if (hint) entry.args = hint;
		if (extra?.choices && extra.choices.length > 0) entry.choices = extra.choices;
		if (extra?.switchesSession) entry.switchesSession = true;
		commands.push(entry);
	};
	// A name a builtin, extension or custom command owns never reaches the file or
	// template expansion at dispatch, so listing it would advertise a lie.
	const taken = (name: string): boolean =>
		lookupBuiltinSlashCommand(name) !== undefined || source.hasHostOnlyCommand(name);

	for (const spec of BUILTIN_SLASH_COMMAND_DEFS) {
		const allowed = Object.hasOwn(COLLAB_RUNNABLE_BUILTINS, spec.name)
			? COLLAB_RUNNABLE_BUILTINS[spec.name]
			: undefined;
		if (!allowed || allowed.unlisted) continue;
		// A command that ends the room is no use to a guest the host would not follow.
		if (allowed.switchesSession && !source.keepsGuestsAcrossSwitch) continue;
		add(spec.name, allowed.description ?? spec.description, allowed.args ?? spec.inlineHint, {
			choices: spec.name === "resume" ? [...source.resumeChoices] : undefined,
			switchesSession: allowed.switchesSession,
		});
	}
	for (const command of source.fileCommands) {
		if (!taken(command.name)) add(command.name, command.description, command.argumentHint);
	}
	for (const template of source.promptTemplates) {
		if (!taken(template.name)) add(template.name, template.description, undefined);
	}
	for (const [name, skill] of source.skills) add(name, skill.description, undefined);
	return commands;
}

/** Decide what a guest prompt starting with `/` means on this host; mirrors the TUI's command precedence. */
export async function routeGuestCommand(text: string, source: GuestCommandSource): Promise<GuestCommandRoute> {
	if (!text.startsWith("/")) return { kind: "literal" };

	if (text.startsWith("/skill:")) {
		const name = text.slice(1).split(/\s/, 1)[0] ?? "";
		return source.skills.has(name)
			? { kind: "skill" }
			: { kind: "refused", message: `/${name} is not a skill on this host` };
	}

	// Builtins resolve first, as in the TUI editor; the parser also splits on `:`.
	const parsed = parseSlashCommand(text);
	const builtin = parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
	if (parsed && builtin) {
		if (!Object.hasOwn(COLLAB_RUNNABLE_BUILTINS, builtin.name)) {
			return { kind: "refused", message: `/${builtin.name} can only be run on the host` };
		}
		const allowed = COLLAB_RUNNABLE_BUILTINS[builtin.name];
		const takes = allowed.takes ?? (builtin.allowArgs ? "optional" : "none");
		if (takes === "none" && parsed.args) {
			return { kind: "refused", message: `/${builtin.name} takes no arguments` };
		}
		if (takes === "required" && !parsed.args) {
			// The bare form opens a selector (or guesses) on the host terminal; a guest names its target.
			return {
				kind: "refused",
				message: `/${builtin.name} needs an argument: /${builtin.name} ${allowed.args ?? builtin.inlineHint ?? "<value>"}`,
			};
		}
		return { kind: "builtin", name: builtin.name, args: parsed.args };
	}

	// File commands and templates split the name on a space only, like the session.
	const space = text.indexOf(" ");
	const name = space === -1 ? text.slice(1) : text.slice(1, space);
	if (source.hasHostOnlyCommand(name)) {
		return { kind: "refused", message: `/${name} is a host command and can only be run on the host` };
	}
	const shell = source.createShell();
	const rendered = expandPromptTemplate(
		expandSlashCommand(text, [...source.fileCommands], shell),
		[...source.promptTemplates],
		shell,
	);
	const expanded = await source.resolveShell(shell, rendered);
	return expanded === text ? { kind: "literal" } : { kind: "expanded", text: expanded };
}
