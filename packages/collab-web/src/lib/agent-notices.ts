/**
 * Two kinds of custom message the host writes for the model that the transcript draws as cards
 * instead of their agent-facing text (a `<system-notice>` block or an `[IRC …]` envelope):
 *
 * - `async-notify`: output lines a running background job or supervised service was asked to report
 *   (`notify` on the `bash` tool). `details.reports` holds one report per job or service.
 * - `irc:*`: messages between agents (subagents, peers, a work pool) delivered to or relayed through
 *   this session. `details` names the sender and recipient and carries the body.
 *
 * Both parsers accept `details` as an object or as its JSON text (older hosts and some replays
 * store it serialized), and return null or an empty list for anything else, so the row falls back
 * to the message's text.
 */

export const ASYNC_NOTIFY_TYPE = "async-notify";

/** One job's or service's share of an `async-notify` message. */
export interface NotifyReport {
	/** The job id (`bg_3`) or service name, as `proc://` takes it. */
	id: string;
	service: boolean;
	/** Source of its `notify` regex. */
	pattern: string;
	/** Matching output lines, oldest first. */
	lines: string[];
	/** Matching lines left out of `lines`. */
	omitted: number;
	/** Still running when the notice was written. */
	running: boolean;
	/** It matched too often: no further notices come from it. */
	stopped: boolean;
}

function record(details: unknown): Record<string, unknown> | null {
	let value = details;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function toReport(value: unknown): NotifyReport | null {
	const report = record(value);
	const id = str(report?.id);
	if (report === null || id === null) return null;
	const omitted = report.omitted;
	return {
		id,
		service: report.type === "service",
		pattern: typeof report.pattern === "string" ? report.pattern : "",
		lines: Array.isArray(report.lines) ? report.lines.filter((line): line is string => typeof line === "string") : [],
		omitted: typeof omitted === "number" && Number.isInteger(omitted) && omitted > 0 ? omitted : 0,
		running: report.running === true,
		stopped: report.stopped === true,
	};
}

/** The reports of an `async-notify` message; empty when its details carry none. */
export function asyncNotifyReports(details: unknown): NotifyReport[] {
	const reports = record(details)?.reports;
	if (!Array.isArray(reports)) return [];
	return reports.map(toReport).filter((report): report is NotifyReport => report !== null);
}

/**
 * - `incoming`: a message another agent sent this session's agent;
 * - `autoreply`: an agent's automatic answer while it was busy;
 * - `relay`: a message between two other agents, shown here for the record;
 * - `workpool`: a work pool handing an agent its next item.
 */
export type AgentMessageKind = "incoming" | "autoreply" | "relay" | "workpool";

const AGENT_MESSAGE_KINDS: Readonly<Record<string, AgentMessageKind>> = {
	"irc:incoming": "incoming",
	"irc:autoreply": "autoreply",
	"irc:relay": "relay",
	"irc:workpool": "workpool",
};

export interface AgentMessage {
	kind: AgentMessageKind;
	from: string | null;
	to: string | null;
	body: string;
	/** The message this one answers, when it is a reply. */
	replyTo: string | null;
	/** The work pool of a `workpool` message. */
	pool: string | null;
}

/** Whether `customType` is a message between agents (`irc:*`). */
export function isAgentMessageType(customType: string): boolean {
	return Object.hasOwn(AGENT_MESSAGE_KINDS, customType);
}

/** The message an `irc:*` custom message carries; null for other types or details without a body. */
export function agentMessage(customType: string, details: unknown): AgentMessage | null {
	const kind = Object.hasOwn(AGENT_MESSAGE_KINDS, customType) ? AGENT_MESSAGE_KINDS[customType]! : null;
	const fields = record(details);
	if (kind === null || fields === null) return null;
	// An incoming message's body is `message`; the other kinds call it `body`.
	const body = kind === "incoming" ? fields.message : fields.body;
	if (typeof body !== "string") return null;
	return {
		kind,
		from: str(fields.from),
		to: str(fields.to),
		body,
		replyTo: str(fields.replyTo),
		pool: str(fields.pool),
	};
}

/**
 * The first non-empty line of a Markdown message as plain text, for a one-line preview: heading, quote and list
 * markers and emphasis or code marks removed.
 */
export function firstLinePlain(markdown: string): string {
	const line = markdown.split("\n").find(candidate => candidate.trim() !== "") ?? "";
	return line
		.trim()
		.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
		.replace(/(\*\*|__|~~|`)/g, "")
		.trim();
}
