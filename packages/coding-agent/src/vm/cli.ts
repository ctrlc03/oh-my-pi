/**
 * `omp vm`: create and run per-repository Linux VMs that pair with the user's devices as their
 * own computers (docs/vm-sessions.md). `--json` output is what the collab companion consumes.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { validateAuthGatewayClient } from "@oh-my-pi/pi-ai/auth-gateway";
import { isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import { IS_FORK_BUILD, RELEASE_REPO } from "../build-identity";
import { gatewayRoutableProviders } from "../cli/auth-gateway-cli";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import type { VmDriver, VmDriverOptions } from "./driver";
import { defaultDriverFor, getVmDriver } from "./drivers";
import { loadGithubApp, runVmGithubCommand } from "./github";
import {
	type GuestIdentity,
	guestModelsYaml,
	guestSystemScript,
	guestUserScript,
	parsePairUrl,
	shellQuote,
} from "./guest";
import { getVmRoot, vmDir, vmEgressSocket, vmHostSocket, vmProvisionLog } from "./paths";
import { readLiveSupervisor, SupervisorRunningError, startVmSupervisor, waitForSupervisor } from "./supervisor";
import { assertVmName, listVmRecords, readVmRecord, removeVmDir, writeVmRecord } from "./store";
import type {
	VmDriverName,
	VmInfo,
	VmListOutput,
	VmNetworkMode,
	VmProgressLine,
	VmReadiness,
	VmRecord,
	VmStatus,
} from "./types";

export const VM_ACTIONS = [
	"init",
	"github",
	"create",
	"list",
	"start",
	"stop",
	"shell",
	"pair",
	"reset",
	"delete",
	"logs",
	"serve",
] as const;
export type VmAction = (typeof VM_ACTIONS)[number];

export interface VmCommandFlags {
	json?: boolean;
	repo?: string[];
	cpus?: number;
	memory?: number;
	disk?: number;
	network?: string;
	allowHost?: string[];
	branchPrefix?: string;
	model?: string[];
	dailyTokens?: number;
	dailyCost?: number;
	owner?: string;
	appId?: number;
	key?: string;
	yes?: boolean;
	idleExit?: boolean;
}

const DEFAULTS = { cpus: 4, memoryGiB: 8, diskGiB: 60 } as const;
const SUPERVISOR_WAIT_MS = 30_000;
/** A supervisor `create` started on its own stops after this long without any VM. */
const IDLE_EXIT_MS = 5 * 60_000;
/** The fork's installer: the guest needs the fork's omp and companion. */
const INSTALLER_REPO = IS_FORK_BUILD ? RELEASE_REPO : "ctrlc03/oh-my-pi";

function installerUrl(): string {
	if (process.env.OMP_VM_INSTALLER_URL) return process.env.OMP_VM_INSTALLER_URL;
	const [owner, name] = INSTALLER_REPO.split("/");
	return `https://${owner}.github.io/${name}/install.sh`;
}

/** Reports progress as NDJSON (`--json`) or as plain lines. */
class Reporter {
	constructor(readonly json: boolean) {}

	progress(step: string, message: string): void {
		this.#emit({ t: "progress", step, message }, `${message}`);
	}

	done(line: Omit<Extract<VmProgressLine, { t: "done" }>, "t">, text: string): void {
		this.#emit({ t: "done", ...line }, text);
	}

	error(message: string): void {
		if (this.json) process.stdout.write(`${JSON.stringify({ t: "error", message } satisfies VmProgressLine)}\n`);
		else process.stderr.write(`omp vm: ${message}\n`);
	}

	#emit(line: VmProgressLine, text: string): void {
		process.stdout.write(this.json ? `${JSON.stringify(line)}\n` : `${text}\n`);
	}
}

export async function runVmCommand(action: VmAction, args: string[], flags: VmCommandFlags): Promise<void> {
	const reporter = new Reporter(flags.json === true);
	try {
		switch (action) {
			case "init":
				await initCommand(flags);
				break;
			case "github": {
				const [sub, ...rest] = args;
				if (sub !== "setup" && sub !== "status" && sub !== "protect") {
					throw new Error("usage: omp vm github setup|status|protect <owner/repo>");
				}
				await runVmGithubCommand(sub, flags.yes ? [...rest, "--yes"] : rest, {
					owner: flags.owner,
					json: flags.json,
					appId: flags.appId,
					key: flags.key,
				});
				break;
			}
			case "list":
				await listCommand(flags);
				break;
			case "create":
				await createCommand(requireName(args), flags, reporter);
				break;
			case "start":
				await startCommand(requireName(args), reporter);
				break;
			case "stop":
				await stopCommand(requireName(args), reporter);
				break;
			case "reset":
				await resetCommand(requireName(args), reporter);
				break;
			case "delete":
				await deleteCommand(requireName(args), reporter);
				break;
			case "pair":
				await pairCommand(requireName(args), flags);
				break;
			case "shell":
				await shellCommand(requireName(args));
				break;
			case "logs":
				await logsCommand(requireName(args));
				break;
			case "serve":
				await serveCommand(flags.idleExit === true);
				break;
		}
	} catch (err) {
		reporter.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

function requireName(args: string[]): string {
	const name = args[0];
	if (!name) throw new Error("name the VM: omp vm <action> <name>");
	assertVmName(name);
	return name;
}

async function requireRecord(name: string): Promise<VmRecord> {
	const record = await readVmRecord(name);
	if (!record) throw new Error(`no VM named ${name} (omp vm list shows them)`);
	return record;
}

// ── readiness and listing ────────────────────────────────────────────────────

async function readiness(): Promise<VmReadiness> {
	const drivers: Record<VmDriverName, string | null> = { lima: null, qemu: null };
	const reasons: Partial<Record<VmDriverName, string>> = {};
	for (const name of ["lima", "qemu"] as const) {
		const check = await getVmDriver(name).check();
		if (check.ok) drivers[name] = check.version;
		else reasons[name] = check.reason;
	}
	const app = await loadGithubApp();
	const github = app
		? { configured: true, slug: app.config.slug, owners: Object.keys(app.config.installations) }
		: { configured: false };
	const defaultDriver = defaultDriverFor("open");
	let reason: string | undefined;
	if (!drivers[defaultDriver]) reason = reasons[defaultDriver];
	else if (!app) reason = "no GitHub App is set up: run `omp vm github setup`";
	return { ok: reason === undefined, reason, drivers, github, supervisor: readLiveSupervisor() !== null };
}

async function vmInfo(record: VmRecord): Promise<VmInfo> {
	let status: VmStatus;
	if (record.phase === "creating") status = "creating";
	else if (record.phase === "failed") status = "failed";
	else {
		const state = await getVmDriver(record.driver)
			.state(record.name)
			.catch(() => "absent" as const);
		status = state === "absent" ? "missing" : state;
	}
	return {
		name: record.name,
		repos: record.repos,
		cpus: record.cpus,
		memoryGiB: record.memoryGiB,
		diskGiB: record.diskGiB,
		network: record.network,
		driver: record.driver,
		status,
		createdAt: record.createdAt,
		...(record.provisionedAt ? { provisionedAt: record.provisionedAt } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.budget ? { budget: record.budget } : {}),
	};
}

async function listCommand(flags: VmCommandFlags): Promise<void> {
	const [ready, records] = await Promise.all([readiness(), listVmRecords()]);
	const vms = await Promise.all(records.map(vmInfo));
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ ready, vms } satisfies VmListOutput)}\n`);
		return;
	}
	if (!ready.ok) console.log(`not ready: ${ready.reason}\n`);
	if (vms.length === 0) {
		console.log("no VMs; create one with: omp vm create <name> --repo owner/repo");
		return;
	}
	for (const vm of vms) {
		const detail = vm.error ? ` — ${vm.error}` : "";
		console.log(
			`${vm.name.padEnd(16)} ${vm.status.padEnd(9)} ${vm.network.padEnd(9)} ${vm.cpus} CPU, ${vm.memoryGiB} GiB, ${vm.diskGiB} GiB disk  ${vm.repos.join(", ")}${detail}`,
		);
	}
}

async function initCommand(flags: VmCommandFlags): Promise<void> {
	await fs.mkdir(getVmRoot(), { recursive: true, mode: 0o700 });
	const ready = await readiness();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(ready)}\n`);
		return;
	}
	const mark = (ok: boolean): string => (ok ? "ok " : "-- ");
	console.log(`${mark(ready.drivers.lima !== null)} lima ${ready.drivers.lima ?? "(unavailable)"}`);
	console.log(
		`${mark(ready.drivers.qemu !== null)} qemu ${ready.drivers.qemu ?? "(unavailable; needed for --network allowlist)"}`,
	);
	console.log(
		`${mark(ready.github.configured)} GitHub App ${ready.github.configured ? `${ready.github.slug} on ${ready.github.owners?.join(", ") || "no account yet"}` : "(not set up)"}`,
	);
	console.log(
		`${mark(ready.supervisor)} supervisor ${ready.supervisor ? "running" : "not running (the companion starts it; or run omp vm serve)"}`,
	);
	if (ready.ok) console.log("\nready: omp vm create <name> --repo owner/repo");
	else console.log(`\nnext: ${ready.reason}`);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function driverOptions(record: VmRecord, driver: VmDriver, log: (line: string) => void): VmDriverOptions {
	return {
		record,
		dir: vmDir(record.name),
		hostSocket: vmHostSocket(record.name),
		...(driver.name === "qemu" ? { egressSocket: vmEgressSocket(record.name) } : {}),
		log,
	};
}

/** The supervisor serves the VM's sockets; start one when none runs (the companion normally does). */
async function ensureSupervisor(reporter: Reporter): Promise<void> {
	if (readLiveSupervisor()) return;
	if (await waitForSupervisor(3_000)) return;
	reporter.progress("supervisor", "starting the VM supervisor");
	const self = process.argv[1]?.endsWith(".ts") ? [process.execPath, process.argv[1]] : [process.execPath];
	const child = Bun.spawn([...self, "vm", "serve", "--idle-exit"], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	child.unref();
	if (!(await waitForSupervisor(SUPERVISOR_WAIT_MS))) {
		throw new Error("the VM supervisor did not start (try `omp vm serve` in a terminal to see why)");
	}
}

async function hostProviders(): Promise<string[]> {
	const settings = await Settings.init({ cwd: os.homedir() });
	const storage = await discoverAuthStorage(undefined, { settings });
	try {
		return [...gatewayRoutableProviders(storage, settings)];
	} finally {
		storage.close();
	}
}

async function guestIdentity(record: VmRecord): Promise<GuestIdentity> {
	const app = await loadGithubApp();
	if (app) return app.config.bot;
	return { name: `omp VM ${record.name}`, email: `vm-${record.name}@localhost` };
}

function parseRepos(values: string[] | undefined): string[] {
	const repos = [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))];
	if (repos.length === 0) throw new Error("give at least one repository: --repo owner/repo");
	for (const repo of repos) {
		if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`not an owner/repo: ${repo}`);
	}
	const owners = new Set(repos.map(repo => repo.split("/")[0].toLowerCase()));
	if (owners.size > 1) throw new Error("all of a VM's repositories must belong to one GitHub owner");
	return repos;
}

function positive(value: number | undefined, label: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
	return value;
}

async function createCommand(name: string, flags: VmCommandFlags, reporter: Reporter): Promise<void> {
	if (await readVmRecord(name)) throw new Error(`a VM named ${name} already exists`);
	const repos = parseRepos(flags.repo);
	const network = (flags.network ?? "open") as VmNetworkMode;
	if (network !== "open" && network !== "allowlist") throw new Error("--network is open or allowlist");
	const driverName = defaultDriverFor(network);
	const driver = getVmDriver(driverName);
	const check = await driver.check();
	if (!check.ok) throw new Error(`the ${driverName} driver is unavailable: ${check.reason}`);
	const app = await loadGithubApp();
	if (!app) throw new Error("no GitHub App is set up: run `omp vm github setup` first");
	const branchPrefix = flags.branchPrefix?.trim();
	if (branchPrefix !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchPrefix)) {
		throw new Error("--branch-prefix takes letters, digits, '.', '_', '-' and '/', e.g. omp/");
	}
	const budget = {
		...(flags.dailyTokens !== undefined ? { dailyTokens: positive(flags.dailyTokens, "--daily-tokens", 0) } : {}),
		...(flags.dailyCost !== undefined ? { dailyCostUsd: positive(flags.dailyCost, "--daily-cost", 0) } : {}),
	};
	const record: VmRecord = {
		version: 1,
		name,
		repos,
		cpus: Math.round(positive(flags.cpus, "--cpus", DEFAULTS.cpus)),
		memoryGiB: positive(flags.memory, "--memory", DEFAULTS.memoryGiB),
		diskGiB: Math.round(positive(flags.disk, "--disk", DEFAULTS.diskGiB)),
		network,
		driver: driverName,
		...(flags.allowHost?.length ? { allowHosts: flags.allowHost } : {}),
		...(branchPrefix ? { branchPrefix } : {}),
		...(flags.model?.length ? { models: flags.model } : {}),
		...(Object.keys(budget).length > 0 ? { budget } : {}),
		phase: "creating",
		createdAt: Date.now(),
	};
	// The supervisor admits the VM as a gateway client with these grants; refuse what it would refuse.
	validateAuthGatewayClient({
		name,
		tokenSha256: "0".repeat(64),
		...(record.models ? { models: record.models } : {}),
		...(record.budget ? { budget: record.budget } : {}),
	});
	await writeVmRecord(record);
	try {
		await ensureSupervisor(reporter);
		const ready = await provision(record, driver, reporter, { fresh: true });
		const pairing = await pairVm(ready, driver);
		const info = await vmInfo(ready);
		reporter.done(
			{ vm: info, pairUrl: pairing.url },
			`VM ${name} is ready. Pair it from the app (Settings → Computers), or open:\n${pairing.url}`,
		);
	} catch (err) {
		await markFailed(record, err);
		throw err;
	}
}

async function markFailed(record: VmRecord, err: unknown): Promise<void> {
	const current = (await readVmRecord(record.name)) ?? record;
	await writeVmRecord({ ...current, phase: "failed", error: err instanceof Error ? err.message : String(err) });
}

/**
 * Boots (creating when `fresh`) and provisions the VM, then marks it ready. The transcript goes to
 * `provision.log`; lines the scripts prefix with `omp-vm:` become progress.
 */
async function provision(
	record: VmRecord,
	driver: VmDriver,
	reporter: Reporter,
	opts: { fresh: boolean },
): Promise<VmRecord> {
	const logPath = vmProvisionLog(record.name);
	await fs.writeFile(logPath, "", { mode: 0o600 });
	const log = (line: string): void => {
		void fs.appendFile(logPath, line.endsWith("\n") ? line : `${line}\n`);
	};
	const onOutput = (chunk: string): void => {
		log(chunk);
		for (const line of chunk.split("\n")) {
			const match = /^omp-vm: (.+)$/.exec(line.trim());
			if (match) reporter.progress("provision", match[1]);
		}
	};
	const options = driverOptions(record, driver, line => {
		log(line);
		reporter.progress("boot", line);
	});
	reporter.progress("boot", opts.fresh ? `creating the ${driver.name} VM` : "starting the VM");
	if (opts.fresh) await driver.create(options);
	else await driver.start(options);

	const whoami = await driver.exec(record.name, ["id", "-un"]);
	if (whoami.code !== 0) throw new Error(`cannot run commands in the VM: ${whoami.stderr.trim()}`);
	const user = whoami.stdout.trim();
	const guest = {
		record,
		endpoints: driver.guestEndpoints(record),
		providers: await hostProviders(),
		installerUrl: installerUrl(),
		identity: await guestIdentity(record),
	};
	const system = await driver.exec(record.name, ["sudo", "bash", "-s"], {
		stdin: guestSystemScript(guest, user),
		onOutput,
	});
	if (system.code !== 0) throw new Error(`system setup failed (see omp vm logs ${record.name})`);
	const userPart = await driver.exec(record.name, ["bash", "-s"], { stdin: guestUserScript(guest), onOutput });
	if (userPart.code !== 0) throw new Error(`setup failed (see omp vm logs ${record.name})`);
	const latest = (await readVmRecord(record.name)) ?? record;
	const { error: _error, ...rest } = latest;
	const ready: VmRecord = { ...rest, phase: "ready", provisionedAt: Date.now() };
	await writeVmRecord(ready);
	return ready;
}

/** A fresh one-time pairing link from the VM's companion. */
async function pairVm(record: VmRecord, driver: VmDriver): Promise<{ url: string; expiresAt: number }> {
	const result = await driver.exec(record.name, ["bash", "-lc", "~/.local/bin/omp companion --pair"], {
		timeoutMs: 60_000,
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const url = parsePairUrl(output);
	if (!url)
		throw new Error(`the VM's companion printed no pairing link: ${output.trim().split("\n").slice(-3).join(" ")}`);
	const minutes = /expires in (\d+) minutes/.exec(output);
	return { url, expiresAt: Date.now() + (minutes ? Number(minutes[1]) : 10) * 60_000 };
}

async function startCommand(name: string, reporter: Reporter): Promise<void> {
	const record = await requireRecord(name);
	if (record.phase !== "ready") throw new Error(`VM ${name} is ${record.phase}; reset or delete it`);
	const driver = getVmDriver(record.driver);
	await ensureSupervisor(reporter);
	reporter.progress("boot", "starting the VM");
	await driver.start(driverOptions(record, driver, line => reporter.progress("boot", line)));
	// Providers the host logged into since the last boot reach the VM's model config.
	const models = await driver.exec(name, ["bash", "-c", "cat > ~/.omp/agent/models.yml"], {
		stdin: guestModelsYaml(await hostProviders()),
	});
	if (models.code !== 0) reporter.progress("models", `could not update the VM's models.yml: ${models.stderr.trim()}`);
	reporter.done({ vm: await vmInfo(record) }, `VM ${name} is running`);
}

async function stopCommand(name: string, reporter: Reporter): Promise<void> {
	const record = await requireRecord(name);
	reporter.progress("stop", "stopping the VM");
	await getVmDriver(record.driver).stop(name);
	reporter.done({ vm: await vmInfo(record) }, `VM ${name} is stopped`);
}

async function deleteCommand(name: string, reporter: Reporter): Promise<void> {
	const record = await requireRecord(name);
	reporter.progress("delete", "deleting the VM and its disk");
	await getVmDriver(record.driver).remove(name);
	// The supervisor notices the directory is gone, closes the VM's sockets and revokes its GitHub token.
	await removeVmDir(name);
	reporter.done({ deleted: true }, `VM ${name} is deleted`);
}

/**
 * Rebuilds the VM from a fresh image, keeping its name, repositories and limits. Nothing comes over from the old
 * guest: its companion state (the paired devices) is guest-written and may be what went wrong, so the new VM pairs
 * again. A new `createdAt` makes the supervisor treat it as a new VM, revoking the old one's GitHub token.
 */
async function resetCommand(name: string, reporter: Reporter): Promise<void> {
	const record = await requireRecord(name);
	const driver = getVmDriver(record.driver);
	const check = await driver.check();
	if (!check.ok) throw new Error(`the ${record.driver} driver is unavailable: ${check.reason}`);
	reporter.progress("reset", "deleting the old VM");
	await driver.remove(name);
	const { error: _error, provisionedAt: _provisionedAt, ...rest } = record;
	const fresh: VmRecord = { ...rest, phase: "creating", createdAt: Date.now() };
	await writeVmRecord(fresh);
	try {
		await ensureSupervisor(reporter);
		const ready = await provision(fresh, driver, reporter, { fresh: true });
		const pairUrl = (await pairVm(ready, driver)).url;
		reporter.done(
			{ vm: await vmInfo(ready), pairUrl },
			`VM ${name} is rebuilt; pair it again (and remove the old computer from your devices):\n${pairUrl}`,
		);
	} catch (err) {
		await markFailed(fresh, err);
		throw err;
	}
}

async function pairCommand(name: string, flags: VmCommandFlags): Promise<void> {
	const record = await requireRecord(name);
	const driver = getVmDriver(record.driver);
	if ((await driver.state(name)) !== "running") throw new Error(`VM ${name} is not running: omp vm start ${name}`);
	const pairing = await pairVm(record, driver);
	if (flags.json) process.stdout.write(`${JSON.stringify(pairing)}\n`);
	else console.log(`open this link on the device to pair (works once, expires in 10 minutes):\n${pairing.url}`);
}

async function shellCommand(name: string): Promise<void> {
	const record = await requireRecord(name);
	const driver = getVmDriver(record.driver);
	if ((await driver.state(name)) !== "running") throw new Error(`VM ${name} is not running: omp vm start ${name}`);
	const shell = driver.interactiveShell(name);
	const child = Bun.spawn(shell.argv, {
		env: { ...process.env, ...shell.env },
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exitCode = await child.exited;
}

async function logsCommand(name: string): Promise<void> {
	await requireRecord(name);
	try {
		process.stdout.write(await fs.readFile(vmProvisionLog(name), "utf8"));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		console.log("no provisioning log yet");
	}
}

/**
 * Runs the supervisor until SIGINT/SIGTERM. When another one serves, waits as a standby and takes over once it
 * exits, so the companion's child and a supervisor `create` started on its own never fight. With `idleExit` (how
 * `create` starts one) it exits after {@link IDLE_EXIT_MS} without any VM.
 */
async function serveCommand(idleExit: boolean): Promise<void> {
	let stopping = false;
	let wake: (() => void) | undefined;
	const stop = (): void => {
		stopping = true;
		wake?.();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let handle: Awaited<ReturnType<typeof startVmSupervisor>> | undefined;
	let announced = false;
	while (!stopping && !handle) {
		try {
			handle = await startVmSupervisor({ log: message => console.log(message) });
		} catch (err) {
			if (!(err instanceof SupervisorRunningError)) throw err;
			if (!announced) console.log(`${err.message}; standing by to take over`);
			announced = true;
			await new Promise<void>(resolve => {
				wake = resolve;
				setTimeout(resolve, 2_000);
			});
		}
	}
	if (!handle) return;
	console.log(`omp vm supervisor (pid ${process.pid}) serving ${getVmRoot()}`);
	const supervisor = handle;
	wake = () => void supervisor.close();
	if (stopping) void supervisor.close();
	let idleSince = Date.now();
	const idleTimer = idleExit
		? setInterval(async () => {
				if ((await listVmRecords()).length > 0) idleSince = Date.now();
				else if (Date.now() - idleSince >= IDLE_EXIT_MS) void supervisor.close();
			}, 30_000)
		: undefined;
	await supervisor.closed;
	clearInterval(idleTimer);
	await postmortem.quit(0);
}

export { shellQuote };
