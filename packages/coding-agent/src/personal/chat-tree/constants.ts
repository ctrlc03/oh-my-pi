/**
 * Numbers of the chat-tree memory mode (docs/personal-chat-tree.md). Every size is in UTF-8 bytes unless the
 * name says characters; none is a token count.
 */

/** A tree node's text: at most this many bytes (the spec's §2). A few bytes over is tolerated, see `NODE_TRIES`. */
export const NODE_MAX_BYTES = 512;

/** The chat view's sawtooth: it grows to `high`, then one batch merges it down to `low` (§3.2). */
export const CHAT_VIEW_HIGH_BYTES = 128_000;
export const CHAT_VIEW_LOW_BYTES = 64_000;

/** A compaction's own view: the chat's view merged further, with the same sawtooth (§4). */
export const COMPACTION_VIEW_HIGH_BYTES = 32_000;
export const COMPACTION_VIEW_LOW_BYTES = 16_000;

/** Lines per cache block of the view (§3.3). */
export const VIEW_BLOCK_LINES = 4;

/** What a view line shows for a message whose node is not built yet. */
export const NOT_SUMMARIZED_TEXT = "(not summarized yet: zoom it)";

/** A tool's output is clipped to its head and tail, this many characters in all (§1). */
export const TOOL_OUTPUT_MAX_CHARS = 30_000;

/**
 * Any other long text is logged as several messages in a row, each at most this many bytes. Not in the spec;
 * chosen so one message stays a comfortable single input for the compactor (about 4,000 tokens).
 */
export const MESSAGE_SPLIT_BYTES = 16_384;

/** `zoom(id, 1)` returns a long message in pages of this many characters (§6). */
export const ZOOM_PAGE_CHARS = 12_000;

/** Calls that run at once, by default (`personal.chatTree.concurrency`). */
export const DEFAULT_CONCURRENCY = 8;

/** A message's node starts once fewer than this many lines before it are still unbuilt (§4). */
export const LEAF_LOOKAHEAD = 8;

/** A compaction may answer over the limit this many times (the first call plus the "Too long" follow-ups) (§4). */
export const NODE_TRIES = 5;

/** How long a turn waits for the messages before it to be summarized before it goes on with placeholders. */
export const TURN_WAIT_MS = 90_000;

/** The status file is rewritten at most this often. */
export const STATUS_MIN_INTERVAL_MS = 1000;

/** The agent's name in the system prompt, and the kinds' wording that follows it. */
export const AGENT_NAME = "Personal";

/** Output cap of a compaction call: a 512-byte line is well under it; the rest is room for a model that thinks first. */
export const COMPACTION_MAX_OUTPUT_TOKENS = 4096;
