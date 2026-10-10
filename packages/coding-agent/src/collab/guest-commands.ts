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
 * credentials, switches or moves the session, or opens a host selector.
 */
import type { CollabCommand } from "@oh-my-pi/pi-wire";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { BUILTIN_SLASH_COMMAND_DEFS, lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";

/**
 * Builtins a writer may run, keyed by canonical name. `description` replaces the
 * registry's where its wording would mislead a guest.
 *
 * - `plan`: enters plan mode, optionally with a first prompt. Session-scoped and
 *   reversible, no credentials or settings. Leaving it can open a confirm dialog
 *   on the host terminal, so the host refuses `/plan` while plan mode is on.
 * - `retry`: re-runs the last failed turn; no UI, no arguments.
 *
 * `compact`, `rename` and the model/thinking switches are `session-cmd`s already.
 */
export const COLLAB_RUNNABLE_BUILTINS: Record<string, { description?: string }> = {
	plan: { description: "Enter plan mode: the agent plans before executing" },
	retry: {},
};

/** The host state command routing and listing read; the host builds it from its live session. */
export interface GuestCommandSource {
	/** `skill:<name>` → skill, as the TUI's `ctx.skillCommands`. */
	skills: ReadonlyMap<string, { description?: string }>;
	fileCommands: readonly FileSlashCommand[];
	promptTemplates: readonly PromptTemplate[];
	/** An extension, TypeScript custom or MCP prompt command named `name` exists: the host runs it, guests may not. */
	hasHostOnlyCommand(name: string): boolean;
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
	const add = (name: string, description: string | undefined, args: string | undefined): void => {
		if (commands.length >= MAX_WELCOME_COMMANDS || Object.hasOwn(seen, name) || /\s/.test(name)) return;
		seen[name] = true;
		const entry: CollabCommand = { name };
		const desc = oneLine(description, MAX_DESCRIPTION_CHARS);
		const hint = oneLine(args, 64);
		if (desc) entry.description = desc;
		if (hint) entry.args = hint;
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
		if (allowed) add(spec.name, allowed.description ?? spec.description, spec.inlineHint);
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
export function routeGuestCommand(text: string, source: GuestCommandSource): GuestCommandRoute {
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
		if (parsed.args && !builtin.allowArgs) {
			return { kind: "refused", message: `/${builtin.name} takes no arguments` };
		}
		return { kind: "builtin", name: builtin.name, args: parsed.args };
	}

	// File commands and templates split the name on a space only, like the session.
	const space = text.indexOf(" ");
	const name = space === -1 ? text.slice(1) : text.slice(1, space);
	if (source.hasHostOnlyCommand(name)) {
		return { kind: "refused", message: `/${name} is a host command and can only be run on the host` };
	}
	const expanded = expandPromptTemplate(expandSlashCommand(text, [...source.fileCommands]), [
		...source.promptTemplates,
	]);
	return expanded === text ? { kind: "literal" } : { kind: "expanded", text: expanded };
}
