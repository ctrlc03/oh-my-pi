/**
 * Output of a run started from the app: cleaned for display, and cut into the prompt "Send output to
 * agent" puts in the composer. The companion keeps the raw bytes with their ANSI colors.
 */

import { parseAnsi } from "./ansi";
import type { RunInfo } from "./companion";
import { fmtDuration } from "./format";

/** Lines of output that go to the agent. */
export const PROMPT_LINES = 200;
/** Lines the output view renders; earlier ones stay in `text` (and in what is sent) but would make a huge DOM. */
export const VIEW_LINES = 3_000;

/**
 * What a terminal would show: `\r\n` is a newline, and a line rewritten with `\r` (progress bars,
 * spinners) keeps only its last version.
 */
export function collapseOverwrites(text: string): string {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	return lines
		.map(line => {
			const cut = line.lastIndexOf("\r");
			// A trailing `\r` has not rewritten anything yet.
			if (cut === line.length - 1) return line.slice(0, -1);
			return cut < 0 ? line : line.slice(cut + 1);
		})
		.join("\n");
}

/** The last `count` lines of `text` and how many lines were left out. */
export function lastLines(text: string, count: number): { text: string; dropped: number } {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = body.split("\n");
	if (lines.length <= count) return { text: body, dropped: 0 };
	return { text: lines.slice(-count).join("\n"), dropped: lines.length - count };
}

/** Text without escape sequences. */
export function stripAnsi(text: string): string {
	return parseAnsi(text)
		.map(span => span.text)
		.join("");
}

/** How a run ended, or that it still goes: "running", "exit 0", "exit 2", "killed by SIGKILL", "stopped", "could not start". */
export function runStatus(run: Pick<RunInfo, "state" | "exitCode" | "signal">): string {
	if (run.state === "running") return "running";
	if (run.state === "failed") return "could not start";
	if (run.signal !== null) return `killed by ${run.signal}`;
	if (run.state === "stopped") return run.exitCode === null ? "stopped" : `stopped (exit ${run.exitCode})`;
	return `exit ${run.exitCode ?? "?"}`;
}

/** Wall time of a run; a running one counts up to `now`. */
export function runDuration(run: Pick<RunInfo, "startedAt" | "endedAt">, now: number): string {
	return fmtDuration((run.endedAt ?? now) - run.startedAt);
}

/** The prompt that hands the tail of a run's output to the agent, fenced so the output cannot end the block. */
export function outputPrompt(run: RunInfo, rawOutput: string, count = PROMPT_LINES): string {
	const tail = lastLines(stripAnsi(collapseOverwrites(rawOutput)), count);
	let longest = 0;
	for (const ticks of tail.text.match(/`+/g) ?? []) longest = Math.max(longest, ticks.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const shown = tail.dropped === 0 ? "output" : `last ${count} lines of output`;
	return `\`${run.command}\` (${runStatus(run)}), ${shown}:\n\n${fence}\n${tail.text}\n${fence}\n`;
}
