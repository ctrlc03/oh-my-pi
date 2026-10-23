import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	limaHome,
	supervisorEndpointPath,
	vmDir,
	vmEgressSocket,
	vmHostSocket,
} from "@oh-my-pi/pi-coding-agent/vm/paths";
import { listVmRecords, removeVmDir, writeVmRecord } from "@oh-my-pi/pi-coding-agent/vm/store";
import {
	readLiveSupervisor,
	SupervisorRunningError,
	startVmSupervisor,
	type VmSupervisorHandle,
} from "@oh-my-pi/pi-coding-agent/vm/supervisor";
import type { VmRecord } from "@oh-my-pi/pi-coding-agent/vm/types";

const handles: VmSupervisorHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	// Short: unix socket paths are limited to ~104 bytes on macOS.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-"));
	roots.push(root);
	return root;
}

function record(name: string): VmRecord {
	return {
		version: 1,
		name,
		repos: ["acme/api"],
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 20,
		network: "open",
		driver: "lima",
		phase: "ready",
		createdAt: 0,
	};
}

async function start(root: string): Promise<VmSupervisorHandle> {
	const handle = await startVmSupervisor({ root, log: () => {} });
	handles.push(handle);
	return handle;
}

function get(socket: string, pathname: string): Promise<Response> {
	return fetch(`http://vm${pathname}`, { unix: socket });
}

describe("vm supervisor", () => {
	test("serves each VM's socket and answers its health check", async () => {
		const root = tempRoot();
		await writeVmRecord(record("api"), root);
		await start(root);
		const socket = vmHostSocket("api", root);
		expect((fs.statSync(socket).mode & 0o777).toString(8)).toBe("600");
		const health = await get(socket, "/healthz");
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok");
	});

	test("GitHub token requests without an App say how to set one up", async () => {
		const root = tempRoot();
		await writeVmRecord(record("api"), root);
		await start(root);
		const response = await get(vmHostSocket("api", root), "/github/token");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: expect.stringContaining("omp vm github setup") });
	});

	test("a second supervisor on the same root refuses to start, naming the first", async () => {
		const root = tempRoot();
		await start(root);
		expect(readLiveSupervisor(root)?.pid).toBe(process.pid);
		const second = startVmSupervisor({ root, log: () => {} });
		await expect(second).rejects.toBeInstanceOf(SupervisorRunningError);
		await expect(second).rejects.toThrow(`pid ${process.pid}`);
	});

	test("a supervisor.json left by one that died does not count as running, whatever PID it names", async () => {
		const root = tempRoot();
		// A crash (or a reboot) leaves the file; its PID may belong to another live process by now.
		fs.writeFileSync(supervisorEndpointPath(root), JSON.stringify({ pid: process.ppid, startedAt: 0 }));
		expect(readLiveSupervisor(root)).toBeNull();
		await start(root);
		expect(readLiveSupervisor(root)?.pid).toBe(process.pid);
	});

	test("picks up new VMs and stops serving deleted ones", async () => {
		const root = tempRoot();
		await start(root);
		await writeVmRecord(record("web"), root);
		const socket = vmHostSocket("web", root);
		for (let i = 0; i < 40 && !fs.existsSync(socket); i++) await Bun.sleep(100);
		expect((await get(socket, "/healthz")).status).toBe(200);

		fs.rmSync(vmDir("web", root), { recursive: true, force: true });
		await Bun.sleep(2_500);
		await expect(get(socket, "/healthz")).rejects.toThrow();
	});

	test("a VM with invalid grants does not keep the other VMs from being served", async () => {
		const root = tempRoot();
		await writeVmRecord({ ...record("bad"), models: ["sonnet"], budget: { dailyTokens: 0 } }, root);
		await writeVmRecord(record("good"), root);
		const logged: string[] = [];
		handles.push(await startVmSupervisor({ root, log: message => logged.push(message) }));
		expect((await get(vmHostSocket("good", root), "/healthz")).status).toBe(200);
		expect(logged.filter(line => line.startsWith("vm bad: no model access"))).toHaveLength(1);
	});

	test("deleting a VM named after a driver folder leaves the driver's VMs alone", async () => {
		const root = tempRoot();
		const limaInstance = path.join(limaHome(root), "other", "lima.yaml");
		fs.mkdirSync(path.dirname(limaInstance), { recursive: true });
		fs.writeFileSync(limaInstance, "");
		await writeVmRecord(record("lima"), root);
		await removeVmDir("lima", root);
		expect(fs.existsSync(limaInstance)).toBe(true);
		expect(await listVmRecords(root)).toEqual([]);
	});

	test("a proxied VM deleted and created again between two scans gets its egress proxy back", async () => {
		const root = tempRoot();
		const proxied: VmRecord = { ...record("box"), network: "allowlist", driver: "qemu" };
		await writeVmRecord(proxied, root);
		await start(root);
		const egress = vmEgressSocket("box", root);
		expect(fs.existsSync(egress)).toBe(true);
		fs.rmSync(vmDir("box", root), { recursive: true, force: true });
		await writeVmRecord({ ...proxied, createdAt: 1 }, root);
		for (let i = 0; i < 40 && !fs.existsSync(egress); i++) await Bun.sleep(100);
		expect(fs.existsSync(egress)).toBe(true);
		expect((await get(vmHostSocket("box", root), "/healthz")).status).toBe(200);
	});

	test("close releases the endpoint file", async () => {
		const root = tempRoot();
		const handle = await start(root);
		expect(fs.existsSync(supervisorEndpointPath(root))).toBe(true);
		await handle.close();
		expect(fs.existsSync(supervisorEndpointPath(root))).toBe(false);
		expect(readLiveSupervisor(root)).toBeNull();
	});
});
