/**
 * The channel omp's `schedule` tool uses to reach the companion on the same computer: a small HTTP
 * server on the loopback interface (an ephemeral port), authorized by a random bearer token. Both
 * are written to `<agent dir>/collab-companion-ipc.json` (mode 0600, so only this user reads it),
 * which is where omp looks; a stale file left by a crashed companion just refuses the connection.
 *
 * Only list, create and delete exist. Whatever the caller sends, a created schedule is enabled,
 * marked as agent-made and never replaces another, and only agent-made schedules can be deleted:
 * what the user made in the app stays theirs to change.
 *
 * The same server also carries the Personal agent's channel (`POST /personal` from its session, `POST /event` from local
 * scripts) under a second token of its own, so the schedule token never authorizes it. Those two paths answer 404 until
 * the Personal profile exists (`personal.serving()`), and the token is only written to a file by `publishPersonal`.
 *
 * High-stakes sessions' `pre-push` hook (./companion-stakes-hook) asks `POST /stakes/pre-push` under a third token, written
 * by `publishStakes`: it only answers whether pushing these commits is allowed, so it can neither change a mode nor pass a quiz.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	PersonalIpcEndpoint,
	PersonalIpcReply,
	PersonalIpcRequest,
	PersonalEventPostReply,
} from "@oh-my-pi/pi-wire/personal-ipc";
import { MAX_PERSONAL_BODY_BYTES } from "@oh-my-pi/pi-wire/personal-ipc";
import type { ScheduleIpcEndpoint, ScheduleIpcReply, ScheduleIpcRequest } from "@oh-my-pi/pi-wire/schedule";
import { STAKES_PRE_PUSH_PATH } from "@oh-my-pi/pi-wire/stakes";
import { type Scheduler, type ValidateDeps, parseScheduleInput } from "./companion-schedule";

const MAX_BODY_BYTES = 256 * 1024;

/** What the Personal agent's two loopback paths call into (see ./companion-personal). */
export interface PersonalIpcHandlers {
	/** The Personal profile exists: only then do `/personal` and `/event` answer. */
	serving(): boolean;
	/** `POST /personal`. */
	request(request: PersonalIpcRequest): Promise<PersonalIpcReply>;
	/** `POST /event`: the status code and the reply. */
	event(input: unknown): Promise<{ status: number; reply: PersonalEventPostReply }>;
}

/** Where the pre-push hook finds the companion: written to `<agent dir>/collab-companion-stakes-ipc` (mode 0600). */
export interface StakesIpcEndpoint {
	port: number;
	token: string;
	pid: number;
}

/** What the high-stakes pre-push hook's loopback path calls into (see ./companion-stakes). */
export interface StakesIpcHandlers {
	prePush(body: string): Promise<{ allow: boolean; message: string }>;
}

export interface ScheduleIpcOptions {
	/** Where the endpoint (port and token) is published. */
	file: string;
	scheduler: Pick<Scheduler, "list" | "save" | "remove">;
	validate: ValidateDeps;
	personal?: PersonalIpcHandlers;
	stakes?: StakesIpcHandlers;
}

export interface ScheduleIpc {
	endpoint: ScheduleIpcEndpoint;
	/** The Personal channel's endpoint: the same port, its own token. Not written anywhere until {@link publishPersonal}. */
	personalEndpoint: PersonalIpcEndpoint;
	/** Publish the Personal endpoint (mode 0600) where the Personal session and local scripts look. */
	publishPersonal(file: string): Promise<void>;
	/** Publish a copy of the schedule endpoint, for a profile whose `schedule` tool looks in its own agent dir. */
	publishSchedule(file: string): Promise<void>;
	/** The pre-push hook's endpoint: the same port, its own token. Not written anywhere until {@link publishStakes}. */
	stakesEndpoint: StakesIpcEndpoint;
	/** Publish the pre-push hook's endpoint (mode 0600) where the hook looks. */
	publishStakes(file: string): Promise<void>;
	/** Remove a file published here, when it is still ours. */
	unpublish(file: string): Promise<void>;
	/** Stop listening and remove the endpoint files (when they are still ours). */
	stop(): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function tokenMatches(header: string | null, token: string): boolean {
	const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
	const wanted = Buffer.from(token);
	return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

async function handle(options: ScheduleIpcOptions, request: ScheduleIpcRequest): Promise<ScheduleIpcReply> {
	switch (request.op) {
		case "list":
			return { ok: true, schedules: options.scheduler.list() };
		case "create": {
			const input = await parseScheduleInput(
				{ ...request.schedule, id: undefined, enabled: true, createdBy: "agent" },
				options.validate,
			);
			return { ok: true, schedule: await options.scheduler.save(input) };
		}
		case "delete": {
			if (typeof request.id !== "string") return { ok: false, error: "invalid schedule id" };
			const found = options.scheduler.list().find(schedule => schedule.id === request.id);
			if (!found) return { ok: false, error: "no such schedule" };
			if (found.createdBy !== "agent")
				return { ok: false, error: `"${found.title}" was made in the app; delete it there` };
			await options.scheduler.remove(found.id);
			return { ok: true, deleted: found.id };
		}
		default:
			return { ok: false, error: "unknown operation" };
	}
}

async function writeEndpoint(file: string, endpoint: object): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
	await fs.chmod(tmp, 0o600);
	await fs.rename(tmp, file);
}

async function removeIfOurs(file: string, token: string): Promise<void> {
	const published = await Bun.file(file)
		.json()
		.catch(() => null);
	if (published?.token === token) await fs.rm(file, { force: true });
}

/** Serve the pre-push hook's question (`POST /stakes/pre-push`); the caller has checked the Origin header and method. */
async function serveStakes(stakes: StakesIpcHandlers, token: string, req: Request): Promise<Response> {
	const reply = (status: number, text: string): Response =>
		new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	if (!tokenMatches(req.headers.get("authorization"), token)) return reply(401, "unauthorized\n");
	const text = await req.text();
	if (text.length > MAX_BODY_BYTES) return reply(413, "request too large\n");
	try {
		const answer = await stakes.prePush(text);
		return reply(200, answer.allow ? "allow\n" : `deny\n${answer.message}\n`);
	} catch (err) {
		return reply(200, `deny\nThe companion could not check the quiz: ${errorText(err)}\n`);
	}
}

/** Serve `/personal` and `/event`; the caller has checked the Origin header, method and path. */
async function servePersonal(
	personal: PersonalIpcHandlers,
	token: string,
	req: Request,
	pathname: "/personal" | "/event",
): Promise<Response> {
	const reply = (status: number, body: PersonalIpcReply | PersonalEventPostReply): Response =>
		Response.json(body, { status });
	if (!personal.serving()) return reply(404, { ok: false, error: "not found" });
	if (!tokenMatches(req.headers.get("authorization"), token)) return reply(401, { ok: false, error: "unauthorized" });
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > MAX_PERSONAL_BODY_BYTES) return reply(413, { ok: false, error: "request too large" });
	const text = await req.text();
	if (Buffer.byteLength(text) > MAX_PERSONAL_BODY_BYTES) return reply(413, { ok: false, error: "request too large" });
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return reply(400, { ok: false, error: "invalid request" });
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return reply(400, { ok: false, error: "invalid request" });
	try {
		if (pathname === "/event") {
			const answer = await personal.event(body);
			return reply(answer.status, answer.reply);
		}
		return reply(200, await personal.request(body as PersonalIpcRequest));
	} catch (err) {
		return reply(200, { ok: false, error: errorText(err) });
	}
}

export async function startScheduleIpc(options: ScheduleIpcOptions): Promise<ScheduleIpc> {
	const token = crypto.randomBytes(32).toString("base64url");
	const personalToken = crypto.randomBytes(32).toString("base64url");
	const stakesToken = crypto.randomBytes(32).toString("base64url");
	const published: { file: string; token: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const reply = (status: number, body: ScheduleIpcReply): Response => Response.json(body, { status });
			const url = new URL(req.url);
			// A browser page can reach loopback; this channel is for omp, which sends no Origin.
			if (req.headers.has("origin") || req.method !== "POST") return reply(404, { ok: false, error: "not found" });
			if (options.personal && (url.pathname === "/personal" || url.pathname === "/event"))
				return await servePersonal(options.personal, personalToken, req, url.pathname);
			if (options.stakes && url.pathname === STAKES_PRE_PUSH_PATH)
				return await serveStakes(options.stakes, stakesToken, req);
			if (url.pathname !== "/schedule") return reply(404, { ok: false, error: "not found" });
			if (!tokenMatches(req.headers.get("authorization"), token))
				return reply(401, { ok: false, error: "unauthorized" });
			try {
				const text = await req.text();
				if (text.length > MAX_BODY_BYTES) return reply(413, { ok: false, error: "request too large" });
				const body = JSON.parse(text) as ScheduleIpcRequest | null;
				if (typeof body !== "object" || body === null) return reply(400, { ok: false, error: "invalid request" });
				return reply(200, await handle(options, body));
			} catch (err) {
				return reply(200, { ok: false, error: errorText(err) });
			}
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("schedule channel did not get a port");
	const endpoint: ScheduleIpcEndpoint = { port, token, pid: process.pid };
	const personalEndpoint: PersonalIpcEndpoint = { port, token: personalToken, pid: process.pid };
	const stakesEndpoint: StakesIpcEndpoint = { port, token: stakesToken, pid: process.pid };
	await writeEndpoint(options.file, endpoint);
	published.push({ file: options.file, token });
	const unpublish = async (file: string): Promise<void> => {
		const at = published.findIndex(entry => entry.file === file);
		if (at < 0) return;
		const [entry] = published.splice(at, 1);
		await removeIfOurs(entry!.file, entry!.token);
	};
	const publish = async (file: string, endpointFile: object, fileToken: string): Promise<void> => {
		await writeEndpoint(file, endpointFile);
		if (!published.some(entry => entry.file === file)) published.push({ file, token: fileToken });
	};
	return {
		endpoint,
		personalEndpoint,
		stakesEndpoint,
		publishPersonal: file => publish(file, personalEndpoint, personalToken),
		publishSchedule: file => publish(file, endpoint, token),
		publishStakes: file => publish(file, stakesEndpoint, stakesToken),
		unpublish,
		async stop() {
			await server.stop(true);
			for (const entry of published.splice(0)) await removeIfOurs(entry.file, entry.token);
		},
	};
}
