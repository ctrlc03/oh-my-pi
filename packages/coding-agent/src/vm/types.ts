/**
 * Shared types for VM sessions (docs/vm-sessions.md): the record `omp vm` keeps per VM, the
 * status it reports, and the per-VM limits the host supervisor applies to model calls.
 */

/** `open`: the VM reaches the internet (and the LAN) directly; `allowlist`: only listed hosts, through a host proxy. */
export type VmNetworkMode = "open" | "allowlist";

/** `lima`: Lima with Virtualization.framework (macOS). `qemu`: QEMU user networking with `restrict=on`. */
export type VmDriverName = "lima" | "qemu";

/** Per-VM model-call budget, enforced by the host gateway per UTC day. */
export interface VmBudget {
	/** Input + output + cache tokens per UTC day. */
	dailyTokens?: number;
	/** Estimated cost in USD per UTC day (catalog prices; a subscription is billed by quota, not by this figure). */
	dailyCostUsd?: number;
}

/** Where the creation of a VM stands. A VM is usable only once `ready`. */
export type VmPhase = "creating" | "ready" | "failed";

/** What `<vm root>/<name>/vm.json` holds. */
export interface VmRecord {
	version: 1;
	/** `[a-z][a-z0-9-]{0,30}`; also the driver's instance name. */
	name: string;
	/** `owner/repo` for each repository cloned into the VM; all under one GitHub owner. */
	repos: string[];
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	network: VmNetworkMode;
	driver: VmDriverName;
	/** Hosts the VM may reach in `allowlist` mode, besides the built-in defaults (exact host or `*.suffix`). */
	allowHosts?: string[];
	/** Gateway model grants (`provider/id` or `provider/*`); absent allows every model the host can serve. */
	models?: string[];
	budget?: VmBudget;
	/** When set, the VM pushes only branches whose names start with it. */
	branchPrefix?: string;
	phase: VmPhase;
	/** Set when `phase` is `failed`: what went wrong. */
	error?: string;
	createdAt: number;
	/** When provisioning last finished. */
	provisionedAt?: number;
}

/** Runtime status reported by `omp vm list`. */
export type VmStatus = "creating" | "running" | "stopped" | "failed" | "missing";

/** One VM as `omp vm list --json` reports it. */
export interface VmInfo {
	name: string;
	repos: string[];
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	network: VmNetworkMode;
	driver: VmDriverName;
	status: VmStatus;
	createdAt: number;
	provisionedAt?: number;
	error?: string;
	budget?: VmBudget;
}

/** What `omp vm list --json` reports about the host's readiness. */
export interface VmReadiness {
	/** True when a VM can be created with the default options. */
	ok: boolean;
	/** Why not, when `ok` is false (first blocking reason). */
	reason?: string;
	/** Installed driver versions, or `null` when that driver is unavailable. */
	drivers: Record<VmDriverName, string | null>;
	github: { configured: boolean; slug?: string; owners?: string[] };
	/** Whether a VM supervisor is serving on this computer. */
	supervisor: boolean;
}

export interface VmListOutput {
	ready: VmReadiness;
	vms: VmInfo[];
}

/**
 * NDJSON lines `omp vm create|start|stop|reset|delete --json` writes to stdout, one per line.
 * The last line is `done` or `error`.
 */
export type VmProgressLine =
	| { t: "progress"; step: string; message: string }
	| { t: "done"; vm?: VmInfo; pairUrl?: string; deleted?: boolean }
	| { t: "error"; message: string };

export const VM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
