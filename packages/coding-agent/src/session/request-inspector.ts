/**
 * Trajectory inspector: one row per model request of a session branch.
 *
 * Everything a row shows is derived from the persisted branch entries, so a
 * resumed session lists its earlier requests too: the assistant message carries
 * the request's timing (`timestamp`, `ttft`, `duration`), usage, cost, model and
 * stop reason, and the entries written since the previous assistant message are
 * what entered the context in between (prompts, tool results, context-note
 * revisions, todo/verify/hook/memory reminders, system-prompt digest changes,
 * compactions, model switches). The live per-request cache ledger
 * (`RequestLedger`) records the same assistant messages as they settle; the
 * report helpers share its hit-rate formula (`cacheHitPct`).
 *
 * Pure layer: tokens come from the caller's counter and text leaves through the
 * caller's `redact`, so the TUI shows plain text and the collab host passes the
 * session's secret obfuscator.
 */
import type { InspectInjected, InspectInjectedKind, InspectRow } from "@oh-my-pi/pi-wire";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { CONTEXT_NOTES_ENTRY_TYPE } from "./context-notes";
import type { SessionEntry } from "./session-entries";

/** Characters of an injected item's text a row keeps. */
export const INSPECT_EXCERPT_CHARS = 1200;
/** Text that goes through `redact`: a secret cut by the excerpt limit is never half-shown. */
const REDACT_INPUT_CHARS = 4 * INSPECT_EXCERPT_CHARS;

/** `system-prompt-digest` custom entries (see `session-tools.ts`) hold the hash of the base prompt a reply was built under. */
const SYSTEM_PROMPT_DIGEST_ENTRY_TYPE = "system-prompt-digest";

export interface InspectBuildOptions {
	/** Estimated tokens of `text`. */
	countTokens: (text: string) => number;
	/** Rewrites text before it leaves the host; identity when absent. */
	redact?: (text: string) => string;
	/** Keep only the newest `limit` rows; `seq` still counts every request. */
	limit?: number;
}

export interface InspectResult {
	rows: InspectRow[];
	/** Requests on the branch, before `limit`. */
	total: number;
}

interface KnownCustomType {
	kind: InspectInjectedKind;
	label: string;
}

/** Custom message types the harness injects, by what they are. Unlisted types fall back to `other` (memory types by name). */
const CUSTOM_TYPES: Record<string, KnownCustomType> = {
	"todo-error-reminder": { kind: "todo", label: "Todo reminder" },
	"mid-run-todo-nudge": { kind: "todo", label: "Todo nudge" },
	"eager-todo-prelude": { kind: "todo", label: "Todo prelude" },
	"eager-task-prelude": { kind: "todo", label: "Task prelude" },
	"verify-failure": { kind: "verify", label: "Verify failure" },
	"claude-hook-context": { kind: "hook", label: "Hook context" },
	"ttsr-injection": { kind: "hook", label: "Rule injection" },
	"experimental-context-notes-reminder": { kind: "context-notes", label: "Context notes reminder" },
	advisor: { kind: "advisor", label: "Advisor note" },
	"autolearn-nudge": { kind: "advisor", label: "Autolearn nudge" },
	"plan-mode-context": { kind: "mode", label: "Plan mode context" },
	"plan-mode-reference": { kind: "mode", label: "Plan mode reference" },
	"goal-mode-context": { kind: "mode", label: "Goal mode context" },
	"goal-continuation": { kind: "mode", label: "Goal continuation" },
	"goal-budget-limit": { kind: "mode", label: "Goal budget limit" },
	"session-stop-continuation": { kind: "hook", label: "Stop-hook continuation" },
};

const MEMORY_CUSTOM_TYPE = /memor|recall|hindsight|mnemopi/i;

/** `foo-bar_baz` → `Foo bar baz`. */
function humanize(customType: string): string {
	const spaced = customType.replace(/[-_:]+/g, " ").trim();
	return spaced.length === 0 ? "Custom message" : spaced[0]!.toUpperCase() + spaced.slice(1);
}

function classifyCustomType(customType: string): KnownCustomType {
	if (Object.hasOwn(CUSTOM_TYPES, customType)) return CUSTOM_TYPES[customType]!;
	if (MEMORY_CUSTOM_TYPE.test(customType)) return { kind: "memory", label: `Memory: ${humanize(customType)}` };
	return { kind: "other", label: humanize(customType) };
}

function textOf(content: string | readonly (TextContent | ImageContent)[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += (text.length > 0 ? "\n" : "") + block.text;
	}
	return text;
}

/** The first `INSPECT_EXCERPT_CHARS` characters of `text` after redaction. */
function excerpt(text: string, redact: ((text: string) => string) | undefined): string | undefined {
	if (text.trim().length === 0) return undefined;
	const head = text.length > REDACT_INPUT_CHARS ? text.slice(0, REDACT_INPUT_CHARS) : text;
	const safe = redact ? redact(head) : head;
	return safe.length > INSPECT_EXCERPT_CHARS ? `${safe.slice(0, INSPECT_EXCERPT_CHARS)}…` : safe;
}

function shortDigest(digest: string): string {
	return digest.length > 8 ? digest.slice(0, 8) : digest;
}

/** Tool results gathered since the previous request; they become one item. */
interface ToolResultTally {
	count: number;
	tokens: number;
	names: Map<string, number>;
}

/**
 * Rows for the model requests on `entries` (a branch, oldest first), each with
 * the context that entered since the request before it.
 */
export function buildInspectRows(entries: readonly SessionEntry[], options: InspectBuildOptions): InspectResult {
	const { countTokens, redact } = options;
	const rows: InspectRow[] = [];
	let pending: InspectInjected[] = [];
	let tools: ToolResultTally | undefined;
	let lastDigest: string | undefined;

	const flushTools = (): void => {
		if (!tools) return;
		const names = [...tools.names].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
		pending.push({
			kind: "tool-results",
			label: `${tools.count} tool result${tools.count === 1 ? "" : "s"}`,
			tokens: tools.tokens,
			...(names.length > 0 ? { text: names } : {}),
		});
		tools = undefined;
	};
	const push = (item: InspectInjected): void => {
		flushTools();
		pending.push(item);
	};

	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const message: AgentMessage = entry.message;
				if (message.role === "assistant") {
					flushTools();
					rows.push(rowOf(rows.length + 1, entry.id, message, pending, redact));
					pending = [];
					break;
				}
				if (message.role === "toolResult") {
					tools ??= { count: 0, tokens: 0, names: new Map() };
					tools.count++;
					tools.tokens += countTokens(textOf(message.content));
					tools.names.set(message.toolName, (tools.names.get(message.toolName) ?? 0) + 1);
					break;
				}
				if (message.role === "user") {
					const text = textOf(message.content);
					push({ kind: "prompt", label: "Prompt", tokens: countTokens(text), text: excerpt(text, redact) });
				} else if (message.role === "developer") {
					const text = textOf(message.content);
					push({
						kind: "hook",
						label: "Developer message",
						tokens: countTokens(text),
						text: excerpt(text, redact),
					});
				}
				break;
			}
			case "custom_message": {
				const known = classifyCustomType(entry.customType);
				const text = textOf(entry.content);
				push({ kind: known.kind, label: known.label, tokens: countTokens(text), text: excerpt(text, redact) });
				break;
			}
			case "custom": {
				if (entry.customType === SYSTEM_PROMPT_DIGEST_ENTRY_TYPE) {
					if (typeof entry.data !== "string" || entry.data === lastDigest) break;
					push({
						kind: "system-prompt",
						label: lastDigest === undefined ? "System prompt" : "System prompt changed",
						tokens: 0,
						text:
							lastDigest === undefined
								? `digest ${shortDigest(entry.data)}`
								: `digest ${shortDigest(lastDigest)} → ${shortDigest(entry.data)}`,
					});
					lastDigest = entry.data;
					break;
				}
				if (entry.customType === CONTEXT_NOTES_ENTRY_TYPE) {
					const data = entry.data;
					const text =
						data !== null && typeof data === "object" && "text" in data && typeof data.text === "string"
							? data.text
							: "";
					push({
						kind: "context-notes",
						label: text.length === 0 ? "Context notes cleared" : "Context notes updated",
						tokens: countTokens(text),
						text: excerpt(text, redact),
					});
				}
				break;
			}
			case "compaction": {
				push({
					kind: "compaction",
					label: "Compaction",
					tokens: countTokens(entry.summary),
					text: excerpt(entry.summary, redact),
				});
				break;
			}
			case "branch_summary": {
				push({
					kind: "other",
					label: "Branch summary",
					tokens: countTokens(entry.summary),
					text: excerpt(entry.summary, redact),
				});
				break;
			}
			case "ttsr_injection": {
				push({
					kind: "hook",
					label: "Rule injection",
					tokens: 0,
					text: excerpt(entry.injectedRules.join(", "), redact),
				});
				break;
			}
			case "model_change": {
				push({ kind: "mode", label: "Model changed", tokens: 0, text: entry.model });
				break;
			}
			case "thinking_level_change": {
				push({ kind: "mode", label: "Thinking level changed", tokens: 0, text: entry.thinkingLevel ?? "off" });
				break;
			}
			case "mode_change": {
				push({ kind: "mode", label: "Mode changed", tokens: 0, text: entry.mode });
				break;
			}
			case "reset_boundary": {
				push({ kind: "compaction", label: "Context reset", tokens: 0 });
				break;
			}
			default:
				break;
		}
	}

	const total = rows.length;
	const limit = options.limit;
	return { rows: limit !== undefined && total > limit ? rows.slice(total - limit) : rows, total };
}

function rowOf(
	seq: number,
	entryId: string,
	message: AssistantMessage,
	injected: InspectInjected[],
	redact: ((text: string) => string) | undefined,
): InspectRow {
	const usage = message.usage;
	const error = message.errorMessage;
	return {
		seq,
		entryId,
		at: message.timestamp,
		model: `${message.provider}/${message.model}`,
		...(typeof message.ttft === "number" ? { ttftMs: message.ttft } : {}),
		...(typeof message.duration === "number" ? { durationMs: message.duration } : {}),
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		cost: usage?.cost?.total ?? 0,
		stopReason: message.stopReason,
		...(error !== undefined && error.length > 0 ? { error: excerpt(error, redact) } : {}),
		injected,
	};
}
