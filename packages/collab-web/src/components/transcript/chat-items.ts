/**
 * Chat view: the transcript reduced to prompts and replies. Thinking and
 * setting markers are dropped, and every run of tool calls between two pieces
 * of reply text (across assistant messages) folds into one `tools` item.
 */

import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../lib/client";

export interface ChatToolCall {
	id: string;
	name: string;
	intent?: string;
	args: unknown;
	/** From the still-streaming message or a live tool: running until its result lands. */
	pending: boolean;
}

export type ChatItem =
	/** A prompt, host-injected message, or divider, rendered as in the full view. */
	| { kind: "entry"; key: string; entry: SessionEntry }
	| { kind: "text"; key: string; entryId: string | null; text: string; pending: boolean; lead: boolean }
	/** `entryId`: the entry of the run's first call; null for live tools not yet committed. `entryIds`: every entry the run's calls came from. */
	| { kind: "tools"; key: string; entryId: string | null; entryIds: string[]; calls: ChatToolCall[]; lead: boolean }
	| { kind: "stop"; key: string; entryId: string | null; stopReason: "error" | "aborted"; errorMessage?: string };

/**
 * `lead` marks the first agent item after a prompt, which carries the "agent"
 * gutter label. `stream` and `tailTools` (live tools not yet in any message)
 * extend the last run, so a turn in progress reads as one growing line.
 */
export function buildChatItems(
	entries: readonly SessionEntry[],
	stream: AssistantMessage | null,
	streamDone: boolean,
	tailTools: readonly ActiveTool[],
): ChatItem[] {
	const items: ChatItem[] = [];
	let run: { calls: ChatToolCall[]; lead: boolean; entryId: string | null; entryIds: string[] } | null = null;
	let inAgentTurn = false;

	const flush = (): void => {
		if (run === null) return;
		items.push({
			kind: "tools",
			key: `tools:${run.calls[0]?.id}`,
			entryId: run.entryId,
			entryIds: run.entryIds,
			calls: run.calls,
			lead: run.lead,
		});
		run = null;
	};
	const addCall = (call: ChatToolCall, entryId: string | null): void => {
		if (run === null) {
			run = { calls: [], lead: !inAgentTurn, entryId, entryIds: [] };
			inAgentTurn = true;
		}
		if (entryId !== null && !run.entryIds.includes(entryId)) run.entryIds.push(entryId);
		run.calls.push(call);
	};
	const human = (entry: SessionEntry): void => {
		flush();
		inAgentTurn = false;
		items.push({ kind: "entry", key: entry.id, entry });
	};
	const assistant = (message: AssistantMessage, entryId: string | null, pending: boolean): void => {
		message.content.forEach((block, i) => {
			if (block.type === "text") {
				if (!block.text.trim()) return;
				flush();
				items.push({
					kind: "text",
					key: `${entryId ?? "stream"}:${i}`,
					entryId,
					text: block.text,
					pending,
					lead: !inAgentTurn,
				});
				inAgentTurn = true;
			} else if (block.type === "toolCall") {
				addCall({ id: block.id, name: block.name, intent: block.intent, args: block.arguments, pending }, entryId);
			}
		});
		const stop = message.stopReason;
		if (!pending && (stop === "error" || stop === "aborted")) {
			flush();
			items.push({
				kind: "stop",
				key: `stop:${entryId ?? "stream"}`,
				entryId,
				stopReason: stop,
				errorMessage: message.errorMessage,
			});
		}
	};

	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				if (entry.message.role === "user") human(entry);
				else if (entry.message.role === "assistant") assistant(entry.message, entry.id, false);
				break;
			case "custom_message":
				if (entry.customType === "collab-prompt" || entry.display) human(entry);
				break;
			case "compaction":
			case "branch_summary":
				human(entry);
				break;
			default:
				// model / thinking-level markers and unknown entries stay out of the chat
				break;
		}
	}
	if (stream !== null) assistant(stream, null, !streamDone);
	for (const tool of tailTools) {
		addCall({ id: tool.toolCallId, name: tool.toolName, intent: tool.intent, args: tool.args, pending: true }, null);
	}
	flush();
	return items;
}
