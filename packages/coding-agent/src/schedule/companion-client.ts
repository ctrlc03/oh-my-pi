/**
 * Client for the companion's scheduling channel: a loopback HTTP server the companion starts next to
 * its state (see `packages/collab-web/scripts/companion-schedule-ipc.ts`) and advertises in
 * `<agent dir>/collab-companion-ipc.json`. The file holds the port and the bearer token and is readable
 * by this user only; a missing file or a refused connection means no companion is running.
 */
import * as path from "node:path";
import {
	SCHEDULE_IPC_FILE,
	type Schedule,
	type ScheduleInput,
	type ScheduleIpcEndpoint,
	type ScheduleIpcReply,
	type ScheduleIpcRequest,
} from "@oh-my-pi/pi-wire/schedule";

/** Scheduling needs the companion: nothing else can start a run later, so there is no fallback. */
export class CompanionUnavailableError extends Error {
	constructor(detail: string) {
		super(
			`Scheduling needs the omp collab companion running on this computer (${detail}). Start it with \`bun run companion\` in packages/collab-web (pair it once from the app), then try again.`,
		);
		this.name = "CompanionUnavailableError";
	}
}

/** The companion refused the request; the message is its own. */
export class CompanionRefusedError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

function isEndpoint(value: unknown): value is ScheduleIpcEndpoint {
	return (
		typeof value === "object" &&
		value !== null &&
		"port" in value &&
		typeof value.port === "number" &&
		Number.isInteger(value.port) &&
		value.port > 0 &&
		value.port < 65_536 &&
		"token" in value &&
		typeof value.token === "string" &&
		value.token !== "" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isInteger(value.pid) &&
		value.pid > 0
	);
}

/** Whether a process with this id exists (signal 0 delivers nothing; EPERM means it exists but is not ours). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

/** Where the companion publishes its endpoint for the omp whose agent directory is `agentDir`. */
export function companionEndpointFile(agentDir: string): string {
	return path.join(agentDir, SCHEDULE_IPC_FILE);
}

async function readEndpoint(agentDir: string): Promise<ScheduleIpcEndpoint> {
	let raw: unknown;
	try {
		raw = await Bun.file(companionEndpointFile(agentDir)).json();
	} catch {
		throw new CompanionUnavailableError("it has not published its channel");
	}
	if (!isEndpoint(raw)) throw new CompanionUnavailableError("its channel file is unreadable");
	if (!isAlive(raw.pid)) throw new CompanionUnavailableError("it has exited; its channel file is stale");
	return raw;
}

function isReply(value: unknown): value is ScheduleIpcReply {
	return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}

async function call(agentDir: string, request: ScheduleIpcRequest, signal?: AbortSignal): Promise<ScheduleIpcReply> {
	const endpoint = await readEndpoint(agentDir);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${endpoint.port}/schedule`, {
			method: "POST",
			headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
			body: JSON.stringify(request),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new CompanionUnavailableError("its channel does not answer");
	}
	if (response.status === 401) throw new CompanionUnavailableError("it was restarted; its channel token changed");
	const reply: unknown = await response.json().catch(() => null);
	if (!isReply(reply)) throw new CompanionUnavailableError("its channel answered something else");
	if (!reply.ok) throw new CompanionRefusedError(reply.error);
	return reply;
}

export interface CompanionSchedules {
	list(signal?: AbortSignal): Promise<Schedule[]>;
	/** Create an enabled schedule marked as agent-made; resolves with it as stored. */
	create(schedule: ScheduleInput, signal?: AbortSignal): Promise<Schedule>;
	/** Delete an agent-made schedule. */
	remove(id: string, signal?: AbortSignal): Promise<void>;
}

/** The companion's schedules, through the channel published in `agentDir` (the omp agent directory). */
export function companionSchedules(agentDir: string): CompanionSchedules {
	return {
		async list(signal) {
			const reply = await call(agentDir, { op: "list" }, signal);
			if (!("schedules" in reply)) throw new CompanionRefusedError("unexpected reply from the companion");
			return reply.schedules;
		},
		async create(schedule, signal) {
			const reply = await call(agentDir, { op: "create", schedule }, signal);
			if (!("schedule" in reply)) throw new CompanionRefusedError("unexpected reply from the companion");
			return reply.schedule;
		},
		async remove(id, signal) {
			await call(agentDir, { op: "delete", id }, signal);
		},
	};
}
