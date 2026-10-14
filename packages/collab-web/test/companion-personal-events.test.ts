import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalEventRecord } from "@oh-my-pi/pi-wire/personal";
import {
	EVENT_CLAIM_STALE_MS,
	EVENT_INGRESS_PER_MINUTE,
	EVENT_TTL_MS,
	MAX_EVENT_BODY_CHARS,
	MAX_PENDING_EVENTS,
	MAX_PERSONAL_BODY_BYTES,
	type PersonalEvent,
	personalEventCanonical,
	personalEventFileName,
} from "@oh-my-pi/pi-wire/personal-ipc";
import {
	createPersonalEvents,
	type PersonalEvents,
	scriptSource,
	signEvent,
	stableEventId,
} from "../scripts/companion-personal-events";
import { createScheduler } from "../scripts/companion-schedule";
import { type ScheduleIpc, startScheduleIpc } from "../scripts/companion-schedule-ipc";
import { openJsonlStore, type PersonalPaths, personalPaths } from "../scripts/companion-personal-store";

const T0 = Date.UTC(2026, 9, 10, 12);
const KEY = "dGVzdC1rZXktMDAwMDAwMDAwMDAwMDAwMDAwMDA";

let root: string;
let clock: number;
let changes: string[][];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-events-"));
	clock = T0;
	changes = [];
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function build(key: string | null = KEY) {
	const paths = personalPaths(root);
	const records = openJsonlStore<PersonalEventRecord>(path.join(paths.personalDir, "events.jsonl"));
	const events = createPersonalEvents({
		paths,
		events: records,
		now: () => clock,
		ownerKey: async () => key,
		changed: what => changes.push(what),
	});
	return { paths, records, events };
}

const inboxNames = async (dir: string): Promise<string[]> => (await fs.readdir(dir).catch(() => [])).sort();
const readEvent = async (dir: string, name: string): Promise<PersonalEvent> =>
	JSON.parse(await Bun.file(path.join(dir, name)).text());

describe("signing", () => {
	it("matches the vector the session verifies against", () => {
		const event: PersonalEvent = {
			id: "ans-1",
			source: "owner-answer",
			kind: "answer",
			at: 1760000000000,
			title: "Answer",
			body: "Yes, squash.",
			trust: "owner",
			ref: "item-1",
		};
		expect(personalEventCanonical(event)).toBe(
			JSON.stringify([
				"ans-1",
				"owner-answer",
				"answer",
				1760000000000,
				"Answer",
				"Yes, squash.",
				"",
				"owner",
				"item-1",
			]),
		);
		expect(signEvent(event, KEY)).toBe("ea17f7fce4950bfec7441bdd220ad3a9239ac2dd34d0adf5135687664a30d259");
	});

	it("signs owner events with the owner key and leaves external events unsigned", async () => {
		const { paths, events } = build();
		const owner = await events.enqueueOwner({ source: "companion", kind: "control", title: "Exit", body: "exit" });
		const external = await events.enqueueExternal({
			source: "source:mail",
			kind: "event",
			title: "Mail",
			body: "hi",
		});
		expect(owner.trust).toBe("owner");
		expect(owner.mac).toBe(signEvent({ ...owner, mac: undefined }, KEY));
		expect(external.trust).toBe("external");
		expect(external.mac).toBeUndefined();
		const names = await inboxNames(paths.inboxDir);
		expect(names).toHaveLength(2);
		expect((await readEvent(paths.inboxDir, names[0]!)).id).toBeDefined();
	});

	it("refuses an owner event when the key is missing", async () => {
		const { events } = build(null);
		await expect(
			events.enqueueOwner({ source: "companion", kind: "control", title: "x", body: "y" }),
		).rejects.toThrow(/owner key/);
	});
});

describe("the file channel", () => {
	it("writes events oldest first with private files, and records them as queued", async () => {
		const { paths, records, events } = build();
		await events.enqueueOwner({ source: "a", kind: "answer", title: "second", body: "", id: "b", at: T0 - 10 });
		await events.enqueueOwner({ source: "a", kind: "answer", title: "first", body: "", id: "a", at: T0 - 20 });
		const names = await inboxNames(paths.inboxDir);
		expect(names).toEqual([
			personalEventFileName({ id: "a", at: T0 - 20 }),
			personalEventFileName({ id: "b", at: T0 - 10 }),
		]);
		expect((await fs.stat(path.join(paths.inboxDir, names[0]!))).mode & 0o777).toBe(0o600);
		expect((await records.get("a"))?.status).toBe("queued");
		expect(changes.some(what => what.includes("events"))).toBe(true);
		expect(await events.pending()).toBe(2);
	});

	it("an event that names its id is queued once", async () => {
		const { paths, events } = build();
		await events.enqueueOwner({ source: "a", kind: "answer", title: "x", body: "", id: "answer-1" });
		await events.enqueueOwner({ source: "a", kind: "answer", title: "x", body: "", id: "answer-1" });
		expect(await inboxNames(paths.inboxDir)).toHaveLength(1);
	});

	it("applies the session's receipts to the record, and ignores one it does not know", async () => {
		const { records, events } = build();
		const event = await events.enqueueOwner({ source: "a", kind: "control", title: "x", body: "y" });
		await events.receipt(event.id, "delivered");
		expect(await records.get(event.id)).toMatchObject({ status: "delivered", deliveredAt: T0 });
		await events.receipt(event.id, "failed", "boom");
		expect(await records.get(event.id)).toMatchObject({ status: "failed", detail: "boom" });
		await events.receipt("nope", "delivered");
		expect(await records.get("nope")).toBeUndefined();
	});

	it("expires an event after 24 hours but keeps an owner's answer", async () => {
		const { paths, records, events } = build();
		const stale = await events.enqueueExternal({ source: "source:a", kind: "event", title: "old", body: "" });
		const answer = await events.enqueueOwner({ source: "owner-answer", kind: "answer", title: "ans", body: "yes" });
		clock += EVENT_TTL_MS + 1;
		await events.maintain();
		expect(await records.get(stale.id)).toMatchObject({ status: "expired" });
		const left = await inboxNames(paths.inboxDir);
		expect(left).toEqual([personalEventFileName(answer)]);
	});

	it("drops the oldest outside events over the cap, never an owner's", async () => {
		const { paths, records, events } = build();
		const owner = await events.enqueueOwner({ source: "a", kind: "answer", title: "keep", body: "", at: T0 - 5000 });
		for (let i = 0; i < MAX_PENDING_EVENTS; i++)
			await events.enqueueExternal({
				source: "source:a",
				kind: "event",
				title: `e${i}`,
				body: "",
				at: T0 - 4000 + i,
			});
		expect(await events.pending()).toBe(MAX_PENDING_EVENTS + 1);
		await events.maintain();
		expect(await events.pending()).toBe(MAX_PENDING_EVENTS);
		const names = await inboxNames(paths.inboxDir);
		expect(names).toContain(personalEventFileName(owner));
		expect(names).not.toContain(personalEventFileName({ id: (await records.list())[1]!.id, at: T0 - 4000 }));
	});

	it("removes an unreadable file instead of looping on it", async () => {
		const { paths, events } = build();
		await fs.mkdir(paths.inboxDir, { recursive: true });
		await Bun.write(path.join(paths.inboxDir, "0000000000001-broken.json"), "{ nope");
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([]);
	});

	async function claim(paths: PersonalPaths, event: PersonalEvent, sessionId: string, at: number) {
		const dir = path.join(paths.claimedDir, sessionId);
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, personalEventFileName(event));
		await Bun.write(file, JSON.stringify(event));
		await fs.utimes(file, at / 1000, at / 1000);
		return file;
	}

	it("hands a dead session's claims back to the inbox, and leaves a live session's alone", async () => {
		const { paths, events } = build();
		const event = await events.enqueueExternal({ source: "source:a", kind: "event", title: "x", body: "" });
		const name = personalEventFileName(event);
		await fs.rm(path.join(paths.inboxDir, name));
		await fs.mkdir(path.dirname(paths.beatFile), { recursive: true });

		// A fresh beat under the same session id: claimed, not stale.
		await claim(paths, event, "live", clock);
		await Bun.write(paths.beatFile, JSON.stringify({ sessionId: "live", pid: 1, at: clock - 1000 }));
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([]);

		// The beat went stale.
		clock += EVENT_CLAIM_STALE_MS + 1000;
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([name]);
		await expect(fs.stat(path.join(paths.claimedDir, "live"))).rejects.toThrow();
	});

	it("waits out the stale time for a claim whose session never beat, then returns it", async () => {
		const { paths, events } = build();
		const event: PersonalEvent = {
			id: "x",
			source: "s",
			kind: "event",
			at: T0,
			title: "t",
			body: "",
			trust: "external",
		};
		await claim(paths, event, "starting", clock);
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([]);
		clock += EVENT_CLAIM_STALE_MS + 1000;
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([personalEventFileName(event)]);
	});

	it("returns a claim of a session that now beats under another id", async () => {
		const { paths, events } = build();
		const event: PersonalEvent = {
			id: "y",
			source: "s",
			kind: "event",
			at: T0,
			title: "t",
			body: "",
			trust: "external",
		};
		await claim(paths, event, "old", clock);
		await fs.mkdir(path.dirname(paths.beatFile), { recursive: true });
		await Bun.write(paths.beatFile, JSON.stringify({ sessionId: "new", pid: 2, at: clock }));
		await events.maintain();
		expect(await inboxNames(paths.inboxDir)).toEqual([personalEventFileName(event)]);
	});
});

describe("ingest (POST /event)", () => {
	const ok = { title: "Build failed", body: "main is red", source: "ci" };

	it("marks the event external with a script: source and queues it", async () => {
		const { paths, events } = build();
		const result = await events.ingest(ok);
		expect(result.status).toBe(200);
		expect(result.reply).toMatchObject({ ok: true, duplicate: false });
		const [name] = await inboxNames(paths.inboxDir);
		const event = await readEvent(paths.inboxDir, name!);
		expect(event).toMatchObject({ trust: "external", source: "script:ci", kind: "event", title: "Build failed" });
		expect(event.mac).toBeUndefined();
		expect(scriptSource("github")).toBe("github");
		expect(scriptSource("script:x")).toBe("script:x");
		expect(scriptSource("ci")).toBe("script:ci");
	});

	it("never lets a caller claim an owner kind or trust", async () => {
		const { paths, events } = build();
		await events.ingest({ ...ok, kind: "answer", trust: "owner", mac: "x" });
		const [name] = await inboxNames(paths.inboxDir);
		const event = await readEvent(paths.inboxDir, name!);
		expect(event.kind).toBe("event");
		expect(event.trust).toBe("external");
		expect(event.mac).toBeUndefined();
	});

	it("answers a repeat of a named event as a duplicate and queues nothing", async () => {
		const { paths, events } = build();
		const first = await events.ingest({ ...ok, id: "run-1" });
		const second = await events.ingest({ ...ok, id: "run-1" });
		expect(first.reply).toMatchObject({ ok: true, duplicate: false });
		expect(second.reply).toMatchObject({ ok: true, duplicate: true, id: stableEventId("script:ci", "run-1") });
		expect(await inboxNames(paths.inboxDir)).toHaveLength(1);
		// The same id from another source is another event.
		await events.ingest({ ...ok, source: "other", id: "run-1" });
		expect(await inboxNames(paths.inboxDir)).toHaveLength(2);
	});

	it("limits a source to 30 a minute and lets it go on after the minute", async () => {
		const { events } = build();
		for (let i = 0; i < EVENT_INGRESS_PER_MINUTE; i++) expect((await events.ingest(ok)).status).toBe(200);
		const over = await events.ingest(ok);
		expect(over.status).toBe(429);
		expect(over.reply.ok).toBe(false);
		expect((await events.ingest({ ...ok, source: "else" })).status).toBe(200);
		clock += 61_000;
		expect((await events.ingest(ok)).status).toBe(200);
	});

	it("clamps a future time to now and refuses one older than 24 hours", async () => {
		const { paths, events } = build();
		await events.ingest({ ...ok, at: T0 + 3_600_000 });
		const [name] = await inboxNames(paths.inboxDir);
		expect((await readEvent(paths.inboxDir, name!)).at).toBe(T0);
		const old = await events.ingest({ ...ok, at: T0 - EVENT_TTL_MS - 1 });
		expect(old.status).toBe(400);
	});

	it("refuses bad input with a 400 and a message", async () => {
		const { events } = build();
		const bad: unknown[] = [
			null,
			[],
			"text",
			{ body: "x" },
			{ title: "", body: "x" },
			{ title: "t" },
			{ title: "t", body: "x".repeat(MAX_EVENT_BODY_CHARS + 1) },
			{ title: "t", body: "x", source: "has space" },
			{ title: "t", body: "x", id: "bad id!" },
			{ title: "t", body: "x", at: "soon" },
			{ title: "t", body: "x", url: 5 },
		];
		for (const input of bad) {
			const result = await events.ingest(input);
			expect(result.status).toBe(400);
			expect(result.reply.ok).toBe(false);
		}
	});
});

describe("the loopback server", () => {
	let ipc: ScheduleIpc | undefined;
	let serving = false;
	let events: PersonalEvents;

	beforeEach(async () => {
		({ events } = build());
		serving = true;
		ipc = await startScheduleIpc({
			file: path.join(root, "schedule-ipc.json"),
			scheduler: createScheduler({
				now: () => clock,
				initial: [],
				save: async () => {},
				start: async () => undefined,
				spendLimitReached: async () => false,
				refreshSessions: async () => {},
				isWorking: () => false,
				notify: () => {},
				onError: () => {},
			}),
			validate: { now: () => clock, sandboxAvailable: false, checkDirectory: async () => {} },
			personal: {
				serving: () => serving,
				request: async request =>
					request.op === "hello" ? { ok: true } : { ok: false, error: "unknown operation" },
				event: input => events.ingest(input),
			},
		});
	});

	afterEach(async () => {
		await ipc?.stop();
		ipc = undefined;
	});

	const post = (
		route: string,
		body: unknown,
		options: { token?: string; headers?: Record<string, string>; raw?: string } = {},
	): Promise<Response> =>
		fetch(`http://127.0.0.1:${ipc!.endpoint.port}${route}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.token ?? ipc!.personalEndpoint.token}`,
				"content-type": "application/json",
				...options.headers,
			},
			body: options.raw ?? JSON.stringify(body),
		});

	it("accepts an event with the personal token and files it as external", async () => {
		const res = await post("/event", { title: "Hi", body: "there" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
		expect(await inboxNames(personalPaths(root).inboxDir)).toHaveLength(1);
	});

	it("refuses the schedule token, no token, a browser Origin, and any other method", async () => {
		const event = { title: "Hi", body: "there" };
		expect((await post("/event", event, { token: ipc!.endpoint.token })).status).toBe(401);
		expect((await post("/event", event, { token: "" })).status).toBe(401);
		expect((await post("/event", event, { headers: { origin: "https://evil.example" } })).status).toBe(404);
		const get = await fetch(`http://127.0.0.1:${ipc!.endpoint.port}/event`, {
			headers: { authorization: `Bearer ${ipc!.personalEndpoint.token}` },
		});
		expect(get.status).toBe(404);
		expect(await inboxNames(personalPaths(root).inboxDir)).toEqual([]);
	});

	it("does not accept the personal token on the schedule path", async () => {
		const res = await post("/schedule", { op: "list" });
		expect(res.status).toBe(401);
		const own = await post("/schedule", { op: "list" }, { token: ipc!.endpoint.token });
		expect(await own.json()).toMatchObject({ ok: true, schedules: [] });
	});

	it("is 404 while the Personal agent is not serving", async () => {
		serving = false;
		expect((await post("/event", { title: "Hi", body: "x" })).status).toBe(404);
		expect((await post("/personal", { op: "hello" })).status).toBe(404);
	});

	it("refuses a body over the limit with 413, bad JSON with 400, and a non-object with 400", async () => {
		const big = JSON.stringify({ title: "t", body: "x".repeat(MAX_PERSONAL_BODY_BYTES) });
		expect((await post("/event", undefined, { raw: big })).status).toBe(413);
		expect((await post("/event", undefined, { raw: "{ nope" })).status).toBe(400);
		expect((await post("/event", undefined, { raw: "[1]" })).status).toBe(400);
		expect((await post("/event", undefined, { raw: '"text"' })).status).toBe(400);
	});

	it("passes a validation failure on as its status, and 429 on the limit", async () => {
		expect((await post("/event", { body: "no title" })).status).toBe(400);
		for (let i = 0; i < EVENT_INGRESS_PER_MINUTE; i++)
			await post("/event", { title: "t", body: "b", source: "burst" });
		expect((await post("/event", { title: "t", body: "b", source: "burst" })).status).toBe(429);
	});

	it("serves /personal requests through the handler", async () => {
		const res = await post("/personal", { op: "hello", sessionId: "s", pid: 1 });
		expect(await res.json()).toEqual({ ok: true });
	});

	it("publishes and removes endpoint files, and removes only its own", async () => {
		const personalFile = path.join(root, "agent", "personal-ipc.json");
		await ipc!.publishPersonal(personalFile);
		expect((await fs.stat(personalFile)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await Bun.file(personalFile).text())).toMatchObject({ token: ipc!.personalEndpoint.token });
		await ipc!.unpublish(personalFile);
		await expect(fs.stat(personalFile)).rejects.toThrow();

		const scheduleCopy = path.join(root, "agent", "schedule-ipc.json");
		await ipc!.publishSchedule(scheduleCopy);
		expect(JSON.parse(await Bun.file(scheduleCopy).text())).toMatchObject({ token: ipc!.endpoint.token });
		// Another companion took the file over: stop leaves it.
		await Bun.write(scheduleCopy, JSON.stringify({ port: 1, token: "other", pid: 1 }));
		await ipc!.stop();
		ipc = undefined;
		expect(JSON.parse(await Bun.file(scheduleCopy).text()).token).toBe("other");
	});
});
