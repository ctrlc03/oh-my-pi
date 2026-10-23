/**
 * Virtual machines for sessions (docs/vm-sessions.md): the companion runs `omp vm …` on its computer and the app lists,
 * creates, controls and pairs the VMs through the `vm-*` requests. A VM runs its own companion, so once paired it is one
 * more computer in the app; the host companion only provisions and supervises it.
 *
 * The VM shapes mirror what `omp vm list --json` prints (`VmListOutput` in `@oh-my-pi/pi-coding-agent/vm/types`),
 * redeclared here because this package depends on nothing. A companion advertises `canVms` on the `hosts` frame when
 * `omp vm list --json` works on its computer; every field added to an older frame is optional.
 */

/** `open`: the VM reaches the internet (and the LAN); `allowlist`: only listed hosts, through a host proxy. */
export type VmNetworkMode = "open" | "allowlist";

/** `lima`: Lima with Virtualization.framework (macOS). `qemu`: QEMU user networking (Linux, allowlist mode). */
export type VmDriverName = "lima" | "qemu";

export type VmStatus = "creating" | "running" | "stopped" | "failed" | "missing";

/** Per-VM model-call budget, per UTC day. */
export interface VmBudget {
	dailyTokens?: number;
	dailyCostUsd?: number;
}

/** Whether a VM can be created on this computer, and what is missing when it cannot. */
export interface VmReadiness {
	ok: boolean;
	/** Why not, when `ok` is false (the first blocking reason, as text a person can act on). */
	reason?: string;
	/** Installed driver versions, or `null` when that driver is unavailable. */
	drivers: Record<VmDriverName, string | null>;
	github: { configured: boolean; slug?: string; owners?: string[] };
	/** A VM supervisor is serving on this computer. */
	supervisor: boolean;
}

/** What a VM's job (a long action) is doing now. */
export type VmJobAction = "create" | "start" | "stop" | "reset" | "delete";

export interface VmBusy {
	action: VmJobAction;
	/** The CLI's step id (`boot`, `provision`, …); empty before its first progress line. */
	step: string;
	/** The CLI's progress text for people. */
	message: string;
}

export interface VmEntry {
	name: string;
	/** `owner/repo`, all under one GitHub owner. */
	repos: string[];
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
	network: VmNetworkMode;
	driver: VmDriverName;
	status: VmStatus;
	createdAt: number;
	provisionedAt?: number;
	/** Why the VM failed, or the last action on it failed. */
	error?: string;
	budget?: VmBudget;
	/** A job runs on this VM now: the app polls `vm-list` while any VM is busy. */
	busy?: VmBusy;
	/**
	 * A fresh pairing link for the VM's companion, left by the `create` or `reset` that just finished. Kept until the
	 * next successful `vm-pair` or ten minutes, whichever is first.
	 */
	pairUrl?: string;
}

/** VM names are also the driver's instance names. */
export const VM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
/** `owner/repo` on GitHub. The first character is alphanumeric so a value is never read as a command-line flag. */
export const VM_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
export const VM_MAX_REPOS = 20;
export const VM_CPUS_RANGE = { min: 1, max: 64 } as const;
export const VM_MEMORY_GIB_RANGE = { min: 1, max: 512 } as const;
export const VM_DISK_GIB_RANGE = { min: 5, max: 4096 } as const;
export const VM_MAX_DAILY_COST_USD = 100_000;
export const VM_DEFAULTS = { cpus: 4, memoryGiB: 8, diskGiB: 60, network: "open" } as const;
/** How long `pairUrl` stays on a VM entry. */
export const VM_PAIR_URL_TTL_MS = 10 * 60_000;

export function isVmName(value: unknown): value is string {
	return typeof value === "string" && VM_NAME_PATTERN.test(value);
}

export function isVmRepo(value: unknown): value is string {
	return typeof value === "string" && VM_REPO_PATTERN.test(value);
}

export interface VmCreateOptions {
	name: string;
	/** One or more `owner/repo`, all under one GitHub owner. */
	repos: string[];
	cpus?: number;
	memoryGiB?: number;
	diskGiB?: number;
	network?: VmNetworkMode;
	/** Estimated model cost allowed per UTC day. */
	dailyCostUsd?: number;
}

/** The first thing wrong with the options, in words for a person; null when they are acceptable. */
export function vmCreateProblem(options: VmCreateOptions): string | null {
	if (!isVmName(options.name))
		return "The name starts with a letter and has at most 31 lower-case letters, digits or dashes.";
	if (!Array.isArray(options.repos) || options.repos.length === 0)
		return "Name at least one repository, as owner/repo.";
	if (options.repos.length > VM_MAX_REPOS) return `At most ${VM_MAX_REPOS} repositories.`;
	const bad = options.repos.find(repo => !isVmRepo(repo));
	if (bad !== undefined) return `"${String(bad)}" is not a repository; write owner/repo.`;
	const owners = new Set(options.repos.map(repo => repo.split("/")[0]!.toLowerCase()));
	if (owners.size > 1) return "All repositories of a VM belong to one GitHub owner.";
	const whole = (value: number | undefined, range: { min: number; max: number }, label: string): string | null =>
		value === undefined || (Number.isInteger(value) && value >= range.min && value <= range.max)
			? null
			: `${label}: a whole number from ${range.min} to ${range.max}.`;
	const numeric =
		whole(options.cpus, VM_CPUS_RANGE, "CPUs") ??
		whole(options.memoryGiB, VM_MEMORY_GIB_RANGE, "Memory (GiB)") ??
		whole(options.diskGiB, VM_DISK_GIB_RANGE, "Disk (GiB)");
	if (numeric !== null) return numeric;
	if (options.network !== undefined && options.network !== "open" && options.network !== "allowlist")
		return "Network is open or allowlist.";
	const cost = options.dailyCostUsd;
	if (cost !== undefined && !(Number.isFinite(cost) && cost > 0 && cost <= VM_MAX_DAILY_COST_USD))
		return "The daily cost limit is a positive amount in USD.";
	return null;
}

export type VmAction = "start" | "stop" | "reset" | "delete";

/**
 * `vm-list`: the VMs and whether one can be created. `vm-create` and `vm-action` start a job and answer `accepted` at
 * once; progress shows as `busy` on the VM in `vm-list`, a failure as its `error`. A VM has one job at a time: a second
 * action on a busy VM is refused. `vm-pair` mints a fresh pairing link for the VM's companion.
 */
export type VmRequest =
	| { t: "vm-list"; reqId: number }
	| ({ t: "vm-create"; reqId: number } & VmCreateOptions)
	| { t: "vm-action"; reqId: number; name: string; action: VmAction }
	| { t: "vm-pair"; reqId: number; name: string };

export type VmReply =
	| { t: "vm-list"; reqId: number; ready: VmReadiness; vms: VmEntry[] }
	| { t: "vm-create"; reqId: number; accepted: true }
	| { t: "vm-action"; reqId: number; accepted: true }
	| { t: "vm-pair"; reqId: number; url: string; expiresAt: number };
