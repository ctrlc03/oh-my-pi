import { describe, expect, it } from "bun:test";
import type { ClaudeHookCommand, ClaudeHookEvent } from "@oh-my-pi/pi-coding-agent/claude-compat/config";
import {
	interpretHookResult,
	mergeVerdicts,
	runHookCommand,
} from "@oh-my-pi/pi-coding-agent/claude-compat/hook-process";
import { TempDir } from "@oh-my-pi/pi-utils";

function hookOf(event: ClaudeHookEvent, command: string): ClaudeHookCommand {
	return {
		event,
		matcher: undefined,
		command,
		timeoutSec: 60,
		source: { path: "/x/settings.json", level: "project" },
		id: `hook:claude:${event}:*:${command}`,
	};
}

async function run(event: ClaudeHookEvent, command: string, stdin = "{}", timeoutMs = 10_000) {
	using dir = TempDir.createSync("@pi-claude-hook-");
	const result = await runHookCommand(command, stdin, { cwd: dir.path(), timeoutMs });
	return { result, verdict: interpretHookResult(hookOf(event, command), result) };
}

describe("Claude command hook execution", () => {
	it("feeds the JSON payload on stdin and exports CLAUDE_PROJECT_DIR", async () => {
		const { result } = await run("PreToolUse", `cat; printf ' %s' "$CLAUDE_PROJECT_DIR"`, '{"tool_name":"Bash"}');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toStartWith('{"tool_name":"Bash"} ');
		expect(result.stdout.length).toBeGreaterThan('{"tool_name":"Bash"} '.length);
	});

	it("blocks on exit 2 and feeds stderr to the model", async () => {
		const { verdict } = await run("PreToolUse", "echo 'rm -rf is not allowed' >&2; exit 2");
		expect(verdict.block).toBe("rm -rf is not allowed");
	});

	it("blocks on an exit 2 hook even when it prints JSON allowing the call", async () => {
		const { verdict } = await run("PreToolUse", `echo '{"decision":"approve"}'; echo nope >&2; exit 2`);
		expect(verdict.block).toBe("nope");
	});

	it("treats other non-zero exits as a non-blocking notice", async () => {
		const { verdict } = await run("PreToolUse", "echo oops >&2; exit 1");
		expect(verdict.block).toBeUndefined();
		expect(verdict.notices[0]).toContain("exited with code 1");
	});

	it("does not block when the hook times out", async () => {
		const { result, verdict } = await run("PreToolUse", "sleep 5", "{}", 150);
		expect(result.failure).toBe("timeout");
		expect(verdict.block).toBeUndefined();
		expect(verdict.notices[0]).toContain("timed out");
	});

	it("honors decision/reason JSON on exit 0", async () => {
		const { verdict } = await run("PreToolUse", `echo '{"decision":"block","reason":"policy"}'`);
		expect(verdict.block).toBe("policy");
	});

	it("honors hookSpecificOutput.permissionDecision deny and ask", async () => {
		const deny = await run(
			"PreToolUse",
			`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'`,
		);
		expect(deny.verdict.block).toBe("no");
		const ask = await run(
			"PreToolUse",
			`echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"sure?"}}'`,
		);
		expect(ask.verdict.block).toBeUndefined();
		expect(ask.verdict.ask).toBe("sure?");
	});

	it("lets an approving decision through", async () => {
		const { verdict } = await run("PreToolUse", `echo '{"decision":"approve","reason":"fine"}'`);
		expect(verdict.block).toBeUndefined();
		expect(verdict.ask).toBeUndefined();
	});

	it("routes a PostToolUse block reason to the model instead of blocking", async () => {
		const { verdict } = await run("PostToolUse", `echo '{"decision":"block","reason":"lint failed"}'`);
		expect(verdict.block).toBeUndefined();
		expect(verdict.context).toEqual(["lint failed"]);
	});

	it("takes plain stdout as context only for UserPromptSubmit and SessionStart", async () => {
		expect((await run("UserPromptSubmit", "echo extra context")).verdict.context).toEqual(["extra context"]);
		expect((await run("SessionStart", "echo hello")).verdict.context).toEqual(["hello"]);
		expect((await run("PreToolUse", "echo ignored")).verdict.context).toEqual([]);
	});

	it("stops with stopReason when continue is false", async () => {
		const { verdict } = await run("UserPromptSubmit", `echo '{"continue":false,"stopReason":"halt"}'`);
		expect(verdict.block).toBe("halt");
	});

	it("treats continue false on Stop as a plain stop, not a block", async () => {
		const stopped = await run("Stop", `echo '{"continue":false,"stopReason":"all done"}'`);
		expect(stopped.verdict.block).toBeUndefined();
		expect(stopped.verdict.notices).toEqual(["all done"]);
		const blocked = await run("Stop", `echo '{"continue":false,"decision":"block","reason":"keep going"}'`);
		expect(blocked.verdict.block).toBe("keep going");
	});

	it("merges every blocking reason and keeps context", () => {
		const merged = mergeVerdicts([
			{ block: "a", context: ["c1"], notices: [] },
			{ context: ["c2"], notices: ["n"] },
			{ block: "b", context: [], notices: [] },
		]);
		expect(merged.block).toBe("a\nb");
		expect(merged.context).toEqual(["c1", "c2"]);
		expect(merged.notices).toEqual(["n"]);
	});
});
