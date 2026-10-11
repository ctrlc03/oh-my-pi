import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "@oh-my-pi/pi-coding-agent/session/session-stats";

function usage(cost: number, input = 100, output = 50, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead: 7,
		cacheWrite,
		totalTokens: input + output + cacheWrite + 7,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(cost: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reply ${timestamp}` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(cost),
		stopReason: "stop",
		timestamp,
	};
}

function taskResult(cost: number, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `task-${timestamp}`,
		toolName: "task",
		content: [{ type: "text", text: "done" }],
		details: { usage: usage(cost) },
		isError: false,
		timestamp,
	};
}

function createTracker(manager: SessionManager) {
	const host = {
		sessionManager: manager,
		sessionId: () => manager.getSessionId(),
		agent: { state: { messages: [] } },
	} as unknown as SessionStatsTrackerHost;
	return new SessionStatsTracker(host);
}

describe("SessionStatsTracker.getSpendUsage", () => {
	it("counts assistant turns, task results and model usage, cache reads excluded", () => {
		const manager = SessionManager.inMemory();
		const tracker = createTracker(manager);
		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		manager.appendMessage(assistant(0.25, 2));
		manager.appendMessage(taskResult(0.5, 3));
		const owner = { sessionId: manager.getSessionId(), parentId: manager.getLeafId() };
		manager.appendModelUsage(
			{
				purpose: "title",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku",
				usage: usage(0.125, 10, 5, 3),
				stopReason: "stop",
			},
			owner,
		);

		expect(tracker.getSpendUsage()).toEqual({ costUsd: 0.875, tokens: 150 + 150 + 18 });
	});

	it("keeps spend through compaction, rewind and branch navigation", () => {
		const manager = SessionManager.inMemory();
		const tracker = createTracker(manager);
		const firstUser = manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		manager.appendMessage(assistant(0.25, 2));
		const secondUser = manager.appendMessage({ role: "user", content: "two", timestamp: 3 });
		manager.appendMessage(assistant(0.25, 4));
		expect(tracker.getSpendUsage().costUsd).toBe(0.5);

		// Compaction drops the early turns from the active window; their spend was still paid.
		manager.appendCompaction("summary", undefined, secondUser, 1_000);
		expect(tracker.getSpendUsage().costUsd).toBe(0.5);

		// /undo and /tree move the leaf back; the abandoned branch stays on the books.
		manager.branch(firstUser);
		expect(tracker.getSpendUsage().costUsd).toBe(0.5);
		manager.resetLeaf();
		expect(tracker.getSpendUsage()).toEqual({ costUsd: 0.5, tokens: 300 });

		// New work on the new branch adds to it.
		manager.appendMessage({ role: "user", content: "again", timestamp: 5 });
		manager.appendMessage(assistant(0.25, 6));
		expect(tracker.getSpendUsage().costUsd).toBe(0.75);
	});

	it("counts a settled message before the journal records it, then once after", () => {
		const manager = SessionManager.inMemory();
		const tracker = createTracker(manager);
		const reply = assistant(0.25, 2);

		tracker.recordSettledMessage(reply);
		expect(tracker.getSpendUsage().costUsd).toBe(0.25);

		manager.appendMessage(reply);
		expect(tracker.getSpendUsage()).toEqual({ costUsd: 0.25, tokens: 150 });
		manager.appendMessage(assistant(0.25, 3));
		expect(tracker.getSpendUsage().costUsd).toBe(0.5);
	});

	it("keeps counting a settled message the journal never records", () => {
		const manager = SessionManager.inMemory();
		const tracker = createTracker(manager);
		tracker.recordSettledMessage(assistant(0.25, 2));
		tracker.recordSettledMessage(taskResult(0.5, 3));
		expect(tracker.getSpendUsage().costUsd).toBe(0.75);
		expect(tracker.getSpendUsage().costUsd).toBe(0.75);
	});
});
