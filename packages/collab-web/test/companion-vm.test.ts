import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VmListOutput } from "@oh-my-pi/pi-coding-agent/vm/types";
import type { VmEntry, VmReply, VmRequest } from "@oh-my-pi/pi-wire/vm";
import {
	createCliRunner,
	createVmFeature,
	type VmFeature,
	type VmRunOptions,
	type VmRunResult,
	type VmSupervisorProcess,
} from "../scripts/companion-vm";

const dirs: string[] = [];
const features: VmFeature[] = [];

afterEach(async () => {
	bus.clear();
	for (const feature of features.splice(0)) await feature.shutdown();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "companion-vm-test-"));
	dirs.push(dir);
	return dir;
}

/** Things the feature did (a change reported, a supervisor started or stopped); tests wait on these, not on the clock. */
const bus = new Set<() => void>();
const emit = (): void => {
	for (const listener of [...bus]) listener();
};

function until(check: () => boolean): Promise<void> {
	if (check()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const listener = (): void => {
		if (!check()) return;
		bus.delete(listener);
		resolve();
	};
	bus.add(listener);
	return promise;
}

const READY: VmListOutput["ready"] = {
	ok: true,
	drivers: { lima: "2.3.0", qemu: null },
	github: { configured: true, slug: "omp-vm", owners: ["acme"] },
	supervisor: true,
};

const INFO: VmListOutput["vms"][number] = {
	name: "api",
	repos: ["acme/api"],
	cpus: 4,
	memoryGiB: 8,
	diskGiB: 60,
	network: "open",
	driver: "lima",
	status: "running",
	createdAt: 1,
};

interface RunningJob {
	args: string[];
	/** One NDJSON line on the command's stdout. */
	say(line: object): void;
	finish(code?: number, stderr?: string): void;
}

/** A scripted `omp vm`: `list` answers `listed`, `pair` answers `paired`; every other command is a job the test drives. */
function fakeCli() {
	const state = {
		listed: { ready: READY, vms: [INFO] } as VmListOutput | null,
		listError: "lima not found",
		paired: { url: "https://my.omp.sh/#pair:fresh", expiresAt: 99 },
	};
	const calls: string[][] = [];
	const jobs: RunningJob[] = [];
	const run = (args: string[], options: VmRunOptions = {}): Promise<VmRunResult> => {
		calls.push(args);
		if (args[0] === "list") {
			return Promise.resolve(
				state.listed === null
					? { code: 1, stdout: "", stderr: state.listError }
					: { code: 0, stdout: JSON.stringify(state.listed), stderr: "" },
			);
		}
		if (args[0] === "pair") return Promise.resolve({ code: 0, stdout: JSON.stringify(state.paired), stderr: "" });
		const { promise, resolve } = Promise.withResolvers<VmRunResult>();
		jobs.push({
			args,
			say: line => options.onLine?.(JSON.stringify(line)),
			finish: (code = 0, stderr = "") => resolve({ code, stdout: "", stderr }),
		});
		return promise;
	};
	return { state, calls, jobs, run };
}

interface FakeSupervisor extends VmSupervisorProcess {
	args: string[];
	logPath: string;
	killed: boolean;
	startedAt: number;
	exit(code: number): void;
}

function fakeSpawn() {
	const procs: FakeSupervisor[] = [];
	const spawn = (args: string[], logPath: string): VmSupervisorProcess => {
		const { promise, resolve } = Promise.withResolvers<number>();
		const proc: FakeSupervisor = {
			args,
			logPath,
			killed: false,
			startedAt: performance.now(),
			exited: promise,
			exit: resolve,
			kill() {
				proc.killed = true;
				resolve(143);
				emit();
			},
		};
		procs.push(proc);
		emit();
		return proc;
	};
	return { procs, spawn };
}

async function setup(
	options: { vmDirs?: string[]; restartBaseMs?: number; checkEveryMs?: number; now?: () => number } = {},
) {
	const vmRoot = await tmp();
	for (const name of options.vmDirs ?? []) {
		await fs.mkdir(path.join(vmRoot, "vms", name), { recursive: true });
		await Bun.write(path.join(vmRoot, "vms", name, "vm.json"), "{}");
	}
	const cli = fakeCli();
	const sup = fakeSpawn();
	const changes = { count: 0 };
	const feature = createVmFeature({
		ompBin: "omp",
		vmRoot,
		log: () => {},
		onChange: () => {
			changes.count++;
			emit();
		},
		run: cli.run,
		spawn: sup.spawn,
		restartBaseMs: options.restartBaseMs ?? 5,
		restartMaxMs: 10_000,
		checkEveryMs: options.checkEveryMs ?? 3_600_000,
		now: options.now,
	});
	features.push(feature);
	const list = async (): Promise<Extract<VmReply, { t: "vm-list" }>> => {
		const reply = await feature.handle({ t: "vm-list", reqId: 1 });
		if (reply.t !== "vm-list") throw new Error("not a list");
		return reply;
	};
	const entry = async (name: string): Promise<VmEntry | undefined> => (await list()).vms.find(vm => vm.name === name);
	return { vmRoot, cli, sup, changes, feature, list, entry };
}

const CREATE: Extract<VmRequest, { t: "vm-create" }> = { t: "vm-create", reqId: 2, name: "web", repos: ["acme/web"] };

describe("canVms", () => {
	it("is advertised when `omp vm list --json` works", async () => {
		const { feature, cli } = await setup();
		expect(feature.hostsFields()).toEqual({});
		await feature.init();
		expect(feature.hostsFields()).toEqual({ canVms: true });
		expect(cli.calls).toEqual([["list", "--json"]]);
	});

	it("is not advertised when it fails, is re-probed no sooner than a minute later, and then turns on and tells the app", async () => {
		let time = 1_000_000;
		const { feature, cli, changes, list } = await setup({ now: () => time });
		cli.state.listed = null;
		await feature.init();
		expect(feature.hostsFields()).toEqual({});
		expect(changes.count).toBe(0);

		cli.state.listed = { ready: READY, vms: [] };
		time += 30_000;
		await expect(list()).rejects.toThrow("lima not found");
		expect(cli.calls.filter(args => args[0] === "list")).toHaveLength(1);

		time += 31_000;
		const reply = await list();
		expect(reply.vms).toEqual([]);
		expect(feature.hostsFields()).toEqual({ canVms: true });
		expect(changes.count).toBe(1);
	});

	it("is withdrawn when a later list fails, and says why", async () => {
		const { feature, cli, changes, list } = await setup();
		await feature.init();
		const afterInit = changes.count;
		cli.state.listed = null;
		await expect(list()).rejects.toThrow("omp vm is not available on this computer: lima not found");
		expect(feature.hostsFields()).toEqual({});
		expect(changes.count).toBe(afterInit + 1);
	});

	it("treats output that is not a VM list as not available", async () => {
		const other = createVmFeature({
			ompBin: "omp",
			vmRoot: await tmp(),
			log: () => {},
			onChange: () => {},
			run: () => Promise.resolve({ code: 0, stdout: "hello", stderr: "" }),
		});
		features.push(other);
		await other.init();
		expect(other.hostsFields()).toEqual({});
	});
});

describe("listing", () => {
	it("passes the readiness and the VMs through, so the app can show what is missing", async () => {
		const { feature, cli, list } = await setup();
		cli.state.listed = {
			ready: {
				ok: false,
				reason: "No GitHub App is set up",
				drivers: { lima: "2.3.0", qemu: null },
				github: { configured: false },
				supervisor: false,
			},
			vms: [INFO],
		};
		await feature.init();
		const reply = await list();
		expect(reply.ready.ok).toBe(false);
		expect(reply.ready.reason).toBe("No GitHub App is set up");
		expect(reply.vms).toEqual([INFO]);
	});
});

describe("jobs", () => {
	it("starts `omp vm create` with the options as flags and shows its NDJSON progress as busy", async () => {
		const { feature, cli, entry } = await setup();
		await feature.init();
		const accepted = await feature.handle({
			t: "vm-create",
			reqId: 5,
			name: "web",
			repos: ["acme/web", "acme/api"],
			cpus: 2,
			memoryGiB: 4,
			diskGiB: 30,
			network: "allowlist",
			dailyCostUsd: 2.5,
		});
		expect(accepted).toEqual({ t: "vm-create", reqId: 5, accepted: true });
		expect(cli.jobs[0]?.args).toEqual([
			"create",
			"web",
			"--repo",
			"acme/web",
			"--repo",
			"acme/api",
			"--cpus",
			"2",
			"--memory",
			"4",
			"--disk",
			"30",
			"--network",
			"allowlist",
			"--daily-cost",
			"2.5",
			"--json",
		]);

		// Before the CLI lists the VM, the app still sees it, creating, with what it asked for.
		const creating = await entry("web");
		expect(creating).toMatchObject({
			name: "web",
			repos: ["acme/web", "acme/api"],
			status: "creating",
			cpus: 2,
			network: "allowlist",
			busy: { action: "create", step: "", message: "Creating…" },
		});

		cli.jobs[0]?.say({ t: "progress", step: "boot", message: "Booting the VM" });
		cli.jobs[0]?.say({ t: "not json" });
		expect((await entry("web"))?.busy).toEqual({ action: "create", step: "boot", message: "Booting the VM" });
	});

	it("shows progress on a VM the CLI already lists, and completion clears it and tells the companion", async () => {
		const { feature, cli, changes, entry } = await setup();
		await feature.init();
		await feature.handle({ t: "vm-action", reqId: 3, name: "api", action: "stop" });
		expect(cli.jobs[0]?.args).toEqual(["stop", "api", "--json"]);
		cli.jobs[0]?.say({ t: "progress", step: "stop", message: "Shutting down" });
		expect(await entry("api")).toMatchObject({ status: "running", busy: { action: "stop", step: "stop" } });

		cli.state.listed = { ready: READY, vms: [{ ...INFO, status: "stopped" }] };
		cli.jobs[0]?.say({ t: "done", vm: { ...INFO, status: "stopped" } });
		cli.jobs[0]?.finish();
		await until(() => changes.count > 0);
		const after = await entry("api");
		expect(after?.status).toBe("stopped");
		expect(after?.busy).toBeUndefined();
		expect(after?.error).toBeUndefined();
	});

	it("keeps the pairing link a finished create or reset left until a pair, or ten minutes", async () => {
		let time = 5_000_000;
		const { feature, cli, changes, entry } = await setup({ now: () => time });
		await feature.init();
		await feature.handle(CREATE);
		cli.state.listed = { ready: READY, vms: [INFO, { ...INFO, name: "web", repos: ["acme/web"] }] };
		cli.jobs[0]?.say({ t: "done", pairUrl: "https://my.omp.sh/#pair:created" });
		cli.jobs[0]?.finish();
		await until(() => changes.count > 0);
		expect((await entry("web"))?.pairUrl).toBe("https://my.omp.sh/#pair:created");
		expect((await entry("api"))?.pairUrl).toBeUndefined();

		time += 9 * 60_000;
		expect((await entry("web"))?.pairUrl).toBe("https://my.omp.sh/#pair:created");
		time += 2 * 60_000;
		expect((await entry("web"))?.pairUrl).toBeUndefined();

		// A reset hands out a new one; pairing the VM again uses it up.
		time = 6_000_000;
		await feature.handle({ t: "vm-action", reqId: 4, name: "web", action: "reset" });
		cli.jobs[1]?.say({ t: "done", pairUrl: "https://my.omp.sh/#pair:reset" });
		cli.jobs[1]?.finish();
		await until(() => changes.count > 1);
		expect((await entry("web"))?.pairUrl).toBe("https://my.omp.sh/#pair:reset");
		const paired = await feature.handle({ t: "vm-pair", reqId: 6, name: "web" });
		expect(paired).toEqual({ t: "vm-pair", reqId: 6, url: "https://my.omp.sh/#pair:fresh", expiresAt: 99 });
		expect(cli.calls.at(-1)).toEqual(["pair", "web", "--json"]);
		expect((await entry("web"))?.pairUrl).toBeUndefined();
	});

	it("refuses a second action on a VM that is busy, and says which; other VMs are not held up", async () => {
		const { feature, cli, changes, entry } = await setup();
		await feature.init();
		await feature.handle(CREATE);
		await expect(feature.handle({ t: "vm-action", reqId: 7, name: "web", action: "delete" })).rejects.toThrow(
			"web is busy (creating)",
		);
		await expect(feature.handle({ ...CREATE, reqId: 8 })).rejects.toThrow("web is busy");
		await expect(feature.handle({ t: "vm-pair", reqId: 9, name: "web" })).rejects.toThrow("web is busy");
		expect(cli.jobs).toHaveLength(1);

		await feature.handle({ t: "vm-action", reqId: 10, name: "api", action: "stop" });
		expect(cli.jobs).toHaveLength(2);

		// The create ends; its VM is free again, the other one still works on its stop.
		cli.jobs[0]?.finish();
		await until(() => changes.count > 0);
		await feature.handle({ t: "vm-action", reqId: 11, name: "web", action: "delete" });
		expect(cli.jobs[2]?.args).toEqual(["delete", "web", "--json"]);
		expect((await entry("api"))?.busy?.action).toBe("stop");
	});

	it("shows an error line as the VM's error until the next action on it", async () => {
		const { feature, cli, changes, entry } = await setup();
		await feature.init();
		await feature.handle({ t: "vm-action", reqId: 3, name: "api", action: "start" });
		cli.jobs[0]?.say({ t: "progress", step: "boot", message: "Booting" });
		cli.jobs[0]?.say({ t: "error", message: "Lima could not start the instance" });
		cli.jobs[0]?.finish(1, "stderr noise");
		await until(() => changes.count > 0);
		const failed = await entry("api");
		expect(failed?.error).toBe("Lima could not start the instance");
		expect(failed?.busy).toBeUndefined();

		await feature.handle({ t: "vm-action", reqId: 4, name: "api", action: "start" });
		expect((await entry("api"))?.error).toBeUndefined();
	});

	it("reads a command that failed without an error line from its stderr", async () => {
		const { feature, cli, changes, entry } = await setup();
		await feature.init();
		await feature.handle({ t: "vm-action", reqId: 3, name: "api", action: "stop" });
		cli.jobs[0]?.finish(2, "warning\nomp: the VM is locked\n");
		await until(() => changes.count > 0);
		expect((await entry("api"))?.error).toBe("omp: the VM is locked");
	});

	it("lists a create that failed before the CLI wrote anything, and deleting it dismisses the note", async () => {
		const { feature, cli, changes, entry } = await setup();
		await feature.init();
		await feature.handle(CREATE);
		cli.jobs[0]?.say({ t: "error", message: "GitHub App has no access to acme/web" });
		cli.jobs[0]?.finish(1);
		await until(() => changes.count > 0);
		expect(await entry("web")).toMatchObject({
			name: "web",
			status: "failed",
			error: "GitHub App has no access to acme/web",
		});

		const callsBefore = cli.calls.length;
		await feature.handle({ t: "vm-action", reqId: 12, name: "web", action: "delete" });
		expect(cli.jobs).toHaveLength(1);
		expect(cli.calls.slice(callsBefore).every(args => args[0] === "list")).toBe(true);
		expect(await entry("web")).toBeUndefined();
	});

	it("refuses a request with a bad name, repository or size before running anything", async () => {
		const { feature, cli } = await setup();
		await feature.init();
		const create = (patch: Record<string, unknown>) => feature.handle({ ...CREATE, ...patch } as VmRequest);
		await expect(create({ name: "Web" })).rejects.toThrow("name");
		await expect(create({ name: "-rf" })).rejects.toThrow("name");
		await expect(create({ repos: [] })).rejects.toThrow("repository");
		await expect(create({ repos: ["--flag/x"] })).rejects.toThrow("owner/repo");
		await expect(create({ repos: ["a/b", "c/d"] })).rejects.toThrow("one GitHub owner");
		await expect(create({ cpus: 0 })).rejects.toThrow("CPUs");
		await expect(create({ network: "wide" })).rejects.toThrow("Network");
		await expect(feature.handle({ t: "vm-action", reqId: 1, name: "../x", action: "stop" })).rejects.toThrow(
			"invalid VM name",
		);
		await expect(
			feature.handle({ t: "vm-action", reqId: 1, name: "api", action: "format" } as unknown as {
				t: "vm-action";
				reqId: number;
				name: string;
				action: "stop";
			}),
		).rejects.toThrow("invalid action");
		expect(cli.jobs).toHaveLength(0);
		expect(cli.calls).toEqual([["list", "--json"]]);
	});
});

describe("the supervisor", () => {
	it("is kept running while a VM directory exists, with its output in supervisor.log", async () => {
		const { feature, sup, vmRoot } = await setup({ vmDirs: ["api"] });
		await feature.init();
		expect(sup.procs).toHaveLength(1);
		expect(sup.procs[0]?.args).toEqual(["vm", "serve"]);
		expect(sup.procs[0]?.logPath).toBe(path.join(vmRoot, "supervisor.log"));
		await feature.shutdown();
		expect(sup.procs[0]?.killed).toBe(true);
	});

	it("is not started when no VM exists, and neither is it with `omp vm` unavailable", async () => {
		const none = await setup();
		await none.feature.init();
		expect(none.sup.procs).toHaveLength(0);

		const broken = await setup({ vmDirs: ["api"] });
		broken.cli.state.listed = null;
		await broken.feature.init();
		expect(broken.sup.procs).toHaveLength(0);
	});

	it("is restarted after it exits, waiting longer each time", async () => {
		const { feature, sup } = await setup({ vmDirs: ["api"], restartBaseMs: 40 });
		await feature.init();
		sup.procs[0]?.exit(1);
		await until(() => sup.procs.length === 2);
		sup.procs[1]?.exit(0);
		await until(() => sup.procs.length === 3);
		const first = (sup.procs[1]?.startedAt ?? 0) - (sup.procs[0]?.startedAt ?? 0);
		const second = (sup.procs[2]?.startedAt ?? 0) - (sup.procs[1]?.startedAt ?? 0);
		expect(first).toBeGreaterThanOrEqual(35);
		expect(second).toBeGreaterThanOrEqual(75);
	});

	it("runs while a job runs even with no VM directory yet, and stops when the last VM and job are gone", async () => {
		const { feature, cli, sup, changes } = await setup();
		await feature.init();
		await feature.handle(CREATE);
		expect(sup.procs).toHaveLength(1);
		cli.jobs[0]?.say({ t: "error", message: "no" });
		cli.jobs[0]?.finish(1);
		await until(() => changes.count > 0);
		await until(() => sup.procs[0]?.killed === true);
		expect(sup.procs).toHaveLength(1);
	});

	it("stops when the last VM directory is removed, and starts when one appears, at the next check", async () => {
		const { feature, sup, vmRoot } = await setup({ vmDirs: ["api"], checkEveryMs: 20 });
		await feature.init();
		expect(sup.procs).toHaveLength(1);
		await fs.rm(path.join(vmRoot, "vms", "api"), { recursive: true });
		await until(() => sup.procs[0]?.killed === true);
		expect(sup.procs).toHaveLength(1);

		await fs.mkdir(path.join(vmRoot, "vms", "web"));
		await Bun.write(path.join(vmRoot, "vms", "web", "vm.json"), "{}");
		await until(() => sup.procs.length === 2);
		expect(sup.procs[1]?.killed).toBe(false);
	});

	it("keeps running when `omp vm list` fails while VMs exist", async () => {
		const { feature, cli, sup, list } = await setup({ vmDirs: ["api"], checkEveryMs: 10 });
		await feature.init();
		expect(sup.procs).toHaveLength(1);
		cli.state.listed = null;
		await expect(list()).rejects.toThrow("omp vm is not available");
		await Bun.sleep(60);
		expect(sup.procs).toHaveLength(1);
		expect(sup.procs[0]?.killed).toBe(false);
		await feature.shutdown();
	});
});

describe("the real runner", () => {
	it("streams stdout lines as they arrive, returns the exit code and stderr, and hands the VM root to the command", async () => {
		const dir = await tmp();
		const script = path.join(dir, "omp");
		await Bun.write(
			script,
			`#!/bin/sh
echo "$@"
echo '{"t":"progress","step":"boot","message":"Booting"}'
echo "root=$OMP_VM_ROOT"
echo "it broke" >&2
exit 3
`,
		);
		await fs.chmod(script, 0o755);
		const lines: string[] = [];
		const result = await createCliRunner(script, "/vm/root")(["create", "x", "--json"], {
			onLine: line => lines.push(line),
		});
		expect(lines).toEqual([
			"vm create x --json",
			'{"t":"progress","step":"boot","message":"Booting"}',
			"root=/vm/root",
		]);
		expect(result.code).toBe(3);
		expect(result.stderr.trim()).toBe("it broke");
		expect(result.stdout).toContain("root=/vm/root");
	});

	it("gives up on a command that takes too long", async () => {
		const dir = await tmp();
		const script = path.join(dir, "omp");
		await Bun.write(script, "#!/bin/sh\nexec sleep 30\n");
		await fs.chmod(script, 0o755);
		const result = await createCliRunner(script, dir)(["list", "--json"], { timeoutMs: 100 });
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("timed out");
	});
});
