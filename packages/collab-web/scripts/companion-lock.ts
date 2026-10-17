/**
 * One companion at a time per config directory. Two companions that serve the same room fight over it (the relay
 * closes the second host with 4009 and each retries forever), so the companion that becomes active writes
 * `<config>/agent/collab-companion.lock` (mode 0600, `{ pid, startedAt }`) and removes it when it exits. A companion that
 * finds a live lock is on standby: it binds nothing and opens nothing until the lock is gone or stale.
 *
 * A lock is live while its pid runs a companion (the command line says so: a pid the operating system handed to some other
 * program after a crash does not count). The desktop app reads the same file with the same rule.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CompanionLock {
	pid: number;
	/** Milliseconds since the epoch. */
	startedAt: number;
}

export interface ReadCompanionLock extends CompanionLock {
	/** The pid runs a companion now. */
	live: boolean;
}

/** How the lock asks the operating system about a pid; tests replace it. */
export interface ProcessProbe {
	alive(pid: number): boolean;
	/** The command line of `pid`, or null when it cannot be read. */
	commandLine(pid: number): string | null;
}

/** How often a standby companion looks at the lock. */
export const STANDBY_POLL_MS = 2_000;

/** `bun …/companion.ts` (from a checkout) and `omp companion` (the standalone binary). */
const COMPANION_COMMAND_RE = /companion\.ts(?:\s|$)|(?:^|\/)omp(?:-\S*)?\s+companion(?:\s|$)/;

export function isCompanionCommand(commandLine: string): boolean {
	return COMPANION_COMMAND_RE.test(commandLine.trim());
}

export const systemProbe: ProcessProbe = {
	alive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	commandLine(pid) {
		try {
			const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			const text = out.stdout.toString().trim();
			return out.exitCode === 0 && text !== "" ? text : null;
		} catch {
			return null;
		}
	},
};

export function companionLockFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-companion.lock");
}

function parseLock(text: string): CompanionLock | null {
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("startedAt" in raw)) return null;
		const { pid, startedAt } = raw;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
		if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
		return { pid, startedAt };
	} catch {
		return null;
	}
}

function isLive(lock: CompanionLock, probe: ProcessProbe): boolean {
	if (!probe.alive(lock.pid)) return false;
	const command = probe.commandLine(lock.pid);
	return command !== null && isCompanionCommand(command);
}

/** The lock in `configDir`, or null when there is none (or it is unreadable: nothing protects a file nobody can interpret). */
export async function readCompanionLock(
	configDir: string,
	probe: ProcessProbe = systemProbe,
): Promise<ReadCompanionLock | null> {
	let text: string;
	try {
		text = await Bun.file(companionLockFile(configDir)).text();
	} catch {
		return null;
	}
	const lock = parseLock(text);
	return lock === null ? null : { ...lock, live: isLive(lock, probe) };
}

/** How often the active companion checks that it still holds the lock. */
export const LOCK_WATCH_MS = 30_000;

export interface CompanionLockHandle {
	readonly pid: number;
	/** Remove the lock when it is still this process's. Synchronous: it runs from an `exit` handler. */
	release(): void;
	/**
	 * Make sure the lock names this companion again: null when it does (it was missing, stale or already ours), else the
	 * live companion that holds it now.
	 */
	reclaim(): ReadCompanionLock | null;
}

export interface AcquireOptions {
	/** The pid the lock names; defaults to this process. */
	pid?: number;
	now?: () => number;
	probe?: ProcessProbe;
	pollMs?: number;
	/** Stops waiting: the promise rejects with the signal's reason. */
	signal?: AbortSignal;
	/** Called once, when a live lock makes this companion wait. */
	onStandby?: (holder: ReadCompanionLock) => void;
}

function sameLock(a: CompanionLock, b: CompanionLock): boolean {
	return a.pid === b.pid && a.startedAt === b.startedAt;
}

function readLockSync(file: string): CompanionLock | null | "missing" {
	try {
		return parseLock(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
	}
}

let uniqueCounter = 0;
function unique(file: string, pid: number, label: string): string {
	return `${file}.${label}.${pid}.${uniqueCounter++}.${Math.random().toString(36).slice(2, 8)}`;
}

/** Create the lock file atomically with its content: a reader never sees an empty or half-written lock. */
function createLock(file: string, lock: CompanionLock): boolean {
	const temp = unique(file, lock.pid, "new");
	fs.writeFileSync(temp, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
	try {
		fs.linkSync(temp, file);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/**
 * Remove the lock at `file` that still reads as `stale`. The lock is first moved to a name of this process's own, then
 * read again: when it turned out to be another companion's fresh lock (taken between our read and the move), it goes
 * back. Of several standbys that see the same stale lock, the move succeeds for one; the rest find nothing there.
 */
function removeStale(file: string, stale: CompanionLock | null, pid: number, probe: ProcessProbe): void {
	const current = readLockSync(file);
	if (current === "missing") return;
	if (stale === null ? current !== null : current === null || !sameLock(current, stale)) return;
	const moved = unique(file, pid, "stale");
	try {
		fs.renameSync(file, moved);
	} catch {
		return;
	}
	const taken = readLockSync(moved);
	const fresh = taken !== null && taken !== "missing" && (stale === null || !sameLock(taken, stale));
	if (fresh && isLive(taken, probe)) {
		try {
			fs.linkSync(moved, file);
		} catch {
			// A third companion created its own lock in this instant; it wins and the moved lock is gone for good.
		}
	}
	fs.rmSync(moved, { force: true });
}

function holdLock(file: string, mine: CompanionLock, probe: ProcessProbe): CompanionLockHandle {
	return {
		pid: mine.pid,
		release() {
			const current = readLockSync(file);
			if (current !== null && current !== "missing" && sameLock(current, mine)) fs.rmSync(file, { force: true });
		},
		reclaim() {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (createLock(file, mine)) return null;
				const holder = readLockSync(file);
				if (holder === "missing") continue;
				if (holder !== null && sameLock(holder, mine)) return null;
				if (holder !== null && holder.pid !== mine.pid && isLive(holder, probe)) return { ...holder, live: true };
				removeStale(file, holder, mine.pid, probe);
			}
			const holder = readLockSync(file);
			return holder === null || holder === "missing" ? null : { ...holder, live: true };
		},
	};
}

/**
 * Keep checking that the lock is still this companion's, every `intervalMs`. A lock that vanished or went stale is taken
 * again; one a live companion now holds (two standbys that raced on a stale lock can both end up active) calls `onLost`
 * once and stops. Returns what stops the watch.
 */
export function watchCompanionLock(
	handle: CompanionLockHandle,
	options: { intervalMs?: number; onLost(holder: ReadCompanionLock): void },
): () => void {
	const timer = setInterval(() => {
		const holder = handle.reclaim();
		if (holder === null) return;
		clearInterval(timer);
		options.onLost(holder);
	}, options.intervalMs ?? LOCK_WATCH_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * Become the active companion: resolves with the lock once it is created, which is at once when nothing holds it. While a
 * live companion holds it, polls every `pollMs` and calls `onStandby` once.
 */
export async function acquireCompanionLock(
	configDir: string,
	options: AcquireOptions = {},
): Promise<CompanionLockHandle> {
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	const probe = options.probe ?? systemProbe;
	const pollMs = options.pollMs ?? STANDBY_POLL_MS;
	const file = companionLockFile(configDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let announced = false;
	for (;;) {
		options.signal?.throwIfAborted();
		const mine: CompanionLock = { pid, startedAt: now() };
		if (createLock(file, mine)) return holdLock(file, mine, probe);
		const holder = readLockSync(file);
		if (holder === "missing") continue;
		// An unreadable lock is nobody's; one that names this very pid is a previous life of it (the pid was reused).
		if (holder === null || holder.pid === pid || !isLive(holder, probe)) {
			removeStale(file, holder, pid, probe);
			continue;
		}
		if (!announced) {
			announced = true;
			options.onStandby?.({ ...holder, live: true });
		}
		await Bun.sleep(pollMs);
	}
}
