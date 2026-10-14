/**
 * A digest of the conversation of an omp session, for the quiz agent: what the user asked for and what the assistant
 * said back, so a question can ask why a change was made. Only prompts and assistant prose go in: no tool calls, no
 * tool results, no thinking, no injected reminders, no bookkeeping entries.
 *
 * A session file is JSONL (see companion-sessions.ts): user prompts typed in the app are
 * `{type:"custom_message", customType:"collab-prompt", attribution:"user", content}`, other user turns are
 * `{type:"message", message:{role:"user"}}`, assistant turns `{type:"message", message:{role:"assistant", content:[…]}}`.
 */

import { isRecord } from "../src/tool-render/util";

export interface DigestTurn {
	role: "user" | "assistant";
	text: string;
}

export interface Digest {
	text: string;
	/** Turns in `text`. */
	turns: number;
	/** Turns left out to fit the budget. */
	omitted: number;
}

/** A long user prompt is cut to about this many characters: the head and the tail carry the intent. */
const PROMPT_CHARS = 700;
/** An assistant turn is never clipped below this while others can be dropped instead. */
const MIN_ASSISTANT_CHARS = 240;
const SEPARATOR = "\n\n";
const SUMMARY_PREFIX = "Earlier in the session (summary): ";
/** Lines longer than this (a tool result with a file in it) are skipped without parsing. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function clean(text: string): string {
	return text
		.replace(REMINDER_RE, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** The text of a message `content`: a string, or the `text` blocks of a block list. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n\n");
}

/** Builds the turns from entries fed in file order, so a big file never has to be held whole. */
class TurnCollector {
	readonly turns: DigestTurn[] = [];
	/** The summary of the latest compaction that came before any turn: earlier history the file no longer holds. */
	#summary: string | null = null;
	/** The assistant turn being built: consecutive assistant text between two user prompts. */
	#assistant: string[] = [];

	push(entry: unknown): void {
		if (!isRecord(entry)) return;
		if (entry.type === "compaction") {
			if (this.turns.length === 0 && this.#assistant.length === 0 && typeof entry.summary === "string") {
				this.#summary = clean(entry.summary);
			}
			return;
		}
		if (entry.type === "custom_message") {
			if (entry.customType === "collab-prompt" && entry.attribution === "user") this.#user(textOf(entry.content));
			return;
		}
		if (entry.type !== "message" || !isRecord(entry.message)) return;
		if (entry.message.role === "user") this.#user(textOf(entry.message.content));
		else if (entry.message.role === "assistant") {
			const text = clean(textOf(entry.message.content));
			if (text) this.#assistant.push(text);
		}
	}

	#user(raw: string): void {
		const text = clean(raw);
		if (!text) return;
		this.#flush();
		this.turns.push({ role: "user", text });
	}

	#flush(): void {
		if (this.#assistant.length === 0) return;
		this.turns.push({ role: "assistant", text: this.#assistant.join(SEPARATOR) });
		this.#assistant = [];
	}

	finish(): DigestTurn[] {
		this.#flush();
		if (this.#summary) this.turns.unshift({ role: "assistant", text: SUMMARY_PREFIX + this.#summary });
		return this.turns;
	}
}

/**
 * The conversation of a session as turns, oldest first: user prompts and, between them, the assistant's text joined
 * into one turn. A compaction summary becomes an assistant turn ("Earlier in the session (summary): …") only when no
 * turn comes before the compaction in the file, that is when the history it replaced is gone; a file that still holds
 * every turn is read as it is.
 */
export function extractTurns(entries: readonly unknown[]): DigestTurn[] {
	const collector = new TurnCollector();
	for (const entry of entries) collector.push(entry);
	return collector.finish();
}

// ── render ───────────────────────────────────────────────────────────────────

function label(turn: DigestTurn): string {
	return turn.role === "user" ? "User: " : "Assistant: ";
}

/** `text` cut to at most `limit` characters: the head and the tail stay, the middle becomes a marker. */
function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = (cut: number) => `[… ${cut} characters cut]`;
	if (limit <= marker(text.length).length + 2) return text.slice(0, Math.max(0, limit));
	const room = Math.max(0, limit - marker(text.length).length - 2);
	const head = Math.ceil(room * 0.6);
	const tail = room - head;
	const clipped = `${text.slice(0, head).trimEnd()}\n${marker(text.length - head - tail)}\n${tail > 0 ? text.slice(text.length - tail).trimStart() : ""}`;
	return clipped.trimEnd();
}

function size(turn: DigestTurn, text: string): number {
	return label(turn).length + text.length + SEPARATOR.length;
}

/** The largest cap `c` such that clipping every text to `c` characters stays within `room`; 0 when none does. */
function fairCap(lengths: readonly number[], room: number): number {
	let low = 0;
	let high = Math.max(0, ...lengths);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const total = lengths.reduce((sum, length) => sum + Math.min(length, mid), 0);
		if (total <= room) low = mid;
		else high = mid - 1;
	}
	return low;
}

/**
 * The turns as `User: …` and `Assistant: …` blocks separated by blank lines, oldest first, within `budgetChars`.
 * Every user prompt is kept (a long one is clipped to about {@link PROMPT_CHARS} characters). The assistant turns
 * share what is left: the longest are clipped first, keeping their head and tail. When even clipped they do not fit,
 * the oldest assistant turns are dropped; when the prompts alone exceed the budget, the oldest prompts are dropped.
 * Deterministic.
 */
export function renderDigest(turns: readonly DigestTurn[], budgetChars: number): Digest {
	const budget = Math.max(0, Math.floor(budgetChars));
	const texts = turns.map(turn => (turn.role === "user" ? clip(turn.text, PROMPT_CHARS) : turn.text));
	const kept = turns.map(() => true);
	const userIndexes = turns.flatMap((turn, i) => (turn.role === "user" ? [i] : []));
	const assistantIndexes = turns.flatMap((turn, i) => (turn.role === "assistant" ? [i] : []));
	const cost = (i: number) => size(turns[i] as DigestTurn, texts[i] as string);

	// Prompts first: they carry the intent; drop the oldest only when they alone are over budget.
	let promptTotal = userIndexes.reduce((sum, i) => sum + cost(i), 0);
	for (const i of userIndexes) {
		if (promptTotal <= budget + SEPARATOR.length) break;
		kept[i] = false;
		promptTotal -= cost(i);
	}
	const survivors = userIndexes.filter(i => kept[i]);
	const sole = survivors.length === 1 ? survivors[0] : undefined;
	if (sole !== undefined && cost(sole) > budget + SEPARATOR.length) {
		texts[sole] = clip(texts[sole] as string, Math.max(0, budget - label(turns[sole] as DigestTurn).length));
	}

	// Assistant turns: clip the longest to a common cap; drop the oldest while the cap would fall below the floor.
	const room = () => budget + SEPARATOR.length - userIndexes.filter(i => kept[i]).reduce((sum, i) => sum + cost(i), 0);
	let live = assistantIndexes;
	let cap = 0;
	for (;;) {
		const overhead = live.reduce((sum, i) => sum + label(turns[i] as DigestTurn).length + SEPARATOR.length, 0);
		cap = fairCap(
			live.map(i => (texts[i] as string).length),
			room() - overhead,
		);
		if (
			live.length === 0 ||
			cap >= MIN_ASSISTANT_CHARS ||
			cap >= Math.max(...live.map(i => (texts[i] as string).length))
		)
			break;
		live = live.slice(1);
	}
	for (const i of assistantIndexes) kept[i] = live.includes(i);
	for (const i of live) texts[i] = clip(texts[i] as string, cap);

	const blocks: string[] = [];
	for (let i = 0; i < turns.length; i++) {
		if (kept[i]) blocks.push(`${label(turns[i] as DigestTurn)}${texts[i]}`);
	}
	return { text: blocks.join(SEPARATOR), turns: blocks.length, omitted: turns.length - blocks.length };
}

// ── file ─────────────────────────────────────────────────────────────────────

/**
 * The digest of the session file at `file`, or null when it cannot be read or holds no conversation. The file is
 * streamed line by line (they can be tens of megabytes); a line that is not JSON, or is huge, is skipped.
 */
export async function sessionDigest(file: string, budgetChars: number): Promise<Digest | null> {
	const collector = new TurnCollector();
	try {
		const decoder = new TextDecoder();
		let pending = "";
		let skipping = false;
		const feed = (line: string) => {
			if (!line.startsWith("{") || line.length > MAX_LINE_CHARS) return;
			try {
				collector.push(JSON.parse(line));
			} catch {
				// partial or foreign line
			}
		};
		for await (const chunk of Bun.file(file).stream()) {
			pending += decoder.decode(chunk, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				if (!skipping) feed(pending.slice(0, newline));
				skipping = false;
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			if (pending.length > MAX_LINE_CHARS) {
				pending = "";
				skipping = true;
			}
		}
		pending += decoder.decode();
		if (!skipping) feed(pending);
	} catch {
		return null;
	}
	const turns = collector.finish();
	if (turns.length === 0) return null;
	const digest = renderDigest(turns, budgetChars);
	return digest.turns === 0 ? null : digest;
}
