/**
 * Receipts: what a session did, read straight from its entries. Every file the agent changed
 * through its edit tools, every shell command (the agent's and the user's `!` commands) with its
 * exit status, every recorded approval decision and every subagent a `task` call ran, each tagged
 * with the turn (prompt) it happened under.
 *
 * Built from the active path only, the conversation the user sees. Files changed by shell commands
 * are not listed here (they show in the turn diff, which reads the working tree).
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { ReceiptApproval, ReceiptCommand, ReceiptFile, ReceiptSubagent, SessionReceipts } from "@oh-my-pi/pi-wire";
import { isTranscriptEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";

/** `customType` of the session entry that records a tool approval decision (see `tools/approval-grants.ts`). */
export const TOOL_APPROVAL_ENTRY_TYPE = "tool-approval";

/** Rows kept per list; the oldest are dropped past it. */
export const RECEIPTS_MAX_ROWS = 500;
const MAX_COMMAND_CHARS = 400;
const EDIT_TOOLS: Record<string, true> = { edit: true, apply_patch: true };
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const APPLY_PATCH_HEADER_RE = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/;

interface Turn {
	number: number;
	promptId: string | null;
}

interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

interface ToolResult {
	isError: boolean;
	details: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isFilePath(path: string | undefined): path is string {
	return path !== undefined && !URI_RE.test(path);
}

/** Path from a hashline `[path#TAG]` / `[path]` header line. */
function hashlinePath(line: string): string | undefined {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	let body = trimmed.slice(1, -1).trim();
	const tag = /#[0-9a-fA-F]{4}$/.exec(body);
	if (tag) body = body.slice(0, tag.index);
	const quote = body[0];
	if (body.length >= 2 && (quote === '"' || quote === "'") && quote === body.at(-1)) body = body.slice(1, -1);
	return body.length > 0 ? body : undefined;
}

/** File paths an `edit` / `apply_patch` call names, in order: its arguments, then its patch headers. */
function editedPaths(args: Record<string, unknown>, details: Record<string, unknown>): string[] {
	const reported = Array.isArray(details.perFileResults)
		? details.perFileResults.filter(isRecord).flatMap(file => (file.isError === true ? [] : [str(file.path)]))
		: [];
	if (reported.length > 0) return reported.filter(isFilePath);
	const paths: string[] = [];
	const direct = str(args.file_path) ?? str(args.path);
	if (direct) paths.push(direct);
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			const path = isRecord(edit) ? str(edit.path) : undefined;
			if (path) paths.push(path);
		}
	}
	const input = str(args.input) ?? str(args._input);
	for (const rawLine of input ? input.split("\n") : []) {
		const line = rawLine.replace(/\r$/, "");
		const path = hashlinePath(line) ?? APPLY_PATCH_HEADER_RE.exec(line.trim())?.[1]?.trim();
		if (path) paths.push(path);
	}
	return [...new Set(paths)].filter(isFilePath);
}

function commandText(command: string): string {
	const single = command.trim();
	return single.length > MAX_COMMAND_CHARS ? `${single.slice(0, MAX_COMMAND_CHARS)}…` : single;
}

/** The exit status of a finished bash call: reported on failure, 0 on success, none when it did not finish. */
function bashExitCode(result: ToolResult | undefined): number | null {
	if (!result) return null;
	const reported = result.details.exitCode;
	if (typeof reported === "number") return reported;
	return result.isError ? null : 0;
}

function firstLine(text: string): string {
	return (text.trim().split("\n", 1)[0] ?? "").trim();
}

/** The subagents of one `task` call: the finished ones from its result, the rest from its arguments. */
function taskSubagents(call: ToolCall, result: ToolResult | undefined, turn: Turn): ReceiptSubagent[] {
	const base = { turn: turn.number, promptId: turn.promptId };
	const results = Array.isArray(result?.details.results) ? result.details.results.filter(isRecord) : [];
	if (results.length > 0) {
		return results.map(entry => ({
			id: str(entry.id) ?? "?",
			agent: str(entry.agent) ?? "task",
			label: firstLine(str(entry.description) ?? str(entry.task) ?? ""),
			exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
			durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
			...base,
		}));
	}
	const asked = Array.isArray(call.args.tasks) ? call.args.tasks.filter(isRecord) : [call.args];
	return asked.map((item, index) => ({
		id: str(item.name) ?? `${call.id}:${index}`,
		agent: str(item.agent) ?? "task",
		label: firstLine(str(item.description) ?? str(item.task) ?? ""),
		exitCode: null,
		durationMs: null,
		...base,
	}));
}

function approvalOf(data: unknown, turn: Turn): ReceiptApproval | undefined {
	if (!isRecord(data) || typeof data.approved !== "boolean") return undefined;
	const tool = str(data.tool);
	if (!tool) return undefined;
	return {
		tool,
		approved: data.approved,
		by: str(data.by) ?? "unknown",
		...(str(data.reason) ? { reason: str(data.reason) } : {}),
		turn: turn.number,
		promptId: turn.promptId,
	};
}

function newest<T>(rows: T[]): { rows: T[]; cut: boolean } {
	return rows.length > RECEIPTS_MAX_ROWS
		? { rows: rows.slice(rows.length - RECEIPTS_MAX_ROWS), cut: true }
		: { rows, cut: false };
}

/** Receipts for the entries of the active path, oldest first. */
export function buildReceipts(branch: readonly SessionEntry[]): SessionReceipts {
	const results = new Map<string, ToolResult>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		results.set(entry.message.toolCallId, {
			isError: entry.message.isError === true,
			details: recordOf(entry.message.details),
		});
	}

	const files: ReceiptFile[] = [];
	const commands: ReceiptCommand[] = [];
	const approvals: ReceiptApproval[] = [];
	const subagents: ReceiptSubagent[] = [];
	const filed = new Map<string, true>();
	const turn: Turn = { number: 0, promptId: null };
	/** `ast_edit` only stages a preview; it lands when a later `resolve` applies it. */
	let staged: { paths: string[]; turn: Turn } | undefined;

	const recordFiles = (paths: readonly string[], tool: string, at: Turn): void => {
		for (const path of paths) {
			const key = `${at.number}\0${path}`;
			if (filed.has(key)) continue;
			filed.set(key, true);
			files.push({ path, tool, turn: at.number, promptId: at.promptId });
		}
	};

	for (const entry of branch) {
		if (isTranscriptEntry(entry) && isUserRequestEntry(entry)) {
			turn.number++;
			turn.promptId = entry.id;
			continue;
		}
		if (entry.type === "custom") {
			if (entry.customType !== TOOL_APPROVAL_ENTRY_TYPE) continue;
			const approval = approvalOf(entry.data, turn);
			if (approval) approvals.push(approval);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "bashExecution") {
			commands.push({
				command: commandText(message.command),
				exitCode: message.cancelled || message.exitCode === undefined ? null : message.exitCode,
				source: "user",
				turn: turn.number,
				promptId: turn.promptId,
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const call: ToolCall = { id: block.id, name: block.name, args: recordOf(block.arguments) };
			const result = results.get(call.id);
			const at: Turn = { ...turn };
			if (call.name === "bash") {
				const command = str(call.args.command);
				if (command) {
					commands.push({
						command: commandText(command),
						exitCode: bashExitCode(result),
						source: "agent",
						turn: at.number,
						promptId: at.promptId,
					});
				}
			} else if (call.name === "task") {
				subagents.push(...taskSubagents(call, result, at));
			} else if (!result || result.isError) {
				continue;
			} else if (Object.hasOwn(EDIT_TOOLS, call.name)) {
				recordFiles(editedPaths(call.args, result.details), call.name, at);
			} else if (call.name === "write") {
				const path = str(call.args.file_path) ?? str(call.args.path);
				if (isFilePath(path)) recordFiles([path], "write", at);
			} else if (call.name === "ast_edit") {
				const replaced = Array.isArray(result.details.fileReplacements)
					? result.details.fileReplacements.filter(isRecord).map(file => str(file.path))
					: [];
				staged = { paths: replaced.filter(isFilePath), turn: at };
			} else if (call.name === "resolve" || call.name === "reject") {
				const action =
					str(result.details.action) ?? str(call.args.action) ?? (call.name === "reject" ? "discard" : "apply");
				if (staged && action === "apply") recordFiles(staged.paths, "ast_edit", staged.turn);
				staged = undefined;
			}
		}
	}

	const cutFiles = newest(files);
	const cutCommands = newest(commands);
	const cutApprovals = newest(approvals);
	const cutSubagents = newest(subagents);
	const truncated = cutFiles.cut || cutCommands.cut || cutApprovals.cut || cutSubagents.cut;
	return {
		turns: turn.number,
		files: cutFiles.rows,
		commands: cutCommands.rows,
		approvals: cutApprovals.rows,
		subagents: cutSubagents.rows,
		...(truncated ? { truncated: true as const } : {}),
	};
}

/** Whether `receipts` lists anything at all. */
export function hasReceipts(receipts: SessionReceipts): boolean {
	return receipts.files.length + receipts.commands.length + receipts.approvals.length + receipts.subagents.length > 0;
}

/** The receipts as plain text for the TUI and text-mode output. */
export function formatReceipts(receipts: SessionReceipts): string {
	if (!hasReceipts(receipts))
		return "No files changed, commands run, approvals or subagents in this conversation yet.";
	const turnLabel = (turn: number): string => (turn === 0 ? "before the first prompt" : `turn ${turn}`);
	const sections: string[] = [];
	if (receipts.files.length > 0) {
		sections.push(
			[
				`Files changed (${receipts.files.length})`,
				...receipts.files.map(file => `  ${file.path}  ${file.tool}, ${turnLabel(file.turn)}`),
			].join("\n"),
		);
	}
	if (receipts.commands.length > 0) {
		sections.push(
			[
				`Commands (${receipts.commands.length})`,
				...receipts.commands.map(command => {
					const status = command.exitCode === null ? "no exit status" : `exit ${command.exitCode}`;
					const who = command.source === "user" ? "you" : "agent";
					return `  ${command.command.split("\n").join(" ⏎ ")}  ${status}, ${who}, ${turnLabel(command.turn)}`;
				}),
			].join("\n"),
		);
	}
	if (receipts.approvals.length > 0) {
		sections.push(
			[
				`Approvals (${receipts.approvals.length})`,
				...receipts.approvals.map(approval => {
					const verdict = approval.approved ? "granted" : "denied";
					const reason = approval.reason ? ` (${approval.reason})` : "";
					return `  ${approval.tool}  ${verdict} by ${approval.by}${reason}, ${turnLabel(approval.turn)}`;
				}),
			].join("\n"),
		);
	}
	if (receipts.subagents.length > 0) {
		sections.push(
			[
				`Subagents (${receipts.subagents.length})`,
				...receipts.subagents.map(agent => {
					const status =
						agent.exitCode === null ? "running" : agent.exitCode === 0 ? "done" : `exit ${agent.exitCode}`;
					const label = agent.label ? `: ${agent.label}` : "";
					return `  ${agent.id} (${agent.agent})${label}  ${status}, ${turnLabel(agent.turn)}`;
				}),
			].join("\n"),
		);
	}
	if (receipts.truncated) sections.push(`Showing the most recent ${RECEIPTS_MAX_ROWS} of each list.`);
	return sections.join("\n\n");
}
