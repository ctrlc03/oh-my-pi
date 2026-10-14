import { describe, expect, it } from "bun:test";
import type { LocalEndpoint } from "../src/main/companion-endpoint";
import { type CompanionCommand, ompCommand, type Resolution } from "../src/main/companion-resolve";
import {
	backoffMs,
	type ChildHandle,
	CompanionSupervisor,
	type CompanionStatus,
	nextAttempt,
	STABLE_MS,
	type SupervisorDeps,
} from "../src/main/companion-supervisor";

type ExitInfo = { code: number | null; signal: string | null; error?: string };

class FakeChild implements ChildHandle {
	killed: string[] = [];
	released = false;
	#listener: ((info: ExitInfo) => void) | null = null;
	constructor(
		readonly pid: number,
		private readonly onKill?: (child: FakeChild, signal: string) => void,
	) {}
	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.killed.push(signal);
		this.onKill?.(this, signal);
	}
	onExit(listener: (info: ExitInfo) => void): void {
		this.#listener = listener;
	}
	release(): void {
		this.released = true;
	}
	exit(info: ExitInfo = { code: 1, signal: null }): void {
		this.#listener?.(info);
	}
}

/** A virtual world: a clock that `sleep` advances, the endpoint file the "companion" publishes, and the processes started. */
function world(options: { endpoint?: LocalEndpoint | null; resolution?: Resolution } = {}) {
	const state = {
		now: 0,
		endpoint: options.endpoint ?? null,
		children: [] as FakeChild[],
		spawned: [] as CompanionCommand[],
		logs: [] as string[],
		nextPid: 1000,
		/** What a newly spawned companion does: publish itself (default) or stay silent. */
		publish: true,
		spawnError: null as Error | null,
		/** Sleeps of a second or more (the attached-companion check, restart delays) wait here until the test ticks. */
		waiters: [] as (() => void)[],
		tick(): void {
			for (const wake of state.waiters.splice(0)) wake();
		},
	};
	const resolution: Resolution = options.resolution ?? { ok: true, command: ompCommand("/bin/omp") };
	const deps: SupervisorDeps = {
		resolve: async () => resolution,
		discover: async () => state.endpoint,
		spawn: command => {
			if (state.spawnError !== null) throw state.spawnError;
			state.spawned.push(command);
			const child = new FakeChild(state.nextPid++, (c, signal) => {
				if (signal === "SIGTERM") queueMicrotask(() => c.exit({ code: null, signal: "SIGTERM" }));
			});
			state.children.push(child);
			if (state.publish) state.endpoint = { pid: child.pid, port: 7467 + state.children.length - 1, app: true };
			const original = child.exit.bind(child);
			child.exit = info => {
				if (state.endpoint?.pid === child.pid) state.endpoint = null;
				original(info);
			};
			return child;
		},
		sleep: ms => {
			if (ms >= 1000) return new Promise<void>(resolve => state.waiters.push(resolve));
			state.now += ms;
			return Promise.resolve();
		},
		now: () => state.now,
		log: line => state.logs.push(line),
	};
	return { state, deps };
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("backoff", () => {
	it("doubles up to 30 seconds", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
	});

	it("starts over after a stable run", () => {
		expect(nextAttempt(0, 500)).toBe(1);
		expect(nextAttempt(3, 500)).toBe(4);
		expect(nextAttempt(5, STABLE_MS)).toBe(1);
	});
});

describe("CompanionSupervisor", () => {
	it("attaches to a running companion and starts nothing", async () => {
		const { state, deps } = world({ endpoint: { pid: 55, port: 7467, app: true } });
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 55, port: 7467, app: true } });
		expect(state.spawned).toEqual([]);
		await supervisor.stop({ keepRunning: false });
		expect(supervisor.status.kind).toBe("stopped");
	});

	it("refuses a running companion that serves no app, without starting a second", async () => {
		const { state, deps } = world({ endpoint: { pid: 55, port: 7467, app: false } });
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(supervisor.status.kind).toBe("unavailable");
		expect((supervisor.status as Extract<CompanionStatus, { kind: "unavailable" }>).reason).toBe("blocked");
		expect(state.spawned).toEqual([]);
	});

	it("starts one when none runs and waits for its address", async () => {
		const { state, deps } = world();
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(state.spawned.length).toBe(1);
		expect(supervisor.status).toMatchObject({ kind: "running", pid: 1000, endpoint: { pid: 1000, port: 7467 } });
	});

	it("says omp is missing instead of starting anything", async () => {
		const { state, deps } = world({ resolution: { ok: false, tried: ["/a/omp"] } });
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(supervisor.status).toMatchObject({ kind: "unavailable", reason: "no-omp", tried: ["/a/omp"] });
		expect(state.spawned).toEqual([]);
	});

	it("restarts a companion that crashes, with growing delays", async () => {
		const { state, deps } = world();
		const seen: CompanionStatus[] = [];
		const supervisor = new CompanionSupervisor(deps);
		supervisor.onStatus(status => seen.push(status));
		await supervisor.start();
		state.children[0]!.exit({ code: 1, signal: null });
		await settle();
		expect(supervisor.status).toMatchObject({ kind: "restarting", attempt: 1 });
		state.tick();
		await settle();
		expect(supervisor.status).toMatchObject({ kind: "running", pid: 1001 });
		state.children[1]!.exit({ code: 1, signal: null });
		await settle();
		state.tick();
		await settle();
		expect(supervisor.status).toMatchObject({ kind: "running", pid: 1002 });
		const delays = seen
			.filter(s => s.kind === "restarting")
			.map(s => (s as Extract<CompanionStatus, { kind: "restarting" }>).delayMs);
		expect(delays).toEqual([1000, 2000]);
	});

	it("starts the delays over once a companion has run for a while", async () => {
		const { state, deps } = world();
		const delays: number[] = [];
		const supervisor = new CompanionSupervisor(deps);
		supervisor.onStatus(status => {
			if (status.kind === "restarting") delays.push(status.delayMs);
		});
		await supervisor.start();
		state.children[0]!.exit();
		await settle();
		state.tick();
		await settle();
		state.now += STABLE_MS;
		state.children[1]!.exit();
		await settle();
		expect(delays).toEqual([1000, 1000]);
	});

	it("attaches instead of restarting when another companion took over", async () => {
		const { state, deps } = world();
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		state.children[0]!.exit();
		// A service came up while ours was down.
		state.endpoint = { pid: 77, port: 7480, app: true };
		await settle();
		state.tick();
		await settle();
		expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 77, port: 7480, app: true } });
		expect(state.spawned.length).toBe(1);
	});

	it("takes over when the companion it attached to goes away", async () => {
		const { state, deps } = world({ endpoint: { pid: 55, port: 7467, app: true } });
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		state.endpoint = null;
		state.tick();
		await settle();
		expect(supervisor.status.kind).toBe("running");
		expect(state.spawned.length).toBe(1);
		await supervisor.stop({ keepRunning: false });
	});

	it("treats a failed spawn like a crash", async () => {
		const { state, deps } = world();
		state.spawnError = new Error("ENOENT");
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(supervisor.status).toMatchObject({ kind: "restarting", attempt: 1, reason: "could not start: ENOENT" });
	});

	it("kills a companion that never publishes its address", async () => {
		const { state, deps } = world();
		state.publish = false;
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		expect(state.children[0]!.killed).toEqual(["SIGTERM"]);
		await settle();
		expect(supervisor.status.kind).toBe("restarting");
	});

	it("yields to a companion that came up first", async () => {
		const { state, deps } = world();
		state.publish = false;
		const supervisor = new CompanionSupervisor(deps);
		const starting = supervisor.start();
		await settle();
		state.endpoint = { pid: 99, port: 7490, app: true };
		await starting;
		expect(state.children[0]!.killed).toEqual(["SIGTERM"]);
		expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 99, port: 7490, app: true } });
	});

	it("stops the companion it started, and leaves one it attached to", async () => {
		const own = world();
		const supervisor = new CompanionSupervisor(own.deps);
		await supervisor.start();
		await supervisor.stop({ keepRunning: false });
		expect(own.state.children[0]!.killed).toContain("SIGTERM");
		expect(own.state.endpoint).toBeNull();
		expect(supervisor.status.kind).toBe("stopped");

		const attached = world({ endpoint: { pid: 55, port: 7467, app: true } });
		const other = new CompanionSupervisor(attached.deps);
		await other.start();
		await other.stop({ keepRunning: false });
		expect(attached.state.endpoint).toEqual({ pid: 55, port: 7467, app: true });
	});

	it("lets the companion outlive the app when asked to", async () => {
		const { state, deps } = world();
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		await supervisor.stop({ keepRunning: true });
		expect(state.children[0]!.killed).toEqual([]);
		expect(state.children[0]!.released).toBe(true);
	});

	it("does not restart a companion it stopped", async () => {
		const { state, deps } = world();
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		await supervisor.stop({ keepRunning: false });
		await settle();
		expect(state.spawned.length).toBe(1);
		expect(supervisor.status.kind).toBe("stopped");
	});

	it("restarts on request with a new process", async () => {
		const { state, deps } = world();
		const supervisor = new CompanionSupervisor(deps);
		await supervisor.start();
		await supervisor.restart();
		expect(state.spawned.length).toBe(2);
		expect(supervisor.status).toMatchObject({ kind: "running", pid: 1001 });
	});
});
