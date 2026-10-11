/**
 * The channel omp's `schedule` tool uses to reach the companion on the same computer: a small HTTP
 * server on the loopback interface (an ephemeral port), authorized by a random bearer token. Both
 * are written to `<agent dir>/collab-companion-ipc.json` (mode 0600, so only this user reads it),
 * which is where omp looks; a stale file left by a crashed companion just refuses the connection.
 *
 * Only list, create and delete exist. Whatever the caller sends, a created schedule is enabled,
 * marked as agent-made and never replaces another, and only agent-made schedules can be deleted:
 * what the user made in the app stays theirs to change.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ScheduleIpcEndpoint, ScheduleIpcReply, ScheduleIpcRequest } from "@oh-my-pi/pi-wire/schedule";
import { type Scheduler, type ValidateDeps, parseScheduleInput } from "./companion-schedule";

const MAX_BODY_BYTES = 256 * 1024;

export interface ScheduleIpcOptions {
	/** Where the endpoint (port and token) is published. */
	file: string;
	scheduler: Pick<Scheduler, "list" | "save" | "remove">;
	validate: ValidateDeps;
}

export interface ScheduleIpc {
	endpoint: ScheduleIpcEndpoint;
	/** Stop listening and remove the endpoint file (when it is still ours). */
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

export async function startScheduleIpc(options: ScheduleIpcOptions): Promise<ScheduleIpc> {
	const token = crypto.randomBytes(32).toString("base64url");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const reply = (status: number, body: ScheduleIpcReply): Response => Response.json(body, { status });
			const url = new URL(req.url);
			// A browser page can reach loopback; this channel is for omp, which sends no Origin.
			if (req.headers.has("origin") || url.pathname !== "/schedule" || req.method !== "POST")
				return reply(404, { ok: false, error: "not found" });
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
	await fs.mkdir(path.dirname(options.file), { recursive: true });
	const tmp = `${options.file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
	await fs.chmod(tmp, 0o600);
	await fs.rename(tmp, options.file);
	return {
		endpoint,
		async stop() {
			await server.stop(true);
			const published = await Bun.file(options.file)
				.json()
				.catch(() => null);
			if (published?.token === token) await fs.rm(options.file, { force: true });
		},
	};
}
