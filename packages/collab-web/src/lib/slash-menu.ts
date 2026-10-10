/**
 * Pure logic behind the composer's slash-command popup: which draft opens it, what it
 * lists, and what picking an entry writes back. The popup itself is `SlashMenu.tsx`.
 */

import type { CollabCommand } from "@oh-my-pi/pi-wire";

export type SlashItem =
	| { kind: "command"; command: CollabCommand }
	/** A saved prompt (quick reply): picking it puts its text in the draft. */
	| { kind: "saved"; text: string };

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

/** The draft after picking `item`: a command becomes `/name ` (ready for arguments), a saved prompt becomes its text. */
export function applySlash(item: SlashItem): string {
	return item.kind === "saved" ? item.text : `/${item.command.name} `;
}
