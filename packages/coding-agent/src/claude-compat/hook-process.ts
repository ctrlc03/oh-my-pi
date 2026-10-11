/**
 * Runs one Claude command hook and interprets its result with Claude's semantics:
 *
 * - exit 0: success; stdout is parsed as JSON when it is an object, else (for the events that take it)
 *   treated as extra context
 * - exit 2: blocking error; stderr is the reason fed back to the model
 * - any other exit, timeout, or spawn failure: non-blocking; the user is told, execution continues
 */
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import type { ClaudeHookCommand, ClaudeHookEvent } from "./config";

export interface HookRunOptions {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface HookProcessResult {
	/** `null` when the process never produced an exit code (timeout, abort, spawn failure). */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	failure?: "timeout" | "aborted" | "spawn";
}

export interface HookVerdict {
	/** Blocking reason (tool calls, prompts, stop). */
	block?: string;
	/** `permissionDecision: "ask"` from a PreToolUse hook. */
	ask?: string;
	/** Text to hand the model as context. */
	context: string[];
	/** Non-blocking messages for the user. */
	notices: string[];
}

function shellCommand(command: string): string[] {
	return process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
}

export async function runHookCommand(
	command: string,
	stdin: string,
	options: HookRunOptions,
): Promise<HookProcessResult> {
	try {
		const result = await ptree.exec(shellCommand(command), {
			cwd: options.cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: options.cwd },
			input: stdin,
			timeout: options.timeoutMs,
			signal: options.signal,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		const failure = result.exitError?.aborted
			? result.exitError instanceof ptree.TimeoutError
				? "timeout"
				: "aborted"
			: undefined;
		return { exitCode: failure ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr, failure };
	} catch (error) {
		return {
			exitCode: null,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			failure: "spawn",
		};
	}
}

function firstLine(text: string): string {
	return text.trim().split("\n", 1)[0] ?? "";
}

function describeFailure(hook: ClaudeHookCommand, result: HookProcessResult): string {
	const label = `${hook.event} hook \`${hook.command}\``;
	if (result.failure === "timeout") return `${label} timed out after ${hook.timeoutSec}s`;
	if (result.failure === "spawn") return `${label} failed to start: ${firstLine(result.stderr)}`;
	const detail = firstLine(result.stderr);
	return `${label} exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Events whose plain (non-JSON) stdout is context for the model. */
const STDOUT_IS_CONTEXT: Partial<Record<ClaudeHookEvent, true>> = { UserPromptSubmit: true, SessionStart: true };

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
	const text = stdout.trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function interpretHookResult(hook: ClaudeHookCommand, result: HookProcessResult): HookVerdict {
	const verdict: HookVerdict = { context: [], notices: [] };
	if (result.exitCode === 2) {
		verdict.block = result.stderr.trim() || `${hook.event} hook \`${hook.command}\` blocked with exit code 2`;
		return verdict;
	}
	if (result.exitCode !== 0) {
		verdict.notices.push(describeFailure(hook, result));
		return verdict;
	}

	const json = parseJsonObject(result.stdout);
	if (!json) {
		const text = result.stdout.trim();
		if (text !== "" && STDOUT_IS_CONTEXT[hook.event] === true) verdict.context.push(text);
		return verdict;
	}

	const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
	const decision = stringField(json, "decision");
	const reason = stringField(json, "reason");
	const permission = stringField(specific, "permissionDecision");
	const permissionReason = stringField(specific, "permissionDecisionReason");
	const additional = stringField(specific, "additionalContext");
	const systemMessage = stringField(json, "systemMessage");

	if (systemMessage) verdict.notices.push(systemMessage);
	if (additional) verdict.context.push(additional);

	// For Stop, `continue: false` means "stop" - what omp does without a verdict. Mapping it to a block would make
	// the session keep running, so Stop blocks only on `decision: "block"` or exit code 2.
	if (json.continue === false && hook.event === "Stop") {
		verdict.notices.push(stringField(json, "stopReason") ?? `${hook.event} hook stopped processing`);
	}
	if (json.continue === false && hook.event !== "PostToolUse" && hook.event !== "Stop") {
		verdict.block = stringField(json, "stopReason") ?? reason ?? `${hook.event} hook stopped processing`;
	} else if (hook.event === "PreToolUse" && permission === "deny") {
		verdict.block = permissionReason ?? reason ?? `${hook.event} hook denied the tool call`;
	} else if (hook.event === "PreToolUse" && permission === "ask") {
		verdict.ask = permissionReason ?? reason ?? `${hook.event} hook asks for confirmation`;
	} else if (decision === "block") {
		const text = reason ?? `${hook.event} hook blocked`;
		// PostToolUse cannot undo the call; its `block` reason is fed to the model instead.
		if (hook.event === "PostToolUse") verdict.context.push(text);
		else verdict.block = text;
	}
	return verdict;
}

/** Fold verdicts from hooks that ran for the same event: every block reason is kept, first ask wins. */
export function mergeVerdicts(verdicts: readonly HookVerdict[]): HookVerdict {
	const blocks = verdicts.flatMap(verdict => (verdict.block === undefined ? [] : [verdict.block]));
	return {
		block: blocks.length > 0 ? blocks.join("\n") : undefined,
		ask: verdicts.find(verdict => verdict.ask !== undefined)?.ask,
		context: verdicts.flatMap(verdict => verdict.context),
		notices: verdicts.flatMap(verdict => verdict.notices),
	};
}
