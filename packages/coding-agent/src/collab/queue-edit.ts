/**
 * Editing a queued collab prompt in place (`session-cmd` `queue-edit`). Only prompts the host itself
 * wrapped as a guest's `collab-prompt` message can be rewritten: the host's own queued input may have been
 * transformed (templates, `^model` mentions) in ways the guest's text no longer describes, and a slash
 * command's queued content is its expansion, not what the guest typed.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "./protocol";
import { withMentionContext } from "./mentions";

/** The reason a queued message cannot be edited, or undefined when it can. */
export function queueEditRefusal(message: AgentMessage, text: string): string | undefined {
	if (message.role !== "custom" || message.customType !== COLLAB_PROMPT_MESSAGE_TYPE) {
		return "only prompts sent from a collab guest can be edited here; remove it and send it again";
	}
	if (text.trimStart().startsWith("/")) return "a slash command cannot be queued by editing; send it as a new prompt";
	const chip = (message.details as { __queueChipText?: unknown } | undefined)?.__queueChipText;
	if (typeof chip === "string" && chip.trimStart().startsWith("/")) {
		return "a queued slash command cannot be edited; remove it and send it again";
	}
	return undefined;
}

/**
 * `message` with `text` (and the mention `context`) in place of its text; its images, author and queue
 * position stay. Call {@link queueEditRefusal} first.
 */
export function rewriteQueuedPrompt(message: AgentMessage, text: string, context: string | undefined): AgentMessage {
	if (message.role !== "custom") return message;
	const images: ImageContent[] =
		typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image");
	const content: string | (TextContent | ImageContent)[] =
		images.length > 0 ? [{ type: "text", text }, ...images] : text;
	const details = message.details && typeof message.details === "object" ? message.details : {};
	return {
		...message,
		content: withMentionContext(content, context),
		details: { ...details, __queueChipText: text },
	};
}
