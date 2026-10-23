/**
 * The mock companion's virtual machines: a computer that can run VMs, with two canned VMs (`--vm-github missing` makes
 * `ready.ok` false, so the app shows the `omp vm github setup` hint). A create takes
 * a few seconds of progress lines, ends with a pairing link, and adds the VM to the list; start, stop, reset and delete
 * take a moment and change the VM's status. A template (`template: true`) is built the same way and stays stopped, unpaired.
 * With a `home`, a canned template `web-template` is listed, and a clone of a template (a fresh VM) takes a few progress
 * lines, ends with a pairing link, and is deleted when its `guest` exits or on a delete. Nothing here starts a process or
 * touches a disk (the mock companion's `guest` does). See ./companion-vm for the real thing, which runs `omp vm …`.
 */

import {
	isVmName,
	VM_DEFAULTS,
	VM_MAX_FRESH,
	type VmCreateOptions,
	type VmEntry,
	type VmJobAction,
	type VmReadiness,
	type VmReply,
	type VmRequest,
	vmCreateProblem,
} from "@oh-my-pi/pi-wire/vm";
import type { CompanionRequest } from "../src/lib/companion";

const STEP_MS = 900;
const ACTION_MS = 1_800;

const CREATE_STEPS: readonly { step: string; message: string }[] = [
	{ step: "image", message: "Downloading the Ubuntu image…" },
	{ step: "boot", message: "Booting the VM…" },
	{ step: "install", message: "Installing omp and the companion…" },
	{ step: "clone", message: "Cloning the repositories…" },
];

const CLONE_STEPS: readonly { step: string; message: string }[] = [
	{ step: "clone", message: "Copying the template's disk…" },
	{ step: "boot", message: "Booting the clone…" },
	{ step: "pair", message: "Pairing the clone…" },
];

/** A fresh VM is deleted this long after it was cloned, session or not (the CLI's own limit). */
const FRESH_TTL_MS = 24 * 60 * 60_000;

const GERUND = { start: "Starting…", stop: "Stopping…", reset: "Resetting…", delete: "Deleting…" } as const;

/** The running side of a clone: a companion of its own (the mock companion starts one per clone). */
export interface MockGuest {
	/** The link that pairs with the clone's companion. */
	pairUrl: string;
	/** Settles when the clone's session ended and its companion went. */
	exited: Promise<unknown>;
	stop(): void;
}

export interface MockVm {
	/** Fields of the mock companion's `hosts` frame: the capability. */
	hostsFields(): { canVms: true };
	handles(request: CompanionRequest): request is VmRequest;
	/** Stops every clone's companion (the mock companion's exit). */
	stop(): void;
	answer(request: VmRequest): Promise<VmReply>;
}

export function createMockVm(options: {
	/** The `omp vm github setup` state: `ready` (the default), or `missing`, which makes the app show how to set it up. */
	github?: "ready" | "missing";
	onChange(): void;
	/** The link a finished create or reset hands out; the mock room's own link makes the VM "appear" as this computer. */
	pairUrl?: () => string;
	now?: () => number;
	/** How a step or action takes its time; tests hold and release it. */
	sleep?: (ms: number) => Promise<void>;
	/** The guest's home folder: lists the canned template `web-template`, and a VM's repositories are under `<home>/src`. */
	home?: string;
	/** Starts the companion of a clone; without it a clone pairs with `pairUrl` and lives until deleted. */
	guest?: (clone: VmEntry) => Promise<MockGuest>;
}): MockVm {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? Bun.sleep;
	const github = options.github ?? "ready";
	const pairUrl = options.pairUrl ?? (() => "https://my.omp.sh/#pair:mock-vm");
	const vms = new Map<string, VmEntry>();
	const pending = new Map<string, { url: string; until: number }>();
	const guests = new Map<string, MockGuest>();
	const seed = (entry: Partial<VmEntry> & Pick<VmEntry, "name" | "repos" | "status">): void => {
		vms.set(entry.name, {
			cpus: 4,
			memoryGiB: 8,
			diskGiB: 60,
			network: "open",
			driver: "lima",
			createdAt: now() - 3 * 86_400_000,
			provisionedAt: now() - 3 * 86_400_000,
			...entry,
		});
	};
	seed({ name: "oh-my-pi", repos: ["ctrlc03/oh-my-pi"], status: "running" });
	seed({
		name: "scratch",
		repos: ["ctrlc03/scratch", "ctrlc03/notes"],
		status: "stopped",
		memoryGiB: 4,
		network: "allowlist",
		budget: { dailyCostUsd: 5 },
	});

	if (options.home !== undefined) {
		seed({ name: "web-template", repos: ["acme/web"], status: "stopped", template: true, home: options.home });
	}

	const ready = (): VmReadiness =>
		github === "ready"
			? {
					ok: true,
					drivers: { lima: "2.3.0", qemu: null },
					github: { configured: true, slug: "mock-omp-vm", owners: ["ctrlc03"] },
					supervisor: true,
				}
			: {
					ok: false,
					reason: "No GitHub App is set up for VMs yet.",
					drivers: { lima: "2.3.0", qemu: null },
					github: { configured: false },
					supervisor: true,
				};

	const setBusy = (name: string, action: VmJobAction, step: string, message: string): void => {
		const entry = vms.get(name);
		if (entry !== undefined) entry.busy = { action, step, message };
	};

	const refuseBusy = (name: string): void => {
		if (vms.get(name)?.busy !== undefined) throw new Error(`${name} is busy; wait for it to finish`);
	};

	const create = async (spec: VmCreateOptions): Promise<void> => {
		const { name } = spec;
		vms.set(name, {
			name,
			repos: spec.repos,
			cpus: spec.cpus ?? VM_DEFAULTS.cpus,
			memoryGiB: spec.memoryGiB ?? VM_DEFAULTS.memoryGiB,
			diskGiB: spec.diskGiB ?? VM_DEFAULTS.diskGiB,
			network: spec.network ?? VM_DEFAULTS.network,
			driver: "lima",
			status: "creating",
			createdAt: now(),
			...(spec.dailyCostUsd === undefined ? {} : { budget: { dailyCostUsd: spec.dailyCostUsd } }),
			...(spec.template === true ? { template: true as const } : {}),
			home: options.home ?? "/home/ubuntu",
		});
		setBusy(name, "create", "", "Creating…");
		for (const { step, message } of CREATE_STEPS) {
			setBusy(name, "create", step, message);
			await sleep(STEP_MS);
		}
		const entry = vms.get(name);
		if (entry === undefined) return;
		delete entry.busy;
		entry.provisionedAt = now();
		// A template is stopped after its provisioning and never paired.
		if (spec.template === true) entry.status = "stopped";
		else {
			entry.status = "running";
			pending.set(name, { url: pairUrl(), until: now() + 10 * 60_000 });
		}
		options.onChange();
	};

	const clone = async (templateName: string, name: string): Promise<void> => {
		const template = vms.get(templateName);
		if (template === undefined) return;
		const { template: _template, provisionedAt: _provisioned, ...rest } = template;
		const entry: VmEntry = {
			...rest,
			name,
			status: "creating",
			createdAt: now(),
			fresh: { from: templateName, expiresAt: now() + FRESH_TTL_MS },
		};
		vms.set(name, entry);
		setBusy(name, "clone", "", "Cloning…");
		let guest: MockGuest | undefined;
		try {
			for (const { step, message } of CLONE_STEPS) {
				setBusy(name, "clone", step, message);
				await sleep(STEP_MS);
			}
			guest = await options.guest?.(entry);
		} catch (err) {
			delete entry.busy;
			entry.status = "failed";
			entry.error = err instanceof Error ? err.message : String(err);
			options.onChange();
			return;
		}
		if (vms.get(name) !== entry) {
			guest?.stop();
			return;
		}
		delete entry.busy;
		entry.status = "running";
		entry.provisionedAt = now();
		pending.set(name, { url: guest?.pairUrl ?? pairUrl(), until: now() + 10 * 60_000 });
		if (guest !== undefined) {
			guests.set(name, guest);
			void guest.exited.then(() => {
				if (vms.get(name) !== entry) return;
				vms.delete(name);
				pending.delete(name);
				guests.delete(name);
				options.onChange();
			});
		}
		options.onChange();
	};

	const act = async (name: string, action: "start" | "stop" | "reset" | "delete"): Promise<void> => {
		setBusy(name, action, action, GERUND[action]);
		await sleep(ACTION_MS);
		const entry = vms.get(name);
		if (entry === undefined) return;
		delete entry.busy;
		if (action === "delete") {
			vms.delete(name);
			pending.delete(name);
			guests.get(name)?.stop();
			guests.delete(name);
		} else if (action === "stop") entry.status = "stopped";
		else {
			entry.status = "running";
			if (action === "reset") {
				entry.provisionedAt = now();
				pending.set(name, { url: pairUrl(), until: now() + 10 * 60_000 });
			}
		}
		options.onChange();
	};

	return {
		hostsFields: () => ({ canVms: true }),
		handles: (request): request is VmRequest =>
			request.t === "vm-list" ||
			request.t === "vm-create" ||
			request.t === "vm-clone" ||
			request.t === "vm-action" ||
			request.t === "vm-pair",
		stop() {
			for (const guest of guests.values()) guest.stop();
			guests.clear();
		},
		async answer(request) {
			if (request.t === "vm-list") {
				const time = now();
				const listed = [...vms.values()].map(entry => {
					const url = pending.get(entry.name);
					return { ...entry, ...(url !== undefined && url.until > time ? { pairUrl: url.url } : {}) };
				});
				return { t: "vm-list", reqId: request.reqId, ready: ready(), vms: listed };
			}
			if (request.t === "vm-create") {
				const { t: _t, reqId, ...spec } = request;
				const problem = vmCreateProblem(spec);
				if (problem !== null) throw new Error(problem);
				const readiness = ready();
				if (!readiness.ok) throw new Error(readiness.reason ?? "VMs cannot be created on this computer");
				if (vms.has(spec.name)) throw new Error(`${spec.name} already exists`);
				void create(spec);
				return { t: "vm-create", reqId, accepted: true };
			}
			if (request.t === "vm-clone") {
				if (!isVmName(request.name) || !isVmName(request.template)) throw new Error("invalid VM name");
				const template = vms.get(request.template);
				if (template === undefined) throw new Error(`no VM named ${request.template}`);
				if (template.template !== true) throw new Error(`${request.template} is not a template`);
				if (template.status !== "stopped" || template.busy !== undefined) {
					throw new Error(`${request.template} must be stopped and idle to be cloned`);
				}
				if (vms.has(request.name)) throw new Error(`${request.name} already exists`);
				const fresh = [...vms.values()].filter(vm => vm.fresh !== undefined).length;
				if (fresh >= VM_MAX_FRESH) throw new Error(`${VM_MAX_FRESH} fresh VMs already exist`);
				void clone(request.template, request.name);
				return { t: "vm-clone", reqId: request.reqId, accepted: true };
			}
			if (!isVmName(request.name)) throw new Error("invalid VM name");
			if (!vms.has(request.name)) throw new Error(`no VM named ${request.name}`);
			refuseBusy(request.name);
			if (request.t === "vm-action") {
				if (
					request.action !== "start" &&
					request.action !== "stop" &&
					request.action !== "reset" &&
					request.action !== "delete"
				)
					throw new Error("invalid action");
				void act(request.name, request.action);
				return { t: "vm-action", reqId: request.reqId, accepted: true };
			}
			if (vms.get(request.name)?.template === true) {
				throw new Error(
					`${request.name} is a template: it is never paired; fresh VMs cloned from it pair themselves`,
				);
			}
			pending.delete(request.name);
			return {
				t: "vm-pair",
				reqId: request.reqId,
				url: pairUrl(),
				expiresAt: now() + 10 * 60_000,
			};
		},
	};
}
