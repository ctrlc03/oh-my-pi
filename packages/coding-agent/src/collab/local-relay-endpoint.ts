/**
 * The companion's endpoint file (`collab.localRelayEndpointFile`): `{ pid, port, app }`, written
 * by the companion that is currently active. A host whose local relay stays unreachable asks it
 * where the relay is now, so a companion that came back on another port does not strand the
 * session on a dead one.
 */
import * as fs from "node:fs";

/** Whether a process with this pid exists; a process owned by another user still counts. */
function processRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The loopback port the endpoint file names, or undefined when the file is missing, unreadable,
 * malformed, or names a process that is gone (a stale file from a companion that exited).
 */
export function readLiveLocalRelayPort(file: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || !("port" in parsed)) return undefined;
	const { pid, port } = parsed;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return processRunning(pid) ? port : undefined;
}
