import { getVmDriver } from "./drivers";
import { removeVmDir } from "./store";
import type { VmRecord } from "./types";

/**
 * Deletes a VM: its driver instance and disk, then its directory. The supervisor notices the directory is gone,
 * closes the VM's sockets and revokes its GitHub token within two seconds. Safe to repeat.
 */
export async function deleteVm(record: Pick<VmRecord, "name" | "driver">, root?: string): Promise<void> {
	await getVmDriver(record.driver).remove(record.name);
	await removeVmDir(record.name, root);
}
