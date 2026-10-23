/**
 * `omp vm serve`: the host side of every VM. For each VM it serves `<vm dir>/host.sock` (model
 * calls through an in-process auth gateway scoped to that VM, and GitHub through a policy-checking
 * proxy that adds the VM's installation token) and, for proxied VMs, `<vm dir>/egress.sock`.
 * Credentials stay in this process; VMs only see answers.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import {
	type AuthGatewayClient,
	type AuthGatewayClientScope,
	AuthGatewayClientTable,
	type AuthGatewayRouter,
	type AuthGatewayUsageLedger,
	type AuthGatewayUsageTotals,
	createAuthGatewayRouter,
	hashAuthGatewayToken,
	validateAuthGatewayClient,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { type FileLockHandle, isEnoent, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import {
	gatewayRoutableModels,
	gatewayRoutableProviders,
	indexModelsByRequestId,
	resolveGatewayModel,
} from "../cli/auth-gateway-cli";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { usesEgressProxy } from "./drivers";
import { DEFAULT_ALLOW_HOSTS, type EgressPolicy, startEgressProxy } from "./egress-proxy";
import { InstallationTokens, loadGithubApp, saveGithubApp } from "./github";
import { createGithubProxy, isGithubProxyRequest } from "./github-proxy";
import { getVmRoot, supervisorEndpointPath, vmEgressSocket, vmGithubLog, vmHostSocket, vmUsagePath } from "./paths";
import { listVmRecords, writeFileAtomic } from "./store";
import type { VmRecord } from "./types";

const RESCAN_MS = 2_000;

export interface SupervisorEndpoint {
	pid: number;
	startedAt: number;
}

/**
 * The live supervisor, if one runs. Liveness is the kernel lock the supervisor holds on `supervisor.json` for its
 * lifetime (released when it exits, however it exits), so a stale file or a reused PID never counts as running.
 */
export function readLiveSupervisor(root = getVmRoot()): SupervisorEndpoint | null {
	const probe = tryAcquireLockIn(root);
	if (probe) {
		probe.release();
		return null;
	}
	try {
		const endpoint: unknown = JSON.parse(fs.readFileSync(supervisorEndpointPath(root), "utf8"));
		if (isSupervisorEndpoint(endpoint)) return endpoint;
	} catch {}
	// Locked, but the file is not written yet (or is being replaced): running, PID unknown.
	return { pid: 0, startedAt: 0 };
}

function isSupervisorEndpoint(value: unknown): value is SupervisorEndpoint {
	return (
		typeof value === "object" &&
		value !== null &&
		"pid" in value &&
		typeof value.pid === "number" &&
		"startedAt" in value &&
		typeof value.startedAt === "number"
	);
}

function tryAcquireLockIn(root: string): FileLockHandle | null {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return tryAcquireFileLock(supervisorEndpointPath(root));
}

/** Polls until a live supervisor is up, for `timeoutMs`. */
export async function waitForSupervisor(timeoutMs: number, root = getVmRoot()): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readLiveSupervisor(root)) return true;
		await Bun.sleep(250);
	}
	return readLiveSupervisor(root) !== null;
}

/** Today's usage per VM, in `<vm dir>/usage.json`, so budgets survive a supervisor restart. */
class FileUsageLedger implements AuthGatewayUsageLedger {
	readonly #root: string;
	readonly #cache = new Map<string, { day: string; tokens: number; costUsd: number }>();

	constructor(root: string) {
		this.#root = root;
	}

	read(client: string, day: string): AuthGatewayUsageTotals {
		const entry = this.#load(client);
		return entry.day === day ? { tokens: entry.tokens, costUsd: entry.costUsd } : { tokens: 0, costUsd: 0 };
	}

	add(client: string, day: string, delta: AuthGatewayUsageTotals): void {
		const current = this.read(client, day);
		const next = { day, tokens: current.tokens + delta.tokens, costUsd: current.costUsd + delta.costUsd };
		this.#cache.set(client, next);
		writeFileAtomic(vmUsagePath(client, this.#root), `${JSON.stringify(next)}\n`).catch(err =>
			logger.warn("vm usage write failed", { vm: client, error: String(err) }),
		);
	}

	#load(client: string): { day: string; tokens: number; costUsd: number } {
		const cached = this.#cache.get(client);
		if (cached) return cached;
		let entry = { day: "", tokens: 0, costUsd: 0 };
		try {
			const parsed = JSON.parse(fs.readFileSync(vmUsagePath(client, this.#root), "utf8"));
			if (typeof parsed?.day === "string") {
				entry = { day: parsed.day, tokens: Number(parsed.tokens) || 0, costUsd: Number(parsed.costUsd) || 0 };
			}
		} catch (err) {
			if (!isEnoent(err)) logger.warn("vm usage read failed", { vm: client, error: String(err) });
		}
		this.#cache.set(client, entry);
		return entry;
	}
}

/** The gateway half: credentials, models and the per-VM client table, built on first use. */
class VmGateway {
	readonly #root: string;
	#ready: Promise<void> | undefined;
	#storage: AuthStorage | undefined;
	#settings: Settings | undefined;
	#registry: ModelRegistry | undefined;
	#router: AuthGatewayRouter | undefined;
	#table: AuthGatewayClientTable | undefined;
	#modelById = new Map<string, Model<Api>>();
	#routable: Model<Api>[] = [];
	#clients: AuthGatewayClient[] = [];
	/** VM name → its in-memory bearer, never written anywhere. */
	readonly #tokens = new Map<string, string>();

	readonly #log: (message: string) => void;
	/** VM name → why its record was refused, so a bad `vm.json` is logged once, not every scan. */
	readonly #refused = new Map<string, string>();

	constructor(root: string, log: (message: string) => void) {
		this.#root = root;
		this.#log = log;
	}

	/**
	 * Admits one client per VM. A VM whose grants or budget are invalid (a hand-edited `vm.json`) is left out and
	 * logged, so its model calls fail while every other VM keeps working.
	 */
	setVms(records: readonly VmRecord[]): void {
		const clients: AuthGatewayClient[] = [];
		for (const record of records) {
			let token = this.#tokens.get(record.name);
			if (!token) {
				token = crypto.randomBytes(32).toString("base64url");
				this.#tokens.set(record.name, token);
			}
			const client: AuthGatewayClient = {
				name: record.name,
				tokenSha256: hashAuthGatewayToken(token),
				...(record.models ? { models: record.models } : {}),
				...(record.budget && Object.values(record.budget).some(value => value !== undefined)
					? { budget: record.budget }
					: {}),
			};
			try {
				validateAuthGatewayClient(client);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				if (this.#refused.get(record.name) !== reason) {
					this.#refused.set(record.name, reason);
					this.#log(`vm ${record.name}: no model access until vm.json is fixed: ${reason}`);
				}
				continue;
			}
			this.#refused.delete(record.name);
			clients.push(client);
		}
		const names = new Set(records.map(record => record.name));
		for (const name of this.#tokens.keys()) if (!names.has(name)) this.#tokens.delete(name);
		for (const name of this.#refused.keys()) if (!names.has(name)) this.#refused.delete(name);
		this.#clients = clients;
		if (this.#table) {
			this.#reindex();
			this.#table.set(clients);
		}
	}

	async route(req: Request, vm: string): Promise<Response> {
		await this.#init();
		const token = this.#tokens.get(vm);
		const scope: AuthGatewayClientScope | undefined = token ? this.#table?.authenticate(token) : undefined;
		if (!scope || !this.#router) {
			return Response.json(
				{ error: { message: `unknown VM ${vm}`, type: "authentication_error" } },
				{ status: 401 },
			);
		}
		return this.#router.route(req, `vm:${vm}`, scope);
	}

	#init(): Promise<void> {
		this.#ready ??= (async () => {
			const settings = await Settings.init({ cwd: os.homedir() });
			const storage = await discoverAuthStorage(undefined, { settings });
			const registry = new ModelRegistry(storage);
			await registry.refresh();
			this.#settings = settings;
			this.#storage = storage;
			this.#registry = registry;
			this.#reindex();
			this.#router = createAuthGatewayRouter({
				storage,
				resolveModel: id => resolveGatewayModel(id, this.#modelById, this.#routable),
				listModels: () => new Set(this.#modelById.values()),
				usageLedger: new FileUsageLedger(this.#root),
			});
			this.#table = new AuthGatewayClientTable(storage.sessions, []);
			this.#table.set(this.#clients);
			logger.debug("vm gateway ready", { models: this.#modelById.size });
		})();
		this.#ready.catch(err => {
			logger.error("vm gateway init failed", { error: String(err) });
			this.#ready = undefined;
		});
		return this.#ready;
	}

	/** Recomputes the served models, so a login or logout on the host reaches running VMs. */
	#reindex(): void {
		if (!this.#registry || !this.#storage || !this.#settings) return;
		this.#routable = gatewayRoutableModels(this.#registry);
		this.#modelById = indexModelsByRequestId(this.#routable, gatewayRoutableProviders(this.#storage, this.#settings));
	}

	close(): void {
		this.#table?.close();
		this.#router?.close();
		this.#storage?.close();
	}
}

interface ServedVm {
	record: VmRecord;
	server: ReturnType<typeof Bun.serve>;
	egress?: { close(): Promise<void> };
	egressPolicy?: string;
}

export interface VmSupervisorHandle {
	close(): Promise<void>;
	/** Resolves when the supervisor stops (closed or a fatal error). */
	readonly closed: Promise<void>;
}

/**
 * Starts the supervisor. Throws {@link SupervisorRunningError} when another one holds the lock on `supervisor.json`.
 */
export async function startVmSupervisor(
	opts: { root?: string; log?: (message: string) => void } = {},
): Promise<VmSupervisorHandle> {
	const root = opts.root ?? getVmRoot();
	const log = opts.log ?? ((message: string) => logger.debug(message));
	// Held until close() or exit: the kernel drops it with the process, so a crash never leaves a stale owner.
	const lock = tryAcquireLockIn(root);
	if (!lock) throw new SupervisorRunningError(readLiveSupervisor(root)?.pid ?? 0);
	await writeFileAtomic(
		supervisorEndpointPath(root),
		`${JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies SupervisorEndpoint)}\n`,
	);

	const gateway = new VmGateway(root, log);
	const tokens = new InstallationTokens({
		load: () => loadGithubApp(root),
		save: async config => {
			const app = await loadGithubApp(root);
			if (app) await saveGithubApp(config, app.privateKey, root);
		},
		log,
	});
	const github = createGithubProxy({
		token: async record => {
			if (!(await loadGithubApp(root))) {
				throw new Error("no GitHub App is set up on the host: run `omp vm github setup` there");
			}
			return (await tokens.get(record.name, record.repos)).token;
		},
		log: (vm, message) => {
			log(`vm ${vm}: ${message}`);
			fs.promises
				.appendFile(vmGithubLog(vm, root), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
				.catch(() => undefined);
		},
	});
	const served = new Map<string, ServedVm>();
	let closing = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>(resolve => {
		resolveClosed = resolve;
	});

	async function handle(name: string, req: Request): Promise<Response> {
		const url = new URL(req.url);
		const entry = served.get(name);
		if (!entry) return new Response("unknown VM", { status: 404 });
		if (url.pathname === "/healthz") return new Response("ok");
		if (isGithubProxyRequest(req)) return github.handle(req, entry.record);
		return gateway.route(req, name);
	}

	function serveSocket(record: VmRecord): ReturnType<typeof Bun.serve> {
		const socket = vmHostSocket(record.name, root);
		fs.rmSync(socket, { force: true });
		const server = Bun.serve({
			unix: socket,
			fetch: (req, server) => {
				// A model can think for minutes before its next byte: no idle timeout on the VM's requests.
				server.timeout(req, 0);
				return handle(record.name, req);
			},
		});
		fs.chmodSync(socket, 0o600);
		return server;
	}

	function egressPolicy(record: VmRecord): EgressPolicy {
		return record.network === "allowlist"
			? { mode: "allowlist", hosts: [...DEFAULT_ALLOW_HOSTS, ...(record.allowHosts ?? [])] }
			: { mode: "public" };
	}

	async function retire(name: string, entry: ServedVm): Promise<void> {
		served.delete(name);
		entry.server.stop(true);
		await entry.egress?.close();
		await tokens.revoke(name);
	}

	async function sync(): Promise<void> {
		const records = await listVmRecords(root);
		gateway.setVms(records);
		const names = new Set(records.map(record => record.name));
		for (const [name, entry] of served) {
			if (names.has(name)) continue;
			await retire(name, entry);
			log(`vm ${name}: removed`);
		}
		for (const record of records) {
			let entry = served.get(record.name);
			// Deleted and created again between two scans: a different VM under the same name.
			if (entry && entry.record.createdAt !== record.createdAt) {
				await retire(record.name, entry);
				entry = undefined;
			}
			if (!entry) {
				entry = { record, server: serveSocket(record) };
				served.set(record.name, entry);
				log(`vm ${record.name}: serving ${vmHostSocket(record.name, root)}`);
			} else {
				if (entry.record.repos.join(",") !== record.repos.join(",")) await tokens.revoke(record.name);
				entry.record = record;
				// A socket deleted from under us is served again.
				if (!fs.existsSync(vmHostSocket(record.name, root))) {
					entry.server.stop(true);
					entry.server = serveSocket(record);
				}
				if (entry.egress && !fs.existsSync(vmEgressSocket(record.name, root))) {
					await entry.egress.close();
					entry.egress = undefined;
					entry.egressPolicy = undefined;
				}
			}
			const policy = usesEgressProxy(record) ? egressPolicy(record) : undefined;
			const policyKey = policy ? JSON.stringify(policy) : undefined;
			if (policyKey !== entry.egressPolicy) {
				await entry.egress?.close();
				entry.egress = undefined;
				entry.egressPolicy = undefined;
				if (policy) {
					entry.egress = await startEgressProxy({
						socketPath: vmEgressSocket(record.name, root),
						policy,
						log: message => log(`vm ${record.name}: egress: ${message}`),
					});
					entry.egressPolicy = policyKey;
				}
			}
		}
	}

	let timer: NodeJS.Timeout | undefined;
	const loop = async (): Promise<void> => {
		if (closing) return;
		try {
			await sync();
		} catch (err) {
			log(`vm supervisor: scan failed: ${String(err)}`);
		}
		if (!closing) timer = setTimeout(loop, RESCAN_MS);
	};
	await loop();

	return {
		closed,
		async close() {
			if (closing) return closed;
			closing = true;
			clearTimeout(timer);
			for (const entry of served.values()) {
				entry.server.stop(true);
				await entry.egress?.close();
			}
			await tokens.revokeAll();
			gateway.close();
			fs.rmSync(supervisorEndpointPath(root), { force: true });
			lock.release();
			resolveClosed();
			return closed;
		},
	};
}

export class SupervisorRunningError extends Error {
	constructor(readonly pid: number) {
		super(`a VM supervisor is already running (pid ${pid})`);
	}
}
