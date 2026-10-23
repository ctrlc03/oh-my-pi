/**
 * Starting a session in a fresh VM (docs/collab.md → Virtual machines): the app asks a computer to clone a template
 * VM, pairs with the clone, starts the session on it and opens it. Only the app sees both computers, so it
 * orchestrates; the host deletes the VM when the session ends. The decisions live here, apart from React, so they can
 * be tested: which templates are offered, what the start waits for, and which computers are forgotten once their VM is gone.
 */

import { VM_MAX_FRESH, type VmEntry } from "@oh-my-pi/pi-wire/vm";
import type { CompanionPhase } from "./companion";
import type { FreshComputer } from "./computers";

/** How often the start reads the host's VM list and the new computer. */
export const FRESH_POLL_MS = 2_000;
/** A clone that has not finished by now is given up on. */
export const FRESH_CLONE_TIMEOUT_MS = 10 * 60_000;
/** The host lists a clone it accepted at once; one it never lists was not started. */
export const FRESH_APPEAR_MS = 20_000;
/** A cloned VM's companion is up when the clone finishes; it may take a moment to reach the relay. */
export const FRESH_CONNECT_TIMEOUT_MS = 90_000;
/** Deleting a half-made clone is retried (the host refuses while its clone job still runs) for this long. */
export const FRESH_CLEANUP_MS = 10 * 60_000;
/** The app asks the hosts of the fresh VMs it paired whether they still exist this often. */
export const FRESH_FORGET_POLL_MS = 60_000;

/** Templates a fresh VM can be cloned from now: provisioned, stopped, not mid-job, with a known home to find the repositories in. */
export function usableTemplates(vms: readonly VmEntry[]): VmEntry[] {
	return vms.filter(
		vm =>
			vm.template === true &&
			vm.status === "stopped" &&
			vm.busy === undefined &&
			vm.home !== undefined &&
			vm.repos.length > 0,
	);
}

/** Why no further fresh VM can be made on the host, or null while there is room. */
export function freshLimitReason(vms: readonly VmEntry[], hostName: string): string | null {
	const count = vms.filter(vm => vm.fresh !== undefined).length;
	if (count < VM_MAX_FRESH) return null;
	return `${hostName} already runs ${VM_MAX_FRESH} fresh VMs, the most it allows. Start again when one of those sessions ends.`;
}

/** Where a template's repository is in every VM cloned from it. */
export function freshFolder(home: string, repo: string): string {
	return `${home}/src/${repo}`;
}

export type FreshStage = "cloning" | "connecting" | "starting";

/** What a fresh start is waiting for. */
export interface FreshRun {
	stage: FreshStage;
	/** When the current stage began (ms). */
	stageAt: number;
	/** The host listed the clone at least once: from then on its absence means it was removed. */
	seen: boolean;
}

export interface FreshObservation {
	now: number;
	/** The clone in the host's VM list; undefined: not listed; null: the list could not be read this time. */
	vm: VmEntry | undefined | null;
	/** The new computer's connection; null before it is paired. */
	phase: CompanionPhase | null;
}

export type FreshAction =
	| { kind: "wait"; message: string }
	/** Pair with the VM's companion through `url`. */
	| { kind: "pair"; url: string }
	/** The VM's companion is connected: start the session on it. */
	| { kind: "start" }
	| { kind: "fail"; message: string };

/** The next thing a fresh start does, and where it stands afterwards. Pure: the caller carries out the action. */
export function freshStep(run: FreshRun, obs: FreshObservation): { run: FreshRun; action: FreshAction } {
	const { vm, now } = obs;
	const seen = run.seen || (vm !== undefined && vm !== null);
	const current: FreshRun = { ...run, seen };
	const waited = now - run.stageAt;
	if (run.stage === "cloning") {
		if (waited > FRESH_CLONE_TIMEOUT_MS) {
			return { run: current, action: { kind: "fail", message: "Cloning the VM took too long." } };
		}
		if (vm?.busy !== undefined) return { run: current, action: { kind: "wait", message: vm.busy.message } };
		if (vm === null) return { run: current, action: { kind: "wait", message: "Cloning the VM…" } };
		if (vm === undefined) {
			if (seen)
				return { run: current, action: { kind: "fail", message: "The VM was removed before it was ready." } };
			if (waited > FRESH_APPEAR_MS) {
				return { run: current, action: { kind: "fail", message: "The computer did not start cloning the VM." } };
			}
			return { run: current, action: { kind: "wait", message: "Cloning the VM…" } };
		}
		if (vm.error !== undefined) return { run: current, action: { kind: "fail", message: vm.error } };
		if (vm.pairUrl === undefined) {
			return { run: current, action: { kind: "fail", message: "The VM was cloned but gave no pairing link." } };
		}
		return { run: { stage: "connecting", stageAt: now, seen }, action: { kind: "pair", url: vm.pairUrl } };
	}
	if (run.stage === "connecting") {
		if (obs.phase === "live") return { run: { stage: "starting", stageAt: now, seen }, action: { kind: "start" } };
		if (obs.phase === "unpaired") {
			return { run: current, action: { kind: "fail", message: "The new VM did not accept this device." } };
		}
		if (vm === undefined && seen) {
			return { run: current, action: { kind: "fail", message: "The VM was removed before it connected." } };
		}
		if (waited > FRESH_CONNECT_TIMEOUT_MS) {
			return {
				run: current,
				action: {
					kind: "fail",
					message: `The new VM did not connect within ${FRESH_CONNECT_TIMEOUT_MS / 1000} seconds.`,
				},
			};
		}
		return { run: current, action: { kind: "wait", message: "Connecting to the new VM…" } };
	}
	return { run: current, action: { kind: "wait", message: "Starting the session…" } };
}

export interface FreshStartDeps {
	vmClone(template: string, name: string): Promise<void>;
	vmList(): Promise<readonly VmEntry[]>;
	/** Ask the host to delete the VM; rejects while it refuses (a job still runs on it). */
	vmDelete(name: string): Promise<void>;
	/** Pair with the VM's companion; the new computer's id, null when the link cannot be used. */
	pair(url: string, fresh: FreshComputer): string | null;
	phaseOf(computerId: string): CompanionPhase | null;
	/** Start the session on the new computer; its instance id. */
	startSession(computerId: string): Promise<string>;
	/** Take the computer off this device. */
	forget(computerId: string): Promise<void>;
	now(): number;
	/** Resolves after `ms`, or at once when `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A pause that ends early when `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal?.aborted) return resolve();
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

export interface FreshProgress {
	stage: FreshStage;
	message: string;
}

export type FreshStartResult =
	| { ok: true; computerId: string; instanceId: string }
	| {
			ok: false;
			cancelled: boolean;
			message: string;
			/** The half-made VM's deletion: resolves with why it failed, or undefined once the host accepted it. */
			cleanup: Promise<string | undefined>;
	  };

class FreshFailure extends Error {}

/**
 * Clone `template` as `name` on the host, pair with the clone, wait for it to connect and start the session on it.
 * A failure or `signal` aborting ends it and asks the host to delete what was made (and drops the paired computer);
 * the result's `cleanup` is that request, which keeps retrying while the host refuses.
 */
export async function runFreshStart(
	deps: FreshStartDeps,
	params: { template: string; name: string; hostComputerId: string },
	signal: AbortSignal,
	onProgress: (progress: FreshProgress) => void,
): Promise<FreshStartResult> {
	const { template, name, hostComputerId } = params;
	let computerId: string | null = null;
	const cleanup = async (): Promise<string | undefined> => {
		if (computerId !== null) await deps.forget(computerId).catch(() => {});
		const deadline = deps.now() + FRESH_CLEANUP_MS;
		for (;;) {
			try {
				await deps.vmDelete(name);
				return undefined;
			} catch (err) {
				if (deps.now() > deadline) {
					return `${name} could not be deleted: ${err instanceof Error ? err.message : String(err)}. It is removed when it expires.`;
				}
				await deps.sleep(FRESH_POLL_MS);
			}
		}
	};
	onProgress({ stage: "cloning", message: "Cloning the VM…" });
	try {
		await deps.vmClone(template, name);
	} catch (err) {
		return {
			ok: false,
			cancelled: false,
			message: err instanceof Error ? err.message : String(err),
			cleanup: Promise.resolve(undefined),
		};
	}
	try {
		let run: FreshRun = { stage: "cloning", stageAt: deps.now(), seen: false };
		while (!signal.aborted) {
			let vm: VmEntry | undefined | null;
			try {
				vm = (await deps.vmList()).find(entry => entry.name === name);
			} catch {
				vm = null;
			}
			const phase = computerId === null ? null : deps.phaseOf(computerId);
			const step = freshStep(run, { now: deps.now(), vm, phase });
			run = step.run;
			const { action } = step;
			if (action.kind === "fail") throw new FreshFailure(action.message);
			if (action.kind === "pair") {
				computerId = deps.pair(action.url, { hostComputerId, name });
				if (computerId === null) throw new FreshFailure("The VM gave a pairing link this app cannot use.");
				onProgress({ stage: "connecting", message: "Connecting to the new VM…" });
				continue;
			}
			if (action.kind === "start") {
				const paired = computerId;
				if (paired === null) throw new FreshFailure("The VM was not paired.");
				onProgress({ stage: "starting", message: "Starting the session…" });
				return { ok: true, computerId: paired, instanceId: await deps.startSession(paired) };
			}
			onProgress({ stage: run.stage, message: action.message });
			await deps.sleep(FRESH_POLL_MS, signal);
		}
		return { ok: false, cancelled: true, message: "Cancelled.", cleanup: cleanup() };
	} catch (err) {
		return {
			ok: false,
			cancelled: false,
			message: err instanceof Error ? err.message : String(err),
			cleanup: cleanup(),
		};
	}
}

/**
 * The fresh-VM computers to forget: not connected, and their host's VM list (read successfully, `lists` by host
 * computer id) no longer holds the VM. A connected one is alive whatever the list says; a host that could not be asked
 * leaves its fresh computers alone.
 */
export function forgettableComputers(
	computers: readonly { id: string; fresh?: FreshComputer; snap: { phase: CompanionPhase } }[],
	lists: ReadonlyMap<string, readonly { name: string }[]>,
): string[] {
	const gone: string[] = [];
	for (const computer of computers) {
		const { fresh } = computer;
		if (fresh === undefined || computer.snap.phase === "live") continue;
		const listed = lists.get(fresh.hostComputerId);
		if (listed !== undefined && !listed.some(vm => vm.name === fresh.name)) gone.push(computer.id);
	}
	return gone;
}
