/**
 * Shared wire types for the omp collab live-session protocol.
 *
 * Dependency-free JSON shapes produced by `@oh-my-pi/pi-coding-agent`
 * (`src/collab/protocol.ts` and friends). Browser and test clients import this
 * package instead of depending on the coding-agent runtime; conformance is
 * asserted type-only in `packages/coding-agent/test/collab/web-wire.types.ts`.
 *
 * Unknown entry/event variants arrive over the wire as plain JSON. The unions
 * below cover only the variants this client renders; consumers cast at the
 * JSON boundary and every `switch` keeps a tolerant `default:` branch.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: WireUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as SessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

export interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format. */
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export type SessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
	from?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Events (handled subset)
// ═══════════════════════════════════════════════════════════════════════════

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	/** Carries the FULL accumulating partial message — no delta tracking needed. */
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// ═══════════════════════════════════════════════════════════════════════════
// State & agents
// ═══════════════════════════════════════════════════════════════════════════

/** An agent profile a writer may switch to with `session-cmd` `profile` (feature `profiles`). */
export interface WireProfile {
	name: string;
	description?: string;
}

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
	/** Thinking selectors this model accepts, for a `prompt`'s `thinking`; sent by hosts that advertise `prompt-model`. */
	thinkingLevels?: string[];
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface Participant {
	name: string;
	role: "host" | "guest";
	/** True when the guest joined through a read-only (view) link. */
	readOnly?: boolean;
}

/** Spend against the host's `session.maxCostUsd` / `session.maxTokens`; a limit that is not set is absent. */
export interface SessionSpend {
	costUsd: number;
	/** Input + output + cache-write tokens, as counted against `maxTokens`. */
	tokens: number;
	maxCostUsd?: number;
	maxTokens?: number;
	/** True once a limit is reached: the host stopped at a safe point and refuses prompts until it is raised. */
	capped: boolean;
}

/** Debounced footer snapshot broadcast by the host. */
export interface SessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	/** Host cwd — display only; the guest never chdirs. */
	cwd: string;
	model?: WireModel;
	thinkingLevel?: string;
	contextUsage?: ContextUsage;
	participants: Participant[];
	isAborting?: boolean;
	/** Thinking levels the current model accepts, for a `session-cmd` `thinking`; absent on hosts without `session-cmd`. */
	thinkingLevels?: string[];
	/** Texts of the host's queued follow-ups, oldest first; present only on hosts with feature `follow-up`. */
	followUps?: string[];
	/** How many undone turns `session-cmd` `redo` can bring back; present only on hosts with feature `undo`. */
	redoTurns?: number;
	/** Session spend against its cap; present only on hosts with feature `spend-cap`, and only while a cap is set. */
	spend?: SessionSpend;
	/** Name of the active agent profile; present only on hosts with feature `profiles`. */
	profile?: string;
}

export interface AgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	/** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bus payloads (task subagent lifecycle/progress channels)
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	/** Argument key selected for the display preview, when known. */
	currentToolArgsKey?: string;
	/** Intent the model attached to the current call; undefined when that call carried none. */
	currentToolIntent?: string;
	currentToolStartMs?: number;
	recentTools: { tool: string; args: string; argsKey?: string; intent?: string; isError?: boolean; endMs: number }[];
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frames (JSON inside the AES-GCM seal)
// ═══════════════════════════════════════════════════════════════════════════

export type CollabUiSelectItem = string | { label: string; description?: string };

export type CollabUiResponseValue = string | undefined;

export type CollabUiRequestDraft =
	| {
			kind: "select";
			title: string;
			options: CollabUiSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| {
			kind: "editor";
			title: string;
			prefill?: string;
	  };

export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };

export type GuestFrame =
	| {
			t: "hello";
			proto: number;
			name: string;
			/**
			 * base64url write token proving full-link possession; absent for
			 * read-only (view) links. The host marks peers without a valid token
			 * read-only and rejects their mutating frames.
			 */
			writeToken?: string;
			/**
			 * Delta resume: the guest still holds a replica of this session and
			 * asks for only the entries after `entryId` (the last entry it has).
			 * The host honours it when `sessionId` is the session it currently
			 * mirrors and `entryId` is in its snapshot, and answers with
			 * `welcome.resumed: true`; otherwise it sends the full snapshot as
			 * usual. Hosts that predate the field ignore it (full snapshot).
			 */
			resume?: { sessionId: string; entryId: string };
			/**
			 * The guest can open compressed frames (sealed plaintext starting with
			 * a 0x00 byte followed by deflate-raw JSON). Hosts compress targeted
			 * frames only toward peers that sent this; hosts that predate the field
			 * never compress.
			 */
			zip?: boolean;
	  }
	/**
	 * `deliver` absent = steer into the running turn. `follow-up`: when the
	 * agent is working, deliver after the current turn ends as its own turn;
	 * idle, it is a normal prompt. Hosts that predate the field steer. Text
	 * starting with `/<name>` for a `welcome.commands` entry runs that command.
	 * `model` (`provider/id` of one of `welcome.models`) and `thinking` (one of
	 * that model's `thinkingLevels`) run this prompt, and any turns it starts,
	 * on that model without switching the session's; the session model and
	 * thinking level are unchanged once the run settles. Sent only to hosts
	 * that advertise `prompt-model`; others run the prompt on the session model.
	 */
	| {
			t: "prompt";
			text: string;
			images?: ImageContent[];
			deliver?: "follow-up";
			model?: string;
			thinking?: string;
	  }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number }
	/**
	 * Run a host session control. `compact`: `arg` is optional custom
	 * instructions. `model`: `arg` is `provider/id` of one of `welcome.models`.
	 * `thinking`: `arg` is one of `state.thinkingLevels`. `rename`: `arg` is the
	 * new session name, as the host's `/rename`; it reaches guests as
	 * `state.sessionName`. Write access required. Hosts that predate the frame
	 * ignore it, so guests offer these controls only when `welcome.models` is
	 * present; hosts that predate a command answer it with an `error`.
	 */
	| { t: "session-cmd"; cmd: SessionCommand; arg?: string; restoreFiles?: boolean };

/**
 * Optional host capabilities advertised in `welcome.features`. `commands`: the
 * host lists the slash commands a writer may run in `welcome.commands` and
 * dispatches a `prompt` whose text starts with one of them as that command.
 * `prompt-model`: a `prompt` may carry `model`/`thinking` to run on another
 * model for that prompt only.
 */
export type CollabFeature =
	| "follow-up"
	| "rewind"
	| "commands"
	| "prompt-model"
	| "rewind-files"
	| "undo"
	| "spend-cap"
	| "context-items"
	| "profiles";

/** A slash command a writer may run by sending it as a `prompt` (`/name args`). */
export interface CollabCommand {
	/** Name without the leading slash; may contain `:` (e.g. `skill:review`). */
	name: string;
	description?: string;
	/** Argument hint to show after the name, e.g. `[prompt]`. */
	args?: string;
	/**
	 * Values worth offering for the argument, most useful first (`/resume`: the
	 * current folder's recent sessions, `value` being what the host resolves).
	 * Suggestions only: the host validates whatever arrives. Absent when the host
	 * has none, or lists the choices elsewhere (`/model` and `/effort` take
	 * `welcome.models` and `state.thinkingLevels`).
	 */
	choices?: CollabCommandChoice[];
	/**
	 * Running it ends this room: the host's session changes identity, so it
	 * retires the room and opens a successor under its auto-start policy. A guest
	 * follows through its paired computer; without one the connection simply ends.
	 */
	switchesSession?: boolean;
}

/** One suggested argument for a {@link CollabCommand}. */
export interface CollabCommandChoice {
	/** Text that follows the command name when picked. */
	value: string;
	/** Short display text; the guest falls back to `value`. */
	label?: string;
	description?: string;
}

/**
 * Host session controls a writer may run through `session-cmd`. `rewind`:
 * `arg` is the id of a prompt entry (a user `message`, or a `custom_message`
 * with customType `collab-prompt`) on the active path; the host moves the
 * session leaf to just before it so the next prompt starts a sibling branch,
 * and refuses while streaming, compacting, or busy. `unqueue`: `arg` is the
 * text of a queued follow-up; the host removes the first queued follow-up
 * with that text. `rewind-preview` (feature `rewind-files`): `arg` is a
 * prompt entry id; the host answers with a `rewind-preview` frame. `redo-files`
 * (feature `rewind-files`): undo the last file restore, answered with a
 * `files-restored` frame. `undo` / `redo` (feature `undo`): rewind the conversation
 * to before the last prompt (restoring the files from that prompt's snapshot when
 * the host has one) and return to what the last `undo` left; answered with a
 * `turn-undone` frame, refused while the host is busy or has nothing to undo or redo.
 * `context-items` / `context-prune` (feature `context-items`): the first asks what fills
 * the context window and is answered with a `context-items` frame; `context-prune` takes the
 * `id` of one listed item, elides it from the context the way the host's `/context prune`
 * does, and is answered with a fresh `context-items` frame carrying `pruned`.
 * `profile` (feature `profiles`): `arg` is the name of one of `welcome.profiles`; the host
 * switches the session to it (at the next turn when it is busy) and refuses while plan, goal or
 * vibe mode is active.
 */
export type SessionCommand =
	| "compact"
	| "model"
	| "thinking"
	| "rename"
	| "rewind"
	| "unqueue"
	| "rewind-preview"
	| "redo-files"
	| "undo"
	| "redo"
	| "context-items"
	| "context-prune"
	| "profile";

/** One row of the host's ranking of what fills the context window (`context-items` frame). */
export interface ContextItemRow {
	/** Pass to `session-cmd` `context-prune`; only valid until the context changes. */
	id: string;
	kind: "toolResult" | "file" | "attachment" | "systemPrompt" | "toolSchema";
	/** Human label: `bash bun test`, `src/x.ts (3 reads)`, `System prompt`, … */
	label: string;
	/** Estimated tokens the item occupies. */
	tokens: number;
	/** `tokens` as a fraction (0–1) of the estimated context in use. */
	share: number;
	/** Whether `context-prune` can elide it (system prompt and tool schemas cannot). */
	prunable: boolean;
}

/**
 * What restoring the working tree to before a prompt does: files whose content
 * goes back (`revert`), files created since that are deleted (`remove`), and
 * files deleted since that come back (`recreate`).
 */
export interface RewindFilesPlan {
	revert: number;
	remove: number;
	recreate: number;
}

/** EventBus channels mirrored to guests (task subagent traffic only). */
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. Guests stay in the loading
			 * phase until they have accumulated all of them (or a chunk arrives
			 * with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
			/**
			 * Models a writer may switch to with `session-cmd` `model`. Sent to
			 * writers only, by hosts that accept `session-cmd`; its presence is the
			 * capability signal.
			 */
			models?: WireModel[];
			/**
			 * Slash commands a writer may run. Sent to writers only, by hosts that
			 * advertise the `commands` feature. A `prompt` whose text starts with
			 * `/<name>` for one of these runs it on the host, with the guest named
			 * as its author; a host command that is not listed is refused with an
			 * `error`, and any other text stays a literal prompt. Hosts that predate
			 * the field send everything as literal text.
			 */
			commands?: CollabCommand[];
			/**
			 * True when the host honoured `hello.resume`: `entryCount` and the
			 * `snapshot-chunk` frames carry only the entries AFTER the guest's
			 * `resume.entryId` (possibly none — the train still ends with a
			 * `final` chunk). The guest keeps its replica up to and including that
			 * entry and appends the chunks. Absent/false: the chunks are the full
			 * snapshot and replace the replica.
			 */
			resumed?: boolean;
			/** Optional host capabilities; absent on hosts that predate the field (none). */
			features?: CollabFeature[];
			/**
			 * Agent profiles a writer may switch to with `session-cmd` `profile`. Sent to
			 * writers only, by hosts that advertise the `profiles` feature; `state.profile`
			 * names the active one.
			 */
			profiles?: WireProfile[];
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Hosts split the
	 * transcript into chunks bounded by byte size so a multi-MB session is not
	 * forced through one giant frame the relay may stall on. The last chunk
	 * carries `final: true`; guests finalize the replica on that frame.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentEvent }
	| { t: "state"; state: SessionState }
	/**
	 * The active path changed other than by appending (a guest `rewind`, or
	 * the host user's own rewind / tree navigation). Guests keep their
	 * replicated entries up to and including entry `keep` (`null` = none),
	 * drop everything after it, then append `entries` — the rest of the new
	 * active path. Entries appended later continue from the new leaf.
	 */
	| { t: "branch"; keep: string | null; entries: SessionEntry[] }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	/**
	 * Targeted reply to `session-cmd` `rewind-preview`: what restoring the files
	 * to before prompt `entryId` would change, or `null` when no file snapshot
	 * was recorded for that prompt (the host can not restore its files).
	 */
	| { t: "rewind-preview"; entryId: string; files: RewindFilesPlan | null }
	/**
	 * Targeted reply once files were restored: by `session-cmd` `rewind` with
	 * `restoreFiles` (`kind: "restore"`) or by `redo-files` (`kind: "redo"`).
	 * `plan` is what changed, `skipped` counts files left alone because a path
	 * the snapshot does not cover was in the way, and `canRedo` says whether
	 * `redo-files` can undo it (it can until files change again).
	 */
	| { t: "files-restored"; kind: "restore" | "redo"; plan: RewindFilesPlan; skipped: number; canRedo: boolean }
	/**
	 * Targeted reply to `session-cmd` `undo` / `redo`. `undo`: `text` (and `images`) is the
	 * prompt that was undone, to put back in the message box. `redo`: `staleText` is the
	 * draft the matching undo handed out, to drop if the message box still holds it.
	 * `files` and `skipped` describe the file restore that ran (absent when the files
	 * already matched or the host does not snapshot); `filesUnavailable` says the host
	 * snapshots files but recorded none before that prompt, so only the conversation moved.
	 */
	| {
			t: "turn-undone";
			kind: "undo" | "redo";
			text?: string;
			images?: ImageContent[];
			staleText?: string;
			files?: RewindFilesPlan;
			skipped?: number;
			filesUnavailable?: true;
	  }
	/**
	 * Targeted reply to `session-cmd` `context-items` and `context-prune`: the largest
	 * items filling the context, largest first. `usedTokens` / `contextWindow` give the
	 * share a row takes (`contextWindow` is 0 when no model is selected). `pruned` is
	 * present only in the reply to `context-prune`: how many session entries were
	 * elided and the estimated tokens freed.
	 */
	| {
			t: "context-items";
			items: ContextItemRow[];
			usedTokens: number;
			contextWindow: number;
			pruned?: { entries: number; tokensFreed: number };
	  }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `text` is decoded JSONL from `fromByte`, `newSize` the next offset base. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

export type WireFrame = GuestFrame | HostFrame;

/**
 * Wire protocol version carried in `hello`; the host rejects mismatches.
 *
 * - `1` (legacy): `welcome` carried the full `entries` array inline.
 * - `2`: `welcome` carries only metadata (header/state/agents/entryCount);
 *   transcript entries follow in `snapshot-chunk` frames, so multi-MB
 *   sessions are not gated on a single welcome frame fitting under the
 *   guest's first-welcome timeout.
 * - `3`: host asks guests through `ui-request`/`ui-request-end` host frames
 *   answered by the `ui-response` guest frame. Guests that predate the
 *   grammar would silently drop `ui-request` (asks hang forever on the
 *   host), so they must be rejected at hello.
 */
export const COLLAB_PROTO = 3;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

// ═══════════════════════════════════════════════════════════════════════════
// Envelope & link constants
// ═══════════════════════════════════════════════════════════════════════════

/** Plaintext envelope prefix: `[4B uint32 BE peerId][sealed payload]`. */
export const ENVELOPE_HEADER_LENGTH = 4;

export const ROOM_ID_BYTES = 16;

/** AES-256-GCM room key; the seal key for every collab frame. */
export const ROOM_KEY_BYTES = 32;

/**
 * Compressed seal: sealed plaintext is either UTF-8 JSON (first byte `{`) or
 * this marker byte followed by the deflate-raw bytes of the UTF-8 JSON. `open`
 * auto-detects, so a plain frame always stays valid.
 */
export const ZIP_MARKER = 0x00;

/** A frame is compressed only when its JSON exceeds this many UTF-8 bytes. */
export const ZIP_MIN_BYTES = 1024;

/**
 * Random write token appended to the room key in full links
 * (`base64url(key ∥ token)`); view links carry the bare key. Possession
 * proves prompt/abort/agent-cmd capability to the host.
 */
export const WRITE_TOKEN_BYTES = 16;

/** Default public relay; bare `<roomId>.<key>` links resolve against it. */
export const DEFAULT_RELAY_URL = "wss://my.omp.sh";

/** Default share viewer/upload base; `/share` links resolve against `<base>/<id>#<key>`. */
export const DEFAULT_SHARE_URL = "https://my.omp.sh/s";

/**
 * Query parameter of a collab link naming a second relay the host also serves the room on:
 * `host:port` of a relay on the host's own machine. A viewer on that machine may reach it
 * over loopback and skips the public relay; every other viewer ignores it.
 */
export const LOCAL_RELAY_LINK_PARAM = "local";

const LOOPBACK_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * Normalize a loopback relay address (`127.0.0.1:7467`, `ws://localhost:7467`, `http://[::1]:7467`)
 * into `ws://<host>:<port>`. Null when it is not loopback, has no explicit port, or carries a
 * path, query or fragment: a link must never steer a viewer's WebSocket at another machine.
 */
export function normalizeLocalRelayUrl(input: string): string | null {
	const text = input.trim();
	let url: URL;
	try {
		url = new URL(text.includes("://") ? text : `ws://${text}`);
	} catch {
		return null;
	}
	if (url.protocol !== "ws:" && url.protocol !== "http:") return null;
	if (LOOPBACK_HOSTNAMES[url.hostname] !== true || !url.port) return null;
	if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
	return `ws://${url.hostname}:${url.port}`;
}

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
	/** ws://<loopback>:<port>/r/<roomId>: the same room on the host machine's own relay; absent when the link names none. */
	localWsUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Relay control messages (TEXT JSON, unencrypted, no session data)
// ═══════════════════════════════════════════════════════════════════════════

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

export * from "./stream";
export * from "./tsp";
