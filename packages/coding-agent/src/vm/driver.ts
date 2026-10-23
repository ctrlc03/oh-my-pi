import type { VmDriverName, VmRecord } from "./types";

/** How the guest reaches the host's services; fixed per driver and record. */
export interface VmGuestEndpoints {
	/**
	 * `socat` address the guest's shim connects to for host services (gateway routes and the GitHub
	 * token endpoint): `UNIX-CONNECT:<guest path>` when the driver forwards the host socket into the
	 * guest, `TCP:<ip>:<port>` when it forwards a guest TCP address to it.
	 */
	hostServices: string;
	/** HTTP proxy URL every guest egress must use (`allowlist` mode); absent when the guest has direct NAT egress. */
	egressProxy?: string;
}

export interface VmDriverOptions {
	record: VmRecord;
	/** `<vm root>/<name>`: the driver may keep files here (and under its own home). */
	dir: string;
	/** Host socket the supervisor serves for this VM; the driver forwards guest connections to it. */
	hostSocket: string;
	/** `allowlist` mode: host socket of the VM's HTTP proxy; the driver forwards the guest's proxy address to it. */
	egressSocket?: string;
	log: (line: string) => void;
}

export interface VmExecOptions {
	stdin?: string;
	timeoutMs?: number;
	/** Called with each chunk of combined output while the command runs. */
	onOutput?: (chunk: string) => void;
}

export interface VmExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type VmDriverState = "running" | "stopped" | "absent";

/**
 * A VM backend. Every method takes the VM's name as its instance name. The guest is Ubuntu with a
 * default user that has passwordless sudo; `exec` runs as that user with a login environment.
 */
export interface VmDriver {
	readonly name: VmDriverName;
	/** Whether this driver can run on this host; `version` is what it reports. */
	check(): Promise<{ ok: true; version: string } | { ok: false; reason: string }>;
	/** Defines the instance and boots it for the first time; resolves once `exec` works. */
	create(opts: VmDriverOptions): Promise<void>;
	/** Boots an existing, stopped instance; resolves once `exec` works. No-op when running. */
	start(opts: VmDriverOptions): Promise<void>;
	/**
	 * Copies the stopped instance `source` into a new instance named `opts.record.name` (copy-on-write where the
	 * host allows it) and boots it; resolves once `exec` works. The guest boots as a new cloud-init instance (new SSH
	 * host keys), but it has the source's disk, so the caller must give it the rest of its own identity.
	 */
	clone(source: string, opts: VmDriverOptions): Promise<void>;
	/** Shuts the instance down; no-op when stopped or absent. */
	stop(name: string): Promise<void>;
	/** Deletes the instance and its disks; no-op when absent. */
	remove(name: string): Promise<void>;
	state(name: string): Promise<VmDriverState>;
	exec(name: string, argv: string[], opts?: VmExecOptions): Promise<VmExecResult>;
	/** argv (and env) of an interactive login shell in the guest, for `omp vm shell`. */
	interactiveShell(name: string): { argv: string[]; env: Record<string, string> };
	guestEndpoints(record: VmRecord): VmGuestEndpoints;
}
