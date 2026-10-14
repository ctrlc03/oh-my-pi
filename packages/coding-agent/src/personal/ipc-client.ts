/**
 * The Personal session's side of `POST /personal`: the companion's loopback server, whose port and bearer token
 * are in `<agentDir>/collab-companion-personal-ipc.json` (loopback only, readable by this user only). A missing
 * file, a dead pid or a refused connection means no companion is serving this profile. Mirrors
 * `schedule/companion-client.ts`, with its own token: the schedule token cannot reach `/personal`.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	type NotifyOwnerInput,
	PERSONAL_IPC_FILE,
	type PersonalIpcEndpoint,
	type PersonalIpcReply,
	type PersonalIpcRequest,
	type PersonalReceiptOutcome,
	type PersonalTurnOrigin,
} from "@oh-my-pi/pi-wire/personal-ipc";

/** The companion is not running, or not for this profile. */
export class PersonalCompanionUnavailableError extends Error {
	constructor(detail: string) {
		super(
			`The omp collab companion is not reachable for the Personal agent (${detail}). It must be running on this computer with the Personal agent set up; the owner can start it with \`bun run companion\` in packages/collab-web.`,
		);
		this.name = "PersonalCompanionUnavailableError";
	}
}

/** The companion answered and said no; the message is its own. */
export class PersonalCompanionRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PersonalCompanionRefusedError";
	}
}

const REQUEST_TIMEOUT_MS = 10_000;

function isEndpoint(value: unknown): value is PersonalIpcEndpoint {
	return (
		isRecord(value) &&
		typeof value.port === "number" &&
		Number.isInteger(value.port) &&
		value.port > 0 &&
		value.port < 65_536 &&
		typeof value.token === "string" &&
		value.token !== "" &&
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

function isReply(value: unknown): value is PersonalIpcReply {
	return isRecord(value) && typeof value.ok === "boolean";
}

/** Where the companion publishes its personal endpoint for the omp whose agent directory is `agentDir`. */
export function personalEndpointFile(agentDir: string): string {
	return path.join(agentDir, PERSONAL_IPC_FILE);
}

async function readEndpoint(agentDir: string): Promise<PersonalIpcEndpoint> {
	let raw: unknown;
	try {
		raw = await Bun.file(personalEndpointFile(agentDir)).json();
	} catch {
		throw new PersonalCompanionUnavailableError("it has not published its channel");
	}
	if (!isEndpoint(raw)) throw new PersonalCompanionUnavailableError("its channel file is unreadable");
	if (!isAlive(raw.pid)) throw new PersonalCompanionUnavailableError("it has exited; its channel file is stale");
	return raw;
}

async function call(agentDir: string, request: PersonalIpcRequest, signal?: AbortSignal): Promise<PersonalIpcReply> {
	const endpoint = await readEndpoint(agentDir);
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${endpoint.port}/personal`, {
			method: "POST",
			headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
			body: JSON.stringify(request),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new PersonalCompanionUnavailableError("its channel does not answer");
	}
	if (response.status === 401)
		throw new PersonalCompanionUnavailableError("it was restarted; its channel token changed");
	const reply: unknown = await response.json().catch(() => null);
	if (!isReply(reply)) throw new PersonalCompanionUnavailableError("its channel answered something else");
	if (!reply.ok) throw new PersonalCompanionRefusedError(reply.error);
	return reply;
}

/** What the companion did with a `notify`. */
export interface NotifyResult {
	itemId: string;
	pushed: boolean;
}

/** The session-to-companion calls of `personal-ipc.ts`. */
export interface PersonalCompanion {
	/** Make an inbox item (and, unless it is quiet, a push) for the owner. */
	notify(
		request: { sessionId: string; runKind: "live" | "review"; origin: PersonalTurnOrigin; item: NotifyOwnerInput },
		signal?: AbortSignal,
	): Promise<NotifyResult>;
	/** Tell the companion this live session is up. */
	hello(request: { sessionId: string; pid: number }, signal?: AbortSignal): Promise<void>;
	/** Tell the companion what became of an event. */
	receipt(
		request: { sessionId: string; eventId: string; outcome: PersonalReceiptOutcome; detail?: string },
		signal?: AbortSignal,
	): Promise<void>;
}

/** The companion serving the profile whose agent directory is `agentDir`. */
export function personalCompanion(agentDir: string): PersonalCompanion {
	return {
		async notify(request, signal) {
			const reply = await call(agentDir, { op: "notify", ...request }, signal);
			if (!("itemId" in reply)) throw new PersonalCompanionRefusedError("unexpected reply from the companion");
			return { itemId: reply.itemId, pushed: reply.pushed };
		},
		async hello(request, signal) {
			await call(agentDir, { op: "hello", runKind: "live", ...request }, signal);
		},
		async receipt(request, signal) {
			await call(agentDir, { op: "receipt", ...request }, signal);
		},
	};
}
