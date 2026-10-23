/**
 * The mock companion's virtual machines: a computer that can run VMs, with two canned VMs (`--vm-github missing` makes
 * `ready.ok` false, so the app shows the `omp vm github setup` hint). A create takes
 * a few seconds of progress lines, ends with a pairing link, and adds the VM to the list; start, stop, reset and delete
 * take a moment and change the VM's status. Nothing starts a process or touches a disk. See ./companion-vm for the real
 * thing, which runs `omp vm …`.
 */

import {
	isVmName,
	VM_DEFAULTS,
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

const GERUND = { start: "Starting…", stop: "Stopping…", reset: "Resetting…", delete: "Deleting…" } as const;

export interface MockVm {
	/** Fields of the mock companion's `hosts` frame: the capability. */
	hostsFields(): { canVms: true };
	handles(request: CompanionRequest): request is VmRequest;
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
}): MockVm {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? Bun.sleep;
	const github = options.github ?? "ready";
	const pairUrl = options.pairUrl ?? (() => "https://my.omp.sh/#pair:mock-vm");
	const vms = new Map<string, VmEntry>();
	const pending = new Map<string, { url: string; until: number }>();
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
		});
		setBusy(name, "create", "", "Creating…");
		for (const { step, message } of CREATE_STEPS) {
			setBusy(name, "create", step, message);
			await sleep(STEP_MS);
		}
		const entry = vms.get(name);
		if (entry === undefined) return;
		delete entry.busy;
		entry.status = "running";
		entry.provisionedAt = now();
		pending.set(name, { url: pairUrl(), until: now() + 10 * 60_000 });
		options.onChange();
	};

	const act = async (name: string, action: "start" | "stop" | "reset" | "delete"): Promise<void> => {
		setBusy(name, action, action, GERUND[action]);
		await sleep(ACTION_MS);
		const entry = vms.get(name);
		if (entry === undefined) return;
		delete entry.busy;
		if (action === "delete") vms.delete(name);
		else if (action === "stop") entry.status = "stopped";
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
			request.t === "vm-list" || request.t === "vm-create" || request.t === "vm-action" || request.t === "vm-pair",
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
