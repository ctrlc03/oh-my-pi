/**
 * Prompt recall, like a shell's history: ↑ in an empty message box brings back the previous prompt of this
 * session, ↑ again the one before, ↓ walks forward and ends on the draft that was there.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { isPrompt } from "./trim";
import { stripMentionContext } from "./mentions";

/** A prompt longer than this (a pasted log, a skill's expansion) is not worth recalling. */
export const MAX_RECALL_CHARS = 20_000;

/** Where a walk through the history stands: `index` into the list it started with (null: not walking) and the draft it left. */
export interface RecallState {
	index: number | null;
	draft: string;
}

export const NOT_RECALLING: RecallState = { index: null, draft: "" };

function promptText(entry: SessionEntry): string {
	const content =
		entry.type === "custom_message"
			? entry.content
			: entry.type === "message" && entry.message.role === "user"
				? entry.message.content
				: "";
	if (typeof content === "string") return content;
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

/**
 * The prompts on `entries` (the session's active path), oldest first: as typed, without the context the host
 * appended for mentions, skipping host-injected and oversized ones and collapsing a prompt repeated in a row.
 */
export function promptHistory(entries: readonly SessionEntry[]): string[] {
	const history: string[] = [];
	for (const entry of entries) {
		if (!isPrompt(entry)) continue;
		if (entry.type === "message" && entry.message.role === "user" && entry.message.synthetic) continue;
		const text = stripMentionContext(promptText(entry)).trim();
		if (text === "" || text.length > MAX_RECALL_CHARS || history.at(-1) === text) continue;
		history.push(text);
	}
	return history;
}

/** The caret of the message box: where the selection starts and ends. */
export interface RecallCaret {
	start: number;
	end: number;
}

/**
 * One ↑ (`older`) or ↓ (`newer`) press. Returns the text to show and the new state, or null when the key keeps
 * its normal meaning (moving the caret): not at the edge of the text, or the box holds something the walk did not put there.
 * ↑ starts only on an empty box; once walking, a one-line prompt steps on whatever the caret, and a multi-line one needs the
 * caret at the very start (↑) or end (↓), so it can still be navigated by line. ↑ at the oldest prompt and ↓ with nothing to
 * come back to do nothing.
 */
export function recallStep(
	history: readonly string[],
	state: RecallState,
	key: "older" | "newer",
	text: string,
	caret: RecallCaret,
): { text: string; state: RecallState } | null {
	const shown = state.index === null ? undefined : history[state.index];
	// A walk whose text was edited is over: what is in the box is a new draft.
	const walking = state.index !== null && shown === text;
	const oneLine = !text.includes("\n");
	if (key === "older") {
		if (!(walking && oneLine) && (caret.start !== 0 || caret.end !== 0)) return null;
		if (walking) {
			const index = (state.index ?? 0) - 1;
			return index < 0 ? null : { text: history[index] ?? text, state: { index, draft: state.draft } };
		}
		if (text !== "" || history.length === 0) return null;
		const index = history.length - 1;
		return { text: history[index] ?? "", state: { index, draft: text } };
	}
	if (!walking || state.index === null) return null;
	if (!oneLine && (caret.start !== text.length || caret.end !== text.length)) return null;
	const index = state.index + 1;
	if (index >= history.length) return { text: state.draft, state: NOT_RECALLING };
	return { text: history[index] ?? text, state: { index, draft: state.draft } };
}
