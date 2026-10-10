/**
 * The companion's session listing. Hosts and idle omps are read in-process from the collab discovery
 * registry (the code `omp collab list` runs), which costs a few IPC round trips instead of spawning a
 * whole omp every poll. Control links (`omp collab link` / `omp collab start`) come from the same module,
 * so opening or sharing a session spawns nothing either. When the registry module cannot be loaded or
 * fails unexpectedly, the call falls back to the `omp collab` CLI, which answers from whichever omp version is installed.
 */

import type * as Registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import type { CompanionHost, CompanionIdleSession } from "../src/lib/companion";
import { sandboxedPids } from "./companion-sandbox";

/** How the last listing was produced. */
export type ListMethod = "registry" | "cli";

export interface SessionListing {
	/** Control-capable hosts (the app joins with full control or not at all), newest first. */
	hosts: CompanionHost[];
	/** Idle sessions that could be shared, newest first. */
	idle: CompanionIdleSession[];
	/** instanceId → pid of every listed host and idle session. */
	pids: Map<string, number>;
}

export interface SessionLister {
	list(): Promise<SessionListing>;
	/** Source of the latest listing: "registry" until an in-process listing fails. */
	method(): ListMethod;
	/** Wall time of the latest successful listing in milliseconds; null before the first. */
	lastMs(): number | null;
	/**
	 * Control link of a hosting session, bound to the room generation observed while listing: a host
	 * that started a new room since fails with `stale_generation` instead of handing out the successor.
	 */
	link(instanceId: string): Promise<string>;
	/** Make an idle session host collab; resolves with its control link. */
	share(instanceId: string): Promise<string>;
}

/** The in-process collab registry module. */
export type RegistryModule = typeof Registry;

export interface SessionListerOptions {
	/** Run an omp CLI command and resolve with its stdout. */
	runOmp(args: string[]): Promise<string>;
	/** Config overlay path that marks a session sandboxed. */
	sandboxOverlayPath: string;
	/** Loads the in-process registry module; defaults to omp's own. */
	loadRegistry?: () => Promise<RegistryModule>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Hosts and idle rows as `omp collab list --json` prints them; idle is absent from CLIs that predate sharing idle sessions. */
interface RawListing {
	hosts?: Registry.CollabHostSnapshot[];
	idle?: Registry.CollabIdleSnapshot[];
}

export function createSessionLister(options: SessionListerOptions): SessionLister {
	// Dynamic on purpose: the module graph is large and a checkout where it does not load must still list
	// through the CLI.
	const loadRegistry = options.loadRegistry ?? (() => import("@oh-my-pi/pi-coding-agent/collab/registry"));
	let registry: Promise<RegistryModule | null> | undefined;
	let method: ListMethod = "registry";
	let lastMs: number | null = null;

	function registryModule(): Promise<RegistryModule | null> {
		registry ??= loadRegistry().catch((err: unknown) => {
			console.error(`companion: in-process registry unavailable, using omp CLI: ${errorText(err)}`);
			return null;
		});
		return registry;
	}

	async function listRaw(): Promise<RawListing> {
		const module = await registryModule();
		if (module) {
			try {
				const listing = await module.listCollabSessions();
				method = "registry";
				return listing;
			} catch (err) {
				// This call only: the next poll tries the registry again.
				if (method === "registry")
					console.error(`companion: registry listing failed, using omp CLI: ${errorText(err)}`);
			}
		}
		method = "cli";
		return JSON.parse(await options.runOmp(["collab", "list", "--json"])) as RawListing;
	}

	/**
	 * The registry's answer, or the CLI's when the registry module is unavailable or fails unexpectedly.
	 * A `CollabLinkError` is the registry's definite answer (no such host, stale generation, ...): the CLI
	 * would only repeat it, or re-list and hand out a successor room, so it is not retried.
	 */
	async function resolve(
		viaRegistry: (module: RegistryModule) => Promise<Registry.CollabResolvedLink>,
		cliArgs: string[],
	): Promise<string> {
		const module = await registryModule();
		if (module) {
			try {
				return (await viaRegistry(module)).url;
			} catch (err) {
				if (err instanceof module.CollabLinkError) throw err;
				console.error(`companion: registry link failed, using omp CLI: ${errorText(err)}`);
			}
		}
		const parsed = JSON.parse(await options.runOmp([...cliArgs, "--json"])) as { url?: unknown };
		if (typeof parsed.url !== "string" || !parsed.url) throw new Error("omp returned no link");
		return parsed.url;
	}

	async function list(): Promise<SessionListing> {
		const started = performance.now();
		const parsed = await listRaw();
		const listedIdle = (Array.isArray(parsed.idle) ? parsed.idle : []).filter(
			row => typeof row?.instanceId === "string" && typeof row.cwd === "string",
		);
		const listedHosts = (parsed.hosts ?? []).filter(host => host.access === "control");
		const sandboxed = await sandboxedPids(
			[...listedHosts, ...listedIdle].map(row => row.pid).filter(pid => Number.isInteger(pid) && pid > 0),
			options.sandboxOverlayPath,
		);
		const hosts = listedHosts
			.map(host => ({
				instanceId: host.instanceId,
				sessionId: host.sessionId,
				sessionName: host.sessionName,
				cwd: host.cwd,
				model: host.model ? `${host.model.provider}/${host.model.id}` : null,
				startedAt: host.startedAt,
				participants: host.participants,
				busy: host.busy ?? null,
				inputRequired: host.inputRequired,
				relayConnected: host.relayConnected,
				sandboxed: sandboxed.has(host.pid),
			}))
			.sort((a, b) => b.startedAt - a.startedAt);
		const idle = listedIdle
			.map(row => ({
				instanceId: row.instanceId,
				sessionId: row.sessionId,
				sessionName: row.sessionName ?? null,
				cwd: row.cwd,
				model: row.model ? `${row.model.provider}/${row.model.id}` : null,
				startedAt: row.startedAt,
				busy: row.busy ?? null,
				sandboxed: sandboxed.has(row.pid),
			}))
			.sort((a, b) => b.startedAt - a.startedAt);
		const pids = new Map<string, number>();
		for (const row of [...listedHosts, ...listedIdle]) pids.set(row.instanceId, row.pid);
		lastMs = performance.now() - started;
		return { hosts, idle, pids };
	}

	return {
		list,
		method: () => method,
		lastMs: () => lastMs,
		link: instanceId =>
			resolve(module => module.resolveCollabHostLink(instanceId, "control"), ["collab", "link", instanceId]),
		share: instanceId =>
			resolve(module => module.startCollabSession(instanceId, "control"), ["collab", "start", instanceId]),
	};
}
