import * as path from "node:path";
import { getBaseConfigRoot } from "@oh-my-pi/pi-utils";

/**
 * Host-side layout of VM sessions, profile-independent (one set of VMs per computer):
 *
 *   ~/.omp/agent/vm/
 *     supervisor.json        live supervisor {pid, startedAt}; its `.lock` sidecar is held while it runs
 *     github-app.json        GitHub App config (0600)
 *     github-app.pem         its private key (0600)
 *     lima/                  LIMA_HOME for the lima driver
 *     qemu/                  images and instances of the qemu driver
 *     vms/<name>/vm.json     VmRecord
 *     vms/<name>/host.sock   host services for that VM (gateway routes, GitHub token)
 *     vms/<name>/egress.sock proxied VMs: the VM's HTTP proxy
 *     vms/<name>/usage.json  model-call usage per UTC day
 *     vms/<name>/provision.log  last provisioning transcript
 *
 * VMs live in their own folder so no VM name can collide with the drivers' folders.
 */
export function getVmRoot(): string {
	return process.env.OMP_VM_ROOT || path.join(getBaseConfigRoot(), "agent", "vm");
}

/** The folder holding one folder per VM. */
export function vmsDir(root = getVmRoot()): string {
	return path.join(root, "vms");
}

export function vmDir(name: string, root = getVmRoot()): string {
	return path.join(vmsDir(root), name);
}

export function vmRecordPath(name: string, root = getVmRoot()): string {
	return path.join(vmDir(name, root), "vm.json");
}

export function vmHostSocket(name: string, root = getVmRoot()): string {
	return path.join(vmDir(name, root), "host.sock");
}

export function vmEgressSocket(name: string, root = getVmRoot()): string {
	return path.join(vmDir(name, root), "egress.sock");
}

export function vmUsagePath(name: string, root = getVmRoot()): string {
	return path.join(vmDir(name, root), "usage.json");
}

export function vmProvisionLog(name: string, root = getVmRoot()): string {
	return path.join(vmDir(name, root), "provision.log");
}

export function supervisorEndpointPath(root = getVmRoot()): string {
	return path.join(root, "supervisor.json");
}

export function githubAppConfigPath(root = getVmRoot()): string {
	return path.join(root, "github-app.json");
}

export function githubAppKeyPath(root = getVmRoot()): string {
	return path.join(root, "github-app.pem");
}

export function limaHome(root = getVmRoot()): string {
	return path.join(root, "lima");
}

export function qemuHome(root = getVmRoot()): string {
	return path.join(root, "qemu");
}
