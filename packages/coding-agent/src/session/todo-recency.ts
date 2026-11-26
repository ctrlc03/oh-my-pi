import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import type { SessionEntry } from "./session-entries";

/**
 * Whether the user has prompted since the todo list last changed: walking back from the leaf, a prompt or steer the
 * user wrote comes before the last `todo` call or list edit. Prompts count from the terminal (a user message that is
 * neither injected nor a parent agent's IRC steer) and from the app or a joined terminal (a `collab-prompt` the user
 * wrote). A list an earlier request finished is then history, not the session's current work.
 */
export function promptedSinceTodoChange(entries: {
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
}): boolean {
	let entry = entries.getLeafEntry();
	while (entry !== undefined) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user" && message.synthetic !== true && message.parentIrc === undefined) return true;
			if (message.role === "toolResult" && message.toolName === "todo") return false;
		} else if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			return false;
		} else if (
			entry.type === "custom_message" &&
			entry.customType === COLLAB_PROMPT_MESSAGE_TYPE &&
			entry.attribution === "user"
		) {
			return true;
		}
		entry = entry.parentId === null ? undefined : entries.getEntry(entry.parentId);
	}
	return false;
}
