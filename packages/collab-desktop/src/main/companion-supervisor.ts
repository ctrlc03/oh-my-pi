/**
 * Keeps one companion running on this computer: uses the one that is already there, starts one when none is, and
 * restarts the one it started when it crashes (backing off, so a companion that cannot start does not spin).
 * Process, clock and file system are injected; `companion-supervisor.test.ts` drives it with fakes.
 *
 * Two companions must never run at once: they fight over the room (relay close 4009). So the supervisor looks for a
 * running one before every start, and never starts one while another is there or on its way:
 *
 * - a live single-instance lock means a companion is starting or standing by: wait for its endpoint. A holder that
 *   publishes none within `LOCK_WAIT_MS` (no local relay, no web app) is reported as in the way, and still watched;
 * - an installed service (launchd, systemd) owns the companion: the app never spawns one. It asks the service manager
 *   to start the service and waits for the endpoint, asking again at most every `SERVICE_ASK_MS`. A service that
 *   fails `SERVICE_FAILURES_MAX` asks in a row is reported as unable to start, and still asked (never replaced by an
 *   app companion: it would fight the service the day that loads);
 * - otherwise the app runs the companion itself, and restarts it when it crashes.
 *
 * An attached companion that goes away is handled the same way (boot again).
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
	/**
	 * Someone else is about to serve and the app waits for them: the companion service it asked to start
	 * (`cause: "service"`; `note` says why the last request failed), or a companion holding the lock (`cause: "lock"`).
	 */
	| { kind: "waiting"; cause: "service" | "lock"; pid: number | null; note: string | null }
	/**
	 * Nothing can serve the app: `omp` is missing, a companion without the app holds the room or the lock, or the
	 * installed service will not start.
	 */
	| { kind: "unavailable"; reason: "no-omp" | "blocked" | "service"; message: string; tried: string[] };

export interface ChildHandle {
	pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	/** Called once, when the process is gone. `error` is set when it never started. */
	onExit(listener: (info: { code: number | null; signal: string | null; error?: string }) => void): void;
	/** Let the process outlive the app. */
	release(): void;
}

/** The outcome of asking the service manager to start the companion service. */
export type ServiceStart = { ok: true } | { ok: false; message: string };

export interface SupervisorDeps {
	resolve(): Promise<Resolution>;
	discover(): Promise<LocalEndpoint | null>;
	/** The companion is installed as a launchd or systemd service. Checked at every boot: migrating removes it. */
	serviceInstalled(): boolean;
	/** The pid of a companion holding the single-instance lock (starting or standing by), or null. */
	liveLock(): Promise<{ pid: number } | null>;
	/** Ask the service manager to start the companion service (not restart it); never rejects. */
	startService(): Promise<ServiceStart>;
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
/** The service is asked to start at most this often while its companion does not come up. */
export const SERVICE_ASK_MS = 30_000;
/** First pause between looks for a companion that is on its way, and the longest one. */
export const WAIT_FIRST_MS = 1_000;
export const WAIT_MAX_MS = 5_000;
/** Failed service starts in a row after which the service is reported as unable to start. */
export const SERVICE_FAILURES_MAX = 3;
/** How long a live lock may stay without an endpoint before its holder is reported as in the way. */
export const LOCK_WAIT_MS = 60_000;

/** Delay before restart number `attempt` (1-based): 1 s, 2 s, 4 s … at most 30 s. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/** The attempt number after a companion that ran `uptimeMs` died, given the previous attempt (0: it was the first start). */
export function nextAttempt(previous: number, uptimeMs: number): number {
	return uptimeMs >= STABLE_MS ? 1 : previous + 1;
}

/** Pause before look number `step` (0-based) for a companion that is on its way: 1 s, 2 s, 4 s, then 5 s. */
export function waitMs(step: number): number {
	return Math.min(WAIT_MAX_MS, WAIT_FIRST_MS * 2 ** step);
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
		if (await this.#someoneElseStarts(generation)) return;
		if (generation !== this.#generation) return;
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

	/**
	 * With a live lock or an installed service, a companion is there or on its way and the app must not start one:
	 * wait for it (asking the service to start when nobody holds the lock), then boot again. False when nothing
	 * stands in the way and the app may run its own.
	 */
	async #someoneElseStarts(generation: number): Promise<boolean> {
		const lock = await this.#deps.liveLock();
		if (generation !== this.#generation) return true;
		if (lock === null && !this.#deps.serviceInstalled()) return false;
		await this.#waitForCompanion(generation);
		return true;
	}

	async #waitForCompanion(generation: number): Promise<void> {
		let lastAsk = Number.NEGATIVE_INFINITY;
		let note: string | null = null;
		let failures = 0;
		let held = null as { pid: number; since: number } | null;
		for (let step = 0; ; step++) {
			const lock = await this.#deps.liveLock();
			if (generation !== this.#generation) return;
			const service = lock === null && this.#deps.serviceInstalled();
			if (lock === null && !service) break;
			held = lock === null ? null : held?.pid === lock.pid ? held : { pid: lock.pid, since: this.#deps.now() };
			if (service && this.#deps.now() - lastAsk >= SERVICE_ASK_MS) {
				lastAsk = this.#deps.now();
				this.#deps.log("no companion is running; asking the companion service to start");
				const started = await this.#deps.startService();
				if (generation !== this.#generation) return;
				note = started.ok ? null : started.message;
				failures = started.ok ? 0 : failures + 1;
				if (!started.ok) this.#deps.log(`the companion service did not start: ${started.message}`);
			}
			if (held !== null && this.#deps.now() - held.since >= LOCK_WAIT_MS) {
				this.#setUnavailable(
					"blocked",
					`A companion (process ${held.pid}) has been starting for over ${LOCK_WAIT_MS / 1000} s without publishing an address for the app. It may have been started without its local web app, or its local relay could not start. Stop it (process ${held.pid}) or restart it normally; the app connects as soon as it is ready.`,
				);
			} else if (service && failures >= SERVICE_FAILURES_MAX) {
				this.#setUnavailable(
					"service",
					`The companion service is installed but cannot be started${note === null ? "" : ` (${note})`}. Choose Run the Companion Inside This App to remove the service and let the app run the companion, or reinstall the service with omp companion --install. The app keeps trying meanwhile.`,
				);
			} else {
				this.#setWaiting(
					lock === null ? { cause: "service", pid: null, note } : { cause: "lock", pid: lock.pid, note: null },
				);
			}
			await this.#deps.sleep(waitMs(step));
			if (generation !== this.#generation) return;
			if ((await this.#deps.discover()) !== null) break;
			if (generation !== this.#generation) return;
		}
		await this.#boot(generation);
	}

	#setUnavailable(reason: "blocked" | "service", message: string): void {
		const current = this.#status;
		if (current.kind === "unavailable" && current.reason === reason && current.message === message) return;
		this.#set({ kind: "unavailable", reason, message, tried: [] });
	}

	#setWaiting(next: { cause: "service" | "lock"; pid: number | null; note: string | null }): void {
		const current = this.#status;
		if (
			current.kind === "waiting" &&
			current.cause === next.cause &&
			current.pid === next.pid &&
			current.note === next.note
		)
			return;
		this.#set({ kind: "waiting", ...next });
	}

	/** An attached companion that disappears is replaced: boot again, which attaches to a newer one, waits for the service or starts ours. */
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
