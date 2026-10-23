import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VmDriver, VmDriverOptions, VmDriverState, VmExecOptions, VmExecResult, VmGuestEndpoints } from "./driver";
import { limaHome } from "./paths";
import type { VmRecord } from "./types";

/** Where the guest sees the host socket; `{{.Home}}` is Lima's template for the guest user's home. */
const GUEST_SOCKET_TEMPLATE = "{{.Home}}/.omp-host.sock";
const GUEST_SOCKET_NAME = ".omp-host.sock";

export interface LimaDriverOptions {
	/** LIMA_HOME; defaults to `<vm root>/lima`, so these instances never mix with the user's own. */
	home?: string;
	/** limactl binary; defaults to `limactl` on PATH. */
	limactl?: string;
	/** Image template the instances are based on. */
	base?: string;
}

/**
 * Lima template for one VM: Virtualization.framework, no mounts, no automatic port forwarding, the
 * host's loopback blocked, and the supervisor's socket reverse-forwarded into the guest.
 */
export function limaTemplate(record: VmRecord, hostSocket: string, base = "template:ubuntu-24.04"): string {
	const q = (value: string): string => JSON.stringify(value);
	return [
		"# Written by `omp vm`; edits are overwritten.",
		"minimumLimaVersion: 2.0.0",
		`base: ${q(base)}`,
		"vmType: vz",
		`cpus: ${record.cpus}`,
		`memory: ${q(`${record.memoryGiB}GiB`)}`,
		`disk: ${q(`${record.diskGiB}GiB`)}`,
		"mounts: []",
		"containerd:",
		"  system: false",
		"  user: false",
		"networkOpts:",
		"  # The guest runs untrusted code: it must not reach services on the host's 127.0.0.1.",
		"  hostLoopback: false",
		"portForwards:",
		`  - guestSocket: ${q(GUEST_SOCKET_TEMPLATE)}`,
		`    hostSocket: ${q(hostSocket)}`,
		"    reverse: true",
		"  # Nothing the guest listens on is exposed on the host.",
		'  - guestIP: "0.0.0.0"',
		"    guestPortRange: [1, 65535]",
		"    ignore: true",
		'  - guestIP: "127.0.0.1"',
		"    guestPortRange: [1, 65535]",
		"    ignore: true",
		"",
	].join("\n");
}

interface LimaInstance {
	name: string;
	status: string;
}

export function createLimaDriver(opts: LimaDriverOptions = {}): VmDriver {
	const limactl = opts.limactl ?? "limactl";
	const home = opts.home ?? limaHome();
	const env = (): Record<string, string> => ({ ...(process.env as Record<string, string>), LIMA_HOME: home });

	async function run(args: string[], execOpts: VmExecOptions = {}): Promise<VmExecResult> {
		await fs.mkdir(home, { recursive: true, mode: 0o700 });
		const proc = Bun.spawn([limactl, ...args], {
			env: env(),
			stdin: execOpts.stdin === undefined ? "ignore" : new Blob([execOpts.stdin]),
			stdout: "pipe",
			stderr: "pipe",
			timeout: execOpts.timeoutMs,
			killSignal: "SIGKILL",
		});
		const decoder = new TextDecoder();
		const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
			let text = "";
			for await (const chunk of stream) {
				const piece = decoder.decode(chunk, { stream: true });
				text += piece;
				execOpts.onOutput?.(piece);
			}
			return text;
		};
		const [stdout, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
		return { code, stdout, stderr };
	}

	async function instances(): Promise<LimaInstance[]> {
		const result = await run(["list", "--json"]);
		if (result.code !== 0) throw new Error(`limactl list failed: ${lastLines(result.stderr)}`);
		return result.stdout
			.split("\n")
			.filter(line => line.trim().startsWith("{"))
			.map(line => JSON.parse(line) as LimaInstance);
	}

	async function boot(options: VmDriverOptions, first: boolean): Promise<void> {
		const { record, dir, hostSocket, log } = options;
		const templatePath = path.join(dir, "lima.yaml");
		await Bun.write(templatePath, limaTemplate(record, hostSocket, opts.base));
		const args = first
			? ["start", "--tty=false", `--name=${record.name}`, templatePath]
			: ["start", "--tty=false", record.name];
		if (!first) {
			// Re-apply the current template (cpus, memory, socket path) to the existing instance.
			const edit = await run(["edit", "--tty=false", record.name, "--set", limaSetExpression(record, hostSocket)]);
			if (edit.code !== 0) log(`limactl edit: ${lastLines(edit.stderr)}`);
		}
		const result = await run(args, { onOutput: chunk => forwardLimaLog(chunk, log) });
		if (result.code !== 0) throw new Error(`limactl start failed: ${lastLines(result.stderr)}`);
	}

	return {
		name: "lima",
		async check() {
			if (process.platform !== "darwin") {
				return {
					ok: false,
					reason: "the lima driver blocks the host's loopback only with Virtualization.framework (macOS)",
				};
			}
			if (!Bun.which(limactl)) return { ok: false, reason: "limactl is not installed (brew install lima)" };
			const info = await run(["info"]);
			if (info.code !== 0) return { ok: false, reason: `limactl info failed: ${lastLines(info.stderr)}` };
			let parsed: {
				version?: string;
				vmTypes?: string[];
				defaultTemplate?: { networkOpts?: { hostLoopback?: unknown } };
			};
			try {
				parsed = JSON.parse(info.stdout);
			} catch {
				return { ok: false, reason: "limactl info printed something other than JSON" };
			}
			const version = parsed.version ?? "unknown";
			if (!parsed.vmTypes?.includes("vz"))
				return { ok: false, reason: "this Lima has no vz (Virtualization.framework) driver" };
			if (parsed.defaultTemplate?.networkOpts?.hostLoopback === undefined) {
				return {
					ok: false,
					reason: `Lima ${version} cannot block the host's loopback (networkOpts.hostLoopback needs Lima 2.3 or newer)`,
				};
			}
			return { ok: true, version };
		},
		async create(options) {
			await boot(options, true);
		},
		async start(options) {
			if ((await this.state(options.record.name)) === "running") return;
			await boot(options, false);
		},
		async clone(source, options) {
			const { record, dir, hostSocket, log } = options;
			if ((await this.state(source)) !== "stopped")
				throw new Error(`${source} must exist and be stopped to clone it`);
			if ((await this.state(record.name)) !== "absent")
				throw new Error(`a Lima instance named ${record.name} already exists`);
			// Written as `boot` does, so later boots re-apply the template with `limactl edit`.
			await Bun.write(path.join(dir, "lima.yaml"), limaTemplate(record, hostSocket, opts.base));
			const onOutput = (chunk: string): void => forwardLimaLog(chunk, log);
			const cloned = await run(
				["clone", "--tty=false", source, record.name, "--set", limaSetExpression(record, hostSocket)],
				{ onOutput },
			);
			if (cloned.code !== 0) throw new Error(`limactl clone failed: ${lastLines(cloned.stderr)}`);
			const started = await run(["start", "--tty=false", record.name], { onOutput });
			if (started.code !== 0) throw new Error(`limactl start failed: ${lastLines(started.stderr)}`);
		},
		async stop(name) {
			if ((await this.state(name)) !== "running") return;
			const result = await run(["stop", name]);
			if (result.code !== 0) throw new Error(`limactl stop failed: ${lastLines(result.stderr)}`);
		},
		async remove(name) {
			if ((await this.state(name)) === "absent") return;
			const result = await run(["delete", "--force", name]);
			if (result.code !== 0) throw new Error(`limactl delete failed: ${lastLines(result.stderr)}`);
		},
		async state(name): Promise<VmDriverState> {
			const found = (await instances()).find(instance => instance.name === name);
			if (!found) return "absent";
			return found.status === "Running" ? "running" : "stopped";
		},
		exec(name, argv, execOpts) {
			return run(["shell", "--workdir", "/", name, "--", ...argv], execOpts);
		},
		interactiveShell(name) {
			return {
				argv: [limactl, "shell", "--workdir", "/", name, "--", "bash", "-lc", "cd && exec bash -l"],
				env: { LIMA_HOME: home },
			};
		},
		guestEndpoints(): VmGuestEndpoints {
			// `%h` is the systemd specifier for the user's home: the shim runs as a systemd user unit.
			return { hostServices: `UNIX-CONNECT:%h/${GUEST_SOCKET_NAME}` };
		},
	};
}

/** `limactl edit --set` expression that brings an existing instance in line with the record. */
function limaSetExpression(record: VmRecord, hostSocket: string): string {
	return [
		`.cpus = ${record.cpus}`,
		`.memory = ${JSON.stringify(`${record.memoryGiB}GiB`)}`,
		`.portForwards[0].hostSocket = ${JSON.stringify(hostSocket)}`,
	].join(" | ");
}

/** Lima logs every step as logfmt on stderr; keep the human part of `msg=`. */
function forwardLimaLog(chunk: string, log: (line: string) => void): void {
	for (const line of chunk.split("\n")) {
		const match = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
		if (!match) continue;
		const msg = match[1].replaceAll('\\"', '"');
		if (LIMA_LOG_NOISE.some(pattern => pattern.test(msg))) continue;
		log(msg);
	}
}

/** Lima log lines that say nothing to someone waiting for their VM. */
const LIMA_LOG_NOISE = [
	/treating lima version/,
	/^\[hostagent\] Not forwarding/,
	/^\[hostagent\] gvproxy API request/,
	/^Terminal is not available/,
	/SSH server does not seem to be running on vsock/,
];

function lastLines(text: string, count = 5): string {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line && !line.includes("treating lima version"))
		.slice(-count)
		.join("\n");
}
