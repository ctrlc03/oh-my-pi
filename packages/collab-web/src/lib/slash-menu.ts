/**
 * Pure logic behind the composer's slash-command popup: which draft opens it, what it
 * lists, and what picking an entry writes back. The popup itself is `SlashMenu.tsx`.
 */

import type { CollabCommand, CollabCommandChoice, WireModel } from "@oh-my-pi/pi-wire";

export type SlashItem =
	| { kind: "command"; command: CollabCommand }
	/** A suggested argument for a command already typed: picking it completes `/name value`. */
	| { kind: "choice"; command: CollabCommand; choice: CollabCommandChoice }
	/** A saved prompt (quick reply): picking it puts its text in the draft. */
	| { kind: "saved"; text: string };

/** Where a command's argument suggestions come from when the host's list carries none of its own. */
const ARGUMENT_SOURCES: Record<string, "models" | "thinking"> = {
	model: "models",
	switch: "models",
	effort: "thinking",
};

/** What the host session offers beyond `welcome.commands`: the models and thinking levels `/model` and `/effort` take. */
export interface SlashSources {
	models: readonly WireModel[] | null;
	thinkingLevels: readonly string[] | undefined;
}

/** Entries shown per kind; the host can list hundreds of commands. */
const MAX_COMMANDS = 50;
const MAX_SAVED = 5;

/**
 * What follows the `/` while the whole draft is still one slash token (no whitespace yet);
 * null for any other draft, so the popup closes once an argument or a second word is typed.
 */
export function slashQuery(text: string): string | null {
	return /^\/\S*$/.test(text) ? text.slice(1) : null;
}

/** The command name and the partial argument of a one-line `/name arg` draft; null for any other draft. */
export function slashArgument(text: string): { name: string; query: string } | null {
	const match = /^\/(\S+) ([^\n]*)$/.exec(text);
	return match === null ? null : { name: match[1] ?? "", query: match[2] ?? "" };
}

/** Everything `command`'s argument may be, as suggestions; empty when nothing is known about it. */
export function argumentChoices(command: CollabCommand, sources: SlashSources): CollabCommandChoice[] {
	const source = Object.hasOwn(ARGUMENT_SOURCES, command.name) ? ARGUMENT_SOURCES[command.name] : undefined;
	if (source === "models") {
		return (sources.models ?? []).map(model => ({
			value: `${model.provider}/${model.id}`,
			label: model.name,
			description: `${model.provider}/${model.id}`,
		}));
	}
	if (source === "thinking") return (sources.thinkingLevels ?? []).map(level => ({ value: level }));
	return command.choices ?? [];
}

/** Suggestions containing what was typed: prefix matches first, then substrings, then description hits; host order within a rank. */
export function matchChoices(query: string, choices: readonly CollabCommandChoice[]): CollabCommandChoice[] {
	const needle = query.trim().toLowerCase();
	const rank = (choice: CollabCommandChoice): number => {
		if (needle === "") return 0;
		const value = choice.value.toLowerCase();
		const label = choice.label?.toLowerCase() ?? "";
		if (value.startsWith(needle) || label.startsWith(needle)) return 0;
		if (value.includes(needle) || label.includes(needle)) return 1;
		return choice.description?.toLowerCase().includes(needle) ? 2 : -1;
	};
	return choices
		.map((choice, index) => ({ choice, index, score: rank(choice) }))
		.filter(entry => entry.score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, MAX_COMMANDS)
		.map(entry => entry.choice);
}

/** 0 = name starts with the query, 1 = a `:`/`-` separated part does, 2 = name contains it, 3 = description does; -1 = no match. */
function rank(command: CollabCommand, query: string): number {
	if (query === "") return 0;
	const name = command.name.toLowerCase();
	if (name.startsWith(query)) return 0;
	if (name.split(/[:\-_/]/).some(part => part.startsWith(query))) return 1;
	if (name.includes(query)) return 2;
	if (command.description?.toLowerCase().includes(query)) return 3;
	return -1;
}

/** Host commands matching `query` (best matches first, host order within a rank), then saved prompts containing it. */
export function matchSlash(query: string, commands: readonly CollabCommand[], saved: readonly string[]): SlashItem[] {
	const needle = query.toLowerCase();
	const ranked = commands
		.map((command, index) => ({ command, index, score: rank(command, needle) }))
		.filter(entry => entry.score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, MAX_COMMANDS);
	const items: SlashItem[] = ranked.map(({ command }) => ({ kind: "command", command }));
	let shown = 0;
	for (const text of saved) {
		if (shown === MAX_SAVED) break;
		if (needle !== "" && !text.toLowerCase().includes(needle)) continue;
		items.push({ kind: "saved", text });
		shown++;
	}
	return items;
}

/**
 * The commands worth listing: one that ends the room (`/new`, `/resume`, `/fork`) needs a paired computer to bring
 * this guest to the successor room, and without one it would just drop the connection.
 */
export function usableCommands(commands: readonly CollabCommand[], followsRoom: boolean): readonly CollabCommand[] {
	return followsRoom ? commands : commands.filter(command => command.switchesSession !== true);
}

/** Suggestions for the argument of the command typed in `draft`, as popup items; empty when `draft` is not `/name arg` of a listed command with suggestions. */
export function matchArgument(draft: string, commands: readonly CollabCommand[], sources: SlashSources): SlashItem[] {
	const typed = slashArgument(draft);
	if (typed === null) return [];
	const command = commands.find(candidate => candidate.name === typed.name);
	if (command === undefined) return [];
	return matchChoices(typed.query, argumentChoices(command, sources)).map(choice => ({
		kind: "choice",
		command,
		choice,
	}));
}

/** The draft after picking `item`: a command becomes `/name ` (ready for arguments), a choice `/name value`, a saved prompt its text. */
export function applySlash(item: SlashItem): string {
	if (item.kind === "saved") return item.text;
	return item.kind === "choice" ? `/${item.command.name} ${item.choice.value}` : `/${item.command.name} `;
}
