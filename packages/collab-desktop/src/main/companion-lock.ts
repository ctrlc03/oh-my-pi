/**
 * Is a companion holding the single-instance lock? The companion that is (or is about to become) active creates
 * `<config>/agent/collab-companion.lock` (`{ pid, startedAt }`) and removes it on a clean exit; a second companion
 * waits in standby while the lock is live. This reads that file with the companion's own rule (`readCompanionLock`
 * in collab-web's `companion-lock.ts`, which the app cannot import): the lock is live when its process runs AND that
 * process is a companion, so a pid reused by something else after a crash does not count. Everything that touches
 * the system is injected.
 */
import * as path from "node:path";

export interface CompanionLock {
	pid: number;
	/** Milliseconds since the epoch. */
	startedAt: number;
	live: boolean;
}

export function lockFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-companion.lock");
}

/** The lock a file's text holds, or null when it is not one. */
export function parseLock(text: string): { pid: number; startedAt: number } | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { pid, startedAt } = raw as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
	return { pid, startedAt };
}

/**
 * A process command line that is a companion: `bun …/companion.ts` from a checkout, or `omp companion` compiled
 * (the two forms the companion service runs).
 */
export function isCompanionCommand(commandLine: string): boolean {
	return /companion\.ts(\s|$)/.test(commandLine) || /(^|[/\s])omp(-[\w.-]*)?\s+companion(\s|$)/.test(commandLine);
}

export interface LockDeps {
	/** The file's text; null when it is missing or unreadable. */
	readFile(file: string): Promise<string | null>;
	/** A process with this pid exists (permission denied counts: it exists). */
	alive(pid: number): boolean;
	/** The process's command line; null when it cannot be read. */
	commandLine(pid: number): Promise<string | null>;
}

/** The lock and whether it is live, or null when there is no readable lock. */
export async function readCompanionLock(file: string, deps: LockDeps): Promise<CompanionLock | null> {
	const text = await deps.readFile(file);
	if (text === null) return null;
	const lock = parseLock(text);
	if (lock === null) return null;
	if (!deps.alive(lock.pid)) return { ...lock, live: false };
	const command = await deps.commandLine(lock.pid);
	return { ...lock, live: command !== null && isCompanionCommand(command) };
}
