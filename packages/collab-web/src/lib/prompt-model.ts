import type { SessionEntry } from "@oh-my-pi/pi-wire";

/**
 * Assistant messages that a model other than the session's answered: entry id to the model id.
 * The session's model applies from its latest `model_change` on, so an earlier answer from
 * another model is plain history and a later one ran on a per-prompt choice (or a fallback).
 * A turn's tool calls produce several assistant messages; only its last one per model is noted.
 */
export function answeredByOtherModel(
	entries: readonly SessionEntry[],
	sessionModelId: string | undefined,
): ReadonlyMap<string, string> {
	const other = new Map<string, string>();
	if (sessionModelId === undefined) return other;
	let from = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "model_change") {
			from = i + 1;
			break;
		}
	}
	// The previous noted reply of the current turn: a later one from the same model replaces it.
	let last: { id: string; model: string } | null = null;
	for (let i = from; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.type === "custom_message" || (entry?.type === "message" && entry.message.role === "user")) {
			last = null;
			continue;
		}
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const model = entry.message.model;
		if (model === "" || model === sessionModelId) continue;
		if (last !== null && last.model === model) other.delete(last.id);
		other.set(entry.id, model);
		last = { id: entry.id, model };
	}
	return other;
}
