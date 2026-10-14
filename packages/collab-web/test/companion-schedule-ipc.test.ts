import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ScheduleTool } from "@oh-my-pi/pi-coding-agent/tools/schedule";
import {
	CompanionRefusedError,
	CompanionUnavailableError,
	companionEndpointFile,
	companionSchedules,
} from "@oh-my-pi/pi-coding-agent/schedule/companion-client";
import { type ScheduleInput } from "@oh-my-pi/pi-wire/schedule";
import { createScheduler } from "../scripts/companion-schedule";
import { type ScheduleIpc, startScheduleIpc } from "../scripts/companion-schedule-ipc";

const NOW = Date.UTC(2026, 9, 9, 7, 0);

describe("the companion's schedule channel and omp's client", () => {
	let dir: string;
	let ipc: ScheduleIpc | undefined;
	let started: string[];

	const scheduler = () =>
		createScheduler({
			now: () => NOW,
			initial: [],
			save: async () => {},
			start: async schedule => {
				started.push(schedule.id);
				return "inst";
			},
			spendLimitReached: async () => false,
			refreshSessions: async () => {},
			isWorking: () => false,
			notify: () => {},
			onError: () => {},
		});

	async function launch() {
		const sched = scheduler();
		ipc = await startScheduleIpc({
			file: companionEndpointFile(dir),
			scheduler: sched,
			validate: {
				now: () => NOW,
				sandboxAvailable: false,
				checkDirectory: async d => {
					if (d.includes("missing")) throw new Error("folder does not exist on this computer");
				},
			},
		});
		return { sched, client: companionSchedules(dir) };
	}

	const weekdayTests: ScheduleInput = {
		title: "Weekday tests",
		prompt: "Run the tests and report failures",
		cwd: "/work/app",
		mode: "new",
		when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" },
		catchUp: "run-once",
		enabled: true,
	};

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sched-ipc-"));
		started = [];
	});
	afterEach(async () => {
		await ipc?.stop();
		ipc = undefined;
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("publishes a channel only this user can read", async () => {
		await launch();
		const stat = await fs.stat(companionEndpointFile(dir));
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("creates an agent-made schedule that the companion's scheduler then holds and fires", async () => {
		const { sched, client } = await launch();
		const created = await client.create(weekdayTests);
		expect(created).toMatchObject({
			title: "Weekday tests",
			createdBy: "agent",
			enabled: true,
			catchUp: "run-once",
			when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" },
			// Fri 9 Oct 2026 07:00Z is 09:00 in Berlin: the slot is not strictly ahead, so Monday.
			nextRun: Date.UTC(2026, 9, 12, 7, 0),
		});
		expect(sched.list().map(s => s.id)).toEqual([created.id]);
		expect((await client.list()).map(s => s.id)).toEqual([created.id]);
		await sched.runNow(created.id);
		expect(started).toEqual([created.id]);
	});

	it("ignores an id, a disabled flag, or an app marker the caller sends", async () => {
		const { sched, client } = await launch();
		const app = await sched.save({ ...weekdayTests, title: "From the app" });
		const created = await client.create({ ...weekdayTests, id: app.id, enabled: false, createdBy: undefined });
		expect(created.id).not.toBe(app.id);
		expect(created).toMatchObject({ enabled: true, createdBy: "agent" });
		expect(sched.list()).toHaveLength(2);
		expect(sched.list().find(s => s.id === app.id)?.title).toBe("From the app");
	});

	it("deletes only what an agent made", async () => {
		const { sched, client } = await launch();
		const app = await sched.save({ ...weekdayTests, title: "From the app" });
		const mine = await client.create(weekdayTests);
		await expect(client.remove(app.id)).rejects.toThrow("made in the app");
		await client.remove(mine.id);
		expect(sched.list().map(s => s.id)).toEqual([app.id]);
		await expect(client.remove("nope")).rejects.toThrow("no such schedule");
	});

	it("carries the agent's tool call to the scheduler and back", async () => {
		const { sched } = await launch();
		const session = { cwd: dir, getSessionId: () => "sess-1", settings: Settings.isolated() };
		const tool = new ScheduleTool(session, companionSchedules(dir));
		const made = await tool.execute("c1", {
			action: "create",
			title: "Weekday tests",
			prompt: "Run the tests and report failures",
			cron: "0 9 * * 1-5",
			timezone: "Europe/Berlin",
			catch_up: "run-once",
		});
		const [stored] = sched.list();
		expect(stored).toMatchObject({
			title: "Weekday tests",
			cwd: dir,
			mode: "new",
			createdBy: "agent",
			catchUp: "run-once",
			when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" },
		});
		expect(made.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(stored?.id ?? "?") });
		const listed = await tool.execute("l1", { action: "list" });
		expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("made by an agent") });
		await tool.execute("d1", { action: "delete", id: stored?.id });
		expect(sched.list()).toEqual([]);
	});

	it("treats a channel file left by a companion that is gone as no companion", async () => {
		await Bun.write(companionEndpointFile(dir), JSON.stringify({ port: 9, token: "t", pid: 2_147_483_646 }));
		await expect(companionSchedules(dir).list()).rejects.toThrow("stale");
	});

	it("passes the companion's validation messages back", async () => {
		const { client } = await launch();
		await expect(client.create({ ...weekdayTests, cwd: "/work/missing" })).rejects.toBeInstanceOf(
			CompanionRefusedError,
		);
		await expect(client.create({ ...weekdayTests, when: { kind: "cron", expr: "* * * * *" } })).rejects.toThrow(
			"shortest allowed",
		);
		await expect(client.create({ ...weekdayTests, when: { kind: "once", at: NOW - 1 } })).rejects.toThrow(
			"already passed",
		);
		await expect(client.create({ ...weekdayTests, sandboxed: true })).rejects.toThrow("sandbox");
	});

	it("refuses a caller without the token, and a browser", async () => {
		await launch();
		const { port, token } = await Bun.file(companionEndpointFile(dir)).json();
		const url = `http://127.0.0.1:${port}/schedule`;
		const body = JSON.stringify({ op: "list" });
		expect((await fetch(url, { method: "POST", body })).status).toBe(401);
		expect((await fetch(url, { method: "POST", body, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
		expect(
			(
				await fetch(url, {
					method: "POST",
					body,
					headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
				})
			).status,
		).toBe(404);
		expect((await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
		expect((await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${token}` } })).status).toBe(
			200,
		);
	});

	it("explains that scheduling needs the companion when there is none or it went away", async () => {
		const client = companionSchedules(dir);
		await expect(client.list()).rejects.toBeInstanceOf(CompanionUnavailableError);
		await expect(client.list()).rejects.toThrow("companion");
		await launch();
		await ipc?.stop();
		await expect(client.list()).rejects.toBeInstanceOf(CompanionUnavailableError);
		expect(await Bun.file(companionEndpointFile(dir)).exists()).toBe(false);
	});

	it("detects a companion that restarted: the old token is refused", async () => {
		await launch();
		const stale = await Bun.file(companionEndpointFile(dir)).text();
		await ipc?.stop();
		await launch();
		await Bun.write(companionEndpointFile(dir), stale.replace(/"port":\d+/, `"port":${ipc?.endpoint.port}`));
		await expect(companionSchedules(dir).list()).rejects.toBeInstanceOf(CompanionUnavailableError);
	});
});
