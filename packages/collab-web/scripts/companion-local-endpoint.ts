/**
 * Where the running companion serves the app on this computer, for the commands that run in another process
 * (`companion --open`, `--print-local-link`): the companion publishes its loopback port to
 * `<agent dir>/collab-companion-local.json` (mode 0600) while it runs. A file a crashed companion left behind is
 * recognised by its process being gone, or by nothing answering on the port.
 *
 * The port is not a secret and the file holds nothing that pairs a device: a pairing link needs an invite, which
 * only a process that can read the companion's own state directory can issue. No HTTP route hands one out.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface LocalEndpoint {
	pid: number;
	/** The loopback relay's port, which is also the app's. */
	port: number;
	/** The companion serves the app there (not `--no-local-app`, and this build has one). */
	app: boolean;
}

const PROBE_TIMEOUT_MS = 2_000;

export function localEndpointFile(configDir: string): string {
	return path.join(configDir, "agent", "collab-companion-local.json");
}

/** `http://127.0.0.1:<port>/`: where this computer's browser opens the app. */
export function localAppUrl(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

/**
 * The `collab:` overlay lines that point omp at this companion's local relay: its address, and the endpoint file that
 * says where it listens after a restart. Empty without a relay (nothing is published then).
 */
export function localRelayOverlayYaml(localRelayUrl?: string, localRelayEndpointFile?: string): string {
	if (!localRelayUrl) return "";
	const file = localRelayEndpointFile ? `  localRelayEndpointFile: ${JSON.stringify(localRelayEndpointFile)}\n` : "";
	return `  localRelayUrl: ${JSON.stringify(localRelayUrl)}\n${file}`;
}

/** Written whole or not at all: another process reads this file while the companion starts. */
export async function publishLocalEndpoint(file: string, endpoint: LocalEndpoint): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
	await fs.rename(temp, file);
}

/** Remove the file when it still names `pid`: a newer companion may have replaced it. */
export async function removeLocalEndpoint(file: string, pid: number): Promise<void> {
	const current = await readLocalEndpoint(file);
	if (current?.pid === pid) await fs.rm(file, { force: true });
}

/** The endpoint file's content, whether or not the companion that wrote it still runs; null when absent or unreadable. */
export async function readLocalEndpoint(file: string): Promise<LocalEndpoint | null> {
	try {
		const raw: unknown = JSON.parse(await Bun.file(file).text());
		if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("port" in raw) || !("app" in raw))
			return null;
		const { pid, port, app } = raw;
		if (typeof pid !== "number" || !Number.isInteger(pid) || typeof port !== "number" || !Number.isInteger(port))
			return null;
		return typeof app === "boolean" ? { pid, port, app } : null;
	} catch {
		return null;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The published endpoint of a companion that is running now, or null. */
export async function findRunningEndpoint(file: string): Promise<LocalEndpoint | null> {
	const endpoint = await readLocalEndpoint(file);
	if (endpoint === null || !alive(endpoint.pid)) return null;
	try {
		// Any answer proves something listens there; the status says nothing (the app may still be building).
		await fetch(localAppUrl(endpoint.port), {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return endpoint;
	} catch {
		return null;
	}
}

/** How long `--open` waits for a companion that holds the lock to publish its address. */
export const ENDPOINT_WAIT_MS = 60_000;

/** Look for the endpoint every `pollMs` until one is running or `timeoutMs` has passed (checked at least once). */
export async function waitForRunningEndpoint(
	file: string,
	options: {
		timeoutMs?: number;
		pollMs?: number;
		find?: (file: string) => Promise<LocalEndpoint | null>;
	} = {},
): Promise<LocalEndpoint | null> {
	const find = options.find ?? findRunningEndpoint;
	const deadline = Date.now() + (options.timeoutMs ?? ENDPOINT_WAIT_MS);
	for (;;) {
		const found = await find(file);
		if (found !== null || Date.now() >= deadline) return found;
		await Bun.sleep(options.pollMs ?? 1_000);
	}
}

/** Open `url` in the default browser; false when this computer has no way to (a server, a container). */
export async function openInBrowser(url: string): Promise<boolean> {
	const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
	const binary = opener === null ? null : Bun.which(opener);
	if (binary === null) return false;
	const proc = Bun.spawn([binary, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	return (await proc.exited) === 0;
}
