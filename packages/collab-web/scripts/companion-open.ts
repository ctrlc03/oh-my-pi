/**
 * Which omp processes on this computer have a session open, for the `start` request that resumes it:
 * two omps appending to one session file interleave and corrupt its history.
 *
 * omp keeps a session's .jsonl open for writing from its first write until it exits (every version,
 * observed with `lsof`), so a writer shows up as an open file; newer omps also hold a lease in
 * `~/.omp/run/session-owners`, which `lsof` shows the same way. A process that resumed a session and
 * has not written to it yet holds nothing, but still says so in its arguments (`-r <id>`), and an omp
 * the registry lists reports its session id. A session opened with the in-TUI /resume before its
 * first write is invisible to all three.
 */

import type { SessionHolder } from "../src/lib/companion";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	/** Controlling terminal, e.g. `ttys014`; null when none (`??`). */
	tty: string | null;
	command: string;
}

/** `ps -axww -o pid=,ppid=,tty=,command=` rows. */
export function parsePs(output: string): ProcessInfo[] {
	const rows: ProcessInfo[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			tty: match[3] === "??" ? null : match[3],
			command: match[4],
		});
	}
	return rows;
}

/** Processes with the file open for writing, from `lsof -F pcfa` output. */
export function parseLsofWriters(output: string): { pid: number; command: string }[] {
	const writers: { pid: number; command: string }[] = [];
	let current: { pid: number; command: string } | null = null;
	for (const line of output.split("\n")) {
		const field = line.slice(1);
		if (line.startsWith("p")) current = { pid: Number(field), command: "" };
		else if (line.startsWith("c") && current) current.command = field;
		// Access mode of one descriptor: r, w, or u (both).
		else if (line.startsWith("a") && current && (field === "w" || field === "u") && Number.isInteger(current.pid)) {
			if (!writers.some(writer => writer.pid === current?.pid)) writers.push({ ...current });
		}
	}
	return writers;
}

/** The session an omp command line opens: the value of `-r`/`--resume`/`--session`, else null. */
export function resumedSession(command: string): string | null {
	const tokens = command.split(/\s+/);
	const [first, second] = tokens.map(token => token.split("/").pop());
	// `omp ...` or `bun <path>/omp ...`: not `tmux new-session ... omp -r <id>`, whose arguments only mention it.
	const program = first === "omp" ? 0 : first === "bun" && second === "omp" ? 1 : -1;
	if (program < 0) return null;
	for (let i = program + 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-r" || token === "--resume" || token === "--session") return tokens[i + 1] ?? null;
		const inline = /^(?:--resume|--session)=(.+)$/.exec(token);
		if (inline) return inline[1];
	}
	return null;
}

/** True when `opened` (an id, an id prefix, or a path of the session file) names `sessionId`. */
function namesSession(opened: string, sessionId: string): boolean {
	if (opened === sessionId || opened.includes(`_${sessionId}.jsonl`)) return true;
	return opened.length >= 8 && !opened.includes("/") && sessionId.startsWith(opened);
}

/** The app a process runs under: the nearest `.app` bundle among its ancestors, or `tmux`. */
function appOf(pid: number, byPid: Map<number, ProcessInfo>): string | null {
	let current = byPid.get(pid);
	for (let depth = 0; current && depth < 32; depth++) {
		const bundle = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(current.command);
		if (bundle) return bundle[1];
		if (current.command.split(/\s+/)[0].split("/").pop()?.startsWith("tmux")) return "tmux";
		current = byPid.get(current.ppid);
	}
	return null;
}

export interface OpenSessionEvidence {
	sessionId: string;
	/** Writers of the session file (`lsof`). */
	writers: { pid: number; command: string }[];
	/** Every process on the computer. */
	processes: ProcessInfo[];
	/** Pids of omps the registry lists as running this session. */
	listedPids: number[];
	/** Processes that never count: the companion itself. */
	ignorePids: number[];
}

/** The omp processes that have `sessionId` open, combining the three signals, newest pid last. */
export function sessionHolders(evidence: OpenSessionEvidence): SessionHolder[] {
	const byPid = new Map(evidence.processes.map(proc => [proc.pid, proc]));
	const pids = new Set<number>(evidence.listedPids);
	// A tmux server keeps the descriptors it inherited from whatever started it, so it is no writer itself.
	for (const writer of evidence.writers) if (writer.command !== "tmux") pids.add(writer.pid);
	for (const proc of evidence.processes) {
		const opened = resumedSession(proc.command);
		if (opened !== null && namesSession(opened, evidence.sessionId)) pids.add(proc.pid);
	}
	for (const pid of evidence.ignorePids) pids.delete(pid);
	return [...pids]
		.sort((a, b) => a - b)
		.map(pid => ({ pid, tty: byPid.get(pid)?.tty ?? null, app: appOf(pid, byPid) }));
}

async function run(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

/**
 * The omp processes that have `sessionId` open right now. `file` is its session file when found
 * (without it only the arguments and the registry can tell).
 */
export async function findSessionHolders(
	sessionId: string,
	file: string | null,
	listedPids: number[],
): Promise<SessionHolder[]> {
	const [lsof, ps] = await Promise.all([
		file === null ? "" : run(["lsof", "-nP", "-F", "pcfa", "--", file]),
		run(["ps", "-axww", "-o", "pid=,ppid=,tty=,command="]),
	]);
	return sessionHolders({
		sessionId,
		writers: parseLsofWriters(lsof),
		processes: parsePs(ps),
		listedPids,
		ignorePids: [process.pid],
	});
}
