/**
 * References in a guest's prompt (`prompt.mentions`, feature `mentions`). The prompt text stays what
 * the guest typed (`#123`, `@title`); the host appends a short context block that tells the agent what
 * each reference points at and how to read it. Everything a guest sends is checked and shortened here,
 * because it ends up in the model's context.
 */
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { PromptMention } from "@oh-my-pi/pi-wire";

/** The block's tags: the web app strips the block from a prompt it shows back for editing or recall. */
export const MENTION_CONTEXT_OPEN = "<referenced-context>";
export const MENTION_CONTEXT_CLOSE = "</referenced-context>";

const MAX_MENTIONS = 12;
const MAX_TITLE_CHARS = 160;
const MAX_URL_CHARS = 300;
/** Session ids are UUIDs or the shorter ids older sessions carry; anything else cannot name a file. */
const SESSION_ID = /^[\w-]{4,64}$/;

type MessageContent = string | (TextContent | ImageContent)[];

/** One line, no angle brackets (a title must not be able to close the block), shortened. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** An absolute `https` URL without whitespace or credentials, or undefined. */
function safeUrl(raw: string): string | undefined {
	if (raw.length > MAX_URL_CHARS || /\s|[<>]/.test(raw)) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

/** The transcript file of session `id` under one of the session roots (`<root>/<project>/<time>_<id>.jsonl`), or undefined. */
export function findSessionFile(id: string, roots: readonly string[]): string | undefined {
	if (!SESSION_ID.test(id)) return undefined;
	for (const root of roots) {
		try {
			const [match] = Array.from(new Bun.Glob(`*/*_${id}.jsonl`).scanSync({ cwd: root, onlyFiles: true }));
			if (match !== undefined) return path.join(root, match);
		} catch {
			// An unreadable root only means this session is not found there.
		}
	}
	return undefined;
}

function describeMention(mention: PromptMention, roots: readonly string[]): string | undefined {
	if (mention.kind === "pr") {
		if (!Number.isSafeInteger(mention.number) || mention.number <= 0) return undefined;
		const url = typeof mention.url === "string" ? safeUrl(mention.url) : undefined;
		if (url === undefined) return undefined;
		const title = typeof mention.title === "string" ? oneLine(mention.title, MAX_TITLE_CHARS) : "";
		return `- #${mention.number} is a pull request${title ? ` titled "${title}"` : ""}: ${url}`;
	}
	if (mention.kind === "session") {
		if (typeof mention.id !== "string" || !SESSION_ID.test(mention.id)) return undefined;
		const title = typeof mention.title === "string" ? oneLine(mention.title, MAX_TITLE_CHARS) : "";
		const label = title ? `"${title}" ` : "";
		const file = findSessionFile(mention.id, roots);
		const where = file
			? `its transcript is the JSONL session log ${file}; read it with the read tool, or try \`read history://${mention.id}\``
			: `no session log with that id was found on this computer; try \`read history://${mention.id}\``;
		return `- @session ${label}(id ${mention.id}) is another omp session: ${where}`;
	}
	return undefined;
}

/**
 * The context block for `mentions`, or undefined when none is valid. Invalid entries (wrong shape,
 * a non-https URL, an id that cannot name a file) are skipped, never passed through.
 */
export function buildMentionContext(mentions: unknown, roots: readonly string[]): string | undefined {
	if (!Array.isArray(mentions)) return undefined;
	const lines: string[] = [];
	for (const mention of mentions.slice(0, MAX_MENTIONS)) {
		if (typeof mention !== "object" || mention === null) continue;
		const line = describeMention(mention as PromptMention, roots);
		if (line !== undefined && !lines.includes(line)) lines.push(line);
	}
	if (lines.length === 0) return undefined;
	return [MENTION_CONTEXT_OPEN, "The message above refers to:", ...lines, MENTION_CONTEXT_CLOSE].join("\n");
}

/** `content` with the context block after its text (a text part is added when there is none). */
export function withMentionContext(content: MessageContent, context: string | undefined): MessageContent {
	if (context === undefined) return content;
	if (typeof content === "string") return `${content}\n\n${context}`;
	const at = content.findIndex(part => part.type === "text");
	if (at < 0) return [{ type: "text", text: context }, ...content];
	return content.map((part, i) =>
		i === at && part.type === "text" ? { ...part, text: `${part.text}\n\n${context}` } : part,
	);
}
