/**
 * Regression tests for the project-shared headless Chromium that outlived its
 * tabs. The browser is owned by the daemon broker, so closing every tab (even
 * with `kill: true`) only dropped this process's CDP connection and the Chrome
 * process tree ran for as long as the session lived.
 *
 * Contract pinned here: when no tab uses the hidden shared browser it is closed
 * after a grace period, or at once on `kill`; a new open during the grace
 * period cancels the shutdown and one during a running shutdown waits for it;
 * the close goes over CDP first, falls back to the broker's process-tree stop,
 * and clears the target registry only once the daemon is confirmed ended;
 * headed and user-attached browsers are never touched.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { DaemonOperation } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { closeSharedBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import {
	SHARED_BROWSER_IDLE_GRACE_MS,
	SharedBrowserIdleShutdown,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-idle";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

const DAEMON_NAME = "omp.browser.headless";
const READY_MATCH = "DevTools listening on ws://127.0.0.1:63199/devtools/browser/idle";
/** A pid no process can hold: `isPidAlive` reads it as dead. */
const DEAD_PID = 2_147_483_646;

const scopes: SharedTargetScope[] = [];

/** Unique per-test scope, removed after the test even when an assertion fails. */
function trackedScope(): SharedTargetScope {
	const scope = {
		projectDir: path.join("/tmp", `omp-idle-test-${crypto.randomUUID()}`),
		daemonName: DAEMON_NAME,
	};
	scopes.push(scope);
	return scope;
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetOrphanRegistryForTest();
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

/** Let every continuation already queued on a promise run, without waiting on a clock. */
function eventLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Timer double: nothing fires until the test says so, and a cancelled timer never fires. */
function makeFakeTimer() {
	const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
	return {
		timers,
		timer: (callback: () => void, ms: number) => {
			const entry = { ms, callback, cancelled: false };
			timers.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		/** Fire every timer that is still live, as the clock reaching its deadline would. */
		fire: () => {
			for (const entry of timers) {
				if (!entry.cancelled) {
					entry.cancelled = true;
					entry.callback();
				}
			}
		},
	};
}

describe("SharedBrowserIdleShutdown", () => {
	function makeIdle(overrides: { inUse?: () => boolean; shutdown?: () => Promise<unknown> } = {}) {
		const clock = makeFakeTimer();
		const shutdowns: SharedTargetScope[] = [];
		const idle = new SharedBrowserIdleShutdown({
			graceMs: 1_000,
			timer: clock.timer,
			inUse: overrides.inUse ?? (() => false),
			shutdown: async scope => {
				shutdowns.push(scope);
				await overrides.shutdown?.();
			},
		});
		return { idle, clock, shutdowns };
	}
	const scope: SharedTargetScope = { projectDir: "/tmp/omp-idle-class", daemonName: DAEMON_NAME };

	it("closes the browser only once the grace period has run", async () => {
		const { idle, clock, shutdowns } = makeIdle();
		idle.scheduleShutdown(scope);
		expect(clock.timers.map(t => t.ms)).toEqual([1_000]);
		expect(idle.isScheduled(scope)).toBe(true);
		expect(shutdowns).toEqual([]);

		clock.fire();
		await eventLoopTurn();
		expect(shutdowns).toEqual([scope]);
		expect(idle.isScheduled(scope)).toBe(false);
	});

	it("keeps the browser when an open starts during the grace period", async () => {
		const { idle, clock, shutdowns } = makeIdle();
		idle.scheduleShutdown(scope);
		const endOpen = await idle.beginOpen(scope);

		expect(clock.timers[0]?.cancelled).toBe(true);
		expect(idle.isScheduled(scope)).toBe(false);
		clock.fire();
		endOpen();
		expect(shutdowns).toEqual([]);
	});

	it("restarts the grace period when another tab closes during it", () => {
		const { idle, clock } = makeIdle();
		idle.scheduleShutdown(scope);
		idle.scheduleShutdown(scope);
		expect(clock.timers.map(t => t.cancelled)).toEqual([true, false]);
	});

	it("closes at once on an explicit kill and drops the pending grace timer", async () => {
		const { idle, clock, shutdowns } = makeIdle();
		idle.scheduleShutdown(scope);
		await idle.shutdownNow(scope);

		expect(shutdowns).toEqual([scope]);
		expect(clock.timers[0]?.cancelled).toBe(true);
	});

	it("makes an open during a running shutdown wait for it, then proceed", async () => {
		const gate = Promise.withResolvers<void>();
		const log: string[] = [];
		const { idle } = makeIdle({
			shutdown: async () => {
				log.push("shutdown-start");
				await gate.promise;
				log.push("shutdown-end");
			},
		});
		const closing = idle.shutdownNow(scope);
		// Let the shutdown pass its in-use probe and start, then open while it runs.
		await eventLoopTurn();
		expect(log).toEqual(["shutdown-start"]);
		const opened = idle.beginOpen(scope).then(release => {
			log.push("open-attached");
			return release;
		});
		await eventLoopTurn();
		expect(log).toEqual(["shutdown-start"]);

		gate.resolve();
		await closing;
		(await opened)();
		expect(log).toEqual(["shutdown-start", "shutdown-end", "open-attached"]);
	});

	it("leaves a browser that is still in use or being opened", async () => {
		const busy = makeIdle({ inUse: () => true });
		await busy.idle.shutdownNow(scope);
		expect(busy.shutdowns).toEqual([]);

		const opening = makeIdle();
		const endOpen = await opening.idle.beginOpen(scope);
		await opening.idle.shutdownNow(scope);
		expect(opening.shutdowns).toEqual([]);
		endOpen();
		await opening.idle.shutdownNow(scope);
		expect(opening.shutdowns).toEqual([scope]);
	});

	it("absorbs a failed shutdown and still serves the next one", async () => {
		let failures = 1;
		const { idle, shutdowns } = makeIdle({
			shutdown: async () => {
				if (failures-- > 0) throw new Error("broker unreachable");
			},
		});
		await idle.shutdownNow(scope);
		await idle.shutdownNow(scope);
		expect(shutdowns).toEqual([scope, scope]);
	});
});

/** Shared headless handle as `openSharedHeadlessHandle` builds it, with a stub CDP connection. */
function makeSharedHandle(
	scope: SharedTargetScope,
	options: { refCount: number; headless?: boolean; kind?: "headless" | "connected" },
): { handle: BrowserHandle; disconnects: () => number } {
	let disconnected = 0;
	const kind =
		options.kind === "connected"
			? { kind: "connected", cdpUrl: "http://127.0.0.1:9222" }
			: { kind: "headless", headless: options.headless ?? true };
	const handle: Record<string, unknown> = {
		key: `idle-test:${crypto.randomUUID()}`,
		kind,
		refCount: options.refCount,
		stealth: { browserSession: null, override: null },
		browser: {
			connected: true,
			disconnect: () => {
				disconnected++;
			},
		},
	};
	if (options.kind !== "connected") handle.sharedDaemon = { name: scope.daemonName, projectDir: scope.projectDir };
	return { handle: handle as unknown as BrowserHandle, disconnects: () => disconnected };
}

describe("releaseBrowser — shared headless browser idle shutdown", () => {
	it("closes the browser after the grace period once the last handle is released", async () => {
		vi.useFakeTimers();
		const scope = trackedScope();
		const closed = Promise.withResolvers<SharedTargetScope>();
		const close = spyOn(sharedDaemon, "closeSharedBrowser").mockImplementation(async closing => {
			closed.resolve(closing);
			return true;
		});
		const { handle, disconnects } = makeSharedHandle(scope, { refCount: 2 });

		await releaseBrowser(handle, { kill: false });
		vi.advanceTimersByTime(SHARED_BROWSER_IDLE_GRACE_MS * 2);
		// Another tab still holds the handle: nothing is scheduled.
		expect(close).not.toHaveBeenCalled();

		await releaseBrowser(handle, { kill: false });
		expect(disconnects()).toBe(1);
		vi.advanceTimersByTime(SHARED_BROWSER_IDLE_GRACE_MS - 1);
		expect(close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(await closed.promise).toEqual(scope);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes the browser before returning when the last tab is released with kill", async () => {
		const scope = trackedScope();
		const close = spyOn(sharedDaemon, "closeSharedBrowser").mockResolvedValue(true);
		const { handle } = makeSharedHandle(scope, { refCount: 1 });

		await releaseBrowser(handle, { kill: true });

		expect(close).toHaveBeenCalledTimes(1);
		expect(close.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("leaves the browser while a tab is still owned in it", async () => {
		const scope = trackedScope();
		const close = spyOn(sharedDaemon, "closeSharedBrowser").mockResolvedValue(true);
		await recordSharedTarget(scope, "T1");
		const { handle } = makeSharedHandle(scope, { refCount: 1 });

		await releaseBrowser(handle, { kill: true });
		expect(close).not.toHaveBeenCalled();

		await forgetSharedTarget(scope, "T1");
		const next = makeSharedHandle(scope, { refCount: 1 });
		await releaseBrowser(next.handle, { kill: true });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("never closes a headed shared browser or a user-attached one", async () => {
		vi.useFakeTimers();
		const scope = trackedScope();
		const close = spyOn(sharedDaemon, "closeSharedBrowser").mockResolvedValue(true);
		const headed = makeSharedHandle(scope, { refCount: 1, headless: false });
		const attached = makeSharedHandle(scope, { refCount: 1, kind: "connected" });

		await releaseBrowser(headed.handle, { kill: true });
		await releaseBrowser(attached.handle, { kill: true });
		vi.advanceTimersByTime(SHARED_BROWSER_IDLE_GRACE_MS * 10);

		expect(close).not.toHaveBeenCalled();
		expect(attached.disconnects()).toBe(1);
	});
});

/**
 * Broker double with a live Chrome: it ends when `closeViaCdp` runs (unless
 * `ignoresCdp`) or when the broker is asked to stop it, and records stops.
 */
function makeLifecycleBroker(scope: SharedTargetScope, opts: { stopFails?: boolean } = {}) {
	let state: DaemonSnapshot["state"] = "ready";
	const stops: { name: string; id: string | undefined }[] = [];
	const snapshot = (): DaemonSnapshot => ({
		name: DAEMON_NAME,
		id: "daemon-idle",
		state,
		createdAt: 0,
		startedAt: 0,
		readyAt: 1,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		readyMatch: READY_MATCH,
	});
	const client = {
		projectDir: scope.projectDir,
		close: () => undefined,
		onCompletion: () => () => undefined,
		request: async (operation: DaemonOperation) => {
			if (operation.op === "describe") return { op: "describe", daemon: snapshot() };
			if (operation.op === "stop") {
				stops.push({ name: operation.name, id: operation.id });
				if (opts.stopFails === true) throw new Error("broker rejected the stop");
				state = "exited";
				return { op: "stop", daemon: snapshot() };
			}
			throw new Error(`unexpected broker op ${operation.op}`);
		},
	} as unknown as DaemonBrokerClient;
	return {
		client,
		stops,
		endDaemon: () => {
			state = "exited";
		},
	};
}

/** An ownership file of a process that died, as its crash left it. */
async function writeDeadOwnerRecord(scope: SharedTargetScope): Promise<string> {
	const dir = path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${DEAD_PID}.json`);
	await Bun.write(file, JSON.stringify({ pid: DEAD_PID, updatedAt: 0, targets: ["ORPHAN"] }));
	return file;
}

describe("closeSharedBrowser", () => {
	it("closes Chrome over CDP, never kills the tree, and clears the registries", async () => {
		const scope = trackedScope();
		const orphanFile = await writeDeadOwnerRecord(scope);
		const broker = makeLifecycleBroker(scope);
		const cdpClosed: string[] = [];

		const closed = await closeSharedBrowser(scope, {
			client: broker.client,
			closeViaCdp: async wsEndpoint => {
				cdpClosed.push(wsEndpoint);
				broker.endDaemon();
			},
		});

		expect(closed).toBe(true);
		expect(cdpClosed).toEqual(["ws://127.0.0.1:63199/devtools/browser/idle"]);
		expect(broker.stops).toEqual([]);
		expect(await Bun.file(orphanFile).exists()).toBe(false);
	});

	it("falls back to stopping the daemon generation it described when Chrome ignores the CDP close", async () => {
		const scope = trackedScope();
		const broker = makeLifecycleBroker(scope);

		const closed = await closeSharedBrowser(scope, {
			client: broker.client,
			closeViaCdp: async () => {
				throw new Error("Timed out closing the shared browser");
			},
			exitWaitMs: 0,
		});

		expect(closed).toBe(true);
		expect(broker.stops).toEqual([{ name: DAEMON_NAME, id: "daemon-idle" }]);
	});

	it("keeps the registry records when the daemon cannot be confirmed ended", async () => {
		const scope = trackedScope();
		const orphanFile = await writeDeadOwnerRecord(scope);
		const broker = makeLifecycleBroker(scope, { stopFails: true });

		const closed = await closeSharedBrowser(scope, {
			client: broker.client,
			closeViaCdp: async () => undefined,
			exitWaitMs: 0,
		});

		expect(closed).toBe(false);
		expect(await Bun.file(orphanFile).exists()).toBe(true);
	});

	it("leaves a browser that still has a live tab", async () => {
		const scope = trackedScope();
		const broker = makeLifecycleBroker(scope);
		await recordSharedTarget(scope, "LIVE-TAB");
		let cdpCalls = 0;

		const closed = await closeSharedBrowser(scope, {
			client: broker.client,
			closeViaCdp: async () => {
				cdpCalls++;
			},
		});

		expect(closed).toBe(false);
		expect(cdpCalls).toBe(0);
		expect(broker.stops).toEqual([]);
	});

	it("treats an already ended daemon as closed so the next open launches a fresh one", async () => {
		const scope = trackedScope();
		const broker = makeLifecycleBroker(scope);
		broker.endDaemon();
		let cdpCalls = 0;

		const closed = await closeSharedBrowser(scope, {
			client: broker.client,
			closeViaCdp: async () => {
				cdpCalls++;
			},
		});

		expect(closed).toBe(true);
		expect(cdpCalls).toBe(0);
		expect(broker.stops).toEqual([]);
	});
});
