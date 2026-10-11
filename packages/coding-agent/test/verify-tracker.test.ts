import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { VerifyTracker, type VerifyTrackerHost } from "@oh-my-pi/pi-coding-agent/session/verify-tracker";
import { runVerifyCommands, type VerifyOutcome } from "@oh-my-pi/pi-coding-agent/verify/run";
import { cfgVerifyCommand, cfgVerifyWhen } from "@oh-my-pi/pi-coding-agent/verify/settings";

const CWD = path.join(os.tmpdir(), "verify-tracker-cwd");
const failed = (output: string, exitCode = 1): VerifyOutcome => ({
	kind: "failed",
	command: "bun test",
	exitCode,
	timedOut: false,
	output,
});

function messageText(message: { content: unknown } | undefined): string {
	return typeof message?.content === "string" ? message.content : "";
}

describe("VerifyTracker", () => {
	let runs: string[][];
	let notices: Array<{ level: string; message: string }>;
	let outcome: VerifyOutcome;
	let host: Partial<VerifyTrackerHost>;

	function tracker(settings: Record<string, unknown>): VerifyTracker {
		return new VerifyTracker({
			settings: Settings.isolated({ "verify.command": "bun test", ...settings }),
			cwd: () => CWD,
			sessionKey: () => "verify:test",
			agentKind: () => "main",
			planModeEnabled: () => false,
			getEnabledToolNames: () => ["bash", "edit", "write"],
			toolWritePaths: (toolName, args) => {
				const target = (args as { path?: string } | undefined)?.path;
				return toolName === "ast_edit" || target === undefined ? undefined : [target];
			},
			spendCapped: () => false,
			emitNotice: (level, message) => notices.push({ level, message }),
			run: async commands => {
				runs.push([...commands]);
				return outcome;
			},
			...host,
		});
	}

	/** Simulates one successful tool call, as the session's message_end hooks see it. */
	function change(t: VerifyTracker, toolName: string, args: Record<string, unknown>, isError = false): void {
		const id = `call-${Math.random()}`;
		t.onAssistantMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: toolName, arguments: args }],
		} as AssistantMessage);
		t.onToolResult(id, toolName, isError);
	}

	beforeEach(() => {
		runs = [];
		notices = [];
		outcome = { kind: "passed" };
		host = {};
	});

	it("runs only after a file-changing tool succeeded, and only once per change", async () => {
		const t = tracker({});
		const signal = new AbortController().signal;
		expect(await t.verify(signal)).toBeUndefined();
		change(t, "write", { path: "a.ts" }, true);
		change(t, "read", { path: "a.ts" });
		expect(await t.verify(signal)).toBeUndefined();
		expect(runs).toHaveLength(0);

		change(t, "write", { path: "a.ts" });
		await t.verify(signal);
		expect(runs).toEqual([["bun test"]]);
		await t.verify(signal);
		expect(runs).toHaveLength(1);
	});

	it("stays off without a command and never tracks changes for sub-agents", async () => {
		const signal = new AbortController().signal;
		const off = tracker({ "verify.command": [] });
		change(off, "write", { path: "a.ts" });
		await off.verify(signal);
		host = { agentKind: () => "sub" };
		const sub = tracker({});
		change(sub, "write", { path: "a.ts" });
		await sub.verify(signal);
		expect(runs).toHaveLength(0);
	});

	it("skips sessions without a bash tool and plan mode, keeping nothing pending to retry", async () => {
		const signal = new AbortController().signal;
		host = { getEnabledToolNames: () => ["write"] };
		const sandboxed = tracker({});
		change(sandboxed, "write", { path: "a.ts" });
		await sandboxed.verify(signal);
		host = { planModeEnabled: () => true };
		const planning = tracker({});
		change(planning, "write", { path: "a.ts" });
		await planning.verify(signal);
		expect(runs).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});

	it("honors verify.paths, treating a change with unknown files as matching", async () => {
		const t = tracker({ "verify.paths": ["src/**/*.ts"] });
		const signal = new AbortController().signal;
		change(t, "write", { path: "docs/readme.md" });
		await t.verify(signal);
		expect(runs).toHaveLength(0);

		change(t, "write", { path: path.join(CWD, "src", "deep", "a.ts") });
		await t.verify(signal);
		expect(runs).toHaveLength(1);

		change(t, "write", { path: "docs/readme.md" });
		change(t, "ast_edit", {});
		await t.verify(signal);
		expect(runs).toHaveLength(2);
	});

	it("feeds the output tail back, counts rounds, and stops after verify.maxAttempts", async () => {
		const t = tracker({ "verify.maxAttempts": 2, "verify.maxOutputChars": 16 });
		const signal = new AbortController().signal;
		outcome = failed(`${"x".repeat(100)}\nFAILED: widget`);

		change(t, "write", { path: "a.ts" });
		const first = await t.verify(signal);
		expect(first?.role).toBe("custom");
		expect(first?.display).toBe(false);
		const text = messageText(first);
		expect(text).toContain("FAILED: widget");
		expect(text).not.toContain("x".repeat(20));
		expect(text).toContain("1/2");

		change(t, "write", { path: "a.ts" });
		expect(messageText(await t.verify(signal))).toContain("2/2");

		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeUndefined();
		expect(runs).toHaveLength(3);
		expect(notices.at(-1)?.level).toBe("error");

		// A new user prompt gets a fresh budget; the tracker's own follow-up does not.
		t.onPromptStart(true);
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeUndefined();
		t.onPromptStart(false);
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeDefined();
	});

	it("restores the fix budget once verification passes", async () => {
		const t = tracker({ "verify.maxAttempts": 1 });
		const signal = new AbortController().signal;
		outcome = failed("boom");
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeDefined();
		outcome = { kind: "passed" };
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeUndefined();
		outcome = failed("boom");
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(signal)).toBeDefined();
	});

	it("reports a timeout as a failure the agent can act on", async () => {
		const t = tracker({ "verify.timeoutMs": 250 });
		outcome = { kind: "failed", command: "bun test", exitCode: undefined, timedOut: true, output: "" };
		change(t, "write", { path: "a.ts" });
		const message = await t.verify(new AbortController().signal);
		expect(messageText(message)).toContain("timed out after 250 ms");
	});

	it("does nothing when the user aborted, before or during the run", async () => {
		const t = tracker({});
		const aborted = new AbortController();
		aborted.abort();
		change(t, "write", { path: "a.ts" });
		expect(await t.verify(aborted.signal)).toBeUndefined();
		expect(runs).toHaveLength(0);

		const during = new AbortController();
		host = {
			run: async () => {
				during.abort();
				return failed("boom");
			},
		};
		const t2 = tracker({});
		change(t2, "write", { path: "a.ts" });
		expect(await t2.verify(during.signal)).toBeUndefined();
		expect(notices.some(notice => notice.level !== "info")).toBe(false);

		host = { run: async () => ({ kind: "cancelled" }) };
		const t3 = tracker({});
		change(t3, "write", { path: "a.ts" });
		expect(await t3.verify(new AbortController().signal)).toBeUndefined();
	});

	it("keeps pending edits when the check is cancelled, aborted or could not run", async () => {
		const signal = new AbortController().signal;
		let attempt: () => Promise<VerifyOutcome> = async () => ({ kind: "cancelled" });
		host = {
			run: async commands => {
				runs.push([...commands]);
				return attempt();
			},
		};
		const t = tracker({});
		change(t, "write", { path: "a.ts" });

		expect(await t.verify(signal)).toBeUndefined();

		const during = new AbortController();
		attempt = async () => {
			during.abort();
			return failed("boom");
		};
		expect(await t.verify(during.signal)).toBeUndefined();

		attempt = async () => {
			throw new Error("spawn failed");
		};
		expect(await t.verify(signal)).toBeUndefined();
		expect(notices.at(-1)?.level).toBe("error");
		expect(runs).toHaveLength(3);

		// Every miss left the edit pending, so the next check still runs and its failure reaches the agent.
		attempt = async () => failed("still broken");
		expect(messageText(await t.verify(signal))).toContain("still broken");
		expect(runs).toHaveLength(4);
	});

	it("forgets pending edits only once the check passed or failed", async () => {
		const t = tracker({});
		const signal = new AbortController().signal;
		change(t, "write", { path: "a.ts" });
		await t.verify(signal);
		await t.verify(signal);
		expect(runs).toHaveLength(1);

		outcome = failed("boom");
		change(t, "write", { path: "a.ts" });
		await t.verify(signal);
		await t.verify(signal);
		expect(runs).toHaveLength(2);
	});

	it("neither runs nor queues a follow-up while the session is spend-capped", async () => {
		let capped = true;
		host = { spendCapped: () => capped };
		outcome = failed("boom");
		const t = tracker({ "verify.maxAttempts": 1 });
		const signal = new AbortController().signal;
		change(t, "write", { path: "a.ts" });

		expect(await t.verify(signal)).toBeUndefined();
		expect(await t.verifyAfterEdit(signal)).toBeUndefined();
		expect(runs).toHaveLength(0);
		expect(notices).toHaveLength(0);

		// The edits stay pending and no fix round was spent: once the cap lifts the failure is sent as attempt 1/1.
		capped = false;
		expect(messageText(await t.verify(signal))).toContain("1/1");
		expect(runs).toHaveLength(1);
	});

	it("runs mid-run checks only for verify.when: after-edit", async () => {
		const signal = new AbortController().signal;
		outcome = failed("boom");
		const turnEnd = tracker({});
		change(turnEnd, "write", { path: "a.ts" });
		expect(await turnEnd.verifyAfterEdit(signal)).toBeUndefined();
		expect(runs).toHaveLength(0);

		const afterEdit = tracker({ "verify.when": "after-edit" });
		change(afterEdit, "write", { path: "a.ts" });
		expect(await afterEdit.verifyAfterEdit(signal)).toBeDefined();
		expect(runs).toHaveLength(1);
	});

	it("accepts a list of commands", async () => {
		const t = tracker({ "verify.command": ["bun run lint", "bun test"] });
		change(t, "write", { path: "a.ts" });
		await t.verify(new AbortController().signal);
		expect(runs).toEqual([["bun run lint", "bun test"]]);
	});
});

describe("runVerifyCommands", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verify-run-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd });
	});

	afterEach(() => {
		resetSettingsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	const options = (extra?: { timeoutMs?: number; signal?: AbortSignal }) => ({
		cwd,
		sessionKey: "verify:test",
		timeoutMs: 30_000,
		...extra,
	});

	it("passes when every command exits 0", async () => {
		expect(await runVerifyCommands(["true", "echo ok"], options())).toEqual({ kind: "passed" });
	});

	it("stops at the first failing command and reports its exit code and output", async () => {
		const marker = path.join(cwd, "never");
		const outcome = await runVerifyCommands(["echo first", "echo broken; exit 3", `touch ${marker}`], options());
		expect(outcome).toMatchObject({ kind: "failed", command: "echo broken; exit 3", exitCode: 3, timedOut: false });
		expect(outcome.kind === "failed" && outcome.output).toContain("broken");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("runs in the given cwd", async () => {
		fs.writeFileSync(path.join(cwd, "present.txt"), "");
		expect(await runVerifyCommands(["test -f present.txt"], options())).toEqual({ kind: "passed" });
	});

	// Real clock on purpose: the deadline lives in the shell executor, which fake timers cannot drive.
	it("kills a command at verify.timeoutMs", async () => {
		const started = Date.now();
		const outcome = await runVerifyCommands(["sleep 20"], options({ timeoutMs: 300 }));
		expect(outcome).toMatchObject({ kind: "failed", timedOut: true });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("reports cancellation when the signal aborts the command", async () => {
		const controller = new AbortController();
		const pending = runVerifyCommands(["sleep 20"], options({ signal: controller.signal }));
		controller.abort();
		expect(await pending).toEqual({ kind: "cancelled" });
	});
});

describe("verify settings", () => {
	it("read a bare string as a one-command list and keep other string settings scalar", () => {
		const settings = Settings.isolated({ "verify.command": "bun test", "verify.when": "after-edit" });
		expect(cfgVerifyCommand.get(settings)).toEqual(["bun test"]);
		expect(cfgVerifyWhen.get(settings)).toBe("after-edit");
		expect(cfgVerifyCommand.get(Settings.isolated({ "verify.command": ["a", "b"] }))).toEqual(["a", "b"]);
		expect(cfgVerifyCommand.get(Settings.isolated({}))).toEqual([]);
	});

	it("parse config text as a command, a JSON string, or a JSON list", () => {
		expect(cfgVerifyCommand.parse("bun test --bail")).toEqual(["bun test --bail"]);
		expect(cfgVerifyCommand.parse('"bun test"')).toEqual(["bun test"]);
		expect(cfgVerifyCommand.parse('["bun run lint", "bun test"]')).toEqual(["bun run lint", "bun test"]);
	});
});
