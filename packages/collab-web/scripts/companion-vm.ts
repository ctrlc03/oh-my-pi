/**
 * Virtual machines in the companion (docs/vm-sessions.md, docs/collab.md → Virtual machines). The companion never links
 * the VM library: it runs `omp vm …` with its own `omp`, so what the app does is exactly what the command line does.
 *
 *   omp vm list --json                     the VMs and whether one can be created (`canVms` is "this works")
 *   omp vm create <name> --repo … [--template] --json   NDJSON progress, the last line `done` (with `pairUrl`, except a template) or `error`
 *   omp vm clone <template> --name <name> --json         a fresh VM from a template: the same lines, `done` with `pairUrl`
 *   omp vm start|stop|reset|delete <name> --json    the same
 *   omp vm pair <name> --json              {"url","expiresAt"}
 *   omp vm serve                           the supervisor: serves every VM's host socket; kept running here
 *
 * Long actions are jobs, one per VM name at a time: the request answers at once, progress lines show as `busy` on the
 * VM in `vm-list`, a failure as its `error`. The supervisor runs as a child of the companion while a VM exists or a
 * job runs, restarted with backoff, its output appended to `<vm root>/supervisor.log`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	isVmName,
	VM_DEFAULTS,
	VM_PAIR_URL_TTL_MS,
	type VmAction,
	type VmBusy,
	type VmCreateOptions,
	type VmEntry,
	type VmJobAction,
	type VmReadiness,
	type VmReply,
	type VmRequest,
	vmCreateProblem,
} from "@oh-my-pi/pi-wire/vm";

/** `omp vm list` and `omp vm pair` answer in seconds; anything longer is a stuck command. */
const QUICK_TIMEOUT_MS = 30_000;
/** After a failed probe, the next one waits this long. */
const PROBE_RETRY_MS = 60_000;
const CHECK_EVERY_MS = 15_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** A supervisor that ran this long was healthy: its next restart starts from the base delay again. */
const HEALTHY_MS = 60_000;
const SHUTDOWN_WAIT_MS = 3_000;
const STDERR_KEEP = 4_000;
/** Failed jobs of VMs the CLI does not list (a create that never wrote `vm.json`) are kept so the app can show why. */
const MAX_FAILURES = 50;

export interface VmRunOptions {
	/** Called with each line of stdout as it arrives. */
	onLine?(line: string): void;
	/** Kill the command after this long (exit code 124). */
	timeoutMs?: number;
	/** Kill the command when aborted. */
	signal?: AbortSignal;
}

export interface VmRunResult {
	code: number;
	stdout: string;
	/** The tail of stderr. */
	stderr: string;
}

/** Runs `omp vm <args>`. */
export type VmRunner = (args: string[], options?: VmRunOptions) => Promise<VmRunResult>;

/** A started `omp vm serve`. */
export interface VmSupervisorProcess {
	/** Resolves with the exit code once the process ended. */
	exited: Promise<number>;
	kill(): void;
}

export type VmSupervisorSpawn = (args: string[], logPath: string) => VmSupervisorProcess;

export interface VmFeatureOptions {
	ompBin: string;
	/** `<agent dir>/vm`; the CLI is told this root too, so both look at the same VMs. */
	vmRoot: string;
	log(message: string): void;
	/** A job finished or `canVms` changed: the `hosts` frame may differ. */
	onChange(): void;
	/** Test seam: how `omp vm …` runs. */
	run?: VmRunner;
	/** Test seam: how the supervisor starts. */
	spawn?: VmSupervisorSpawn;
	now?: () => number;
	/** First restart delay of the supervisor; doubles up to `restartMaxMs`. */
	restartBaseMs?: number;
	restartMaxMs?: number;
	/** How often the companion re-checks whether the supervisor is wanted and whether `omp vm` works. */
	checkEveryMs?: number;
}

export interface VmFeature {
	/** Probes `omp vm list --json` and starts the supervisor when a VM exists. Never rejects on a missing `omp vm`. */
	init(): Promise<void>;
	/** Stops the supervisor and the running jobs. */
	shutdown(): Promise<void>;
	/** Fields of the `hosts` frame. */
	hostsFields(): { canVms?: true };
	handle(request: VmRequest): Promise<VmReply>;
}

interface Job {
	action: VmJobAction;
	step: string;
	message: string;
	/** The create's options, to show the VM before the CLI lists it. */
	spec?: VmCreateOptions;
	startedAt: number;
}

interface VmListed {
	ready: VmReadiness;
	vms: Omit<VmEntry, "busy" | "pairUrl">[];
}

const GERUND: Record<VmJobAction, string> = {
	create: "Creating",
	clone: "Cloning",
	start: "Starting",
	stop: "Stopping",
	reset: "Resetting",
	delete: "Deleting",
};

export function createCliRunner(ompBin: string, vmRoot: string): VmRunner {
	return async (args, options = {}) => {
		const proc = Bun.spawn([ompBin, "vm", ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_VM_ROOT: vmRoot },
		});
		let timedOut = false;
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						proc.kill();
					}, options.timeoutMs);
		const abort = (): void => void proc.kill();
		if (options.signal?.aborted) abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const readStdout = async (): Promise<string> => {
				const decoder = new TextDecoder();
				let all = "";
				let pending = "";
				const flush = (text: string): void => {
					pending += text;
					for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
						const line = pending.slice(0, at).replace(/\r$/, "");
						pending = pending.slice(at + 1);
						if (line.trim() !== "") options.onLine?.(line);
					}
				};
				for await (const chunk of proc.stdout) {
					const text = decoder.decode(chunk, { stream: true });
					all += text;
					flush(text);
				}
				const rest = decoder.decode();
				all += rest;
				flush(`${rest}\n`);
				return all;
			};
			const [stdout, stderr, code] = await Promise.all([
				readStdout(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return {
				code: timedOut ? 124 : code,
				stdout,
				stderr: timedOut ? `timed out after ${options.timeoutMs}ms` : stderr.slice(-STDERR_KEEP),
			};
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		}
	};
}

/** `omp vm serve` with stdout and stderr appended to the log (mode 0600: it may name repositories and tokens' owners). */
export function createCliSupervisorSpawn(ompBin: string, vmRoot: string): VmSupervisorSpawn {
	return (args, logPath) => {
		fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
		const fd = fs.openSync(logPath, "a", 0o600);
		fs.chmodSync(logPath, 0o600);
		try {
			const proc = Bun.spawn([ompBin, ...args], {
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				env: { ...process.env, OMP_VM_ROOT: vmRoot },
			});
			const exited = proc.exited.finally(() => fs.closeSync(fd));
			return { exited, kill: () => proc.kill() };
		} catch (err) {
			fs.closeSync(fd);
			throw err;
		}
	};
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function lastLine(text: string): string {
	const lines = text.split("\n").filter(line => line.trim() !== "");
	return lines[lines.length - 1]?.trim() ?? "";
}

function parseListed(stdout: string): VmListed {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		parsed = JSON.parse(lastLine(stdout));
	}
	const value = parsed as Partial<VmListed> | null;
	if (typeof value?.ready?.ok !== "boolean" || !Array.isArray(value.vms)) throw new Error("unexpected output");
	return { ready: value.ready, vms: value.vms };
}

function createArgs(options: VmCreateOptions): string[] {
	const args = ["create", options.name];
	for (const repo of options.repos) args.push("--repo", repo);
	if (options.cpus !== undefined) args.push("--cpus", String(options.cpus));
	if (options.memoryGiB !== undefined) args.push("--memory", String(options.memoryGiB));
	if (options.diskGiB !== undefined) args.push("--disk", String(options.diskGiB));
	if (options.network !== undefined) args.push("--network", options.network);
	if (options.dailyCostUsd !== undefined) args.push("--daily-cost", String(options.dailyCostUsd));
	if (options.template === true) args.push("--template");
	args.push("--json");
	return args;
}

export function createVmFeature(options: VmFeatureOptions): VmFeature {
	const { ompBin, vmRoot, log, onChange } = options;
	const run = options.run ?? createCliRunner(ompBin, vmRoot);
	const spawn = options.spawn ?? createCliSupervisorSpawn(ompBin, vmRoot);
	const now = options.now ?? Date.now;
	const restartBaseMs = options.restartBaseMs ?? RESTART_BASE_MS;
	const restartMaxMs = options.restartMaxMs ?? RESTART_MAX_MS;
	const logPath = path.join(vmRoot, "supervisor.log");

	let available = false;
	let probedAt = Number.NEGATIVE_INFINITY;
	let lastProblem = "omp vm has not been checked yet";
	let stopped = false;
	const jobs = new Map<string, Job>();
	/** The last failed action per VM, shown as its `error` until the next action on it. */
	const failures = new Map<string, string>();
	const pairUrls = new Map<string, { url: string; until: number }>();
	const shutdownSignal = new AbortController();
	let checkTimer: Timer | undefined;

	let child: VmSupervisorProcess | null = null;
	let childStartedAt = 0;
	let restartTimer: Timer | undefined;
	let restartDelay = restartBaseMs;

	const setAvailable = (next: boolean, problem: string): void => {
		probedAt = now();
		lastProblem = problem;
		if (next === available) return;
		available = next;
		onChange();
	};

	/** Does `omp vm list --json` work? That is the capability; a failure is retried at most once a minute. */
	const listVms = async (): Promise<VmListed> => {
		const result = await run(["list", "--json"], { timeoutMs: QUICK_TIMEOUT_MS, signal: shutdownSignal.signal });
		if (result.code !== 0) {
			const problem = lastLine(result.stderr) || `omp vm list exited with ${result.code}`;
			setAvailable(false, problem);
			throw new Error(`omp vm is not available on this computer: ${problem}`);
		}
		let listed: VmListed;
		try {
			listed = parseListed(result.stdout);
		} catch (err) {
			const problem = `omp vm list printed something unexpected (${errorText(err)})`;
			setAvailable(false, problem);
			throw new Error(`omp vm is not available on this computer: ${problem}`);
		}
		setAvailable(true, "");
		return listed;
	};

	const probe = async (): Promise<void> => {
		try {
			await listVms();
		} catch (err) {
			log(`vm: ${errorText(err)}`);
		}
	};

	/** Refuses while `omp vm` does not work and was checked less than a minute ago. */
	const refuseWhileUnavailable = (): void => {
		if (!available && now() - probedAt < PROBE_RETRY_MS) {
			throw new Error(`omp vm is not available on this computer: ${lastProblem}`);
		}
	};

	/** Refuses while `omp vm` does not work, re-probing when the last probe is old enough. */
	const requireAvailable = async (): Promise<void> => {
		if (available) return;
		refuseWhileUnavailable();
		await probe();
		if (!available) throw new Error(`omp vm is not available on this computer: ${lastProblem}`);
	};

	/** Whether any VM exists: `omp vm` keeps one folder per VM, with its `vm.json`, under `<vm folder>/vms`. */
	const hasVmDirs = async (): Promise<boolean> => {
		const vmsDir = path.join(vmRoot, "vms");
		const names = await fsp.readdir(vmsDir).catch(() => [] as string[]);
		for (const entryName of names) {
			if (await Bun.file(path.join(vmsDir, entryName, "vm.json")).exists()) return true;
		}
		return false;
	};

	const stopChild = (): void => {
		clearTimeout(restartTimer);
		restartTimer = undefined;
		const proc = child;
		child = null;
		proc?.kill();
	};

	const startChild = (): void => {
		let proc: VmSupervisorProcess;
		try {
			proc = spawn(["vm", "serve"], logPath);
		} catch (err) {
			log(`vm: starting the supervisor failed: ${errorText(err)}`);
			scheduleRestart();
			return;
		}
		child = proc;
		childStartedAt = now();
		void proc.exited.then(
			code => onChildExit(proc, `exited with ${code}`),
			err => onChildExit(proc, `failed: ${errorText(err)}`),
		);
	};

	const scheduleRestart = (): void => {
		const delay = restartDelay;
		restartDelay = Math.min(restartDelay * 2, restartMaxMs);
		restartTimer = setTimeout(() => {
			restartTimer = undefined;
			void ensureSupervisor();
		}, delay);
	};

	const onChildExit = (proc: VmSupervisorProcess, how: string): void => {
		if (child !== proc) return;
		child = null;
		if (stopped) return;
		log(`vm: the supervisor ${how}; see ${logPath}`);
		if (now() - childStartedAt >= HEALTHY_MS) restartDelay = restartBaseMs;
		scheduleRestart();
	};

	/**
	 * Starts or stops the supervisor to match whether a VM exists or a job runs. A failed probe (`omp vm list` timing
	 * out under load) only keeps a supervisor from starting; one already running stays, so running VMs keep their
	 * model access and GitHub tokens.
	 */
	const ensureSupervisor = async (): Promise<void> => {
		if (stopped) return;
		const wanted = jobs.size > 0 || (await hasVmDirs());
		if (stopped) return;
		if (!wanted) {
			stopChild();
			restartDelay = restartBaseMs;
			return;
		}
		if (child !== null || restartTimer !== undefined) return;
		if (!available) return;
		startChild();
	};

	const tick = async (): Promise<void> => {
		if (!available && now() - probedAt >= PROBE_RETRY_MS) await probe();
		await ensureSupervisor();
	};

	const rememberFailure = (name: string, message: string): void => {
		failures.delete(name);
		failures.set(name, message);
		for (const oldest of failures.keys()) {
			if (failures.size <= MAX_FAILURES) break;
			failures.delete(oldest);
		}
	};

	/** Runs one NDJSON action to its end; resolves with the `done` line's pairUrl, rejects with the error text. */
	const runJob = async (name: string, action: VmJobAction, args: string[], spec?: VmCreateOptions): Promise<void> => {
		const job: Job = { action, step: "", message: `${GERUND[action]}…`, spec, startedAt: now() };
		jobs.set(name, job);
		failures.delete(name);
		void ensureSupervisor();
		const outcome: { pairUrl?: string; reported?: string; done: boolean } = { done: false };
		try {
			const result = await run(args, {
				signal: shutdownSignal.signal,
				onLine: line => {
					let parsed: { t?: unknown; step?: unknown; message?: unknown; pairUrl?: unknown };
					try {
						parsed = JSON.parse(line) as typeof parsed;
					} catch {
						return;
					}
					if (parsed === null || typeof parsed !== "object") return;
					if (parsed.t === "progress") {
						if (typeof parsed.step === "string") job.step = parsed.step;
						if (typeof parsed.message === "string") job.message = parsed.message;
					} else if (parsed.t === "done") {
						outcome.done = true;
						if (typeof parsed.pairUrl === "string") outcome.pairUrl = parsed.pairUrl;
					} else if (parsed.t === "error" && typeof parsed.message === "string") {
						outcome.reported = parsed.message;
					}
				},
			});
			const failure =
				outcome.reported ??
				(result.code !== 0 ? lastLine(result.stderr) || `omp vm ${action} exited with ${result.code}` : undefined);
			if (failure !== undefined) throw new Error(failure);
			if (!outcome.done) log(`vm: omp vm ${action} ${name} exited 0 without a done line`);
			if (outcome.pairUrl !== undefined) {
				pairUrls.set(name, { url: outcome.pairUrl, until: now() + VM_PAIR_URL_TTL_MS });
			}
			if (action === "delete") pairUrls.delete(name);
		} catch (err) {
			const message = errorText(err);
			log(`vm: ${action} ${name} failed: ${message}`);
			rememberFailure(name, message);
		} finally {
			jobs.delete(name);
			void ensureSupervisor();
			onChange();
		}
	};

	const startJob = (name: string, action: VmJobAction, args: string[], spec?: VmCreateOptions): void => {
		const running = jobs.get(name);
		if (running !== undefined) {
			throw new Error(`${name} is busy (${GERUND[running.action].toLowerCase()}); wait for it to finish`);
		}
		void runJob(name, action, args, spec);
	};

	const busyOf = (job: Job): VmBusy => ({ action: job.action, step: job.step, message: job.message });

	const entries = (listed: VmListed): VmEntry[] => {
		const out: VmEntry[] = [];
		const seen = new Set<string>();
		const time = now();
		for (const info of listed.vms) {
			seen.add(info.name);
			const entry: VmEntry = { ...info };
			const failure = failures.get(info.name);
			if (failure !== undefined) entry.error = failure;
			const job = jobs.get(info.name);
			if (job !== undefined) entry.busy = busyOf(job);
			const pair = pairUrls.get(info.name);
			if (pair !== undefined && pair.until > time) entry.pairUrl = pair.url;
			out.push(entry);
		}
		for (const [name, job] of jobs) {
			if (seen.has(name)) continue;
			seen.add(name);
			const spec = job.spec;
			out.push({
				name,
				repos: spec?.repos ?? [],
				cpus: spec?.cpus ?? VM_DEFAULTS.cpus,
				memoryGiB: spec?.memoryGiB ?? VM_DEFAULTS.memoryGiB,
				diskGiB: spec?.diskGiB ?? VM_DEFAULTS.diskGiB,
				network: spec?.network ?? VM_DEFAULTS.network,
				driver: "lima",
				status: job.action === "delete" ? "missing" : "creating",
				createdAt: job.startedAt,
				busy: busyOf(job),
			});
		}
		for (const [name, message] of failures) {
			if (seen.has(name)) continue;
			out.push({
				name,
				repos: [],
				cpus: VM_DEFAULTS.cpus,
				memoryGiB: VM_DEFAULTS.memoryGiB,
				diskGiB: VM_DEFAULTS.diskGiB,
				network: VM_DEFAULTS.network,
				driver: "lima",
				status: "failed",
				createdAt: 0,
				error: message,
			});
		}
		return out;
	};

	const requireName = (value: unknown): string => {
		if (!isVmName(value)) throw new Error("invalid VM name");
		return value;
	};

	const act = async (name: string, action: VmAction): Promise<void> => {
		if (action !== "start" && action !== "stop" && action !== "reset" && action !== "delete")
			throw new Error("invalid action");
		await requireAvailable();
		if (action === "delete" && !jobs.has(name) && failures.has(name)) {
			// A create that failed before the CLI wrote anything leaves only this note; deleting dismisses it.
			const listed = await listVms();
			if (!listed.vms.some(info => info.name === name)) {
				failures.delete(name);
				return;
			}
		}
		startJob(name, action, [action, name, "--json"]);
	};

	return {
		async init() {
			await probe();
			if (stopped) return;
			await ensureSupervisor();
			checkTimer = setInterval(
				() => void tick().catch(err => log(`vm: ${errorText(err)}`)),
				options.checkEveryMs ?? CHECK_EVERY_MS,
			);
			checkTimer.unref?.();
		},

		async shutdown() {
			stopped = true;
			clearInterval(checkTimer);
			shutdownSignal.abort();
			clearTimeout(restartTimer);
			restartTimer = undefined;
			const proc = child;
			child = null;
			if (proc === null) return;
			proc.kill();
			await Promise.race([proc.exited.catch(() => 0), Bun.sleep(SHUTDOWN_WAIT_MS)]);
		},

		hostsFields: () => (available ? { canVms: true } : {}),

		async handle(request) {
			switch (request.t) {
				case "vm-list": {
					refuseWhileUnavailable();
					const listed = await listVms();
					void ensureSupervisor();
					return { t: "vm-list", reqId: request.reqId, ready: listed.ready, vms: entries(listed) };
				}
				case "vm-create": {
					const { t: _t, reqId, ...create } = request;
					const problem = vmCreateProblem(create);
					if (problem !== null) throw new Error(problem);
					await requireAvailable();
					startJob(create.name, "create", createArgs(create), create);
					return { t: "vm-create", reqId, accepted: true };
				}
				case "vm-clone": {
					const template = requireName(request.template);
					const name = requireName(request.name);
					if (template === name) throw new Error("A fresh VM needs a name of its own.");
					await requireAvailable();
					startJob(name, "clone", ["clone", template, "--name", name, "--json"]);
					return { t: "vm-clone", reqId: request.reqId, accepted: true };
				}
				case "vm-action": {
					await act(requireName(request.name), request.action);
					return { t: "vm-action", reqId: request.reqId, accepted: true };
				}
				case "vm-pair": {
					const name = requireName(request.name);
					await requireAvailable();
					if (jobs.has(name)) throw new Error(`${name} is busy; pair it when it has finished`);
					const result = await run(["pair", name, "--json"], {
						timeoutMs: QUICK_TIMEOUT_MS,
						signal: shutdownSignal.signal,
					});
					if (result.code !== 0) {
						throw new Error(lastLine(result.stderr) || `omp vm pair exited with ${result.code}`);
					}
					let paired: { url?: unknown; expiresAt?: unknown };
					try {
						paired = JSON.parse(result.stdout.trim()) as typeof paired;
					} catch {
						throw new Error("omp vm pair printed something unexpected");
					}
					if (typeof paired.url !== "string" || typeof paired.expiresAt !== "number")
						throw new Error("omp vm pair printed something unexpected");
					pairUrls.delete(name);
					return { t: "vm-pair", reqId: request.reqId, url: paired.url, expiresAt: paired.expiresAt };
				}
			}
		},
	};
}
