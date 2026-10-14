/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * These `{role, content, timestamp}` records are our internal conversation
 * shape. The Hindsight retain API ultimately receives a serialized transcript
 * string, so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines. The
 * SessionEntry timestamp is preserved on the internal record as the source
 * event time.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../session/session-entries";
import { entryTurnOrigin, type TurnOrigin } from "../mnemopi/origin";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(sessionManager: ReadonlySessionManagerLike): HindsightMessage[] {
	const messages: HindsightMessage[] = [];

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text, timestamp: entry.timestamp });
	}

	return messages;
}

/**
 * Count user turns exactly as `extractMessages(sessionManager).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Not memoized: messages may be
 * rewritten in place (e.g. image stripping), so each call re-inspects current content.
 */
export function countUserTurns(sessionManager: ReadonlySessionManagerLike): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (hasSubstantiveContent(extractUserText(entry.message))) count++;
	}
	return count;
}

/** A retained message tagged with the turn it belongs to; see {@link extractTurnMessages}. */
export interface TurnMessage extends HindsightMessage {
	/** Index of the turn: each turn-starting entry begins a new one. */
	turn: number;
	turnOrigin: TurnOrigin;
}

/**
 * Text of a turn-starting entry: a user message, or a stamped `collab-prompt` / `personal-event` custom message
 * (hidden follow-ups that {@link extractMessages} skips). Undefined for every entry that starts no turn.
 */
function turnStartText(entry: SessionEntry): { text: string; origin: TurnOrigin } | undefined {
	const origin = entryTurnOrigin(entry);
	if (!origin) return undefined;
	if (entry.type === "message" && entry.message.role === "user")
		return { text: extractUserText(entry.message), origin };
	if (entry.type === "custom_message") return { text: extractUserText(entry), origin };
	return undefined;
}

/**
 * {@link extractMessages} for a Personal session: the same user/assistant text, plus the prompts and events that
 * reach the session as custom messages, each message tagged with the turn it belongs to and that turn's origin.
 * An assistant message belongs to the turn started by the nearest earlier turn-starting entry (the owner's, before
 * any), so a retained transcript can be split per turn and stored under the right author.
 */
export function extractTurnMessages(sessionManager: ReadonlySessionManagerLike): TurnMessage[] {
	const messages: TurnMessage[] = [];
	let turn = 0;
	let turnOrigin: TurnOrigin = { origin: "owner" };
	for (const entry of sessionManager.getEntries()) {
		const start = turnStartText(entry);
		if (start) {
			turn++;
			turnOrigin = start.origin;
			if (hasSubstantiveContent(start.text)) {
				messages.push({ role: "user", content: start.text, timestamp: entry.timestamp, turn, turnOrigin });
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = extractAssistantText(entry.message as AssistantMessage);
		if (hasSubstantiveContent(text)) {
			messages.push({ role: "assistant", content: text, timestamp: entry.timestamp, turn, turnOrigin });
		}
	}
	return messages;
}

/** {@link countUserTurns} over the entries {@link extractTurnMessages} sees. */
export function countTurnStarts(sessionManager: ReadonlySessionManagerLike): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		const start = turnStartText(entry);
		if (start && hasSubstantiveContent(start.text)) count++;
	}
	return count;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
