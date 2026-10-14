/**
 * Is a companion already running on this computer? The companion says so itself: while it runs it publishes its
 * loopback port to `<config>/agent/collab-companion-local.json` (see `companion-local-endpoint.ts` in collab-web,
 * whose format this reads). A file left behind by a crashed companion is recognised by its process being gone, or
 * by nothing answering on the port. Everything that touches the system is injected, so the decisions are testable.
 */
import * as path from "node:path";

export interface LocalEndpoint {
	pid: number;
	/** The loopback relay's port, which is also the app's. */
	port: number;
	/** The companion serves the app there (not `--no-local-app`, and its build has one). */
	app: boolean;
}

/** `<home>/<PI_CONFIG_DIR or .omp>`: where the companion keeps its state, as the companion computes it. */
export function configDirOf(home: string, env: Record<string, string | undefined>): string {
	return path.join(home, env.PI_CONFIG_DIR || ".omp");
}

export function endpointFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-companion-local.json");
}

/** The companion's state file: its room id and the paired devices. */
export function stateFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-companion.json");
}

export function appUrl(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

/** The endpoint a file's text holds, or null when it is not one. */
export function parseEndpoint(text: string): LocalEndpoint | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { pid, port, app } = raw as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
	return typeof app === "boolean" ? { pid, port, app } : null;
}

export interface DiscoveryDeps {
	/** The file's text; null when it is missing or unreadable. */
	readFile(file: string): Promise<string | null>;
	/** A process with this pid exists (permission denied counts: it exists). */
	alive(pid: number): boolean;
	/** Something answers on the app's URL; the status says nothing (the app may still be building). */
	probe(url: string): Promise<boolean>;
}

/** The published endpoint of a companion that is running now, or null. */
export async function findRunningEndpoint(file: string, deps: DiscoveryDeps): Promise<LocalEndpoint | null> {
	const text = await deps.readFile(file);
	if (text === null) return null;
	const endpoint = parseEndpoint(text);
	if (endpoint === null || !deps.alive(endpoint.pid)) return null;
	return (await deps.probe(appUrl(endpoint.port))) ? endpoint : null;
}

export type CompanionPlan =
	| { action: "attach"; endpoint: LocalEndpoint }
	| { action: "start" }
	/** A companion runs but serves no app, and a second one would fight it for the room. */
	| { action: "blocked"; reason: string };

/** Use the running companion, start one, or say why neither is possible. */
export function planCompanion(running: LocalEndpoint | null): CompanionPlan {
	if (running === null) return { action: "start" };
	if (!running.app) {
		return {
			action: "blocked",
			reason:
				"A companion is already running on this computer without the web app (it was started with --no-local-app). Stop it, or restart it without that flag, and open omp collab again.",
		};
	}
	return { action: "attach", endpoint: running };
}

/** Whether a signal-0 failure means the process exists. */
export function pidExists(kill: (pid: number, signal: 0) => void, pid: number): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
