import { describe, expect, it } from "bun:test";
import type { LocalEndpoint } from "../src/main/companion-endpoint";
import { type CompanionCommand, ompCommand, type Resolution } from "../src/main/companion-resolve";
import {
	backoffMs,
	type ChildHandle,
	CompanionSupervisor,
	type CompanionStatus,
	LOCK_WAIT_MS,
	nextAttempt,
	SERVICE_ASK_MS,
	SERVICE_FAILURES_MAX,
	type ServiceStart,
	STABLE_MS,
	type SupervisorDeps,
	waitMs,
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
		/** The companion is installed as a service. */
		service: false,
		/** A companion holds the single-instance lock. */
		lock: null as { pid: number } | null,
		/** When (virtual clock) the service manager was asked to start the service. */
		serviceAsks: [] as number[],
		/** What the service manager answers. */
		serviceAnswer: { ok: true } as ServiceStart,
		/** Sleeps of a second or more (the attached-companion check, restart delays) wait here until the test ticks. */
		waiters: [] as (() => void)[],
		tick(): void {
			for (const wake of state.waiters.splice(0)) wake();
		},
		/** Let `ms` of virtual time pass, then wake every sleeper. */
		elapse(ms: number): void {
			state.now += ms;
			state.tick();
		},
	};
	const resolution: Resolution = options.resolution ?? { ok: true, command: ompCommand("/bin/omp") };
	const deps: SupervisorDeps = {
		resolve: async () => resolution,
		discover: async () => state.endpoint,
		serviceInstalled: () => state.service,
		liveLock: async () => state.lock,
		startService: async () => {
			state.serviceAsks.push(state.now);
			return state.serviceAnswer;
		},
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

/** Let `ms` of virtual time pass a second at a time, waking the supervisor's pauses as they would be. */
const pass = async (state: ReturnType<typeof world>["state"], ms: number): Promise<void> => {
	for (let left = ms; left > 0; left -= 1000) {
		state.elapse(Math.min(left, 1000));
		await settle();
	}
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

describe("waiting for a companion that is on its way", () => {
	it("checks after 1 s, 2 s, 4 s, then every 5 s", () => {
		expect([0, 1, 2, 3, 4, 10].map(waitMs)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
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

	describe("with the companion installed as a service", () => {
		it("asks the service to start, never spawns, and attaches when the endpoint appears", async () => {
			const { state, deps } = world();
			state.service = true;
			const supervisor = new CompanionSupervisor(deps);
			const starting = supervisor.start();
			await settle();
			expect(state.serviceAsks).toEqual([0]);
			expect(supervisor.status).toMatchObject({ kind: "waiting", cause: "service", pid: null, note: null });
			await pass(state, 3000);
			state.endpoint = { pid: 4242, port: 7468, app: true };
			await pass(state, 5000);
			await starting;
			expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 4242, port: 7468, app: true } });
			expect(state.spawned).toEqual([]);
			await supervisor.stop({ keepRunning: false });
		});

		it("asks again when the companion it was attached to goes away, and attaches to the one that comes back", async () => {
			const { state, deps } = world({ endpoint: { pid: 55, port: 7468, app: true } });
			state.service = true;
			const supervisor = new CompanionSupervisor(deps);
			await supervisor.start();
			expect(state.serviceAsks).toEqual([]);
			state.endpoint = null;
			await pass(state, 4000);
			expect(supervisor.status).toMatchObject({ kind: "waiting", cause: "service" });
			expect(state.serviceAsks.length).toBe(1);
			state.endpoint = { pid: 56, port: 7468, app: true };
			await pass(state, 5000);
			expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 56, port: 7468, app: true } });
			expect(state.spawned).toEqual([]);
			await supervisor.stop({ keepRunning: false });
		});

		it("asks again at most every 30 s while the companion does not come, and says why", async () => {
			const { state, deps } = world();
			state.service = true;
			state.serviceAnswer = { ok: false, message: "Could not find service" };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, 5 * SERVICE_ASK_MS + 1000);
			const gaps = state.serviceAsks.slice(1).map((at, i) => at - state.serviceAsks[i]!);
			expect(state.serviceAsks.length).toBeGreaterThanOrEqual(5);
			expect(gaps.every(gap => gap >= SERVICE_ASK_MS)).toBe(true);
			expect(supervisor.status).toMatchObject({ kind: "unavailable", reason: "service" });
			expect(state.spawned).toEqual([]);
			await supervisor.stop({ keepRunning: false });
		});

		it("waits for a companion holding the lock without asking the service", async () => {
			const { state, deps } = world();
			state.service = true;
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, 40_000);
			expect(supervisor.status).toMatchObject({ kind: "waiting", cause: "lock", pid: 900 });
			expect(state.serviceAsks).toEqual([]);
			expect(state.spawned).toEqual([]);
			state.endpoint = { pid: 900, port: 7468, app: true };
			state.lock = null;
			await pass(state, 5000);
			expect(supervisor.status.kind).toBe("attached");
			await supervisor.stop({ keepRunning: false });
		});

		it("asks the service once the lock holder is gone and nothing serves", async () => {
			const { state, deps } = world();
			state.service = true;
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, 3000);
			expect(state.serviceAsks).toEqual([]);
			state.lock = null;
			await pass(state, 3000);
			expect(state.serviceAsks.length).toBe(1);
			expect(state.spawned).toEqual([]);
			await supervisor.stop({ keepRunning: false });
		});

		it("reports a service that keeps failing to start, never spawns, and recovers when it comes up", async () => {
			const { state, deps } = world();
			state.service = true;
			state.serviceAnswer = { ok: false, message: "Bootstrap failed: 5: Input/output error" };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, (SERVICE_FAILURES_MAX - 1) * SERVICE_ASK_MS + 5000);
			expect(state.serviceAsks.length).toBe(SERVICE_FAILURES_MAX);
			expect(supervisor.status).toMatchObject({ kind: "unavailable", reason: "service" });
			expect((supervisor.status as Extract<CompanionStatus, { kind: "unavailable" }>).message).toContain(
				"Bootstrap failed: 5",
			);
			await pass(state, 2 * SERVICE_ASK_MS);
			expect(state.spawned).toEqual([]);
			expect(state.serviceAsks.length).toBeGreaterThan(SERVICE_FAILURES_MAX);
			state.serviceAnswer = { ok: true };
			await pass(state, SERVICE_ASK_MS);
			expect(supervisor.status.kind).toBe("waiting");
			state.endpoint = { pid: 4242, port: 7468, app: true };
			await pass(state, 5000);
			expect(supervisor.status.kind).toBe("attached");
			await supervisor.stop({ keepRunning: false });
		});

		it("does not report a service that fails less than the limit in a row", async () => {
			const { state, deps } = world();
			state.service = true;
			state.serviceAnswer = { ok: false, message: "busy" };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, (SERVICE_FAILURES_MAX - 2) * SERVICE_ASK_MS + 5000);
			expect(supervisor.status.kind).toBe("waiting");
			await supervisor.stop({ keepRunning: false });
		});

		it("runs its own companion once the service is migrated away", async () => {
			const { state, deps } = world();
			state.service = true;
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			expect(state.spawned).toEqual([]);
			state.service = false;
			await pass(state, 5000);
			expect(state.spawned.length).toBe(1);
			expect(supervisor.status.kind).toBe("running");
			await supervisor.stop({ keepRunning: false });
		});
	});

	describe("a lock holder that publishes no endpoint", () => {
		it("is reported by pid after the wait, still watched, and attached when its endpoint appears", async () => {
			const { state, deps } = world();
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, LOCK_WAIT_MS - 10_000);
			expect(supervisor.status.kind).toBe("waiting");
			await pass(state, 20_000);
			expect(supervisor.status).toMatchObject({ kind: "unavailable", reason: "blocked" });
			expect((supervisor.status as Extract<CompanionStatus, { kind: "unavailable" }>).message).toContain("900");
			expect(state.spawned).toEqual([]);
			expect(state.serviceAsks).toEqual([]);
			state.endpoint = { pid: 900, port: 7467, app: true };
			await pass(state, 5000);
			expect(supervisor.status.kind).toBe("attached");
			await supervisor.stop({ keepRunning: false });
		});

		it("starts the wait over for a different holder", async () => {
			const { state, deps } = world();
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			await pass(state, LOCK_WAIT_MS - 10_000);
			state.lock = { pid: 901 };
			await pass(state, 20_000);
			expect(supervisor.status).toMatchObject({ kind: "waiting", cause: "lock", pid: 901 });
			await supervisor.stop({ keepRunning: false });
		});
	});

	describe("without a service", () => {
		it("starts its own companion when there is no lock and no endpoint", async () => {
			const { state, deps } = world();
			const supervisor = new CompanionSupervisor(deps);
			await supervisor.start();
			expect(state.spawned.length).toBe(1);
			expect(state.serviceAsks).toEqual([]);
			expect(supervisor.status.kind).toBe("running");
		});

		it("waits instead of spawning while a companion holds the lock, then attaches", async () => {
			const { state, deps } = world();
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			expect(supervisor.status).toMatchObject({ kind: "waiting", cause: "lock", pid: 900 });
			state.elapse(1000);
			await settle();
			expect(state.spawned).toEqual([]);
			expect(state.serviceAsks).toEqual([]);
			state.endpoint = { pid: 900, port: 7467, app: true };
			state.elapse(2000);
			await settle();
			expect(supervisor.status).toEqual({ kind: "attached", endpoint: { pid: 900, port: 7467, app: true } });
			expect(state.spawned).toEqual([]);
			await supervisor.stop({ keepRunning: false });
		});

		it("spawns its own once the lock is released and nothing serves", async () => {
			const { state, deps } = world();
			state.lock = { pid: 900 };
			const supervisor = new CompanionSupervisor(deps);
			void supervisor.start();
			await settle();
			state.lock = null;
			state.elapse(1000);
			await settle();
			expect(state.spawned.length).toBe(1);
			expect(supervisor.status.kind).toBe("running");
			await supervisor.stop({ keepRunning: false });
		});
	});
});
