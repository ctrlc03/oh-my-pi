import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCloneCloudInit,
	buildMetaData,
	buildQemuArgs,
	buildSshArgs,
	buildUserData,
	createQemuDriver,
	imageSource,
	parseSha256Sums,
	type QemuBootSpec,
	remoteCommand,
	shellQuote,
} from "../src/vm/qemu-driver";
import type { VmRecord } from "../src/vm/types";

const spec: QemuBootSpec = {
	arch: "aarch64",
	accel: "hvf",
	cpus: 4,
	memoryMiB: 8192,
	diskPath: "/vm/qemu/dev/disk.qcow2",
	seedPath: "/vm/qemu/dev/seed.iso",
	firmware: {
		kind: "pflash",
		code: "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
		vars: "/vm/qemu/dev/efi-vars.fd",
	},
	sshPort: 40222,
	hostSocket: "/vm/dev/host.sock",
	egressSocket: "/vm/dev/egress.sock",
	dir: "/vm/qemu/dev",
};

function valueAfter(args: string[], flag: string): string {
	const index = args.indexOf(flag);
	expect(index).toBeGreaterThanOrEqual(0);
	return args[index + 1];
}

describe("qemu argv", () => {
	test("aarch64 on hvf boots a virt machine from UEFI pflash with a restricted user network", () => {
		const args = buildQemuArgs(spec);
		expect(valueAfter(args, "-machine")).toBe("virt");
		expect(valueAfter(args, "-accel")).toBe("hvf");
		expect(valueAfter(args, "-cpu")).toBe("host");
		expect(valueAfter(args, "-smp")).toBe("4");
		expect(valueAfter(args, "-m")).toBe("8192M");
		const drives = args.filter((_, i) => args[i - 1] === "-drive");
		expect(drives).toEqual([
			"if=pflash,format=raw,unit=0,readonly=on,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
			"if=pflash,format=raw,unit=1,file=/vm/qemu/dev/efi-vars.fd",
			"if=virtio,format=qcow2,file=/vm/qemu/dev/disk.qcow2",
			"if=virtio,format=raw,readonly=on,file=/vm/qemu/dev/seed.iso",
		]);
		expect(valueAfter(args, "-netdev").split(",")).toEqual([
			"user",
			"id=net0",
			"restrict=on",
			"hostfwd=tcp:127.0.0.1:40222-:22",
			"guestfwd=tcp:10.0.2.100:80-cmd:nc -U /vm/dev/host.sock",
			"guestfwd=tcp:10.0.2.101:3128-cmd:nc -U /vm/dev/egress.sock",
		]);
		expect(valueAfter(args, "-device")).toBe("virtio-net-pci,netdev=net0");
		expect(valueAfter(args, "-display")).toBe("none");
		expect(valueAfter(args, "-chardev")).toBe("ringbuf,id=serial0,size=65536");
		expect(valueAfter(args, "-serial")).toBe("chardev:serial0");
		expect(valueAfter(args, "-qmp")).toBe("unix:/vm/qemu/dev/qmp.sock,server,nowait");
		expect(args).toContain("-daemonize");
		expect(valueAfter(args, "-pidfile")).toBe("/vm/qemu/dev/qemu.pid");
	});

	test("x86_64 on kvm uses q35 and no firmware drive; a bios image goes to -bios", () => {
		const x86 = buildQemuArgs({ ...spec, arch: "x86_64", accel: "kvm", firmware: undefined });
		expect(valueAfter(x86, "-machine")).toBe("q35");
		expect(valueAfter(x86, "-accel")).toBe("kvm");
		expect(x86.some(a => a.startsWith("if=pflash"))).toBe(false);
		const bios = buildQemuArgs({
			...spec,
			firmware: { kind: "bios", code: "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd" },
		});
		expect(valueAfter(bios, "-bios")).toBe("/usr/share/qemu-efi-aarch64/QEMU_EFI.fd");
		expect(bios.some(a => a.startsWith("if=pflash"))).toBe(false);
	});

	test("paths with commas and spaces stay inside their option", () => {
		const args = buildQemuArgs({ ...spec, hostSocket: "/v m/a,b/host.sock", dir: "/v m/a,b" });
		const netdev = valueAfter(args, "-netdev");
		expect(netdev).toContain("cmd:nc -U '/v m/a,,b/host.sock',");
	});
});

describe("cloud-init", () => {
	const ci = { name: "dev", user: "alice", publicKey: "ssh-ed25519 AAAAC3Nza test\n", instanceId: "vm-dev-1" };

	test("user-data defines the host user with passwordless sudo and the key", () => {
		const data = buildUserData(ci);
		expect(data.startsWith("#cloud-config\n")).toBe(true);
		const parsed = Bun.YAML.parse(data) as Record<string, any>;
		expect(parsed.hostname).toBe("vm-dev");
		expect(parsed.ssh_pwauth).toBe(false);
		expect(parsed.users).toHaveLength(1);
		const [user] = parsed.users;
		expect(user.name).toBe("alice");
		expect(user.sudo).toBe("ALL=(ALL) NOPASSWD:ALL");
		expect(user.lock_passwd).toBe(true);
		expect(user.ssh_authorized_keys).toEqual(["ssh-ed25519 AAAAC3Nza test"]);
	});

	test("every HTTP client in the guest is pointed at the egress proxy", () => {
		const parsed = Bun.YAML.parse(buildUserData(ci)) as {
			write_files: Array<{ path: string; content: string; append?: boolean }>;
		};
		const file = (p: string) => parsed.write_files.find(f => f.path === p);
		const apt = file("/etc/apt/apt.conf.d/95omp-proxy")?.content;
		expect(apt).toContain('Acquire::http::Proxy "http://10.0.2.101:3128";');
		expect(apt).toContain('Acquire::https::Proxy "http://10.0.2.101:3128";');
		const env = file("/etc/environment");
		expect(env?.append).toBe(true);
		const lines = env?.content.trim().split("\n");
		expect(lines).toEqual(
			expect.arrayContaining([
				"http_proxy=http://10.0.2.101:3128",
				"https_proxy=http://10.0.2.101:3128",
				"HTTP_PROXY=http://10.0.2.101:3128",
				"HTTPS_PROXY=http://10.0.2.101:3128",
				"no_proxy=localhost,127.0.0.1,10.0.2.100",
			]),
		);
		for (const unit of ["/etc/systemd/system.conf.d/omp-proxy.conf", "/etc/systemd/user.conf.d/omp-proxy.conf"]) {
			expect(file(unit)?.content).toContain('"https_proxy=http://10.0.2.101:3128"');
		}
	});

	test("meta-data names the instance and host", () => {
		expect(buildMetaData(ci)).toBe("instance-id: vm-dev-1\nlocal-hostname: vm-dev\n");
	});

	test("a clone's seed has an instance id of its own and the clone's hostname, and trusts the same key", () => {
		const key = "ssh-ed25519 AAAAC3Nza test\n";
		const a = buildCloneCloudInit("base-1", "alice", key);
		const b = buildCloneCloudInit("base-1", "alice", key);
		expect(a.instanceId).toMatch(/^vm-base-1-[0-9a-f]{8}$/);
		expect(a.instanceId).not.toBe(b.instanceId);
		expect(a.instanceId).not.toBe(ci.instanceId);
		expect(buildMetaData(a)).toBe(`instance-id: ${a.instanceId}\nlocal-hostname: vm-base-1\n`);
		const data = Bun.YAML.parse(buildUserData(a)) as Record<string, any>;
		expect(data.hostname).toBe("vm-base-1");
		expect(data.users[0].name).toBe("alice");
		expect(data.users[0].ssh_authorized_keys).toEqual(["ssh-ed25519 AAAAC3Nza test"]);
	});
});

describe("remote commands", () => {
	test("argv survives the login shell unchanged", async () => {
		const argv = ["a b", "it's", '"q"', "$HOME", "`x`", "*", "", "x\ny"];
		// What ssh sends is `remoteCommand(...)`; run it through a local shell the way sshd does.
		const command = remoteCommand(["sh", "-c", 'for a; do printf "%s\\0" "$a"; done', "sh", ...argv]);
		const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out.split("\0").slice(0, -1)).toEqual(argv);
	});

	test("shellQuote leaves safe words alone", () => {
		expect(shellQuote("/usr/bin/env")).toBe("/usr/bin/env");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("")).toBe("''");
	});

	test("ssh args use the instance key and a per-instance known_hosts, non-interactively", () => {
		const args = buildSshArgs({ dir: "/vm/qemu/dev", name: "dev", user: "alice", port: 40222 });
		expect(valueAfter(args, "-i")).toBe("/vm/qemu/dev/id_ed25519");
		expect(valueAfter(args, "-p")).toBe("40222");
		expect(args).toContain("StrictHostKeyChecking=accept-new");
		expect(args).toContain("UserKnownHostsFile=/vm/qemu/dev/known_hosts");
		expect(args).toContain("BatchMode=yes");
		expect(args[args.length - 1]).toBe("alice@127.0.0.1");
	});
});

describe("images", () => {
	test("image names per architecture", () => {
		expect(imageSource("aarch64").file).toBe("noble-server-cloudimg-arm64.img");
		expect(imageSource("x86_64").url).toBe(
			"https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
		);
		expect(imageSource("x86_64").sumsUrl).toBe("https://cloud-images.ubuntu.com/noble/current/SHA256SUMS");
	});

	test("SHA256SUMS lookup picks the exact file", () => {
		const a = "a".repeat(64);
		const b = "B".repeat(64);
		const sums = `${a} *noble-server-cloudimg-arm64.img.manifest\n${b} *noble-server-cloudimg-arm64.img\n${a}  noble-server-cloudimg-amd64.img\n`;
		expect(parseSha256Sums(sums, "noble-server-cloudimg-arm64.img")).toBe("b".repeat(64));
		expect(parseSha256Sums(sums, "noble-server-cloudimg-amd64.img")).toBe(a);
		expect(parseSha256Sums(sums, "missing.img")).toBeUndefined();
	});
});

describe("driver surface", () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "qd-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	test("an unknown instance is absent, stop and remove are no-ops, exec fails", async () => {
		const driver = createQemuDriver({ home });
		expect(driver.name).toBe("qemu");
		expect(await driver.state("ghost")).toBe("absent");
		await driver.stop("ghost");
		await driver.remove("ghost");
		await expect(driver.exec("ghost", ["true"])).rejects.toThrow(/does not exist/);
		expect(() => driver.interactiveShell("ghost")).toThrow(/does not exist/);
	});

	test("instance names cannot escape the home directory", async () => {
		const driver = createQemuDriver({ home });
		await expect(driver.state("../x")).rejects.toThrow(/invalid VM name/);
	});

	test("cloning needs an existing source", async () => {
		const driver = createQemuDriver({ home });
		const options = {
			record: { name: "dev-1" } as VmRecord,
			dir: home,
			hostSocket: "/x",
			egressSocket: "/y",
			log: () => {},
		};
		await expect(driver.clone("ghost", options)).rejects.toThrow(/ghost does not exist/);
		await expect(driver.clone("../x", options)).rejects.toThrow(/invalid VM name/);
	});

	test("guest endpoints are fixed", () => {
		const driver = createQemuDriver({ home });
		expect(driver.guestEndpoints({} as VmRecord)).toEqual({
			hostServices: "TCP:10.0.2.100:80",
			egressProxy: "http://10.0.2.101:3128",
		});
	});

	test("a stopped instance with a stale pidfile reports stopped", async () => {
		fs.mkdirSync(path.join(home, "dev"));
		fs.writeFileSync(
			path.join(home, "dev", "instance.json"),
			JSON.stringify({ version: 1, user: "alice", sshPort: 1, arch: "aarch64" }),
		);
		fs.writeFileSync(path.join(home, "dev", "qemu.pid"), String(process.pid));
		const driver = createQemuDriver({ home });
		// The pid is alive but is not a qemu for this instance.
		expect(await driver.state("dev")).toBe("stopped");
		expect(driver.interactiveShell("dev").argv.slice(0, 2)).toEqual(["ssh", "-t"]);
	});
});
