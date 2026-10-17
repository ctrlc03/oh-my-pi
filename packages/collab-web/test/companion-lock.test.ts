import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireCompanionLock,
	type CompanionLockHandle,
	companionLockFile,
	isCompanionCommand,
	type ProcessProbe,
	readCompanionLock,
	watchCompanionLock,
} from "../scripts/companion-lock";

let configDir: string;
const children: Bun.Subprocess[] = [];
/** Ends every acquire a test left waiting. */
let waiting: AbortController;

beforeEach(async () => {
	configDir = await fs.mkdtemp(path.join(os.tmpdir(), "companion-lock-"));
	waiting = new AbortController();
});

afterEach(async () => {
	waiting.abort();
	await Bun.sleep(0);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await fs.rm(configDir, { recursive: true, force: true });
});

/** Processes as the lock sees them: pid → command line, absent = not running. */
function fakeProcesses(commands: Record<number, string>): { probe: ProcessProbe; commands: Record<number, string> } {
	return {
		commands,
		probe: {
			alive: pid => commands[pid] !== undefined,
			commandLine: pid => commands[pid] ?? null,
		},
	};
}

const COMPANION = "/usr/bin/bun /repo/packages/collab-web/scripts/companion.ts";

/**
 * Resolves with the handle, or "waiting" when it has not after `ms`: a standby that must stay put can only be shown by waiting
 * for the real poll loop, which no fake clock reaches.
 */
async function settles(promise: Promise<CompanionLockHandle>, ms: number): Promise<CompanionLockHandle | "waiting"> {
	return await Promise.race([promise, Bun.sleep(ms).then(() => "waiting" as const)]);
}

describe("what counts as a companion's command line", () => {
	it("accepts a checkout run and the standalone binary, and nothing else", () => {
		expect(isCompanionCommand("/opt/homebrew/bin/bun /repo/packages/collab-web/scripts/companion.ts")).toBe(true);
		expect(isCompanionCommand("bun scripts/companion.ts --open")).toBe(true);
		expect(isCompanionCommand("/Users/me/.local/bin/omp companion")).toBe(true);
		expect(isCompanionCommand("/Users/me/.local/bin/omp companion --no-local-app")).toBe(true);
		expect(isCompanionCommand("/usr/bin/vim notes.txt")).toBe(false);
		expect(isCompanionCommand("/usr/bin/bun scripts/companion-agent.ts")).toBe(false);
		expect(isCompanionCommand("/Users/me/.local/bin/omp")).toBe(false);
		expect(isCompanionCommand("/Users/me/.local/bin/omp --resume companion")).toBe(false);
	});
});

describe("the companion lock", () => {
	it("is created private with the owner's pid and start time, and read back as live", async () => {
		const { probe } = fakeProcesses({ 101: COMPANION });
		expect(await readCompanionLock(configDir, probe)).toBeNull();
		await acquireCompanionLock(configDir, { pid: 101, now: () => 1234, probe });
		expect(JSON.parse(await Bun.file(companionLockFile(configDir)).text())).toEqual({ pid: 101, startedAt: 1234 });
		expect((await fs.stat(companionLockFile(configDir))).mode & 0o777).toBe(0o600);
		expect(await readCompanionLock(configDir, probe)).toEqual({ pid: 101, startedAt: 1234, live: true });
	});

	it("leaves no temporary files behind", async () => {
		const { probe } = fakeProcesses({ 101: COMPANION });
		const lock = await acquireCompanionLock(configDir, { pid: 101, probe });
		expect(await fs.readdir(path.dirname(companionLockFile(configDir)))).toEqual(["collab-companion.lock"]);
		lock.release();
		expect(await fs.readdir(path.dirname(companionLockFile(configDir)))).toEqual([]);
	});

	it("puts a second companion on standby while the first is alive, and hands over on a clean exit", async () => {
		const { probe } = fakeProcesses({ 101: COMPANION, 202: COMPANION });
		const first = await acquireCompanionLock(configDir, { pid: 101, probe });
		const standby: number[] = [];
		const second = acquireCompanionLock(configDir, {
			pid: 202,
			probe,
			pollMs: 10,
			onStandby: holder => standby.push(holder.pid),
		});
		expect(await settles(second, 100)).toBe("waiting");
		expect(standby).toEqual([101]);
		// The first one's lock is untouched while the second waits.
		expect((await readCompanionLock(configDir, probe))?.pid).toBe(101);
		first.release();
		const handle = await settles(second, 1_000);
		expect(handle).not.toBe("waiting");
		expect((await readCompanionLock(configDir, probe))?.pid).toBe(202);
		// Announced once, not on every poll.
		expect(standby).toEqual([101]);
	});

	it("is taken over once the holder crashed and left its lock behind", async () => {
		const procs = fakeProcesses({ 101: COMPANION, 202: COMPANION });
		await acquireCompanionLock(configDir, { pid: 101, probe: procs.probe });
		const second = acquireCompanionLock(configDir, { pid: 202, probe: procs.probe, pollMs: 10 });
		expect(await settles(second, 60)).toBe("waiting");
		delete procs.commands[101];
		expect(await settles(second, 1_000)).not.toBe("waiting");
		expect((await readCompanionLock(configDir, procs.probe))?.pid).toBe(202);
	});

	it("treats a lock whose pid now runs some other program as stale", async () => {
		const { probe } = fakeProcesses({ 101: "/usr/bin/vim notes.txt", 202: COMPANION });
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), JSON.stringify({ pid: 101, startedAt: 1 }));
		expect(await readCompanionLock(configDir, probe)).toEqual({ pid: 101, startedAt: 1, live: false });
		expect(await settles(acquireCompanionLock(configDir, { pid: 202, probe, pollMs: 10 }), 500)).not.toBe("waiting");
		expect((await readCompanionLock(configDir, probe))?.pid).toBe(202);
	});

	it("treats a lock that names this very pid as a previous life of it", async () => {
		const { probe } = fakeProcesses({ 101: COMPANION });
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), JSON.stringify({ pid: 101, startedAt: 1 }));
		expect(await settles(acquireCompanionLock(configDir, { pid: 101, probe, pollMs: 10 }), 500)).not.toBe("waiting");
	});

	it("treats a lock nobody can read as stale", async () => {
		const { probe } = fakeProcesses({ 202: COMPANION });
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), "not json");
		expect(await readCompanionLock(configDir, probe)).toBeNull();
		expect(await settles(acquireCompanionLock(configDir, { pid: 202, probe, pollMs: 10 }), 500)).not.toBe("waiting");
		expect((await readCompanionLock(configDir, probe))?.pid).toBe(202);
	});

	it("never releases a lock another companion has since taken", async () => {
		const procs = fakeProcesses({ 101: COMPANION, 202: COMPANION });
		const first = await acquireCompanionLock(configDir, { pid: 101, probe: procs.probe });
		delete procs.commands[101];
		await acquireCompanionLock(configDir, { pid: 202, probe: procs.probe, pollMs: 10 });
		first.release();
		expect((await readCompanionLock(configDir, procs.probe))?.pid).toBe(202);
	});

	it("lets exactly one of several standbys take a stale lock", async () => {
		for (let round = 0; round < 25; round++) {
			const dir = path.join(configDir, `round-${round}`);
			const pids = [301, 302, 303, 304, 305];
			const procs = fakeProcesses(Object.fromEntries(pids.map(pid => [pid, COMPANION])));
			await fs.mkdir(path.dirname(companionLockFile(dir)), { recursive: true });
			await Bun.write(companionLockFile(dir), JSON.stringify({ pid: 99, startedAt: 1 }));
			const active: number[] = [];
			for (const pid of pids) {
				acquireCompanionLock(dir, { pid, probe: procs.probe, pollMs: 5, signal: waiting.signal }).then(
					() => active.push(pid),
					() => {},
				);
			}
			await Bun.sleep(40);
			expect(active).toHaveLength(1);
			expect((await readCompanionLock(dir, procs.probe))?.pid).toBe(active[0]!);
		}
	});
});

describe("the lock against real processes", () => {
	/** A stand-in for `scripts/companion.ts`: its command line contains `companion.ts`, as the real one's does. */
	async function writeStandIn(): Promise<string> {
		const script = path.join(configDir, "bin", "companion.ts");
		await Bun.write(
			script,
			`import * as fs from "node:fs";
import { acquireCompanionLock } from ${JSON.stringify(path.join(import.meta.dir, "..", "scripts", "companion-lock.ts"))};
const [dir, out] = Bun.argv.slice(2);
const lock = await acquireCompanionLock(dir, { pollMs: 40 });
fs.appendFileSync(out, process.pid + "\\n");
process.on("SIGTERM", () => {
	lock.release();
	process.exit(0);
});
setInterval(() => {}, 1_000);
`,
		);
		return script;
	}

	function start(script: string, out: string): Bun.Subprocess {
		const child = Bun.spawn([process.execPath, script, configDir, out], { stdout: "ignore", stderr: "ignore" });
		children.push(child);
		return child;
	}

	async function activePids(out: string): Promise<number[]> {
		const text = await Bun.file(out)
			.text()
			.catch(() => "");
		return text.split("\n").filter(Boolean).map(Number);
	}

	it("reads a pid that runs another program as stale and a companion's as live", async () => {
		const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		children.push(other);
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), JSON.stringify({ pid: other.pid, startedAt: 1 }));
		expect((await readCompanionLock(configDir))?.live).toBe(false);

		const out = path.join(configDir, "out");
		await fs.rm(companionLockFile(configDir));
		const companion = start(await writeStandIn(), out);
		while ((await activePids(out)).length === 0) await Bun.sleep(20);
		expect(await readCompanionLock(configDir)).toMatchObject({ pid: companion.pid, live: true });
	});

	it("keeps concurrent standbys from both becoming active, through a clean exit and a crash", async () => {
		const script = await writeStandIn();
		const out = path.join(configDir, "out");
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 1 }));
		const started = [start(script, out), start(script, out), start(script, out), start(script, out)];
		const waitFor = async (count: number): Promise<void> => {
			const deadline = Date.now() + 20_000;
			while ((await activePids(out)).length < count) {
				if (Date.now() > deadline)
					throw new Error(`still ${(await activePids(out)).length} active, wanted ${count}`);
				await Bun.sleep(20);
			}
		};

		await waitFor(1);
		await Bun.sleep(300);
		const [first] = await activePids(out);
		expect(await activePids(out)).toEqual([first!]);

		// Clean exit: the lock goes with it and a standby takes over within a poll or two.
		started.find(child => child.pid === first)!.kill("SIGTERM");
		await waitFor(2);
		await Bun.sleep(300);
		const second = (await activePids(out))[1]!;
		expect(await activePids(out)).toHaveLength(2);
		expect((await readCompanionLock(configDir))?.pid).toBe(second);

		// Crash: the lock stays, names a dead pid, and the next standby takes it over.
		started.find(child => child.pid === second)!.kill("SIGKILL");
		await waitFor(3);
		await Bun.sleep(300);
		const pids = await activePids(out);
		expect(pids).toHaveLength(3);
		expect(new Set(pids).size).toBe(3);
		expect((await readCompanionLock(configDir))?.pid).toBe(pids[2]!);
	});
});

describe("an active companion checking that it still holds the lock", () => {
	async function writeLock(pid: number): Promise<void> {
		await fs.mkdir(path.dirname(companionLockFile(configDir)), { recursive: true });
		await Bun.write(companionLockFile(configDir), JSON.stringify({ pid, startedAt: 5 }));
	}

	it("takes the lock again when it vanished or went stale, and reports a live companion that holds it now", async () => {
		const procs = fakeProcesses({ 101: COMPANION, 202: COMPANION });
		const mine = await acquireCompanionLock(configDir, { pid: 101, probe: procs.probe });
		expect(mine.reclaim()).toBeNull();

		await fs.rm(companionLockFile(configDir));
		expect(mine.reclaim()).toBeNull();
		expect((await readCompanionLock(configDir, procs.probe))?.pid).toBe(101);

		await writeLock(303);
		expect(mine.reclaim()).toBeNull();
		expect((await readCompanionLock(configDir, procs.probe))?.pid).toBe(101);

		// Two standbys raced on a stale lock: the other one holds it now.
		await writeLock(202);
		expect(mine.reclaim()).toMatchObject({ pid: 202, live: true });
		expect((await readCompanionLock(configDir, procs.probe))?.pid).toBe(202);
	});

	it("calls onLost once, and not before the lock changed hands", async () => {
		const procs = fakeProcesses({ 101: COMPANION, 202: COMPANION });
		const mine = await acquireCompanionLock(configDir, { pid: 101, probe: procs.probe });
		const lost: number[] = [];
		const lostOnce = Promise.withResolvers<void>();
		const stop = watchCompanionLock(mine, {
			intervalMs: 5,
			onLost: holder => {
				lost.push(holder.pid);
				lostOnce.resolve();
			},
		});
		try {
			// Several checks pass with the lock intact.
			await Bun.sleep(40);
			expect(lost).toEqual([]);
			await writeLock(202);
			await lostOnce.promise;
			// Waiting for the event is the test; a further check after it must not call again.
			await Bun.sleep(30);
			expect(lost).toEqual([202]);
		} finally {
			stop();
		}
	});
});
