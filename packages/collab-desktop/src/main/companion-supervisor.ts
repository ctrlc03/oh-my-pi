/**
 * Keeps one companion running on this computer: uses the one that is already there, starts one when none is, and
 * restarts the one it started when it crashes (backing off, so a companion that cannot start does not spin).
 * Process, clock and file system are injected; `companion-supervisor.test.ts` drives it with fakes.
 *
 * Two companions must never run at once: they fight over the room (relay close 4009). So the supervisor looks for a
 * running one before every start, and an attached companion that goes away (a service stopped, or migrated into the
 * app) is replaced by one of its own.
 */
import type { LocalEndpoint } from "./companion-endpoint";
import { planCompanion } from "./companion-endpoint";
import type { CompanionCommand, Resolution } from "./companion-resolve";

/** The companion's state as the menu and the window show it. */
export type CompanionStatus =
	| { kind: "stopped" }
	| { kind: "starting" }
	/** Someone else's companion (a service, a terminal) is serving; the app uses it and does not stop it. */
	| { kind: "attached"; endpoint: LocalEndpoint }
	/** The companion this app started. */
	| { kind: "running"; endpoint: LocalEndpoint; pid: number; command: CompanionCommand }
	| { kind: "restarting"; attempt: number; delayMs: number; reason: string }
	/** Nothing can serve the app: `omp` is missing, or a companion without the app holds the room. */
	| { kind: "unavailable"; reason: "no-omp" | "blocked"; message: string; tried: string[] };

export interface ChildHandle {
	pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	/** Called once, when the process is gone. `error` is set when it never started. */
	onExit(listener: (info: { code: number | null; signal: string | null; error?: string }) => void): void;
	/** Let the process outlive the app. */
	release(): void;
}

export interface SupervisorDeps {
	resolve(): Promise<Resolution>;
	discover(): Promise<LocalEndpoint | null>;
	spawn(command: CompanionCommand): ChildHandle;
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

export const ENDPOINT_POLL_MS = 250;
/** How long a new companion has to publish its port. */
export const ENDPOINT_WAIT_MS = 60_000;
/** How often an attached companion is checked to still be there. */
export const WATCH_MS = 4_000;
/** A companion that ran this long before it died starts the backoff over. */
export const STABLE_MS = 60_000;
export const KILL_GRACE_MS = 6_000;

/** Delay before restart number `attempt` (1-based): 1 s, 2 s, 4 s … at most 30 s. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/** The attempt number after a companion that ran `uptimeMs` died, given the previous attempt (0: it was the first start). */
export function nextAttempt(previous: number, uptimeMs: number): number {
	return uptimeMs >= STABLE_MS ? 1 : previous + 1;
}

export class CompanionSupervisor {
	readonly #deps: SupervisorDeps;
	#status: CompanionStatus = { kind: "stopped" };
	readonly #listeners = new Set<(status: CompanionStatus) => void>();
	/** Bumped by every start and stop: work belonging to an older one ends quietly. */
	#generation = 0;
	#child: ChildHandle | null = null;
	#exited: Promise<void> | null = null;
	#attempt = 0;

	constructor(deps: SupervisorDeps) {
		this.#deps = deps;
	}

	get status(): CompanionStatus {
		return this.#status;
	}

	onStatus(listener: (status: CompanionStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#set(status: CompanionStatus): void {
		this.#status = status;
		for (const listener of this.#listeners) listener(status);
	}

	/** Attach to a running companion or start one. Resolves once the outcome is known (serving, or unavailable). */
	async start(): Promise<void> {
		const generation = ++this.#generation;
		this.#attempt = 0;
		await this.#boot(generation);
	}

	async #boot(generation: number): Promise<void> {
		if (generation !== this.#generation) return;
		this.#set({ kind: "starting" });
		const plan = planCompanion(await this.#deps.discover());
		if (generation !== this.#generation) return;
		if (plan.action === "attach") {
			this.#deps.log(`attached to the companion on port ${plan.endpoint.port} (pid ${plan.endpoint.pid})`);
			this.#set({ kind: "attached", endpoint: plan.endpoint });
			void this.#watch(generation, plan.endpoint);
			return;
		}
		if (plan.action === "blocked") {
			this.#set({ kind: "unavailable", reason: "blocked", message: plan.reason, tried: [] });
			return;
		}
		const resolution = await this.#deps.resolve();
		if (generation !== this.#generation) return;
		if (!resolution.ok) {
			this.#set({
				kind: "unavailable",
				reason: "no-omp",
				message: "omp is not installed on this computer, so there is no companion to run.",
				tried: resolution.tried,
			});
			return;
		}
		await this.#spawn(generation, resolution.command);
	}

	/** An attached companion that disappears is replaced: boot again, which attaches to a newer one or starts ours. */
	async #watch(generation: number, endpoint: LocalEndpoint): Promise<void> {
		while (generation === this.#generation) {
			await this.#deps.sleep(WATCH_MS);
			if (generation !== this.#generation) return;
			const found = await this.#deps.discover();
			if (generation !== this.#generation) return;
			if (found === null || found.pid !== endpoint.pid || found.port !== endpoint.port) {
				this.#deps.log("the companion this app was using is gone");
				await this.#boot(generation);
				return;
			}
		}
	}

	async #spawn(generation: number, command: CompanionCommand): Promise<void> {
		this.#deps.log(`starting the companion: ${command.argv.join(" ")}`);
		const startedAt = this.#deps.now();
		let child: ChildHandle;
		try {
			child = this.#deps.spawn(command);
		} catch (err) {
			this.#restart(generation, startedAt, `could not start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#child = child;
		const gone = { exited: false };
		const exited = Promise.withResolvers<void>();
		this.#exited = exited.promise;
		child.onExit(info => {
			gone.exited = true;
			if (this.#child === child) this.#child = null;
			exited.resolve();
			if (generation !== this.#generation) return;
			const how =
				info.error ?? (info.signal !== null ? `killed by ${info.signal}` : `exited with code ${info.code}`);
			this.#restart(generation, startedAt, how);
		});
		const deadline = startedAt + ENDPOINT_WAIT_MS;
		while (generation === this.#generation && !gone.exited) {
			const found = await this.#deps.discover();
			if (generation !== this.#generation || gone.exited) return;
			if (found !== null && found.app) {
				if (found.pid === child.pid && child.pid !== undefined) {
					this.#set({ kind: "running", endpoint: found, pid: child.pid, command });
					return;
				}
				// Another companion won the race: stop ours and use it.
				this.#deps.log(`another companion (pid ${found.pid}) came up first; using it`);
				this.#generation++;
				child.kill("SIGTERM");
				await this.#exited;
				const next = this.#generation;
				await this.#boot(next);
				return;
			}
			if (this.#deps.now() >= deadline) {
				this.#deps.log("the companion did not publish its address in time");
				child.kill("SIGTERM");
				return;
			}
			await this.#deps.sleep(ENDPOINT_POLL_MS);
		}
	}

	#restart(generation: number, startedAt: number, reason: string): void {
		if (generation !== this.#generation) return;
		this.#attempt = nextAttempt(this.#attempt, this.#deps.now() - startedAt);
		const delayMs = backoffMs(this.#attempt);
		this.#deps.log(`the companion stopped (${reason}); restarting in ${delayMs / 1000} s`);
		this.#set({ kind: "restarting", attempt: this.#attempt, delayMs, reason });
		void this.#deps.sleep(delayMs).then(() => this.#boot(generation));
	}

	/** Stop supervising. The companion this app started is stopped too, unless `keepRunning`. Resolves when it is gone. */
	async stop(options: { keepRunning: boolean }): Promise<void> {
		this.#generation++;
		const child = this.#child;
		const exited = this.#exited;
		this.#child = null;
		this.#exited = null;
		if (child !== null && exited !== null) {
			if (options.keepRunning) {
				child.release();
			} else {
				child.kill("SIGTERM");
				const forced = this.#deps.sleep(KILL_GRACE_MS).then(() => child.kill("SIGKILL"));
				await Promise.race([exited, forced]);
				await exited;
			}
		}
		this.#set({ kind: "stopped" });
	}

	/** Stop the companion this app started (not an attached one) and start again. */
	async restart(): Promise<void> {
		await this.stop({ keepRunning: false });
		await this.start();
	}
}
