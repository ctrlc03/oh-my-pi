import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalChanged, PersonalReply } from "@oh-my-pi/pi-wire/personal";
import { type PersonalEvent, parsePersonalEvent } from "@oh-my-pi/pi-wire/personal-ipc";
import type { Schedule } from "@oh-my-pi/pi-wire/schedule";
import type { CompanionHost } from "../src/lib/companion";
import {
	backoffMs,
	clockMinutes,
	createPersonal,
	FAILED_AFTER,
	handoffPrompt,
	type KeepAliveInput,
	keepAliveDecision,
	type Launcher,
	localDay,
	nextLocalTime,
	type OwnerPush,
	type PersonalEnv,
	type Personal,
	ROLLOVER_SESSION_BYTES,
	rolloverDue,
} from "../scripts/companion-personal";
import { NOTE_CHUNK_CHARS, NOTE_CONTROL_PREFIX } from "../scripts/companion-personal-chat";
import { type PersonalPaths, personalPaths } from "../scripts/companion-personal-store";
import { parseScheduleInput } from "../scripts/companion-schedule";
import { createSessionOrg, type OrgFile } from "../scripts/companion-sessionorg";
import { assistantReplySince, findSessionFile, readSessionTail } from "../scripts/companion-sessions";
import { applyOrg, emptyOrg, withSettings } from "../src/lib/session-org";
import type { TmuxLaunch } from "../scripts/companion-start";

const local = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();

const base: KeepAliveInput = {
	enabled: true,
	stopped: false,
	loginReady: true,
	live: null,
	lifecycleBusy: false,
	now: 1_000,
	nextStartAt: 0,
	rolloverDue: false,
	contextFull: false,
	chatTree: false,
	modeMismatch: false,
};

describe("keep-alive decision", () => {
	it("starts a missing session once the back-off is over", () => {
		expect(keepAliveDecision(base)).toBe("start");
		expect(keepAliveDecision({ ...base, nextStartAt: 2_000 })).toBe("none");
		expect(keepAliveDecision({ ...base, nextStartAt: 1_000 })).toBe("start");
	});

	it("does nothing when off, stopped by the owner, without a login, or while a step is in flight", () => {
		expect(keepAliveDecision({ ...base, enabled: false })).toBe("none");
		expect(keepAliveDecision({ ...base, stopped: true })).toBe("none");
		expect(keepAliveDecision({ ...base, loginReady: false })).toBe("none");
		expect(keepAliveDecision({ ...base, lifecycleBusy: true })).toBe("none");
		expect(
			keepAliveDecision({ ...base, enabled: false, live: { busy: false, inputRequired: false }, rolloverDue: true }),
		).toBe("none");
	});

	it("rolls over only an idle session, for the daily time or a full context", () => {
		const idle = { busy: false, inputRequired: false };
		expect(keepAliveDecision({ ...base, live: idle })).toBe("none");
		expect(keepAliveDecision({ ...base, live: idle, rolloverDue: true })).toBe("rollover");
		expect(keepAliveDecision({ ...base, live: idle, contextFull: true })).toBe("rollover");
		expect(keepAliveDecision({ ...base, live: { busy: true, inputRequired: false }, rolloverDue: true })).toBe(
			"none",
		);
		expect(keepAliveDecision({ ...base, live: { busy: null, inputRequired: false }, rolloverDue: true })).toBe(
			"none",
		);
		expect(keepAliveDecision({ ...base, live: { busy: false, inputRequired: true }, rolloverDue: true })).toBe(
			"none",
		);
	});

	it("never starts a second session beside a live one", () => {
		expect(keepAliveDecision({ ...base, live: { busy: true, inputRequired: false } })).toBe("none");
	});

	it("backs off 15 s doubling to 5 minutes", () => {
		expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
			15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
		]);
		expect(FAILED_AFTER).toBe(3);
	});
});

describe("the daily clock", () => {
	it("names the local day and the minutes of a time", () => {
		expect(localDay(local(9, 23, 59))).toBe("2026-10-09");
		expect(clockMinutes("04:30")).toBe(270);
	});

	it("finds the next local time strictly after now", () => {
		expect(nextLocalTime(local(9, 3), "04:00")).toBe(local(9, 4));
		expect(nextLocalTime(local(9, 4), "04:00")).toBe(local(10, 4));
		expect(nextLocalTime(local(9, 5), "04:00")).toBe(local(10, 4));
	});

	it("is due once the time passed and the day has not run", () => {
		expect(rolloverDue(local(9, 3, 59), "04:00", null)).toBe(false);
		expect(rolloverDue(local(9, 4), "04:00", null)).toBe(true);
		expect(rolloverDue(local(9, 4), "04:00", "2026-10-09")).toBe(false);
		expect(rolloverDue(local(10, 4), "04:00", "2026-10-09")).toBe(true);
	});

	it("hands the note to the next session in its first prompt", () => {
		expect(handoffPrompt("check the tax mail")).toContain("check the tax mail");
	});
});

let root: string;
let paths: PersonalPaths;
let clock: number;
let hosts: CompanionHost[];
let launches: TmuxLaunch[];
let released: string[];
let killed: string[];
let pushes: OwnerPush[];
let broadcasts: PersonalChanged[];
let published: string[];
let unpublished: string[];
let ended: string[];
/** Launches that fail before they get a host. */
let failLaunches: number;
let counter: number;
/** Every runtime a test built: their background work finishes before the folder goes. */
const built: Personal[] = [];
/** What each listing of the hosts adds to the clock (a session that does not answer lets time pass). */
let drift: number;
/** The session ignores `control exit`. */
let deaf: boolean;
/** Every event the simulated session took from the inbox, in order. */
let consumed: PersonalEvent[];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-runtime-"));
	paths = personalPaths(root);
	clock = local(10, 0, 30);
	hosts = [];
	launches = [];
	released = [];
	killed = [];
	pushes = [];
	broadcasts = [];
	published = [];
	unpublished = [];
	ended = [];
	failLaunches = 0;
	counter = 0;
	drift = 0;
	deaf = false;
	consumed = [];
});

afterEach(async () => {
	await Promise.all(built.splice(0).map(personal => personal.idle()));
	await fs.rm(root, { recursive: true, force: true });
});

const launcher: Launcher = {
	findTmux: async () => "/usr/bin/tmux",
	launch: async launch => {
		launches.push(launch);
		if (failLaunches > 0) {
			failLaunches--;
			throw new Error("tmux exploded");
		}
		counter++;
		const cwd = await fs.realpath(launch.cwd);
		hosts.push({
			instanceId: `inst-${counter}`,
			sessionId: launch.resume ?? `sess-${counter}`,
			sessionName: null,
			cwd,
			model: null,
			startedAt: clock,
			participants: 1,
			busy: false,
			inputRequired: false,
			relayConnected: true,
		});
		return { name: `omp-${counter}`, cwd };
	},
	ended: async () => null,
	screen: async () => "",
	release: async (_tmux, name) => {
		released.push(name);
	},
	kill: async (_tmux, name) => {
		killed.push(name);
	},
};

/** What the live session does with the inbox: answers a rollover with a note, exits on `control exit`. */
async function simulateSession(): Promise<void> {
	const names = (await fs.readdir(paths.inboxDir).catch(() => [])).sort();
	for (const name of names) {
		const file = path.join(paths.inboxDir, name);
		const event = parsePersonalEvent(JSON.parse(await Bun.file(file).text())) as PersonalEvent;
		consumed.push(event);
		const host = hosts[0];
		if (event.kind === "rollover" && host !== undefined) {
			const sessionFile = await findSessionFile(paths.sessionsDir, host.sessionId);
			await fs.appendFile(
				sessionFile!,
				`${JSON.stringify({
					type: "message",
					timestamp: new Date(clock).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "Handoff: renew the passport." }] },
				})}\n`,
			);
		}
		if (event.kind === "control" && event.body === "exit" && !deaf) hosts = [];
		await fs.rm(file);
	}
}

async function sessionFile(sessionId: string): Promise<string> {
	const dir = path.join(paths.sessionsDir, "--personal--");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `2026-10-10T00-00-00-000Z_${sessionId}.jsonl`);
	await Bun.write(file, `${JSON.stringify({ type: "session", id: sessionId, cwd: paths.workspace })}\n`);
	return file;
}

async function build(over: Partial<PersonalEnv> = {}): Promise<Personal> {
	const personal = await createPersonal({
		configRoot: root,
		machine: "mac",
		computerId: "room-1",
		ompBin: "omp",
		relayUrl: "wss://relay.example/ws",
		webUrl: "https://app.example",
		localRelayUrl: () => undefined,
		localRelayEndpointFile: path.join(root, "agent", "collab-companion-local.json"),
		now: () => clock,
		listHosts: async () => {
			await simulateSession();
			clock += drift;
			return [...hosts];
		},
		endHost: async instanceId => {
			ended.push(instanceId);
			hosts = hosts.filter(host => host.instanceId !== instanceId);
		},
		pushOwner: push => {
			pushes.push(push);
		},
		broadcast: frame => {
			broadcasts.push(frame);
		},
		refresh: () => {},
		ipc: () => ({
			publishPersonal: async file => {
				published.push(file);
			},
			publishSchedule: async file => {
				published.push(file);
			},
			unpublish: async file => {
				unpublished.push(file);
			},
		}),
		overlayFile: path.join(root, "agent", "overlay.yml"),
		promptDir: path.join(root, "run", "collab-companion"),
		defaultSessionsDir: path.join(root, "agent", "sessions"),
		launcher,
		timing: { startWaitMs: 2_000, pollMs: 1, replyWaitMs: 2_000, exitWaitMs: 2_000 },
		runOmp: async () => ({ exitCode: 1, stdout: "", stderr: "not used", timedOut: false }),
		...over,
	});
	built.push(personal);
	return personal;
}

const request = async (personal: Personal, frame: Record<string, unknown>): Promise<PersonalReply> =>
	await personal.handleRequest({ reqId: 1, ...frame });

const statusOf = async (personal: Personal) => {
	const reply = await request(personal, { t: "personal-status" });
	if (reply.t !== "personal-status") throw new Error("not a status");
	return reply.status;
};

/** A login the profile accepts without a credentials database. */
const login = async (): Promise<void> => {
	await Bun.write(paths.modelsYml, "providers:\n  ollama:\n    auth: none\n");
};

async function setUp(personal: Personal): Promise<void> {
	await request(personal, { t: "personal-setup" });
	await login();
}

describe("with Personal never set up", () => {
	it("writes nothing, starts no timer, and refuses what needs a profile", async () => {
		const timers: unknown[] = [];
		const { setTimeout: realTimeout, setInterval: realInterval } = globalThis;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			timers.push(args[0]);
			return realTimeout(...args);
		}) as typeof setTimeout;
		globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
			timers.push(args[0]);
			return realInterval(...args);
		}) as typeof setInterval;
		try {
			const personal = await build();
			await personal.tick([]);
			await personal.tick([]);
			expect(await statusOf(personal)).toMatchObject({ setUp: false, enabled: false, run: "off", session: null });
			expect(await request(personal, { t: "personal-events" })).toEqual({
				t: "personal-events",
				reqId: 1,
				events: [],
			});
			for (const t of ["personal-enable", "personal-disable", "personal-control", "personal-answer"])
				await expect(request(personal, { t, action: "start" })).rejects.toThrow("Set up the Personal agent first");
			await expect(personal.deliverSchedule({ id: "s" } as Schedule)).rejects.toThrow();
			expect(personal.ipc.serving()).toBe(false);
			expect(personal.enabled()).toBe(false);
			expect(personal.exempt("anything")).toBe(false);
			expect(personal.sessionDirs()).toEqual([path.join(root, "agent", "sessions")]);
			expect(personal.hostsFields(true)).toEqual({ canPersonal: true, canPersonalChatTree: true });
			expect(personal.hostsFields(false)).toEqual({});
			personal.shutdown();
		} finally {
			globalThis.setTimeout = realTimeout;
			globalThis.setInterval = realInterval;
		}
		expect(timers).toEqual([]);
		expect(await fs.readdir(root)).toEqual([]);
		expect(published).toEqual([]);
		expect(launches).toEqual([]);
		expect(broadcasts).toEqual([]);
	});
});

describe("setup, start and the live session", () => {
	it("setup creates the profile, publishes the endpoints and turns it on", async () => {
		const personal = await build();
		const reply = await request(personal, { t: "personal-setup" });
		expect(reply).toMatchObject({
			t: "personal-setup",
			status: { setUp: true, enabled: true, login: { state: "missing" } },
		});
		expect(await Bun.file(paths.configYml).exists()).toBe(true);
		expect(published).toEqual([paths.ipcFile, path.join(paths.agentDir, "collab-companion-ipc.json")]);
		expect(personal.ipc.serving()).toBe(true);
		expect(personal.sessionDirs()).toEqual([path.join(root, "agent", "sessions"), paths.sessionsDir]);
		await personal.idle();
		expect(broadcasts.at(-1)?.t).toBe("personal-changed");
		expect(personal.hostsFields(true).personalRev).toBeGreaterThan(0);
		// No login: the keep-alive waits and reports stopped.
		await personal.tick([]);
		await personal.idle();
		expect(launches).toEqual([]);
		expect((await statusOf(personal)).run).toBe("stopped");
	});

	it("starts the session once there is a login, in the profile's workspace, and records it", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		const launch = launches[0]!;
		expect(launch).toMatchObject({ cwd: paths.workspace, keepEnded: true, resume: undefined, prompt: undefined });
		expect(launch.profile?.name).toBe("personal");
		expect(launch.profile?.overlayYaml).toContain("autoStart: control");
		expect(launch.tmux).toBe("/usr/bin/tmux");
		const status = await statusOf(personal);
		expect(status.session).toMatchObject({ sessionId: "sess-1", instanceId: "inst-1", generation: 1 });
		expect(status.run).toBe("idle");
		expect(status.error).toBeUndefined();
		expect(killed).toEqual([]);
		// One session only: a poll that sees it again starts nothing.
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(1);
	});

	it("marks the Personal host and nothing else, and exempts its session", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		const other: CompanionHost = { ...hosts[0]!, instanceId: "other", sessionId: "other-s", cwd: "/work/app" };
		const marked = personal.markHosts([hosts[0]!, other]);
		expect(marked.map(host => host.personal)).toEqual([true, undefined]);
		expect(personal.isPersonalHost(hosts[0]!)).toBe(true);
		expect(personal.isPersonalHost(other)).toBe(false);
		expect(personal.exempt("sess-1")).toBe(true);
		expect(personal.exempt("other-s")).toBe(false);
		await personal.tick([hosts[0]!]);
		expect((await statusOf(personal)).run).toBe("idle");
		hosts[0]!.busy = true;
		await personal.tick([hosts[0]!]);
		expect((await statusOf(personal)).run).toBe("working");
		hosts[0]!.inputRequired = true;
		await personal.tick([hosts[0]!]);
		expect((await statusOf(personal)).run).toBe("waiting");
	});

	it("adopts a session someone started by hand in the workspace", async () => {
		const personal = await build();
		await setUp(personal);
		await fs.mkdir(paths.workspace, { recursive: true });
		const hand: CompanionHost = {
			instanceId: "hand",
			sessionId: "hand-s",
			sessionName: null,
			cwd: await fs.realpath(paths.workspace),
			model: null,
			startedAt: clock,
			participants: 1,
			busy: false,
			inputRequired: false,
			relayConnected: true,
		};
		hosts.push(hand);
		await personal.tick([hand]);
		await personal.idle();
		expect(launches).toEqual([]);
		expect((await statusOf(personal)).session).toMatchObject({ sessionId: "hand-s", instanceId: "hand" });
	});

	it("counts the generation once when the hosts poll sees the new session before the launch does", async () => {
		const holder: { personal?: Personal } = {};
		// The companion's 3 s poll lists the hosts while a start is still waiting for its own host (here: it comes first): the poll must not adopt it as a hand-started session.
		const polled: Launcher = {
			...launcher,
			launch: async launch => {
				const launched = await launcher.launch(launch);
				await holder.personal!.tick([...hosts]);
				return launched;
			},
		};
		const personal = await build({ launcher: polled });
		holder.personal = personal;
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		expect((await statusOf(personal)).session).toMatchObject({ sessionId: "sess-1", generation: 1 });
		expect(launches).toHaveLength(1);
	});

	it("resumes the recorded session when its host is gone and its file exists, else starts a new one", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		hosts = [];
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(2);
		expect(launches[1]?.resume).toBe("sess-1");
		expect((await statusOf(personal)).session).toMatchObject({ sessionId: "sess-1", generation: 1 });

		await fs.rm(path.join(paths.sessionsDir, "--personal--"), { recursive: true });
		hosts = [];
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(3);
		expect(launches[2]?.resume).toBeUndefined();
		expect((await statusOf(personal)).session).toMatchObject({ sessionId: "sess-3", generation: 2 });
	});
});

describe("failed starts", () => {
	it("backs off, then reports failed after three, tells the owner once, and recovers", async () => {
		const personal = await build();
		await setUp(personal);
		failLaunches = 3;
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		// Inside the back-off nothing starts.
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		expect((await statusOf(personal)).error).toBe("tmux exploded");

		clock += 16_000;
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(2);
		clock += 31_000;
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(3);
		const failed = await statusOf(personal);
		expect(failed.run).toBe("failed");
		expect(failed.error).toBe("tmux exploded");
		expect(pushes.filter(push => /will not start/.test(push.title))).toHaveLength(1);

		clock += 5 * 60_000;
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(4);
		const recovered = await statusOf(personal);
		expect(recovered.run).toBe("idle");
		expect(recovered.error).toBeUndefined();
		expect(launches[3]?.resume).toBeUndefined();
	});

	it("gives up on a launch that never gets a host and ends its tmux session", async () => {
		await setUp(await build());
		drift = 1_000;
		const never: Launcher = { ...launcher, launch: async launch => ({ name: "omp-x", cwd: launch.cwd }) };
		const personal = await build({ launcher: never });
		await personal.tick([]);
		await personal.idle();
		expect((await statusOf(personal)).error).toContain("did not start hosting in time");
		expect(killed).toEqual(["omp-x"]);
	});

	it("reads the screen of a launch that ended at once", async () => {
		await setUp(await build());
		const dying: Launcher = {
			...launcher,
			launch: async launch => ({ name: "omp-y", cwd: launch.cwd }),
			ended: async () => ({ tail: "error: no such model" }),
		};
		const personal = await build({ launcher: dying });
		await personal.tick([]);
		await personal.idle();
		expect((await statusOf(personal)).error).toContain("no such model");
		expect(killed).toEqual(["omp-y"]);
	});
});

describe("rollover", () => {
	it("asks for a handoff note, ends the session, and starts the next one with the note", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.deps.state.update(s => ({ ...s, settings: { ...s.settings, rollover: { time: "01:00" } } }));
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		expect((await personal.deps.state.read()).rolloverDay).toBeNull();

		clock = local(10, 1, 30);
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(2);
		expect(launches[1]?.resume).toBeUndefined();
		expect(launches[1]?.prompt).toContain("Handoff: renew the passport.");
		const state = personal.deps.state.read();
		expect(state.handoff).toBeNull();
		expect(state.rolloverDay).toBe("2026-10-10");
		expect(state.session).toMatchObject({ sessionId: "sess-2", generation: 2 });
		expect(ended).toEqual([]);
		const kinds = (await personal.deps.stores.events.list()).map(event => event.kind).sort();
		expect(kinds).toEqual(["control", "rollover"]);

		// Done for the day: another poll starts nothing.
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(2);
	});

	it("waits while the session is busy", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.deps.state.update(s => ({ ...s, settings: { ...s.settings, rollover: { time: "01:00" } } }));
		await personal.tick([]);
		await personal.idle();
		hosts[0]!.busy = true;
		clock = local(10, 1, 30);
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		expect(await personal.deps.stores.events.list()).toEqual([]);
	});

	it("restart rolls the live session over now", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		await request(personal, { t: "personal-control", action: "restart" });
		expect(launches).toHaveLength(2);
		expect(launches[1]?.prompt).toContain("renew the passport");
	});
});

describe("the owner's controls", () => {
	it("stop keeps the session down until start, and disable ends it and unpublishes the endpoints", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();

		await request(personal, { t: "personal-control", action: "stop" });
		expect(hosts).toEqual([]);
		await personal.tick([]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		expect((await statusOf(personal)).run).toBe("stopped");

		await request(personal, { t: "personal-control", action: "start" });
		expect(launches).toHaveLength(2);

		const off = await request(personal, { t: "personal-disable" });
		expect(off).toMatchObject({ status: { setUp: true, enabled: false, run: "off" } });
		expect(hosts).toEqual([]);
		expect(unpublished).toEqual([paths.ipcFile, path.join(paths.agentDir, "collab-companion-ipc.json")]);
		expect(personal.ipc.serving()).toBe(false);
		expect(personal.hostsFields(true)).toEqual({ canPersonal: true, canPersonalChatTree: true });
		expect(personal.exempt("sess-2")).toBe(false);
		// Data stays; turning it on again repairs and publishes again.
		expect(await Bun.file(paths.configYml).exists()).toBe(true);
		await request(personal, { t: "personal-enable" });
		expect(personal.ipc.serving()).toBe(true);
		expect(published.length).toBeGreaterThan(2);
	});

	it("refuses an unknown control, and a control while turned off", async () => {
		const personal = await build();
		await setUp(personal);
		await expect(request(personal, { t: "personal-control", action: "explode" })).rejects.toThrow("invalid action");
		await request(personal, { t: "personal-disable" });
		await expect(request(personal, { t: "personal-control", action: "start" })).rejects.toThrow("turned off");
	});

	it("backs up on request, reports the result, and refuses before set-up", async () => {
		const personal = await build();
		await expect(request(personal, { t: "personal-backup-now" })).rejects.toThrow();
		await setUp(personal);
		const reply = await request(personal, { t: "personal-backup-now" });
		if (reply.t !== "personal-backup-now") throw new Error("wrong reply");
		expect(reply.status.backups.lastOk).toBe(reply.ok);
		expect(reply.status.backups.lastAt).not.toBeNull();
		expect(reply.error === undefined).toBe(reply.ok);
		const running = request(personal, { t: "personal-backup-now" });
		await expect(request(personal, { t: "personal-backup-now" })).rejects.toThrow("already running");
		await running;
	});

	it("ends a session that ignores the exit request", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		const instanceId = hosts[0]!.instanceId;
		deaf = true;
		drift = 1_000;
		await request(personal, { t: "personal-control", action: "stop" });
		expect(ended).toEqual([instanceId]);
		expect(hosts).toEqual([]);
	});

	it("lists the event log newest first, in pages", async () => {
		const personal = await build();
		await setUp(personal);
		for (let i = 0; i < 5; i++) {
			clock += 1000;
			await personal.deps.enqueueExternalEvent({ source: "source:x", kind: "event", title: `e${i}`, body: "" });
		}
		const page = await request(personal, { t: "personal-events", limit: 2 });
		if (page.t !== "personal-events") throw new Error("wrong reply");
		expect(page.events.map(event => event.title)).toEqual(["e4", "e3"]);
		const older = await request(personal, { t: "personal-events", limit: 2, before: page.events.at(-1)!.at });
		if (older.t !== "personal-events") throw new Error("wrong reply");
		expect(older.events.map(event => event.title)).toEqual(["e2", "e1"]);
	});
});

describe("schedules for the Personal agent", () => {
	const fields = {
		title: "Morning brief",
		prompt: "Summarise my day",
		when: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
	};

	it("parses deliverTo personal, drops the process fields, and refuses it while Personal is off", async () => {
		const deps = {
			now: () => clock,
			sandboxAvailable: true,
			checkDirectory: async () => Promise.reject(new Error("no")),
		};
		const input = await parseScheduleInput(
			{
				...fields,
				enabled: true,
				cwd: "/ignored",
				mode: "resume",
				sessionId: "x",
				sandboxed: true,
				maxCostUsd: 3,
				deliverTo: "personal",
			},
			{ ...deps, personalEnabled: () => true },
		);
		expect(input).toMatchObject({ deliverTo: "personal", cwd: path.sep, mode: "new" });
		expect(input.sandboxed).toBeUndefined();
		expect(input.maxCostUsd).toBeUndefined();
		expect(input.sessionId).toBeUndefined();
		await expect(
			parseScheduleInput({ ...fields, enabled: true, cwd: "/x", mode: "new", deliverTo: "personal" }, deps),
		).rejects.toThrow("not turned on");
		await expect(
			parseScheduleInput(
				{ ...fields, enabled: true, cwd: "/x", mode: "new", deliverTo: "personal" },
				{ ...deps, personalEnabled: () => false },
			),
		).rejects.toThrow("not turned on");
		await expect(
			parseScheduleInput({ ...fields, enabled: true, cwd: "/x", mode: "new", deliverTo: "elsewhere" }, deps),
		).rejects.toThrow("invalid delivery");
		// A schedule that starts a process still checks its folder.
		await expect(parseScheduleInput({ ...fields, enabled: true, cwd: "/x", mode: "new" }, deps)).rejects.toThrow(
			"no",
		);
	});

	it("hands a due schedule to the session as a signed owner event, or an unsigned one when the agent made it", async () => {
		const personal = await build();
		await setUp(personal);
		const schedule: Schedule = {
			id: "sch-1",
			title: "Morning brief",
			prompt: "Summarise my day",
			cwd: path.sep,
			mode: "new",
			when: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
			deliverTo: "personal",
			enabled: true,
			nextRun: clock,
		};
		await personal.deliverSchedule(schedule);
		await personal.deliverSchedule({ ...schedule, id: "sch-2", createdBy: "agent" });
		const files = await fs.readdir(paths.inboxDir);
		const events = await Promise.all(
			files.map(async name => JSON.parse(await Bun.file(path.join(paths.inboxDir, name)).text()) as PersonalEvent),
		);
		const owner = events.find(event => event.source === "schedule:sch-1");
		const agent = events.find(event => event.source === "schedule:sch-2");
		expect(owner).toMatchObject({
			kind: "schedule",
			trust: "owner",
			title: "Morning brief",
			body: "Summarise my day",
		});
		expect(owner?.mac).toMatch(/^[0-9a-f]{64}$/);
		expect(agent).toMatchObject({ kind: "schedule", trust: "external" });
		expect(agent?.mac).toBeUndefined();
	});

	it("refuses delivery while Personal is off", async () => {
		const personal = await build();
		await setUp(personal);
		await request(personal, { t: "personal-disable" });
		await expect(personal.deliverSchedule({ id: "s", title: "t", prompt: "p" } as Schedule)).rejects.toThrow(
			"not turned on",
		);
	});
});

describe("the loopback requests", () => {
	it("checks hello and receipt, and records what the session says became of an event", async () => {
		const personal = await build();
		await setUp(personal);
		expect(await personal.ipc.request({ op: "hello", sessionId: "s", pid: 1, runKind: "live" })).toEqual({
			ok: true,
		});
		expect(await personal.ipc.request({ op: "hello" } as never)).toMatchObject({ ok: false });
		expect(await personal.ipc.request({ op: "nope" } as never)).toMatchObject({ ok: false });
		const event = await personal.deps.enqueueOwnerEvent({
			source: "companion",
			kind: "control",
			title: "x",
			body: "y",
		});
		expect(await personal.ipc.request({ op: "receipt", eventId: event.id, outcome: "delivered" } as never)).toEqual({
			ok: true,
		});
		expect((await personal.deps.stores.events.get(event.id))?.status).toBe("delivered");
		expect(await personal.ipc.request({ op: "receipt", eventId: 1 } as never)).toMatchObject({ ok: false });
		const posted = await personal.ipc.event({ title: "Build failed", body: "red" });
		expect(posted).toMatchObject({ status: 200, reply: { ok: true } });
	});
});

describe("session folders", () => {
	it("finds a session in the first folder that holds it, and reads the whole handoff reply", async () => {
		const defaultDir = path.join(root, "agent", "sessions");
		await fs.mkdir(path.join(defaultDir, "--p--"), { recursive: true });
		const mine = path.join(defaultDir, "--p--", "2026-10-10T00-00-00-000Z_dflt1.jsonl");
		await Bun.write(mine, `${JSON.stringify({ type: "session", id: "dflt1", cwd: "/w" })}\n`);
		const personalFile = await sessionFile("pers1");
		const dirs = [defaultDir, paths.sessionsDir];
		expect(await findSessionFile(dirs, "dflt1")).toBe(mine);
		expect(await findSessionFile(dirs, "pers1")).toBe(personalFile);
		expect(await findSessionFile(defaultDir, "pers1_missing")).toBeNull();

		const at = (ms: number): string => new Date(ms).toISOString();
		const long = "x".repeat(500);
		await fs.appendFile(
			personalFile,
			[
				{
					type: "message",
					timestamp: at(1_000),
					message: { role: "assistant", content: [{ type: "text", text: "old" }] },
				},
				{
					type: "message",
					timestamp: at(2_000),
					message: { role: "user", content: [{ type: "text", text: "ask" }] },
				},
				{
					type: "message",
					timestamp: at(3_000),
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: long },
							{ type: "text", text: "tail" },
						],
					},
				},
			]
				.map(entry => `${JSON.stringify(entry)}\n`)
				.join(""),
		);
		const entries = await readSessionTail(dirs, "pers1");
		expect(assistantReplySince(entries, 2_500)).toBe(`${long}\ntail`);
		expect(assistantReplySince(entries, 3_000)).toBe(`${long}\ntail`);
		expect(assistantReplySince(entries, 3_001)).toBeNull();
		expect(assistantReplySince([], 0)).toBeNull();
	});
});

describe("settling", () => {
	it("leaves the Personal session out of the organiser: never settled, never ended", async () => {
		const T0 = local(10, 12);
		const settled: string[] = [];
		const endedIds: string[] = [];
		const initial: OrgFile = {
			doc: withSettings(emptyOrg(), { endOnSettle: true }, T0 - 1_000_000),
			rev: 0,
			activity: {},
			settled: {},
			ending: {},
		};
		const org = createSessionOrg({
			now: () => T0,
			initial,
			save: async () => {},
			readPrDone: async () => null,
			prAvailable: () => false,
			onChange: () => {},
			onSettled: sessions => settled.push(...sessions.map(s => s.sessionId)),
			endSession: async session => {
				endedIds.push(session.sessionId);
				return true;
			},
			onError: err => {
				throw err;
			},
			exempt: sessionId => sessionId === "personal-s",
		});
		const listed = (sessionId: string) => ({
			instanceId: `inst-${sessionId}`,
			sessionId,
			cwd: "/w",
			startedAt: T0 - 86_400_000,
			busy: false,
			inputRequired: false,
		});
		// A device settles both; only the ordinary one counts.
		let doc = applyOrg(emptyOrg(), "personal-s", { type: "settle" }, T0);
		doc = applyOrg(doc, "plain-s", { type: "settle" }, T0 + 1);
		const merged = await org.sync(withSettings(doc, { endOnSettle: true }, T0));
		expect(Object.keys(merged.doc.entries)).toEqual(["plain-s"]);
		await org.tick([listed("personal-s"), listed("plain-s")]);
		expect(endedIds).not.toContain("personal-s");
		expect(settled).not.toContain("personal-s");
	});
});

describe("chat-tree mode", () => {
	const quiet = { busy: false, inputRequired: false };

	const patchSettings = async (personal: Personal, patch: Record<string, unknown>): Promise<void> => {
		await request(personal, { t: "personal-settings-set", patch });
	};

	const settingsOf = async (personal: Personal) => {
		const reply = await request(personal, { t: "personal-settings-get" });
		if (reply.t !== "personal-settings-get") throw new Error("not settings");
		return reply.settings;
	};

	/** The chat's log holds a message, so the stored handoff note is stale. */
	const logMessage = async (): Promise<void> => {
		const dir = path.join(paths.chatDir, "main");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "2026-10-09.jsonl"),
			`${JSON.stringify({ i: 0, kind: "user", text: "hello", size: 5, date: "2026-10-09" })}\n`,
		);
	};

	it("takes no daily rollover, renews the session for a full context, and switches mode by restarting", () => {
		const chat = { ...base, chatTree: true, live: quiet };
		expect(keepAliveDecision({ ...chat, rolloverDue: true })).toBe("none");
		expect(keepAliveDecision({ ...chat, contextFull: true })).toBe("renew");
		expect(keepAliveDecision({ ...chat, contextFull: true, rolloverDue: true })).toBe("renew");
		expect(keepAliveDecision({ ...chat, contextFull: true, live: { busy: true, inputRequired: false } })).toBe(
			"none",
		);
		expect(keepAliveDecision({ ...chat, live: null })).toBe("start");
		expect(keepAliveDecision({ ...base, live: quiet, modeMismatch: true })).toBe("rollover");
		expect(keepAliveDecision({ ...chat, modeMismatch: true })).toBe("rollover");
		expect(keepAliveDecision({ ...chat, modeMismatch: true, live: { busy: true, inputRequired: false } })).toBe(
			"none",
		);
	});

	it("advertises canPersonalChatTree with canPersonal and nothing without it", async () => {
		const personal = await build();
		expect(personal.hostsFields(true)).toEqual({ canPersonal: true, canPersonalChatTree: true });
		expect(personal.hostsFields(false)).toEqual({});
	});

	it("keeps the mode in the settings, the profile's config and the next launch, and refuses a bad one", async () => {
		const personal = await build();
		await setUp(personal);
		expect((await settingsOf(personal)).memoryMode).toBe("recall");
		await patchSettings(personal, { memoryMode: "chat-tree" });
		expect((await settingsOf(personal)).memoryMode).toBe("chat-tree");
		expect(Bun.YAML.parse(await Bun.file(paths.configYml).text())).toMatchObject({
			personal: { memoryMode: "chat-tree" },
		});
		await expect(patchSettings(personal, { memoryMode: "endless" })).rejects.toThrow("memory mode");
		expect((await settingsOf(personal)).memoryMode).toBe("chat-tree");

		// A new runtime on the same folder reads it back, and its session starts in the mode.
		const again = await build();
		expect((await settingsOf(again)).memoryMode).toBe("chat-tree");
		await again.tick([]);
		await again.idle();
		expect(launches[0]?.profile?.overlayYaml).toContain("memoryMode: chat-tree");
		expect(again.deps.state.read().session?.mode).toBe("chat-tree");
	});

	it("takes no daily rollover and shows no rollover time", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree", rollover: { time: "01:00" } });
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		clock = local(10, 1, 30);
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		expect(consumed).toEqual([]);
		expect(await personal.deps.stores.events.list()).toEqual([]);
		expect((await statusOf(personal)).nextRolloverAt).toBeNull();
		await patchSettings(personal, { memoryMode: "recall" });
		expect((await statusOf(personal)).nextRolloverAt).toBeGreaterThan(clock);
	});

	it("restarts without a handoff and resumes the same omp session: the chat continues", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		await request(personal, { t: "personal-control", action: "restart" });
		expect(launches).toHaveLength(2);
		expect(launches[1]).toMatchObject({ resume: "sess-1", prompt: undefined });
		expect(consumed.map(event => [event.kind, event.body])).toEqual([["control", "exit"]]);
		expect(personal.deps.state.read().handoff).toBeNull();
		expect(personal.deps.state.read().session).toMatchObject({ sessionId: "sess-1", mode: "chat-tree" });
	});

	it("starts a fresh omp session, with no handoff and no note, when the session file is full; the chat stays", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await personal.tick([]);
		await personal.idle();
		await logMessage();
		const chatFile = path.join(paths.chatDir, "main", "2026-10-09.jsonl");
		const chatBefore = await Bun.file(chatFile).text();
		await personal.deps.state.update(s => ({ ...s, handoff: "stale note" }));
		await fs.truncate(await sessionFile("sess-1"), ROLLOVER_SESSION_BYTES);

		await personal.tick([...hosts]);
		await personal.idle();
		await simulateSession();
		expect(launches).toHaveLength(2);
		expect(launches[1]).toMatchObject({ resume: undefined, prompt: undefined });
		expect(launches[1]?.profile?.overlayYaml).toContain("memoryMode: chat-tree");
		expect(consumed.map(event => [event.kind, event.body])).toEqual([["control", "exit"]]);
		expect(personal.deps.state.read().session).toMatchObject({ sessionId: "sess-2", mode: "chat-tree" });
		expect(await Bun.file(chatFile).text()).toBe(chatBefore);

		// The new session is small: the next poll leaves it be.
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(2);
	});

	it("leaves a busy full session alone until it is idle", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await personal.tick([]);
		await personal.idle();
		await fs.truncate(await sessionFile("sess-1"), ROLLOVER_SESSION_BYTES);
		hosts[0]!.busy = true;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		hosts[0]!.busy = false;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(2);
		expect(launches[1]).toMatchObject({ resume: undefined, prompt: undefined });
	});

	it("switches the live session to the other mode by restarting it once it is idle", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.tick([]);
		await personal.idle();
		await sessionFile("sess-1");
		expect(personal.deps.state.read().session?.mode).toBe("recall");

		// recall → chat-tree: the old session writes its note (the chat's first message), the new one starts in the mode.
		await patchSettings(personal, { memoryMode: "chat-tree" });
		hosts[0]!.busy = true;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(1);
		hosts[0]!.busy = false;
		await personal.tick([...hosts]);
		await personal.idle();
		await simulateSession();
		expect(launches).toHaveLength(2);
		expect(launches[1]).toMatchObject({ resume: undefined, prompt: undefined });
		expect(launches[1]?.profile?.overlayYaml).toContain("memoryMode: chat-tree");
		expect(consumed.map(event => event.kind)).toEqual(["rollover", "control", "control"]);
		const note = consumed[2]!;
		expect(note).toMatchObject({ source: "companion", trust: "owner", body: "note\nHandoff: renew the passport." });
		expect(note.mac).toBeDefined();
		expect(personal.deps.state.read()).toMatchObject({
			handoff: null,
			session: { sessionId: "sess-2", mode: "chat-tree" },
		});

		// A poll that sees the session in the configured mode starts nothing.
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(2);

		// chat-tree → recall: no handoff is asked, a fresh session starts.
		await sessionFile("sess-2");
		consumed.length = 0;
		await patchSettings(personal, { memoryMode: "recall" });
		await personal.tick([...hosts]);
		await personal.idle();
		expect(launches).toHaveLength(3);
		expect(launches[2]).toMatchObject({ resume: undefined, prompt: undefined });
		expect(launches[2]?.profile?.overlayYaml).toContain("memoryMode: recall");
		expect(consumed.map(event => [event.kind, event.body])).toEqual([["control", "exit"]]);
		expect(personal.deps.state.read().session).toMatchObject({ sessionId: "sess-3", mode: "recall" });
	});

	it("hands the stored note to an empty chat on its first start, as signed `note` controls in order", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		const long = `${"a".repeat(NOTE_CHUNK_CHARS)}${"b".repeat(NOTE_CHUNK_CHARS)}c`;
		await personal.deps.state.update(s => ({ ...s, handoff: long }));
		await personal.tick([]);
		await personal.idle();
		await simulateSession();
		expect(launches[0]).toMatchObject({ resume: undefined, prompt: undefined });
		expect(consumed.map(event => event.kind)).toEqual(["control", "control", "control"]);
		expect(consumed.every(event => event.trust === "owner" && event.mac !== undefined)).toBe(true);
		expect(consumed.map(event => event.body.slice(0, NOTE_CONTROL_PREFIX.length))).toEqual([
			"note\n",
			"note\n",
			"note\n",
		]);
		expect(consumed.map(event => event.body.slice(NOTE_CONTROL_PREFIX.length)).join("")).toBe(long);
		expect(personal.deps.state.read().handoff).toBeNull();
	});

	it("keeps the stored note when it cannot be handed over, and hands it over on the next start", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await personal.deps.state.update(s => ({ ...s, handoff: "renew the passport" }));
		const key = await Bun.file(paths.ownerKeyFile).text();
		await fs.rm(paths.ownerKeyFile);
		await personal.tick([]);
		await personal.idle();
		await simulateSession();
		expect(launches).toHaveLength(1);
		expect(consumed).toEqual([]);
		expect(personal.deps.state.read().handoff).toBe("renew the passport");

		// The session dies; the next start still has the note and the chat is still empty.
		await Bun.write(paths.ownerKeyFile, key);
		hosts = [];
		clock += 10 * 60_000;
		await personal.tick([]);
		await personal.idle();
		await simulateSession();
		expect(launches).toHaveLength(2);
		expect(consumed.map(event => event.body)).toEqual(["note\nrenew the passport"]);
		expect(personal.deps.state.read().handoff).toBeNull();
	});

	it("drops the stored note when the chat already has messages", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await logMessage();
		await personal.deps.state.update(s => ({ ...s, handoff: "stale note" }));
		await personal.tick([]);
		await personal.idle();
		await simulateSession();
		expect(consumed).toEqual([]);
		expect(personal.deps.state.read().handoff).toBeNull();
	});

	it("sends no note in recall mode: the note is the first prompt as before", async () => {
		const personal = await build();
		await setUp(personal);
		await personal.deps.state.update(s => ({ ...s, handoff: "check the tax mail" }));
		await personal.tick([]);
		await personal.idle();
		await simulateSession();
		expect(launches[0]?.prompt).toContain("check the tax mail");
		expect(consumed).toEqual([]);
	});

	it("reports the chat's numbers only in chat-tree mode and only while status.json is readable", async () => {
		const personal = await build();
		await setUp(personal);
		const stats = { messages: 1204, nodesBuilt: 1190, nodesPending: 14, viewBytes: 97_000, compactionsFailed: 2 };
		const write = (value: unknown): Promise<number> =>
			Bun.write(paths.chatStatusFile, typeof value === "string" ? value : JSON.stringify(value));
		await fs.mkdir(paths.chatDir, { recursive: true });
		await write({ ...stats, updatedAt: new Date(clock).toISOString() });
		expect((await statusOf(personal)).chatTree).toBeUndefined();
		await patchSettings(personal, { memoryMode: "chat-tree" });
		expect((await statusOf(personal)).chatTree).toEqual({
			messages: 1204,
			nodesPending: 14,
			viewBytes: 97_000,
			compactionsFailed: 2,
		});
		await write("{ not json");
		expect((await statusOf(personal)).chatTree).toBeUndefined();
		await write({ ...stats, messages: "many" });
		expect((await statusOf(personal)).chatTree).toBeUndefined();
		await fs.rm(paths.chatStatusFile);
		expect((await statusOf(personal)).chatTree).toBeUndefined();
	});

	it("tells the devices when the chat's numbers move, at most every few seconds", async () => {
		const personal = await build();
		await setUp(personal);
		await patchSettings(personal, { memoryMode: "chat-tree" });
		await personal.tick([]);
		await personal.idle();
		await personal.tick([...hosts]);
		await personal.idle();
		const numbers = { nodesBuilt: 5, nodesPending: 1, viewBytes: 70_000, compactionsFailed: 0 };
		await fs.mkdir(paths.chatDir, { recursive: true });
		await Bun.write(paths.chatStatusFile, JSON.stringify({ ...numbers, messages: 10 }));
		const before = broadcasts.length;
		clock += 10_000;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(broadcasts.length).toBe(before + 1);
		expect(broadcasts.at(-1)).toMatchObject({ what: ["status"] });
		// Unchanged numbers say nothing.
		clock += 1_000;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(broadcasts.length).toBe(before + 1);
		// Changed numbers inside the window wait for it.
		await Bun.write(paths.chatStatusFile, JSON.stringify({ ...numbers, messages: 11 }));
		clock += 1_000;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(broadcasts.length).toBe(before + 1);
		clock += 5_000;
		await personal.tick([...hosts]);
		await personal.idle();
		expect(broadcasts.length).toBe(before + 2);
	});
});
