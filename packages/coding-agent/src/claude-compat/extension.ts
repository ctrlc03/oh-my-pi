/**
 * Claude Code command hooks as an omp extension.
 *
 * Claude events ride omp's own extension events, so ordering, timeouts, fail-closed `tool_call`
 * handling, and the approval pipeline are the existing ones:
 *
 *   PreToolUse       -> `tool_call`      (block / ask)
 *   PostToolUse      -> `tool_result`    (feedback goes to the model via `additionalContext`)
 *   UserPromptSubmit -> `input`          (block = `handled`; context rides the next `before_agent_start`)
 *   Stop             -> `session_stop`   (`decision: "block"` continues the turn)
 *   SessionStart     -> `session_start` / `session_switch`
 */
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { EXTENSION_HANDLER_TIMEOUT_MS } from "../extensibility/extensions/runner";
import { cfgExtensionHandlersToolCallTimeoutMs } from "../extensibility/settings";
import type { Settings } from "../config/settings";
import { cfgToolsApprovalMode } from "../tools/settings";
import type { ClaudeHookCommand, ClaudeHookEvent } from "./config";
import { type HookVerdict, interpretHookResult, mergeVerdicts, runHookCommand } from "./hook-process";
import { evaluateRuntimeRules, type RuntimeRule } from "./permissions";
import { claudeToolInput, claudeToolNames, matcherSelectsTool } from "./tool-names";

export interface ClaudeHooksExtensionOptions {
	hooks: readonly ClaudeHookCommand[];
	/** Permission rules omp has no setting for (`WebFetch(domain:…)`, `mcp__server`). */
	runtimeRules: readonly RuntimeRule[];
	settings: Settings;
}

const PERMISSION_MODE = {
	yolo: "bypassPermissions",
	write: "acceptEdits",
	"always-ask": "default",
	"always-ask-cached": "default",
} as const;

/** Headroom under the runner's own handler timeout so a slow hook is cut by us (non-blocking), not by it (fail-closed). */
const TIMEOUT_HEADROOM_MS = 1000;

function responseText(content: readonly { type: string; text?: string }[]): string {
	return content.map(block => (block.type === "text" && block.text ? block.text : "")).join("");
}

export function createClaudeHooksExtension(options: ClaudeHooksExtensionOptions): ExtensionFactory {
	const { hooks, runtimeRules, settings } = options;
	const byEvent = (event: ClaudeHookEvent) => hooks.filter(hook => hook.event === event);

	return pi => {
		let pendingContext: string[] = [];

		const basePayload = (ctx: ExtensionContext, event: ClaudeHookEvent) => ({
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? "",
			cwd: ctx.cwd,
			permission_mode: PERMISSION_MODE[cfgToolsApprovalMode.get(settings)],
			hook_event_name: event,
		});

		const run = async (
			selected: readonly ClaudeHookCommand[],
			payload: Record<string, unknown>,
			ctx: ExtensionContext,
			capMs: number,
			signal?: AbortSignal,
		): Promise<HookVerdict> => {
			const stdin = JSON.stringify(payload);
			const verdicts = await Promise.all(
				selected.map(async hook => {
					const result = await runHookCommand(hook.command, stdin, {
						cwd: ctx.cwd,
						timeoutMs: Math.min(hook.timeoutSec * 1000, capMs),
						signal,
					});
					return interpretHookResult(hook, result);
				}),
			);
			const merged = mergeVerdicts(verdicts);
			for (const notice of merged.notices) ctx.ui.notify(notice, "warning");
			return merged;
		};

		const generalCapMs = EXTENSION_HANDLER_TIMEOUT_MS - TIMEOUT_HEADROOM_MS;
		const toolCallCapMs = (): number =>
			Math.max(TIMEOUT_HEADROOM_MS, cfgExtensionHandlersToolCallTimeoutMs.get(settings) - TIMEOUT_HEADROOM_MS);

		const preToolUse = byEvent("PreToolUse");
		if (preToolUse.length > 0 || runtimeRules.length > 0) {
			pi.on("tool_call", async (event, ctx) => {
				const input = event.input as Record<string, unknown>;
				const runtime = evaluateRuntimeRules(runtimeRules, event.toolName, input);
				if (runtime?.action === "deny") {
					return { block: true, reason: `Denied by Claude permission rule \`${runtime.rule}\`` };
				}
				if (runtime?.action === "prompt") {
					const approved =
						ctx.hasUI &&
						(await ctx.ui.confirm(
							"Claude permission rule",
							`\`${runtime.rule}\` requires approval for ${event.toolName}`,
						));
					if (!approved)
						return { block: true, reason: `Not approved: Claude permission rule \`${runtime.rule}\` asks` };
				}

				const selected = preToolUse.filter(hook => matcherSelectsTool(hook.matcher, event.toolName, input));
				if (selected.length === 0) return undefined;
				const verdict = await run(
					selected,
					{
						...basePayload(ctx, "PreToolUse"),
						tool_name: claudeToolNames(event.toolName, input)[0],
						tool_input: claudeToolInput(event.toolName, input),
						tool_use_id: event.toolCallId,
					},
					ctx,
					toolCallCapMs(),
				);
				if (verdict.block !== undefined) return { block: true, reason: verdict.block };
				if (verdict.ask !== undefined) {
					const approved = ctx.hasUI && (await ctx.ui.confirm("Claude PreToolUse hook", verdict.ask));
					if (!approved) return { block: true, reason: verdict.ask };
				}
				return verdict.context.length > 0 ? { additionalContext: verdict.context.join("\n") } : undefined;
			});
		}

		const postToolUse = byEvent("PostToolUse");
		if (postToolUse.length > 0) {
			pi.on("tool_result", async (event, ctx) => {
				if (event.isError) return undefined;
				const input = event.input as Record<string, unknown>;
				const selected = postToolUse.filter(hook => matcherSelectsTool(hook.matcher, event.toolName, input));
				if (selected.length === 0) return undefined;
				const text = responseText(event.content);
				const verdict = await run(
					selected,
					{
						...basePayload(ctx, "PostToolUse"),
						tool_name: claudeToolNames(event.toolName, input)[0],
						tool_input: claudeToolInput(event.toolName, input),
						tool_response:
							event.toolName === "bash"
								? { stdout: text, stderr: "", interrupted: false, content: text }
								: { content: text },
						tool_use_id: event.toolCallId,
					},
					ctx,
					generalCapMs,
				);
				const context = [...(verdict.block === undefined ? [] : [verdict.block]), ...verdict.context];
				return context.length > 0 ? { additionalContext: context.join("\n") } : undefined;
			});
		}

		const userPromptSubmit = byEvent("UserPromptSubmit");
		if (userPromptSubmit.length > 0) {
			pi.on("input", async (event, ctx) => {
				if (ctx.agent.kind !== "main") return undefined;
				const verdict = await run(
					userPromptSubmit,
					{ ...basePayload(ctx, "UserPromptSubmit"), prompt: event.text },
					ctx,
					generalCapMs,
				);
				if (verdict.block !== undefined) {
					ctx.ui.notify(`Prompt blocked by hook: ${verdict.block}`, "warning");
					return { handled: true };
				}
				pendingContext.push(...verdict.context);
				return undefined;
			});
		}

		const sessionStart = byEvent("SessionStart");
		if (sessionStart.length > 0) {
			const start = async (source: "startup" | "resume" | "clear", ctx: ExtensionContext) => {
				if (ctx.agent.kind !== "main") return;
				const verdict = await run(sessionStart, { ...basePayload(ctx, "SessionStart"), source }, ctx, generalCapMs);
				pendingContext.push(...verdict.context);
			};
			pi.on("session_start", (_event, ctx) => start("startup", ctx));
			pi.on("session_switch", (event, ctx) => start(event.reason === "new" ? "clear" : "resume", ctx));
		}

		if (userPromptSubmit.length > 0 || sessionStart.length > 0) {
			pi.on("before_agent_start", () => {
				if (pendingContext.length === 0) return undefined;
				const content = pendingContext.join("\n");
				pendingContext = [];
				return { message: { customType: "claude-hook-context", content, display: false } };
			});
		}

		const stop = byEvent("Stop");
		if (stop.length > 0) {
			pi.on("session_stop", async (event, ctx) => {
				if (ctx.agent.kind !== "main") return undefined;
				const verdict = await run(
					stop,
					{ ...basePayload(ctx, "Stop"), stop_hook_active: event.stop_hook_active },
					ctx,
					generalCapMs,
					event.signal,
				);
				return verdict.block === undefined ? undefined : { decision: "block", reason: verdict.block };
			});
		}
	};
}
