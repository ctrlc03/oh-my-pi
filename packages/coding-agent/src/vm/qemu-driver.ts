import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { VmDriver, VmDriverOptions, VmDriverState, VmExecOptions, VmExecResult, VmGuestEndpoints } from "./driver";
import { qemuHome } from "./paths";
import { VM_NAME_PATTERN, type VmRecord } from "./types";

/**
 * QEMU driver (docs/vm-sessions.md, "Network"): Ubuntu 24.04 cloud image, user-mode networking with
 * `restrict=on`, so the guest has no route of its own. The guest reaches only two addresses, both `guestfwd`
 * entries that run `nc -U` against host unix sockets:
 *
 *   10.0.2.100:80    the VM's host-services socket (gateway routes, GitHub token)
 *   10.0.2.101:3128  the egress proxy (apt, `http_proxy`/`https_proxy`)
 *
 * and the host reaches the guest's sshd only through `hostfwd` on 127.0.0.1.
 */

export const GUEST_HOST_SERVICES_ADDRESS = "10.0.2.100";
export const GUEST_EGRESS_ADDRESS = "10.0.2.101";
export const GUEST_EGRESS_PORT = 3128;
const GUEST_EGRESS_PROXY = `http://${GUEST_EGRESS_ADDRESS}:${GUEST_EGRESS_PORT}`;

const IMAGE_BASE_URL = "https://cloud-images.ubuntu.com/noble/current";
const SSH_READY_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;
const SERIAL_TAIL_BYTES = 4096;
/** The serial console's ring buffer in QEMU's memory (a power of two): the guest can write to it for ever without filling a disk. */
const SERIAL_RING_BYTES = 65_536;
const FIRMWARE_SIZE = 64 * 1024 * 1024;

export type QemuArch = "aarch64" | "x86_64";
export type QemuAccel = "hvf" | "kvm";

export interface QemuFirmware {
	/** `pflash`: a 64 MiB code image plus a writable variable store; `bios`: a smaller image passed to `-bios`. */
	kind: "pflash" | "bios";
	code: string;
	/** Writable 64 MiB variable store (pflash only). */
	vars?: string;
}

export interface QemuBootSpec {
	arch: QemuArch;
	accel: QemuAccel;
	cpus: number;
	memoryMiB: number;
	diskPath: string;
	seedPath: string;
	firmware?: QemuFirmware;
	sshPort: number;
	hostSocket: string;
	egressSocket: string;
	/** Instance directory: serial log, QMP socket and pidfile live here. */
	dir: string;
}

/** Instance state kept next to the disk. */
interface InstanceFile {
	version: 1;
	user: string;
	sshPort: number;
	arch: QemuArch;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure builders

/** Escapes a value inside a QEMU comma-separated option string. */
function qemuOpt(value: string): string {
	return value.replaceAll(",", ",,");
}

/** POSIX single-quote quoting, applied only when the word is not already safe. */
export function shellQuote(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command line ssh sends to the guest: argv as a login-shell command, so the guest's profile applies. */
export function remoteCommand(argv: string[]): string {
	return `bash -lc ${shellQuote(argv.map(shellQuote).join(" "))}`;
}

/** argv (after the binary) that boots the instance. */
export function buildQemuArgs(spec: QemuBootSpec): string[] {
	const machine = spec.arch === "aarch64" ? (spec.accel === "kvm" ? "virt,gic-version=host" : "virt") : "q35";
	const netdev = [
		"user",
		"id=net0",
		"restrict=on",
		`hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22`,
		`guestfwd=tcp:${GUEST_HOST_SERVICES_ADDRESS}:80-cmd:nc -U ${qemuOpt(shellQuote(spec.hostSocket))}`,
		`guestfwd=tcp:${GUEST_EGRESS_ADDRESS}:${GUEST_EGRESS_PORT}-cmd:nc -U ${qemuOpt(shellQuote(spec.egressSocket))}`,
	].join(",");
	const args = [
		"-machine",
		machine,
		"-accel",
		spec.accel,
		"-cpu",
		"host",
		"-smp",
		String(spec.cpus),
		"-m",
		`${spec.memoryMiB}M`,
	];
	if (spec.firmware?.kind === "pflash") {
		args.push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${qemuOpt(spec.firmware.code)}`);
		if (spec.firmware.vars) args.push("-drive", `if=pflash,format=raw,unit=1,file=${qemuOpt(spec.firmware.vars)}`);
	} else if (spec.firmware?.kind === "bios") {
		args.push("-bios", spec.firmware.code);
	}
	args.push(
		"-drive",
		`if=virtio,format=qcow2,file=${qemuOpt(spec.diskPath)}`,
		"-drive",
		`if=virtio,format=raw,readonly=on,file=${qemuOpt(spec.seedPath)}`,
		"-netdev",
		netdev,
		"-device",
		"virtio-net-pci,netdev=net0",
		"-display",
		"none",
		"-chardev",
		`ringbuf,id=serial0,size=${SERIAL_RING_BYTES}`,
		"-serial",
		"chardev:serial0",
		"-qmp",
		`unix:${qemuOpt(path.join(spec.dir, "qmp.sock"))},server,nowait`,
		"-daemonize",
		"-pidfile",
		path.join(spec.dir, "qemu.pid"),
	);
	return args;
}

export interface CloudInitSpec {
	/** Instance name; the guest hostname is `vm-<name>`. */
	name: string;
	user: string;
	publicKey: string;
	instanceId: string;
}

/** `meta-data` for the NoCloud seed. */
export function buildMetaData(spec: CloudInitSpec): string {
	return `instance-id: ${spec.instanceId}\nlocal-hostname: vm-${spec.name}\n`;
}

/**
 * `user-data` for the NoCloud seed: the host user with passwordless sudo and the instance key, and every
 * outbound HTTP client pointed at the egress proxy (apt through its own config, everything else through the
 * environment, including systemd services).
 */
export function buildUserData(spec: CloudInitSpec): string {
	const proxy = GUEST_EGRESS_PROXY;
	const noProxy = `localhost,127.0.0.1,${GUEST_HOST_SERVICES_ADDRESS}`;
	const environment = [
		`http_proxy=${proxy}`,
		`https_proxy=${proxy}`,
		`HTTP_PROXY=${proxy}`,
		`HTTPS_PROXY=${proxy}`,
		`no_proxy=${noProxy}`,
		`NO_PROXY=${noProxy}`,
	];
	const systemdDefaults = `[Manager]\nDefaultEnvironment=${environment.map(line => JSON.stringify(line)).join(" ")}\n`;
	const block = (text: string): string =>
		text
			.split("\n")
			.map(line => (line ? `      ${line}` : ""))
			.join("\n");
	return `#cloud-config
hostname: ${JSON.stringify(`vm-${spec.name}`)}
manage_etc_hosts: true
ssh_pwauth: false
disable_root: true
package_update: false
package_upgrade: false
users:
  - name: ${JSON.stringify(spec.user)}
    gecos: ${JSON.stringify(spec.user)}
    groups: [sudo]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${JSON.stringify(spec.publicKey.trim())}
write_files:
  - path: /etc/apt/apt.conf.d/95omp-proxy
    permissions: "0644"
    content: |
${block(`Acquire::http::Proxy "${proxy}";\nAcquire::https::Proxy "${proxy}";`)}
  - path: /etc/environment
    append: true
    content: |
${block(environment.join("\n"))}
  - path: /etc/systemd/system.conf.d/omp-proxy.conf
    permissions: "0644"
    content: |
${block(systemdDefaults)}
  - path: /etc/systemd/user.conf.d/omp-proxy.conf
    permissions: "0644"
    content: |
${block(systemdDefaults)}
`;
}

/** ssh options shared by `exec`, readiness probes and the interactive shell. */
export function buildSshArgs(opts: {
	dir: string;
	name: string;
	user: string;
	port: number;
	connectTimeoutSec?: number;
}): string[] {
	return [
		"-F",
		"/dev/null",
		"-i",
		path.join(opts.dir, "id_ed25519"),
		"-p",
		String(opts.port),
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		"IdentityAgent=none",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${path.join(opts.dir, "known_hosts")}`,
		"-o",
		`HostKeyAlias=vm-${opts.name}`,
		"-o",
		"LogLevel=ERROR",
		"-o",
		`ConnectTimeout=${opts.connectTimeoutSec ?? 10}`,
		"-o",
		"ServerAliveInterval=15",
		`${opts.user}@127.0.0.1`,
	];
}

/** The instance image name and download URLs for `arch`. */
export function imageSource(arch: QemuArch): { file: string; url: string; sumsUrl: string } {
	const file = `noble-server-cloudimg-${arch === "aarch64" ? "arm64" : "amd64"}.img`;
	return { file, url: `${IMAGE_BASE_URL}/${file}`, sumsUrl: `${IMAGE_BASE_URL}/SHA256SUMS` };
}

/** The checksum of `file` from a `SHA256SUMS` listing (`<hex> *<name>` or `<hex>  <name>`). */
export function parseSha256Sums(sums: string, file: string): string | undefined {
	for (const line of sums.split("\n")) {
		const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line.trim());
		if (match && match[2] === file) return match[1].toLowerCase();
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Host probing

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], opts: { input?: string; cwd?: string } = {}): Promise<RunResult> {
	try {
		const proc = Bun.spawn(argv, {
			cwd: opts.cwd,
			stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function hostArch(): QemuArch | undefined {
	if (process.arch === "arm64") return "aarch64";
	if (process.arch === "x64") return "x86_64";
	return undefined;
}

const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function findBinary(name: string): string | undefined {
	const onPath = Bun.which(name);
	if (onPath) return onPath;
	for (const dir of BINARY_DIRS) {
		const candidate = path.join(dir, name);
		if (fsSync.existsSync(candidate)) return candidate;
	}
	return undefined;
}

function firmwareCandidates(qemuBinary: string): string[] {
	const share = path.join(path.dirname(fsSync.realpathSync(qemuBinary)), "..", "share", "qemu");
	return [
		path.join(share, "edk2-aarch64-code.fd"),
		"/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
		"/usr/local/share/qemu/edk2-aarch64-code.fd",
		"/usr/share/qemu/edk2-aarch64-code.fd",
		"/usr/share/AAVMF/AAVMF_CODE.fd",
		"/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw",
		"/usr/share/qemu-efi-aarch64/QEMU_EFI.fd",
		"/usr/share/edk2/aarch64/QEMU_EFI.fd",
	];
}

function findFirmware(qemuBinary: string): QemuFirmware | undefined {
	for (const candidate of firmwareCandidates(qemuBinary)) {
		try {
			const size = fsSync.statSync(candidate).size;
			return { kind: size === FIRMWARE_SIZE ? "pflash" : "bios", code: candidate };
		} catch {}
	}
	return undefined;
}

async function detectAccel(): Promise<QemuAccel | { reason: string }> {
	if (process.platform === "darwin") {
		const result = await run(["sysctl", "-n", "kern.hv_support"]);
		return result.stdout.trim() === "1"
			? "hvf"
			: { reason: "Hypervisor.framework is not available (kern.hv_support is not 1)" };
	}
	if (process.platform === "linux") {
		try {
			await fs.access("/dev/kvm", fsSync.constants.R_OK | fsSync.constants.W_OK);
			return "kvm";
		} catch {
			return { reason: "/dev/kvm is not accessible (enable KVM and add your user to the kvm group)" };
		}
	}
	return { reason: `QEMU VMs are not supported on ${process.platform}` };
}

async function freePort(): Promise<number> {
	const server = net.createServer();
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const port = (server.address() as net.AddressInfo).port;
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	return port;
}

// ---------------------------------------------------------------------------------------------------------------
// Image cache

const imageDownloads = new Map<string, Promise<string>>();

/**
 * The cached, verified Ubuntu cloud image for `arch`. The file name carries the checksum, so an image an
 * existing overlay is backed by is never replaced in place when Ubuntu publishes a new build.
 */
async function ensureImage(imagesDir: string, arch: QemuArch, log: (line: string) => void): Promise<string> {
	const source = imageSource(arch);
	const sumsResponse = await fetch(source.sumsUrl);
	if (!sumsResponse.ok) throw new Error(`cannot fetch ${source.sumsUrl}: HTTP ${sumsResponse.status}`);
	const expected = parseSha256Sums(await sumsResponse.text(), source.file);
	if (!expected) throw new Error(`${source.file} is not listed in ${source.sumsUrl}`);
	const target = path.join(imagesDir, `${source.file.replace(/\.img$/, "")}-${expected.slice(0, 16)}.img`);
	if (fsSync.existsSync(target)) return target;
	const pending = imageDownloads.get(target);
	if (pending) return pending;
	const download = (async () => {
		await fs.mkdir(imagesDir, { recursive: true, mode: 0o700 });
		const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
		try {
			log(`downloading ${source.url}`);
			const response = await fetch(source.url);
			if (!response.ok || !response.body) throw new Error(`cannot fetch ${source.url}: HTTP ${response.status}`);
			const total = Number(response.headers.get("content-length")) || 0;
			const hasher = new Bun.CryptoHasher("sha256");
			const handle = await fs.open(temp, "w", 0o600);
			let received = 0;
			let lastReported = 0;
			try {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					hasher.update(chunk);
					await handle.write(chunk);
					received += chunk.byteLength;
					if (total > 0 && received - lastReported >= total / 10) {
						lastReported = received;
						log(`downloading ${source.file}: ${Math.floor((received / total) * 100)}%`);
					}
				}
			} finally {
				await handle.close();
			}
			const actual = hasher.digest("hex");
			if (actual !== expected)
				throw new Error(`checksum mismatch for ${source.file}: expected ${expected}, got ${actual}`);
			await fs.rename(temp, target);
			log(`image ready: ${target}`);
			return target;
		} catch (error) {
			await fs.rm(temp, { force: true });
			throw error;
		}
	})();
	imageDownloads.set(target, download);
	try {
		return await download;
	} finally {
		imageDownloads.delete(target);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Seed ISO

async function buildSeedIso(dir: string, userData: string, metaData: string): Promise<string> {
	const sourceDir = path.join(dir, "seed-src");
	const isoPath = path.join(dir, "seed.iso");
	await fs.mkdir(sourceDir, { recursive: true });
	await Bun.write(path.join(sourceDir, "user-data"), userData);
	await Bun.write(path.join(sourceDir, "meta-data"), metaData);
	const files = [path.join(sourceDir, "user-data"), path.join(sourceDir, "meta-data")];
	let result: RunResult;
	if (process.platform === "darwin") {
		result = await run([
			"hdiutil",
			"makehybrid",
			"-iso",
			"-joliet",
			"-default-volume-name",
			"cidata",
			"-o",
			isoPath,
			sourceDir,
		]);
	} else if (findBinary("cloud-localds")) {
		result = await run(["cloud-localds", isoPath, files[0], files[1]]);
	} else if (findBinary("genisoimage")) {
		result = await run(["genisoimage", "-output", isoPath, "-volid", "cidata", "-joliet", "-rock", ...files]);
	} else if (findBinary("xorriso")) {
		result = await run(["xorriso", "-as", "mkisofs", "-o", isoPath, "-V", "cidata", "-J", "-r", ...files]);
	} else {
		throw new Error(
			"cannot build the cloud-init seed: install cloud-image-utils (cloud-localds), genisoimage or xorriso",
		);
	}
	if (result.code !== 0) throw new Error(`seed ISO creation failed: ${(result.stderr || result.stdout).trim()}`);
	await fs.rm(sourceDir, { recursive: true, force: true });
	return isoPath;
}

// ---------------------------------------------------------------------------------------------------------------
// Driver

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function createQemuDriver(opts: { home?: string } = {}): VmDriver {
	const home = opts.home ?? qemuHome();
	const imagesDir = path.join(home, "images");

	function instanceDir(name: string): string {
		if (!VM_NAME_PATTERN.test(name)) throw new Error(`invalid VM name: ${name}`);
		return path.join(home, name);
	}

	function readInstance(name: string): InstanceFile | undefined {
		try {
			return JSON.parse(fsSync.readFileSync(path.join(instanceDir(name), "instance.json"), "utf8")) as InstanceFile;
		} catch {
			return undefined;
		}
	}

	async function writeInstance(dir: string, instance: InstanceFile): Promise<void> {
		const target = path.join(dir, "instance.json");
		await Bun.write(`${target}.tmp`, JSON.stringify(instance));
		await fs.rename(`${target}.tmp`, target);
	}

	/** The qemu pid when the instance's process is alive (checked against the command line, so a recycled pid is not mistaken for it). */
	async function livePid(dir: string): Promise<number | undefined> {
		let pid: number;
		try {
			pid = Number.parseInt(fsSync.readFileSync(path.join(dir, "qemu.pid"), "utf8").trim(), 10);
		} catch {
			return undefined;
		}
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		try {
			process.kill(pid, 0);
		} catch {
			return undefined;
		}
		const ps = await run(["ps", "-o", "command=", "-p", String(pid)]);
		return ps.stdout.includes("qemu-system") && ps.stdout.includes(path.join(dir, "qemu.pid")) ? pid : undefined;
	}

	async function check(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
		const arch = hostArch();
		if (!arch) return { ok: false, reason: `unsupported CPU architecture: ${process.arch}` };
		const binaryName = `qemu-system-${arch}`;
		const qemu = findBinary(binaryName);
		if (!qemu) return { ok: false, reason: `${binaryName} not found on PATH (macOS: brew install qemu)` };
		if (!findBinary("qemu-img")) return { ok: false, reason: "qemu-img not found on PATH" };
		if (arch === "aarch64" && !findFirmware(qemu)) {
			return {
				ok: false,
				reason: "no aarch64 UEFI firmware found (edk2-aarch64-code.fd; macOS: brew install qemu)",
			};
		}
		const accel = await detectAccel();
		if (typeof accel !== "string") return { ok: false, reason: accel.reason };
		if (process.platform === "darwin" && !findBinary("hdiutil")) return { ok: false, reason: "hdiutil not found" };
		const version = await run([qemu, "--version"]);
		const match = /version (\S+)/.exec(version.stdout);
		if (version.code !== 0 || !match)
			return { ok: false, reason: `${binaryName} --version failed: ${version.stderr.trim()}` };
		return { ok: true, version: `${match[1]} (${accel})` };
	}

	/** The end of the guest's serial console, read from QEMU's ring buffer; empty once QEMU is gone. */
	async function serialTail(dir: string): Promise<string> {
		const text = await qmp(dir, "ringbuf-read", { device: "serial0", size: SERIAL_RING_BYTES, format: "utf8" });
		return typeof text === "string" ? text.slice(-SERIAL_TAIL_BYTES) : "";
	}

	async function boot(record: VmRecord, dir: string, o: VmDriverOptions, user: string): Promise<void> {
		const arch = hostArch();
		if (!arch) throw new Error(`unsupported CPU architecture: ${process.arch}`);
		const qemu = findBinary(`qemu-system-${arch}`);
		if (!qemu) throw new Error(`qemu-system-${arch} not found on PATH`);
		const accel = await detectAccel();
		if (typeof accel !== "string") throw new Error(accel.reason);
		if (!o.egressSocket) throw new Error("the qemu driver needs an egress socket");
		let firmware: QemuFirmware | undefined;
		if (arch === "aarch64") {
			firmware = findFirmware(qemu);
			if (!firmware) throw new Error("no aarch64 UEFI firmware found");
			if (firmware.kind === "pflash") {
				const vars = path.join(dir, "efi-vars.fd");
				if (!fsSync.existsSync(vars)) {
					const handle = await fs.open(vars, "w", 0o600);
					await handle.truncate(FIRMWARE_SIZE);
					await handle.close();
				}
				firmware.vars = vars;
			}
		}
		const sshPort = await freePort();
		await writeInstance(dir, { version: 1, user, sshPort, arch });
		const args = buildQemuArgs({
			arch,
			accel,
			cpus: record.cpus,
			memoryMiB: Math.round(record.memoryGiB * 1024),
			diskPath: path.join(dir, "disk.qcow2"),
			seedPath: path.join(dir, "seed.iso"),
			firmware,
			sshPort,
			hostSocket: o.hostSocket,
			egressSocket: o.egressSocket,
			dir,
		});
		await fs.rm(path.join(dir, "qemu.pid"), { force: true });
		await fs.rm(path.join(dir, "qmp.sock"), { force: true });
		o.log(`starting ${path.basename(qemu)} (ssh on 127.0.0.1:${sshPort})`);
		const result = await run([qemu, ...args]);
		if (result.code !== 0) throw new Error(`qemu failed to start: ${(result.stderr || result.stdout).trim()}`);
	}

	async function waitForSsh(name: string, dir: string, log: (line: string) => void): Promise<void> {
		const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
		let lastError = "";
		for (;;) {
			if (!(await livePid(dir))) {
				throw new Error("qemu exited before ssh came up");
			}
			const result = await exec(name, ["true"], { timeoutMs: 20_000 });
			if (result.code === 0) return;
			lastError = result.stderr.trim();
			if (Date.now() > deadline) {
				throw new Error(
					`ssh did not come up within ${SSH_READY_TIMEOUT_MS / 1000}s: ${lastError}\nSerial log tail:\n${await serialTail(dir)}`,
				);
			}
			log("waiting for ssh");
			await sleep(2000);
		}
	}

	async function exec(name: string, argv: string[], o: VmExecOptions = {}): Promise<VmExecResult> {
		const dir = instanceDir(name);
		const instance = readInstance(name);
		if (!instance) throw new Error(`VM ${name} does not exist`);
		const sshArgs = buildSshArgs({ dir, name, user: instance.user, port: instance.sshPort });
		const proc = Bun.spawn(["ssh", ...sshArgs, remoteCommand(argv)], {
			stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		const timer = o.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, o.timeoutMs)
			: undefined;
		const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
			const decoder = new TextDecoder();
			let text = "";
			for await (const chunk of stream) {
				const piece = decoder.decode(chunk, { stream: true });
				text += piece;
				if (piece) o.onOutput?.(piece);
			}
			const rest = decoder.decode();
			if (rest) {
				text += rest;
				o.onOutput?.(rest);
			}
			return text;
		};
		try {
			const [stdout, stderr, code] = await Promise.all([
				collect(proc.stdout as ReadableStream<Uint8Array>),
				collect(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			if (timedOut) return { code: 124, stdout, stderr: `${stderr}timed out after ${o.timeoutMs}ms\n` };
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Runs one QMP command; its `return` value, or undefined when QEMU did not answer within 5 seconds. */
	async function qmp(dir: string, command: string, args?: Record<string, unknown>): Promise<unknown> {
		const socketPath = path.join(dir, "qmp.sock");
		if (!fsSync.existsSync(socketPath)) return undefined;
		const done = Promise.withResolvers<unknown>();
		const socket = net.connect(socketPath);
		let buffered = "";
		let greeted = false;
		let answers = 0;
		const timer = setTimeout(() => done.resolve(undefined), 5000);
		socket.on("error", () => done.resolve(undefined));
		socket.on("data", chunk => {
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line) continue;
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof message !== "object" || message === null) continue;
				if (!greeted && "QMP" in message) {
					greeted = true;
					socket.write(
						`{"execute":"qmp_capabilities"}\n${JSON.stringify({ execute: command, ...(args ? { arguments: args } : {}) })}\n`,
					);
				} else if ("return" in message || "error" in message) {
					answers++;
					// The first answer is qmp_capabilities'; the second is the command's.
					if (answers === 2) done.resolve("return" in message ? message.return : undefined);
				}
			}
		});
		try {
			return await done.promise;
		} finally {
			clearTimeout(timer);
			socket.destroy();
		}
	}

	async function waitForExit(dir: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!(await livePid(dir))) return true;
			await sleep(250);
		}
		return !(await livePid(dir));
	}

	async function killInstance(dir: string): Promise<void> {
		const pid = await livePid(dir);
		if (pid === undefined) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await waitForExit(dir, 10_000);
	}

	async function stop(name: string): Promise<void> {
		const dir = instanceDir(name);
		if (!(await livePid(dir))) return;
		const asked = (await qmp(dir, "system_powerdown")) !== undefined;
		if (!asked || !(await waitForExit(dir, SHUTDOWN_TIMEOUT_MS))) await killInstance(dir);
		await fs.rm(path.join(dir, "qemu.pid"), { force: true });
	}

	return {
		name: "qemu",
		check,

		async create(o) {
			const { record } = o;
			const dir = instanceDir(record.name);
			const ready = await check();
			if (!ready.ok) throw new Error(`qemu driver unavailable: ${ready.reason}`);
			if (fsSync.existsSync(dir)) throw new Error(`VM instance ${record.name} already exists in ${dir}`);
			const arch = hostArch() as QemuArch;
			const qemuImg = findBinary("qemu-img") as string;
			const image = await ensureImage(imagesDir, arch, o.log);
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			const keyPath = path.join(dir, "id_ed25519");
			const keygen = await run([
				"ssh-keygen",
				"-q",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				`omp-vm-${record.name}`,
				"-f",
				keyPath,
			]);
			if (keygen.code !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
			await fs.chmod(keyPath, 0o600);
			const overlay = await run([
				qemuImg,
				"create",
				"-q",
				"-f",
				"qcow2",
				"-b",
				image,
				"-F",
				"qcow2",
				path.join(dir, "disk.qcow2"),
				`${record.diskGiB}G`,
			]);
			if (overlay.code !== 0)
				throw new Error(`qemu-img create failed: ${(overlay.stderr || overlay.stdout).trim()}`);
			const requested = os.userInfo().username.toLowerCase();
			const user = /^[a-z_][a-z0-9_-]{0,31}$/.test(requested) && requested !== "root" ? requested : "omp";
			const cloudInit: CloudInitSpec = {
				name: record.name,
				user,
				publicKey: await Bun.file(`${keyPath}.pub`).text(),
				instanceId: `vm-${record.name}-${crypto.randomBytes(4).toString("hex")}`,
			};
			o.log("building cloud-init seed");
			await buildSeedIso(dir, buildUserData(cloudInit), buildMetaData(cloudInit));
			await boot(record, dir, o, user);
			try {
				o.log("waiting for ssh");
				await waitForSsh(record.name, dir, () => {});
				o.log("waiting for cloud-init");
				const status = await exec(record.name, ["cloud-init", "status", "--wait"], {
					timeoutMs: SSH_READY_TIMEOUT_MS,
				});
				// 0 = done, 2 = done with recoverable errors; anything else means provisioning did not finish.
				if (status.code !== 0 && status.code !== 2) {
					throw new Error(`cloud-init failed (exit ${status.code}): ${(status.stdout + status.stderr).trim()}`);
				}
				if (status.code === 2) o.log(`cloud-init finished with recoverable errors: ${status.stdout.trim()}`);
			} catch (error) {
				await killInstance(dir);
				throw error;
			}
		},

		async start(o) {
			const dir = instanceDir(o.record.name);
			const instance = readInstance(o.record.name);
			if (!instance) throw new Error(`VM instance ${o.record.name} does not exist`);
			if (await livePid(dir)) return;
			await boot(o.record, dir, o, instance.user);
			try {
				o.log("waiting for ssh");
				await waitForSsh(o.record.name, dir, () => {});
			} catch (error) {
				await killInstance(dir);
				throw error;
			}
		},

		stop,

		async remove(name) {
			const dir = instanceDir(name);
			await killInstance(dir);
			await fs.rm(dir, { recursive: true, force: true });
		},

		async state(name): Promise<VmDriverState> {
			const dir = instanceDir(name);
			if (!fsSync.existsSync(path.join(dir, "instance.json"))) return "absent";
			return (await livePid(dir)) ? "running" : "stopped";
		},

		exec,

		interactiveShell(name) {
			const dir = instanceDir(name);
			const instance = readInstance(name);
			if (!instance) throw new Error(`VM ${name} does not exist`);
			return {
				argv: ["ssh", "-t", ...buildSshArgs({ dir, name, user: instance.user, port: instance.sshPort })],
				env: {},
			};
		},

		guestEndpoints(): VmGuestEndpoints {
			return { hostServices: `TCP:${GUEST_HOST_SERVICES_ADDRESS}:80`, egressProxy: GUEST_EGRESS_PROXY };
		},
	};
}
