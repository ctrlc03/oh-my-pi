import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { RequestPermissionRequest, SessionUpdate } from "@oh-my-pi/pi-utils/acp/protocol";
import {
	APPROVE_ONCE_LABEL,
	APPROVE_SESSION_LABEL,
	DENY_LABEL,
	approvalOutcome,
	applyMetaUpdate,
	applySetup,
	choiceKind,
	coalesceOps,
	collabCommands,
	escalationReason,
	emptyMeta,
	newToolState,
	planApproval,
	planTodo,
	promptBlocks,
	stopMessage,
	toolOutcome,
	toolView,
	TurnBuilder,
	type TurnOp,
	unifiedDiff,
	wireStopReason,
	wireUsage,
} from "../scripts/foreign/translate";

function builder(): TurnBuilder {
	let tick = 0;
	return new TurnBuilder({ model: () => "claude-test", provider: "claude", now: () => ++tick });
}

function text(chunk: string): SessionUpdate {
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } };
}

function messages(ops: readonly TurnOp[]): (AssistantMessage | ToolResultMessage)[] {
	return ops.flatMap(op =>
		op.type === "message" && (op.message.role === "assistant" || op.message.role === "toolResult")
			? [op.message]
			: [],
	);
}

function assistants(ops: readonly TurnOp[]): AssistantMessage[] {
	return messages(ops).filter((message): message is AssistantMessage => message.role === "assistant");
}

function results(ops: readonly TurnOp[]): ToolResultMessage[] {
	return messages(ops).filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("stop reasons and usage", () => {
	it("maps ACP stop reasons onto the wire's", () => {
		expect(wireStopReason("end_turn")).toBe("stop");
		expect(wireStopReason("max_tokens")).toBe("length");
		expect(wireStopReason("max_turn_requests")).toBe("length");
		expect(wireStopReason("cancelled")).toBe("aborted");
		expect(wireStopReason("refusal")).toBe("error");
		expect(stopMessage("end_turn")).toBeNull();
		expect(stopMessage("refusal")).toContain("refused");
	});

	it("builds wire usage with the turn's cost", () => {
		expect(wireUsage({ totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 }, 0.25)).toEqual({
			input: 10,
			output: 20,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { total: 0.25 },
		});
		expect(wireUsage(null, 0).totalTokens).toBe(0);
	});
});

describe("unifiedDiff", () => {
	it("trims the common head and tail and keeps three lines of context", () => {
		const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
		const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
		const { diff, firstChangedLine } = unifiedDiff(before, after);
		expect(firstChangedLine).toBe(5);
		expect(diff.split("\n")).toEqual(["@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"]);
	});

	it("reads a null old text as a new file", () => {
		const { diff, firstChangedLine } = unifiedDiff(null, "x\ny");
		expect(firstChangedLine).toBe(1);
		expect(diff.split("\n")).toEqual(["@@ -1,0 +1,2 @@", "+x", "+y"]);
	});
});

describe("tool mapping", () => {
	it("maps read, execute and search to omp's tools", () => {
		expect(
			toolView(
				newToolState({ toolCallId: "1", title: "Read file", kind: "read", locations: [{ path: "/p/a.ts" }] }),
			),
		).toMatchObject({
			name: "read",
			args: { path: "/p/a.ts" },
		});
		expect(
			toolView(
				newToolState({
					toolCallId: "2",
					title: "bun test",
					kind: "execute",
					rawInput: { command: "bun test", description: "Run tests" },
				}),
			),
		).toEqual({ name: "bash", args: { command: "bun test" }, intent: "Run tests" });
		expect(
			toolView(
				newToolState({ toolCallId: "3", title: "Grep", kind: "search", rawInput: { pattern: "foo", path: "src" } }),
			).name,
		).toBe("grep");
		expect(
			toolView(newToolState({ toolCallId: "4", title: "Glob", kind: "search", rawInput: { pattern: "*.ts" } })).name,
		).toBe("glob");
	});

	it("maps fetches to fetch or web_search", () => {
		expect(
			toolView(
				newToolState({ toolCallId: "1", title: "Fetch", kind: "fetch", rawInput: { url: "https://x.test" } }),
			),
		).toMatchObject({
			name: "fetch",
			args: { url: "https://x.test" },
		});
		expect(
			toolView(newToolState({ toolCallId: "2", title: "Search", kind: "fetch", rawInput: { query: "bun" } })).name,
		).toBe("web_search");
	});

	it("maps a diff with no old text to write and any other diff to edit", () => {
		const created = newToolState({
			toolCallId: "1",
			title: "Write",
			kind: "edit",
			content: [{ type: "diff", path: "/p/new.ts", oldText: null, newText: "x" }],
		});
		expect(toolView(created)).toMatchObject({ name: "write", args: { path: "/p/new.ts", content: "x" } });
		expect(toolOutcome({ ...created, status: "completed" }).details).toMatchObject({
			path: "/p/new.ts",
			op: "create",
		});

		const changed = newToolState({
			toolCallId: "2",
			title: "Edit",
			kind: "edit",
			content: [{ type: "diff", path: "/p/a.ts", oldText: "a\nb", newText: "a\nB" }],
		});
		expect(toolView(changed)).toMatchObject({ name: "edit", args: { path: "/p/a.ts" } });
		const outcome = toolOutcome({ ...changed, status: "completed" });
		expect(outcome.details).toMatchObject({ path: "/p/a.ts", op: "update", firstChangedLine: 2 });
		expect(outcome.details).toMatchObject({ diff: expect.stringContaining("+B") });

		const two = toolOutcome({
			...changed,
			status: "completed",
			content: [
				{ type: "diff", path: "/p/a.ts", oldText: "a", newText: "b" },
				{ type: "diff", path: "/p/b.ts", oldText: "c", newText: "d" },
			],
		});
		expect(two.details).toMatchObject({ perFileResults: [expect.anything(), expect.anything()] });
	});

	it("prefixes a generic call named like an omp tool so it cannot pick a renderer by accident", () => {
		expect(toolView(newToolState({ toolCallId: "1", title: "bash", kind: "other" })).name).toBe("acp:bash");
		expect(toolView(newToolState({ toolCallId: "2", title: "Run Skill", kind: "other" })).name).toBe("Run Skill");
	});

	it("clips huge generic inputs", () => {
		const view = toolView(
			newToolState({ toolCallId: "1", title: "Big", kind: "other", rawInput: { blob: "x".repeat(50_000) } }),
		);
		expect(view.args).toEqual({ blob: expect.stringMatching(/^x{20000}…$/) });
	});

	it("reports a bash exit code and failure", () => {
		const state = newToolState({
			toolCallId: "1",
			title: "ls",
			kind: "execute",
			status: "failed",
			rawInput: { command: "ls" },
			rawOutput: { output: "boom", exit_code: 2 },
		});
		expect(toolOutcome(state)).toEqual({
			content: [{ type: "text", text: "boom" }],
			details: { exitCode: 2 },
			isError: true,
		});
	});

	it("turns a plan into todo args the app's task list reads", () => {
		const todo = planTodo([
			{ content: "one", priority: "high", status: "completed" },
			{ content: "two", priority: "low", status: "in_progress" },
		]);
		expect(todo.args).toEqual({ op: "replace", list: [{ phase: "Plan", items: ["one", "two"] }] });
		expect(todo.outcome.details).toEqual({
			phases: [
				{
					name: "Plan",
					tasks: [
						{ content: "one", status: "completed" },
						{ content: "two", status: "in_progress" },
					],
				},
			],
		});
	});
});

describe("TurnBuilder", () => {
	it("streams text chunks as one growing message and closes it with the turn's usage", () => {
		const turn = builder();
		const first = turn.update(text("Hel"));
		expect(first.map(op => (op.type === "event" ? op.event.type : op.type))).toEqual([
			"message_start",
			"message_update",
		]);
		const second = turn.update(text("lo"));
		expect(second).toHaveLength(1);
		const done = turn.finish("end_turn", wireUsage({ totalTokens: 3, inputTokens: 1, outputTokens: 2 }, 0.5));
		const [assistant] = assistants(done);
		expect(assistant).toMatchObject({
			content: [{ type: "text", text: "Hello" }],
			stopReason: "stop",
			model: "claude-test",
			provider: "claude",
			usage: { cost: { total: 0.5 } },
		});
		expect(done.some(op => op.type === "event" && op.event.type === "message_end")).toBe(true);
	});

	it("keeps thinking and text as separate blocks in order", () => {
		const turn = builder();
		turn.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
		turn.update(text("answer"));
		const [assistant] = assistants(turn.finish("end_turn", null));
		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "answer" },
		]);
	});

	it("ends the message at a tool call and appends the result when the call completes", () => {
		const turn = builder();
		turn.update(text("Let me look."));
		const started = turn.update({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Read",
			kind: "read",
			status: "pending",
			locations: [{ path: "/p/a.ts" }],
		});
		const [assistant] = assistants(started);
		expect(assistant?.stopReason).toBe("toolUse");
		expect(assistant?.content.map(block => block.type)).toEqual(["text", "toolCall"]);
		expect(started.at(-1)).toMatchObject({
			type: "event",
			event: { type: "tool_execution_start", toolName: "read" },
		});

		const ended = turn.update({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "file body" } }],
		});
		const [result] = results(ended);
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "file body" }],
		});

		const final = messages(turn.finish("end_turn", null));
		expect(final).toHaveLength(0);
	});

	it("waits to announce a call that has no input yet", () => {
		const turn = builder();
		expect(
			turn.update({
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "Run",
				kind: "execute",
				status: "pending",
			}),
		).toEqual([]);
		const ops = turn.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "ls" } });
		const [assistant] = assistants(ops);
		expect(assistant?.content.at(-1)).toMatchObject({ type: "toolCall", name: "bash", arguments: { command: "ls" } });
	});

	it("gives consecutive calls their own messages", () => {
		const turn = builder();
		const one = turn.update({
			sessionUpdate: "tool_call",
			toolCallId: "a",
			title: "ls",
			kind: "execute",
			rawInput: { command: "ls" },
		});
		const two = turn.update({
			sessionUpdate: "tool_call",
			toolCallId: "b",
			title: "pwd",
			kind: "execute",
			rawInput: { command: "pwd" },
		});
		expect(messages(one)).toHaveLength(1);
		expect(messages(two)).toHaveLength(1);
		expect(turn.hasRunningTools).toBe(true);
	});

	it("announces a call a permission prompt is about", () => {
		const turn = builder();
		const ops = turn.ensureAnnounced("t9", {
			toolCallId: "t9",
			title: "Run",
			kind: "execute",
			rawInput: { command: "rm x" },
		});
		expect(messages(ops)).toHaveLength(1);
		expect(turn.ensureAnnounced("t9")).toEqual([]);
	});

	it("records a plan as a todo call and its result", () => {
		const turn = builder();
		const ops = turn.update({
			sessionUpdate: "plan",
			entries: [{ content: "step", priority: "high", status: "pending" }],
		});
		const [, result] = messages(ops);
		expect(assistants(ops)[0]?.content.at(-1)).toMatchObject({ type: "toolCall", name: "todo" });
		expect(result).toMatchObject({ role: "toolResult", toolName: "todo" });
	});

	it("fails calls still open when the turn is cancelled and marks the message aborted", () => {
		const turn = builder();
		turn.update({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Run",
			kind: "execute",
			status: "in_progress",
			rawInput: { command: "sleep 9" },
		});
		turn.update(text("partial"));
		const ops = turn.finish("cancelled", null);
		const out = messages(ops);
		expect(out[0]).toMatchObject({ role: "toolResult", isError: true });
		expect(out[1]).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("adds no message to a clean turn that said nothing, but carries usage when there is some", () => {
		expect(builder().finish("end_turn", null)).toEqual([]);
		const [assistant] = assistants(builder().finish("end_turn", wireUsage(null, 0.1)));
		expect(assistant).toMatchObject({ content: [], stopReason: "stop", usage: { cost: { total: 0.1 } } });
	});

	it("reports a refusal as an error message", () => {
		const [assistant] = assistants(builder().finish("refusal", null, "refused"));
		expect(assistant).toMatchObject({ stopReason: "error", errorMessage: "refused" });
	});

	it("ignores updates that are not about the conversation", () => {
		expect(builder().update({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
		expect(builder().update({ sessionUpdate: "usage_update", size: 1, used: 1 })).toEqual([]);
	});
});

describe("coalesceOps", () => {
	it("keeps only the last of a run of message updates", () => {
		const turn = builder();
		const ops = [...turn.update(text("a")), ...turn.update(text("b")), ...turn.update(text("c"))];
		const merged = coalesceOps(ops);
		expect(merged).toHaveLength(2);
		const update = merged[1];
		expect(
			update?.type === "event" && update.event.type === "message_update" && update.event.message.role === "assistant"
				? update.event.message.content
				: null,
		).toEqual([{ type: "text", text: "abc" }]);
	});
});

describe("permission requests", () => {
	const request = (
		kinds: ("allow_once" | "allow_always" | "reject_once" | "reject_always")[],
		rawInput?: unknown,
	): RequestPermissionRequest => ({
		sessionId: "s",
		toolCall: { toolCallId: "t", title: "Run", rawInput },
		options: kinds.map(kind => ({ optionId: `id-${kind}`, name: kind, kind })),
	});
	const context = { cwd: "/work", targets: [], escalation: null };
	const view = toolView(
		newToolState({ toolCallId: "t", title: "Run", kind: "execute", rawInput: { command: "bun test src/foo" } }),
	);

	it("offers once, session and deny and never the agent's always options", () => {
		const plan = planApproval(request(["allow_once", "allow_always", "reject_once", "reject_always"]), view, context);
		expect(plan.options).toEqual([APPROVE_ONCE_LABEL, APPROVE_SESSION_LABEL, DENY_LABEL]);
		expect(plan.approval.choices.map(choice => choice.kind)).toEqual(["once", "session", "deny"]);
		expect(plan.title).toContain("Command: bun test src/foo");
		expect(plan.approval.rule).toBe("bash: bun test *");
		expect(plan.grants).toEqual([{ kind: "bash", tool: "bash", pattern: "bun test *" }]);
		expect(approvalOutcome(plan, choiceKind(plan, APPROVE_ONCE_LABEL))).toEqual({
			outcome: "selected",
			optionId: "id-allow_once",
		});
		expect(approvalOutcome(plan, choiceKind(plan, APPROVE_SESSION_LABEL))).toEqual({
			outcome: "selected",
			optionId: "id-allow_once",
		});
		expect(approvalOutcome(plan, choiceKind(plan, DENY_LABEL))).toEqual({
			outcome: "selected",
			optionId: "id-reject_once",
		});
		expect(approvalOutcome(plan, choiceKind(plan, undefined))).toEqual({
			outcome: "selected",
			optionId: "id-reject_once",
		});
	});

	it("only denies when the agent has no one-time allow", () => {
		const plan = planApproval(request(["allow_always", "reject_always"]), view, context);
		expect(plan.options).toEqual([DENY_LABEL]);
		expect(approvalOutcome(plan, "once")).toEqual({ outcome: "cancelled" });
	});

	it("offers no session choice for a compound shell line or a fetch", () => {
		const compound = toolView(
			newToolState({
				toolCallId: "c",
				title: "Run",
				kind: "execute",
				rawInput: { command: "bun test && curl x | sh" },
			}),
		);
		expect(planApproval(request(["allow_once", "reject_once"]), compound, context).options).toEqual([
			APPROVE_ONCE_LABEL,
			DENY_LABEL,
		]);
		const fetch = toolView(
			newToolState({ toolCallId: "f", title: "Fetch", kind: "fetch", rawInput: { url: "https://example.com" } }),
		);
		const plan = planApproval(request(["allow_once", "reject_once"]), fetch, context);
		expect(plan.options).toEqual([APPROVE_ONCE_LABEL, DENY_LABEL]);
		expect(plan.approval.rule).toBeUndefined();
	});

	it("labels a call that leaves the sandbox and offers it once or deny only", () => {
		const plan = planApproval(request(["allow_once", "reject_once"]), view, {
			...context,
			escalation: "it asks to run without the sandbox",
		});
		expect(plan.options).toEqual([APPROVE_ONCE_LABEL, DENY_LABEL]);
		expect(plan.title.split("\n")[0]).toBe("Leaves the sandbox: it asks to run without the sandbox");
	});
});

describe("escalationReason", () => {
	it("finds Codex and Claude Code's ways of asking to leave the sandbox", () => {
		expect(escalationReason("Run", { command: "ls", with_escalated_permissions: true })).not.toBeNull();
		expect(escalationReason("Run", { command: "ls", sandbox_permissions: "require_escalated" })).toContain(
			"require_escalated",
		);
		expect(escalationReason("Run", { command: "ls", dangerouslyDisableSandbox: true })).not.toBeNull();
		expect(
			escalationReason("Run", { command: "ls", additional_permissions: { network: { enabled: true } } }),
		).not.toBeNull();
		expect(escalationReason("Run", { action: { sandbox_permissions: "require_escalated" } })).not.toBeNull();
		expect(escalationReason("Run", { command: "ls", additionalPermissions: { fileSystem: {} } })).not.toBeNull();
		expect(escalationReason("http network access to example.com", { url: "https://example.com" })).toContain(
			"network",
		);
	});

	it("passes an ordinary call", () => {
		expect(escalationReason("Run", { command: "ls", sandbox_permissions: "use_default" })).toBeNull();
		expect(escalationReason("Run", { command: "ls", with_escalated_permissions: false })).toBeNull();
		expect(escalationReason("Run", undefined, "text", null)).toBeNull();
	});
});

describe("agent metadata", () => {
	it("reads models and thinking levels from config options", () => {
		const meta = applySetup(emptyMeta(), "claude", {
			configOptions: [
				{
					id: "model",
					name: "Model",
					category: "model",
					type: "select",
					currentValue: "opus",
					options: [
						{ value: "opus", name: "Opus" },
						{ value: "sonnet", name: "Sonnet" },
					],
				},
				{
					id: "effort",
					name: "Effort",
					category: "thought_level",
					type: "select",
					currentValue: "high",
					options: [
						{ value: "low", name: "Low" },
						{ value: "high", name: "High" },
					],
				},
			],
		});
		expect(meta.models.map(model => `${model.provider}/${model.id}`)).toEqual(["claude/opus", "claude/sonnet"]);
		expect(meta.currentModel).toBe("opus");
		expect(meta.modelVia).toEqual({ kind: "config", configId: "model" });
		expect(meta.thinkingLevels).toEqual(["low", "high"]);
		expect(meta.thinkingConfigId).toBe("effort");
	});

	it("falls back to the agent's own model state", () => {
		const meta = applySetup(emptyMeta(), "x", {
			models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }] },
		});
		expect(meta.modelVia).toEqual({ kind: "set_model" });
		expect(meta.models).toEqual([{ id: "m1", name: "M1", provider: "x", contextWindow: null }]);
	});

	it("tracks commands, title, context and cumulative cost", () => {
		let meta = emptyMeta();
		meta = applyMetaUpdate(meta, "x", {
			sessionUpdate: "available_commands_update",
			availableCommands: [{ name: "/review", description: "Review", input: { hint: "path" } }],
		});
		meta = applyMetaUpdate(meta, "x", { sessionUpdate: "session_info_update", title: " Fix bug " });
		meta = applyMetaUpdate(meta, "x", {
			sessionUpdate: "usage_update",
			size: 200_000,
			used: 1_500,
			cost: { amount: 0.42, currency: "USD" },
		});
		expect(meta.commands).toEqual([{ name: "review", description: "Review", args: "path" }]);
		expect(meta.title).toBe("Fix bug");
		expect(meta).toMatchObject({ contextUsed: 1_500, contextSize: 200_000, costUsd: 0.42 });
		const eur = applyMetaUpdate(meta, "x", {
			sessionUpdate: "usage_update",
			size: 1,
			used: 1,
			cost: { amount: 9, currency: "EUR" },
		});
		expect(eur.costUsd).toBe(0.42);
		expect(collabCommands([{ name: "/", description: "" }])).toEqual([]);
	});
});

describe("promptBlocks", () => {
	it("adds images only when the agent takes them", () => {
		const image = { type: "image" as const, data: "AAA", mimeType: "image/png" };
		expect(promptBlocks("hi", [image], true)).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		]);
		expect(promptBlocks("hi", [image], false)).toEqual([{ type: "text", text: "hi" }]);
	});
});
