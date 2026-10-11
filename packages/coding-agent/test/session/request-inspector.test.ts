/**
 * Contract: the trajectory inspector derives one row per assistant message of a branch — timing,
 * usage, cost, model, stop reason — and attaches what entered the context since the request
 * before it. Excerpts leave through `redact` before they are cut, so a secret straddling the cut
 * is never half-shown.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { buildInspectRows, INSPECT_EXCERPT_CHARS } from "@oh-my-pi/pi-coding-agent/session/request-inspector";

let nextId = 0;

function base(): { id: string; parentId: null; timestamp: string } {
	return { id: `e${++nextId}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

function usage(partial: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		...partial,
	};
}

function assistant(partial: Partial<AssistantMessage> = {}): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
		ttft: 420,
		duration: 3_100,
		...partial,
	};
	return { ...base(), type: "message", message };
}

function user(text: string): SessionEntry {
	return { ...base(), type: "message", message: { role: "user", content: text, timestamp: 1 } };
}

function toolResult(toolName: string, text: string): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `c${nextId}`,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
	};
}

function custom(customType: string, content: string): SessionEntry {
	return { ...base(), type: "custom_message", customType, content, display: false };
}

const options = { countTokens: (text: string) => Math.ceil(text.length / 4) };

describe("buildInspectRows", () => {
	it("records timing, usage, cost, model and stop reason per assistant message", () => {
		const { rows, total } = buildInspectRows(
			[
				user("hi"),
				assistant({ usage: usage({ input: 10, cacheRead: 900, cacheWrite: 90, output: 7 }) }),
				assistant({ stopReason: "error", errorMessage: "overloaded", ttft: undefined, duration: undefined }),
			],
			options,
		);
		expect(total).toBe(2);
		expect(rows.map(row => row.seq)).toEqual([1, 2]);
		expect(rows[0]).toMatchObject({
			at: 1_700_000_000_000,
			model: "anthropic/claude-test",
			ttftMs: 420,
			durationMs: 3_100,
			input: 10,
			output: 7,
			cacheRead: 900,
			cacheWrite: 90,
			cost: 0.003,
			stopReason: "stop",
		});
		expect(rows[1]).toMatchObject({ stopReason: "error", error: "overloaded" });
		expect(rows[1]!.ttftMs).toBeUndefined();
		expect(rows[1]!.durationMs).toBeUndefined();
	});

	it("attaches what entered the context since the previous request, and nothing twice", () => {
		const entries: SessionEntry[] = [
			user("fix the bug"),
			{ ...base(), type: "custom", customType: "system-prompt-digest", data: "aaaa1111bbbb" },
			assistant(),
			toolResult("bash", "line one"),
			toolResult("read", "a file"),
			toolResult("bash", "again"),
			custom("todo-error-reminder", "finish your todos"),
			custom("verify-failure", "tests failed"),
			custom("claude-hook-context", "hook says hi"),
			custom("hindsight-recall", "you prefer tabs"),
			{
				...base(),
				type: "custom",
				customType: "experimental_context_notes",
				data: { version: 1, text: "note body" },
			},
			{ ...base(), type: "custom", customType: "system-prompt-digest", data: "cccc2222dddd" },
			{ ...base(), type: "custom", customType: "system-prompt-digest", data: "cccc2222dddd" },
			assistant(),
			assistant(),
		];
		const { rows } = buildInspectRows(entries, options);
		expect(rows).toHaveLength(3);
		expect(rows[0]!.injected.map(item => item.kind)).toEqual(["prompt", "system-prompt"]);
		expect(rows[0]!.injected[1]!.label).toBe("System prompt");
		expect(rows[1]!.injected.map(item => item.kind)).toEqual([
			"tool-results",
			"todo",
			"verify",
			"hook",
			"memory",
			"context-notes",
			"system-prompt",
		]);
		const tools = rows[1]!.injected[0]!;
		expect(tools.label).toBe("3 tool results");
		expect(tools.text).toBe("bash ×2, read");
		expect(rows[1]!.injected[6]).toMatchObject({
			label: "System prompt changed",
			text: "digest aaaa1111 → cccc2222",
		});
		expect(rows[1]!.injected[5]!.text).toBe("note body");
		expect(rows[2]!.injected).toEqual([]);
	});

	it("keeps the newest rows under a limit while seq still counts every request", () => {
		const { rows, total } = buildInspectRows([assistant(), assistant(), assistant()], { ...options, limit: 2 });
		expect(total).toBe(3);
		expect(rows.map(row => row.seq)).toEqual([2, 3]);
	});

	it("redacts excerpts and errors before cutting them", () => {
		const secret = "sk-live-SECRET-VALUE";
		const long = `${"x".repeat(INSPECT_EXCERPT_CHARS - 5)}${secret} tail`;
		const redact = (text: string): string => text.replaceAll(secret, "[REDACTED]");
		const { rows } = buildInspectRows(
			[
				user(`use ${secret}`),
				custom("claude-hook-context", long),
				assistant({ stopReason: "error", errorMessage: `bad key ${secret}` }),
			],
			{ ...options, redact },
		);
		const serialized = JSON.stringify(rows);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("SECRET-VALUE");
		expect(rows[0]!.injected[0]!.text).toBe("use [REDACTED]");
		expect(rows[0]!.error).toBe("bad key [REDACTED]");
		const hook = rows[0]!.injected[1]!;
		expect(hook.text!.length).toBeLessThanOrEqual(INSPECT_EXCERPT_CHARS + 1);
	});
});
