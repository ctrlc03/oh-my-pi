/** Shared shapes of the chat-tree memory mode (docs/personal-chat-tree.md). */

/** The kinds of a logged message, exactly the spec's (§1): the system prompt's kind list uses the same words. */
export const CHAT_KINDS = ["user", "unii", "tool", "echo", "work", "note"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/** One line of `main/YYYY-MM-DD.jsonl`. `i` is the message's permanent id; `size` is the bytes of `text`; `date` is an ISO UTC timestamp. */
export interface MessageRow {
	i: number;
	kind: ChatKind;
	text: string;
	size: number;
	date: string;
}

/** One line of `tree/YYYY-MM-DD.jsonl`: `node(l, i)` covers the `2^l` messages from `i * 2^l` on; `size` is the bytes of `text`. */
export interface TreeRow {
	l: number;
	i: number;
	text: string;
	size: number;
}

/** A node of the tree as a `[l, i]` pair (the form `view.json` holds). */
export type NodeRef = readonly [l: number, i: number];

/** `status.json`, rewritten atomically at most once a second (see `STATUS_MIN_INTERVAL_MS`). */
export interface ChatTreeStatus {
	messages: number;
	nodesBuilt: number;
	nodesPending: number;
	viewBytes: number;
	/** Nodes whose last compaction call failed and wait for the next message to be tried again. */
	compactionsFailed: number;
	updatedAt: string;
}

/** The first message a node covers, and how many it covers: the `id+n` of the view. */
export function nodeId(ref: NodeRef): { id: number; n: number } {
	const n = 2 ** ref[0];
	return { id: ref[1] * n, n };
}

/** The key of a node in maps and sets. */
export function nodeKey(l: number, i: number): string {
	return `${l}:${i}`;
}
