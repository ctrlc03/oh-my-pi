/**
 * Idle shutdown of the project-shared headless Chromium.
 *
 * The browser belongs to the daemon broker, so closing a tab (or this
 * process's last CDP connection) never ends it: it used to run until the last
 * omp client in the project exited, which can be weeks for a long-lived
 * session, keeping the Chrome process tree and its Dock icon alive. This
 * tracks, per shared browser scope, the moment no tab uses it any more and
 * closes it after a grace period, or at once on an explicit kill.
 *
 * The grace period lets a quick close-then-open reuse the running browser
 * instead of paying a relaunch; an open during it cancels the shutdown, and an
 * open during a shutdown that is already running waits for it, so it relaunches
 * rather than attach to a browser that is going away.
 *
 * Pure state machine: the clock, the shutdown, and the "still in use" probe are
 * injected, so the logic is testable without sleeping or a browser.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SharedTargetScope } from "./orphan-registry";

/**
 * Time the shared headless browser stays up after its last tab closed. Long
 * enough to span an agent's think-then-act gap (a model turn between closing
 * one page and opening the next is typically a few to a few tens of seconds),
 * so those cycles reuse the browser; short enough that an abandoned browser is
 * gone within a minute rather than lingering with the session.
 */
export const SHARED_BROWSER_IDLE_GRACE_MS = 45_000;

/**
 * Timer seam: runs `callback` after `ms` and returns the function that cancels it.
 * The default is the global `setTimeout`, unref'd so a pending shutdown never delays process exit.
 */
export type IdleTimer = (callback: () => void, ms: number) => () => void;

const globalTimer: IdleTimer = (callback, ms) => {
	const timer = setTimeout(callback, ms);
	timer.unref();
	return () => clearTimeout(timer);
};

export interface SharedBrowserIdleOptions {
	/** Grace before an idle browser closes. Default {@link SHARED_BROWSER_IDLE_GRACE_MS}. */
	graceMs?: number;
	timer?: IdleTimer;
	/**
	 * True while anything still uses the browser (a live in-process handle, or
	 * another omp process's tabs). Consulted right before closing; a busy
	 * browser is left running, since whoever uses it runs its own idle shutdown.
	 */
	inUse(scope: SharedTargetScope): boolean | Promise<boolean>;
	/** Close the browser and clear its registries. Never needs to throw; a rejection is logged. */
	shutdown(scope: SharedTargetScope): Promise<unknown>;
}

function scopeKey(scope: SharedTargetScope): string {
	return `${scope.projectDir}\u0000${scope.daemonName}`;
}

export class SharedBrowserIdleShutdown {
	readonly #graceMs: number;
	readonly #timer: IdleTimer;
	readonly #inUse: SharedBrowserIdleOptions["inUse"];
	readonly #shutdown: SharedBrowserIdleOptions["shutdown"];
	/** Cancel function of each running grace period. */
	readonly #pending = new Map<string, () => void>();
	readonly #closing = new Map<string, Promise<void>>();
	readonly #openers = new Map<string, number>();

	constructor(options: SharedBrowserIdleOptions) {
		this.#graceMs = options.graceMs ?? SHARED_BROWSER_IDLE_GRACE_MS;
		this.#timer = options.timer ?? globalTimer;
		this.#inUse = options.inUse;
		this.#shutdown = options.shutdown;
	}

	/** True while a grace period is running for `scope`. */
	isScheduled(scope: SharedTargetScope): boolean {
		return this.#pending.has(scopeKey(scope));
	}

	/**
	 * The last tab on the browser closed: close it once the grace period passes
	 * unless something opens first. Restarts the period when already running.
	 */
	scheduleShutdown(scope: SharedTargetScope): void {
		const key = scopeKey(scope);
		this.#cancel(key);
		const cancel = this.#timer(() => {
			this.#pending.delete(key);
			void this.#run(scope, key);
		}, this.#graceMs);
		this.#pending.set(key, cancel);
	}

	/** Close the browser now (an explicit kill), skipping the grace period. Resolves once it is gone. */
	shutdownNow(scope: SharedTargetScope): Promise<void> {
		const key = scopeKey(scope);
		this.#cancel(key);
		return this.#run(scope, key);
	}

	/**
	 * An open is about to attach to the browser: cancel a pending shutdown and
	 * wait out one already running, so the caller attaches to a browser that
	 * will stay up (or launches a fresh one). Until the returned release is
	 * called the browser counts as in use, covering the gap before the open's
	 * handle is published. The release is idempotent.
	 */
	async beginOpen(scope: SharedTargetScope): Promise<() => void> {
		const key = scopeKey(scope);
		this.#cancel(key);
		// Count first: a shutdown that is past its in-use probe cannot be stopped,
		// but one still probing must see this open.
		this.#openers.set(key, (this.#openers.get(key) ?? 0) + 1);
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			const left = (this.#openers.get(key) ?? 1) - 1;
			if (left > 0) this.#openers.set(key, left);
			else this.#openers.delete(key);
		};
		try {
			await this.#closing.get(key);
		} catch (error) {
			release();
			throw error;
		}
		return release;
	}

	#cancel(key: string): void {
		const cancel = this.#pending.get(key);
		if (!cancel) return;
		cancel();
		this.#pending.delete(key);
	}

	/** One shutdown round; concurrent callers share it, and it is registered synchronously so opens can wait on it. */
	#run(scope: SharedTargetScope, key: string): Promise<void> {
		const inFlight = this.#closing.get(key);
		if (inFlight) return inFlight;
		const run = this.#close(scope, key).finally(() => {
			if (this.#closing.get(key) === run) this.#closing.delete(key);
		});
		this.#closing.set(key, run);
		return run;
	}

	async #close(scope: SharedTargetScope, key: string): Promise<void> {
		try {
			if ((this.#openers.get(key) ?? 0) > 0 || (await this.#inUse(scope))) return;
			// An open that began while the probe ran counts as in use too.
			if ((this.#openers.get(key) ?? 0) > 0) return;
			await this.#shutdown(scope);
		} catch (error) {
			logger.warn("Shared headless browser idle shutdown failed", {
				daemon: scope.daemonName,
				projectDir: scope.projectDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
