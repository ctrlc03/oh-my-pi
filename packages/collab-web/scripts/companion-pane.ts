/**
 * The terminal a session runs in, for the `pane` request: finds the tmux pane whose process tree holds the
 * session's omp (sessions the companion starts run in their own `omp-<id>` tmux session, others may run in
 * any pane) and captures its screen plus a bounded scrollback. Read-only: nothing is ever sent to the pane.
 */

import type { PaneCapture } from "../src/lib/companion";
import { findTmux } from "./companion-start";

const TMUX_TIMEOUT_MS = 5_000;
/** Lines of scrollback captured above the visible screen. */
const SCROLLBACK_LINES = 200;
/** Cap on the captured text; the oldest lines are dropped first. */
const MAX_TEXT_CHARS = 256 * 1024;
/** Longest process ancestry walked from the omp pid to a pane. */
const MAX_DEPTH = 64;
const NOT_IN_TMUX =
	"This session does not run inside tmux, so there is no terminal to show. Sessions started from the app do.";

export interface PaneRow {
	/** The pane's first process (the shell, or the command the pane was started with). */
	pid: number;
	/** `session:window.pane`, usable as a tmux `-t` target. */
	target: string;
	cols: number;
	rows: number;
}

/** Format for `tmux list-panes -a -F`: pid, target, size. The target may contain spaces, so the size comes last. */
export const LIST_PANES_FORMAT =
	"#{pane_pid} #{session_name}:#{window_index}.#{pane_index} #{pane_width} #{pane_height}";

const PANE_LINE_RE = /^(\d+) (.+) (\d+) (\d+)$/;

/** Rows of `tmux list-panes -a -F LIST_PANES_FORMAT`; malformed lines are skipped. */
export function parsePanes(output: string): PaneRow[] {
	const panes: PaneRow[] = [];
	for (const line of output.split("\n")) {
		const match = PANE_LINE_RE.exec(line.trimEnd());
		if (match)
			panes.push({ pid: Number(match[1]), target: match[2]!, cols: Number(match[3]), rows: Number(match[4]) });
	}
	return panes;
}

/** Parent of every process, from `ps -A -o pid=,ppid=`. */
export function parseParents(output: string): Map<number, number> {
	const parents = new Map<number, number>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (match) parents.set(Number(match[1]), Number(match[2]));
	}
	return parents;
}

/** The pane whose first process is `pid` or the nearest ancestor of it, or null when the process is not under any pane. */
export function findPane(pid: number, panes: readonly PaneRow[], parents: ReadonlyMap<number, number>): PaneRow | null {
	const byPid = new Map(panes.map(pane => [pane.pid, pane]));
	let current = pid;
	for (let depth = 0; depth < MAX_DEPTH && current > 1; depth++) {
		const pane = byPid.get(current);
		if (pane) return pane;
		const parent = parents.get(current);
		if (parent === undefined || parent === current) return null;
		current = parent;
	}
	return null;
}

/** Keep the newest lines of `text` within `max` characters, cutting at a line boundary. */
export function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.indexOf("\n", text.length - max);
	return cut < 0 ? text.slice(text.length - max) : text.slice(cut + 1);
}

async function run(bin: string, args: string[]): Promise<string> {
	const proc = Bun.spawn([bin, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		timeout: TMUX_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err.trim() || `${bin} exited with ${code}`);
	return out;
}

/**
 * The screen of the tmux pane running the process `pid`, with its escape sequences (colors) kept and
 * trailing blank lines dropped. A process outside tmux answers with a null target and an explanation.
 */
export async function capturePane(pid: number): Promise<PaneCapture> {
	const notFound = (text: string): PaneCapture => ({ target: null, text, cols: 0, rows: 0, at: Date.now() });
	const tmux = await findTmux();
	if (tmux === null) return notFound("tmux is not installed on this computer.");
	let panes: PaneRow[];
	try {
		panes = parsePanes(await run(tmux, ["list-panes", "-a", "-F", LIST_PANES_FORMAT]));
	} catch {
		// No server running: nothing runs in tmux.
		return notFound(NOT_IN_TMUX);
	}
	const pane = findPane(pid, panes, parseParents(await run("ps", ["-A", "-o", "pid=,ppid="])));
	if (pane === null) return notFound(NOT_IN_TMUX);
	const text = await run(tmux, ["capture-pane", "-p", "-e", "-J", "-S", `-${SCROLLBACK_LINES}`, "-t", pane.target]);
	return {
		target: pane.target,
		text: capText(text.trimEnd(), MAX_TEXT_CHARS),
		cols: pane.cols,
		rows: pane.rows,
		at: Date.now(),
	};
}
