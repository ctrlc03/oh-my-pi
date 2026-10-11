/**
 * Contract: receipts list the files the agent changed, the shell commands run (the agent's with the exit
 * status its tool result carries, the user's `!` commands), the recorded approval decisions and the
 * subagents of `task` calls, each under the turn (prompt) it happened in.
 */
import { describe, expect, it } from "bun:test";
import { buildReceipts, formatReceipts, RECEIPTS_MAX_ROWS } from "@oh-my-pi/pi-coding-agent/session/receipts";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let counter = 0;
function base(): { id: string; parentId: string | null; timestamp: string } {
	counter++;
	return { id: `e${counter}`, parentId: counter > 1 ? `e${counter - 1}` : null, timestamp: "2026-01-01T00:00:00Z" };
}

function prompt(text: string): SessionEntry {
	return {
		...base(),
		type: "message",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	} as SessionEntry;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): SessionEntry {
	return {
		...base(),
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	} as unknown as SessionEntry;
}

function toolResult(id: string, name: string, isError: boolean, details?: unknown): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "" }],
			isError,
			details,
			timestamp: 0,
		},
	} as SessionEntry;
}

function approval(data: unknown): SessionEntry {
	return { ...base(), type: "custom", customType: "tool-approval", data } as SessionEntry;
}

describe("receipts", () => {
	it("lists commands with their exit status and turn", () => {
		const branch = [
			toolCall("c0", "bash", { command: "echo before any prompt" }),
			toolResult("c0", "bash", false),
			prompt("first"),
			toolCall("c1", "bash", { command: "bun test" }),
			toolResult("c1", "bash", true, { exitCode: 1 }),
			toolCall("c2", "bash", { command: "sleep 100" }),
			toolResult("c2", "bash", true, { timedOut: true }),
			toolCall("c3", "bash", { command: "ls" }),
			prompt("second"),
			{
				...base(),
				type: "message",
				message: {
					role: "bashExecution",
					command: "git status",
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 0,
				},
			} as SessionEntry,
			toolCall("c4", "bash", { command: "true" }),
			toolResult("c4", "bash", false, { timeoutSeconds: 30 }),
		];
		const receipts = buildReceipts(branch);
		expect(receipts.turns).toBe(2);
		expect(receipts.commands.map(c => [c.command, c.exitCode, c.source, c.turn])).toEqual([
			["echo before any prompt", 0, "agent", 0],
			["bun test", 1, "agent", 1],
			["sleep 100", null, "agent", 1],
			["ls", null, "agent", 1],
			["git status", 0, "user", 2],
			["true", 0, "agent", 2],
		]);
		expect(receipts.commands[1]?.promptId).toBe(branch[2]?.id);
		expect(receipts.commands[0]?.promptId).toBeNull();
	});

	it("lists each successfully changed file once per turn and skips failed or non-file edits", () => {
		const branch = [
			prompt("first"),
			toolCall("w1", "write", { path: "src/new.ts", content: "x" }),
			toolResult("w1", "write", false),
			toolCall("e1", "edit", { input: '[src/a.ts#AB12]\nPUT 1.=1:\n+x\n["src/b.ts"]\nPUT 1.=1:\n+y\n' }),
			toolResult("e1", "edit", false),
			toolCall("e2", "edit", { path: "src/a.ts", edits: [] }),
			toolResult("e2", "edit", false),
			toolCall("e3", "edit", { path: "src/failed.ts" }),
			toolResult("e3", "edit", true),
			toolCall("e4", "write", { path: "local://note.md", content: "x" }),
			toolResult("e4", "write", false),
			prompt("second"),
			toolCall("e5", "edit", { path: "src/a.ts" }),
			toolResult("e5", "edit", false),
			toolCall("p1", "apply_patch", { input: "*** Update File: src/p.ts\n*** Add File: src/q.ts\n" }),
			toolResult("p1", "apply_patch", false, {
				perFileResults: [{ path: "src/p.ts" }, { path: "src/q.ts", isError: true }],
			}),
		];
		expect(buildReceipts(branch).files.map(f => [f.path, f.tool, f.turn])).toEqual([
			["src/new.ts", "write", 1],
			["src/a.ts", "edit", 1],
			["src/b.ts", "edit", 1],
			["src/a.ts", "edit", 2],
			["src/p.ts", "apply_patch", 2],
		]);
	});

	it("lists approvals as recorded and subagents from their task results", () => {
		const branch = [
			prompt("go"),
			approval({ toolCallId: "c1", tool: "bash", approved: true, by: "tui", choice: "once" }),
			approval({ toolCallId: "c2", tool: "write", approved: false, by: "guest", reason: "denied by user" }),
			approval({ tool: "edit", by: "grant" }),
			toolCall("t1", "task", {
				tasks: [
					{ name: "Scan", agent: "scout", task: "look around" },
					{ name: "Fix", task: "repair" },
				],
			}),
			toolResult("t1", "task", false, {
				results: [
					{
						id: "Scan",
						agent: "scout",
						task: "look around",
						description: "Scan the repo",
						exitCode: 0,
						durationMs: 1200,
					},
					{ id: "Fix", agent: "task", task: "repair\nmore", exitCode: 1, durationMs: 800 },
				],
			}),
			toolCall("t2", "task", { name: "Pending", task: "still going" }),
		];
		const receipts = buildReceipts(branch);
		expect(receipts.approvals).toEqual([
			{ tool: "bash", approved: true, by: "tui", turn: 1, promptId: branch[0]?.id },
			{ tool: "write", approved: false, by: "guest", reason: "denied by user", turn: 1, promptId: branch[0]?.id },
		]);
		expect(receipts.subagents.map(s => [s.id, s.agent, s.label, s.exitCode, s.durationMs])).toEqual([
			["Scan", "scout", "Scan the repo", 0, 1200],
			["Fix", "task", "repair", 1, 800],
			["Pending", "task", "still going", null, null],
		]);
		const text = formatReceipts(receipts);
		expect(text).toContain("write  denied by guest (denied by user)");
		expect(text).toContain("Fix (task): repair  exit 1");
	});

	it("keeps the newest rows of an over-long list and reports empty receipts plainly", () => {
		expect(formatReceipts(buildReceipts([prompt("hi")]))).toContain("No files changed");
		const branch: SessionEntry[] = [prompt("p")];
		for (let index = 0; index < RECEIPTS_MAX_ROWS + 3; index++) {
			branch.push(
				toolCall(`b${index}`, "bash", { command: `cmd ${index}` }),
				toolResult(`b${index}`, "bash", false),
			);
		}
		const receipts = buildReceipts(branch);
		expect(receipts.commands).toHaveLength(RECEIPTS_MAX_ROWS);
		expect(receipts.commands[0]?.command).toBe("cmd 3");
		expect(receipts.truncated).toBe(true);
	});
});
