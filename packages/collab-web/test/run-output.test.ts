import { describe, expect, it } from "bun:test";
import type { RunInfo } from "../src/lib/companion";
import { collapseOverwrites, lastLines, outputPrompt, runStatus } from "../src/lib/run-output";

const run = (patch: Partial<RunInfo> = {}): RunInfo => ({
	runId: "r",
	instanceId: "i",
	targetId: "package:test",
	command: "bun run test",
	startedAt: 0,
	endedAt: 1_000,
	state: "exited",
	exitCode: 1,
	signal: null,
	...patch,
});

describe("collapseOverwrites", () => {
	it("keeps the last version of a line rewritten with carriage returns", () => {
		expect(collapseOverwrites("10%\r50%\r100%\ndone\n")).toBe("100%\ndone\n");
	});

	it("treats CRLF as a plain newline", () => {
		expect(collapseOverwrites("a\r\nb\r\n")).toBe("a\nb\n");
	});
});

describe("lastLines", () => {
	it("returns the newest lines and counts the rest", () => {
		expect(lastLines("1\n2\n3\n4\n", 2)).toEqual({ text: "3\n4", dropped: 2 });
		expect(lastLines("1\n2", 5)).toEqual({ text: "1\n2", dropped: 0 });
	});
});

describe("outputPrompt", () => {
	it("sends the last 200 lines without colors, in a fence the output cannot close", () => {
		const raw = `${Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n")}\n\u001b[31mFAIL\u001b[0m \`\`\`x\n`;
		const prompt = outputPrompt(run(), raw);
		expect(prompt.startsWith("`bun run test` (exit 1), last 200 lines of output:")).toBe(true);
		expect(prompt).not.toContain("\u001b");
		expect(prompt).not.toContain("line 49\n");
		expect(prompt).toContain("line 51\n");
		expect(prompt).toContain("FAIL ```x");
		const lines = prompt.split("\n");
		expect(lines.filter(l => l === "````")).toHaveLength(2);
	});

	it("says what became of a run that did not exit normally", () => {
		expect(outputPrompt(run({ state: "stopped", exitCode: null, signal: "SIGKILL" }), "x")).toContain(
			"(killed by SIGKILL), output:",
		);
	});
});

describe("runStatus", () => {
	it("names every way a run can stand", () => {
		expect(runStatus(run({ state: "running", endedAt: null, exitCode: null }))).toBe("running");
		expect(runStatus(run({ exitCode: 0 }))).toBe("exit 0");
		expect(runStatus(run({ state: "stopped", exitCode: 143 }))).toBe("stopped (exit 143)");
		expect(runStatus(run({ state: "failed", exitCode: null }))).toBe("could not start");
	});
});
