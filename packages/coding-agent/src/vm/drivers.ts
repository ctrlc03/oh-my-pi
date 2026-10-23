import type { VmDriver } from "./driver";
import { createLimaDriver } from "./lima-driver";
import { createQemuDriver } from "./qemu-driver";
import type { VmDriverName, VmNetworkMode, VmRecord } from "./types";

const cache = new Map<VmDriverName, VmDriver>();

export function getVmDriver(name: VmDriverName): VmDriver {
	let driver = cache.get(name);
	if (!driver) {
		driver = name === "lima" ? createLimaDriver() : createQemuDriver();
		cache.set(name, driver);
	}
	return driver;
}

/**
 * The driver a new VM gets. Lima's loopback block exists only with Virtualization.framework, so
 * `open` uses Lima on macOS; `allowlist` (and any mode on other hosts) uses QEMU, whose
 * `restrict=on` network leaves the host's proxy as the only way out.
 */
export function defaultDriverFor(network: VmNetworkMode, platform = process.platform): VmDriverName {
	return network === "open" && platform === "darwin" ? "lima" : "qemu";
}

/** Whether the VM's egress goes through the host's proxy (and so needs one served). */
export function usesEgressProxy(record: Pick<VmRecord, "driver">): boolean {
	return record.driver === "qemu";
}
