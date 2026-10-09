/**
 * The companion's session listing. Hosts and idle omps are read in-process from the collab discovery
 * registry (the code `omp collab list` runs), which costs a few IPC round trips instead of spawning a
 * whole omp every poll. When the registry module cannot be loaded or throws, the listing falls back to
 * `omp collab list --json`, which answers from whichever omp version is installed.
 */

import type {
	CollabHostSnapshot,
	CollabIdleSnapshot,
	CollabSessionListing,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
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
}

export interface SessionListerOptions {
	/** Run an omp CLI command and resolve with its stdout. */
	runOmp(args: string[]): Promise<string>;
	/** Config overlay path that marks a session sandboxed. */
	sandboxOverlayPath: string;
}

type ListCollabSessions = () => Promise<CollabSessionListing>;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Hosts and idle rows as `omp collab list --json` prints them; idle is absent from CLIs that predate sharing idle sessions. */
interface RawListing {
	hosts?: CollabHostSnapshot[];
	idle?: CollabIdleSnapshot[];
}

export function createSessionLister(options: SessionListerOptions): SessionLister {
	let registry: Promise<ListCollabSessions | null> | undefined;
	let method: ListMethod = "registry";
	let lastMs: number | null = null;

	async function listRaw(): Promise<RawListing> {
		// Dynamic on purpose: the module graph is large and a checkout where it does not load must still list
		// through the CLI.
		registry ??= import("@oh-my-pi/pi-coding-agent/collab/registry").then(
			module => module.listCollabSessions,
			(err: unknown) => {
				console.error(`companion: in-process session listing unavailable, using omp CLI: ${errorText(err)}`);
				return null;
			},
		);
		const listRegistry = await registry;
		if (listRegistry) {
			try {
				const listing = await listRegistry();
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

	return { list, method: () => method, lastMs: () => lastMs };
}
