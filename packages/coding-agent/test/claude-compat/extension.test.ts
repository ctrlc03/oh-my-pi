import { describe, expect, it } from "bun:test";
import type { ClaudeHookCommand, ClaudeHookEvent } from "@oh-my-pi/pi-coding-agent/claude-compat/config";
import { createClaudeHooksExtension } from "@oh-my-pi/pi-coding-agent/claude-compat/extension";
import { mapClaudePermissions } from "@oh-my-pi/pi-coding-agent/claude-compat/permissions";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { TempDir } from "@oh-my-pi/pi-utils";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function hook(event: ClaudeHookEvent, command: string, matcher?: string): ClaudeHookCommand {
	return {
		event,
		matcher,
		command,
		timeoutSec: 10,
		source: { path: "/p/.claude/settings.json", level: "project" },
		id: `hook:claude:${event}:${matcher ?? "*"}:${command}`,
	};
}

/** Binds the extension to a recording API and returns the handlers it registered plus a ctx. */
function bind(
	hooks: ClaudeHookCommand[],
	rules: Parameters<typeof createClaudeHooksExtension>[0]["runtimeRules"] = [],
) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	createClaudeHooksExtension({ hooks, runtimeRules: rules, settings: Settings.isolated() })(pi);
	const dir = TempDir.createSync("@pi-claude-ext-");
	const notices: string[] = [];
	const ctx = {
		cwd: dir.path(),
		hasUI: false,
		agent: { kind: "main" },
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/tmp/sess-1.jsonl" },
		ui: { notify: (message: string) => notices.push(message), confirm: async () => false },
	} as unknown as ExtensionContext;
	const emit = async (event: string, payload: Record<string, unknown>) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? [])
			result = (await handler({ type: event, ...payload }, ctx)) ?? result;
		return result;
	};
	return { emit, handlers, notices, dir };
}

// Reads the JSON payload from stdin and refuses `rm -rf`, the way a Claude guard script would.
const BLOCK_RM = `cat | grep -q 'rm -rf' && { echo 'rm -rf is blocked by policy' >&2; exit 2; }; exit 0`;

describe("Claude PreToolUse hook", () => {
	it("blocks rm -rf and lets other commands through", async () => {
		const { emit, dir } = bind([hook("PreToolUse", BLOCK_RM, "Bash")]);
		using _dir = dir;
		expect(
			await emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "rm -rf build" } }),
		).toEqual({
			block: true,
			reason: "rm -rf is blocked by policy",
		});
		expect(await emit("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "ls" } })).toBeUndefined();
	});

	it("only runs for tools its matcher selects", async () => {
		const { emit, dir } = bind([hook("PreToolUse", "exit 2", "Write")]);
		using _dir = dir;
		expect(await emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls" } })).toBeUndefined();
		expect(
			await emit("tool_call", { toolName: "write", toolCallId: "2", input: { path: "a", content: "" } }),
		).toMatchObject({
			block: true,
		});
	});

	it("passes Claude's documented stdin fields", async () => {
		const { emit, dir } = bind([hook("PreToolUse", `cat > payload.json; exit 0`, "Bash")]);
		using _dir = dir;
		await emit("tool_call", { toolName: "bash", toolCallId: "tc-9", input: { command: "echo hi" } });
		const payload = await Bun.file(`${dir.path()}/payload.json`).json();
		expect(payload).toMatchObject({
			session_id: "sess-1",
			transcript_path: "/tmp/sess-1.jsonl",
			hook_event_name: "PreToolUse",
			permission_mode: "bypassPermissions",
			tool_name: "Bash",
			tool_input: { command: "echo hi" },
			tool_use_id: "tc-9",
		});
		expect(payload.cwd).toBe(dir.path());
	});

	it("fails an `ask` closed when there is no UI to answer it", async () => {
		const { emit, dir } = bind([
			hook(
				"PreToolUse",
				`echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"sure?"}}'`,
			),
		]);
		using _dir = dir;
		expect(await emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls" } })).toEqual({
			block: true,
			reason: "sure?",
		});
	});

	it("does not block when the hook itself fails", async () => {
		const { emit, notices, dir } = bind([hook("PreToolUse", "exit 1")]);
		using _dir = dir;
		expect(await emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls" } })).toBeUndefined();
		expect(notices).toHaveLength(1);
	});
});

describe("Claude permission rules enforced at runtime", () => {
	const { runtimeRules } = mapClaudePermissions({ deny: ["WebFetch(domain:evil.test)"], ask: [], allow: [] });

	it("blocks a denied domain without any hook configured", async () => {
		const { emit, handlers, dir } = bind([], runtimeRules);
		using _dir = dir;
		expect(handlers.has("tool_call")).toBe(true);
		expect(
			await emit("tool_call", { toolName: "read", toolCallId: "1", input: { path: "https://evil.test/a" } }),
		).toMatchObject({
			block: true,
		});
		expect(
			await emit("tool_call", { toolName: "read", toolCallId: "2", input: { path: "https://ok.test/a" } }),
		).toBeUndefined();
	});

	it("registers nothing when there are no hooks and no rules", () => {
		const { handlers, dir } = bind([]);
		using _dir = dir;
		expect(handlers.size).toBe(0);
	});
});

describe("other Claude events", () => {
	it("PostToolUse feedback reaches the model as additionalContext and skips failed calls", async () => {
		const { emit, dir } = bind([hook("PostToolUse", "echo 'tests failed' >&2; exit 2", "Edit")]);
		using _dir = dir;
		const event = {
			toolName: "edit",
			toolCallId: "1",
			input: { path: "a.ts" },
			content: [{ type: "text", text: "ok" }],
		};
		expect(await emit("tool_result", { ...event, isError: false })).toEqual({ additionalContext: "tests failed" });
		expect(await emit("tool_result", { ...event, isError: true })).toBeUndefined();
	});

	it("UserPromptSubmit exit 2 swallows the prompt; stdout rides the next turn as context", async () => {
		const blocked = bind([hook("UserPromptSubmit", "echo 'no secrets' >&2; exit 2")]);
		using _blockedDir = blocked.dir;
		expect(await blocked.emit("input", { text: "my key", source: "interactive" })).toEqual({ handled: true });
		expect(blocked.notices[0]).toContain("no secrets");

		const contextual = bind([hook("UserPromptSubmit", "echo 'branch: main'")]);
		using _contextDir = contextual.dir;
		expect(await contextual.emit("input", { text: "hi", source: "interactive" })).toBeUndefined();
		expect(await contextual.emit("before_agent_start", { prompt: "hi", systemPrompt: [] })).toMatchObject({
			message: { content: "branch: main", display: false },
		});
		expect(await contextual.emit("before_agent_start", { prompt: "again", systemPrompt: [] })).toBeUndefined();
	});

	it("Stop with decision block asks the session to continue", async () => {
		const { emit, dir } = bind([hook("Stop", `echo '{"decision":"block","reason":"finish the tests"}'`)]);
		using _dir = dir;
		expect(await emit("session_stop", { stop_hook_active: false, signal: new AbortController().signal })).toEqual({
			decision: "block",
			reason: "finish the tests",
		});
	});

	it("Stop with continue false lets the session stop instead of blocking", async () => {
		const { emit, dir } = bind([hook("Stop", `echo '{"continue":false,"stopReason":"all done"}'`)]);
		using _dir = dir;
		expect(
			await emit("session_stop", { stop_hook_active: false, signal: new AbortController().signal }),
		).toBeUndefined();
	});

	it("SessionStart output becomes context for the first prompt", async () => {
		const { emit, dir } = bind([hook("SessionStart", "echo 'repo is dirty'")]);
		using _dir = dir;
		await emit("session_start", {});
		expect(await emit("before_agent_start", { prompt: "hi", systemPrompt: [] })).toMatchObject({
			message: { content: "repo is dirty" },
		});
	});
});
