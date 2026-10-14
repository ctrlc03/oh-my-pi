import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalBeat, PersonalEvent } from "@oh-my-pi/pi-wire/personal-ipc";
import { Settings } from "../../src/config/settings";
import { BEAT_FILE } from "../../src/personal/beat";
import { INBOX_DIR, type PersonalEventMessage } from "../../src/personal/events";
import type { PersonalCompanion } from "../../src/personal/ipc-client";
import { signPersonalEvent } from "../../src/personal/owner-key";
import { PersonalRuntime, type PersonalRuntimeHost } from "../../src/personal/runtime";
import { cfgToolsApprovalMode } from "../../src/tools/settings";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-runtime-"));
});

afterEach(() => fs.rm(root, { recursive: true, force: true }));

interface Rig {
	host: PersonalRuntimeHost;
	settings: Settings;
	hellos: { sessionId: string; pid: number }[];
	receipts: { eventId: string; outcome: string }[];
	delivered: PersonalEventMessage[];
	exits: { requested: number; forced: number };
	runListeners: Set<(state: "running" | "idle") => void>;
	state: { busy: boolean; disposed: boolean; capped: "day" | "month" | undefined };
}

function rig(overrides: Record<string, unknown> = {}, topLevel = true): Rig {
	const settings = Settings.isolated({ "personal.enabled": true, "personal.events.pollSeconds": 1, ...overrides });
	const hellos: Rig["hellos"] = [];
	const receipts: Rig["receipts"] = [];
	const delivered: PersonalEventMessage[] = [];
	const exits = { requested: 0, forced: 0 };
	const runListeners = new Set<(state: "running" | "idle") => void>();
	const state: Rig["state"] = { busy: false, disposed: false, capped: undefined };
	const companion: PersonalCompanion = {
		notify: async () => ({ itemId: "i", pushed: false }),
		hello: async request => {
			hellos.push(request);
		},
		receipt: async request => {
			receipts.push({ eventId: request.eventId, outcome: request.outcome });
		},
	};
	const host: PersonalRuntimeHost = {
		settings,
		agentDir: path.join(root, "agent"),
		runDir: path.join(root, "run"),
		topLevel,
		sessionId: () => "sess-1",
		isBusy: () => state.busy,
		isDisposed: () => state.disposed,
		capped: () => state.capped,
		deliveredEventIds: () => [],
		deliver: async message => {
			delivered.push(message);
		},
		requestExit: () => {
			exits.requested += 1;
		},
		forceExit: async () => {
			exits.forced += 1;
		},
		subscribeRunState: listener => {
			runListeners.add(listener);
			return () => runListeners.delete(listener);
		},
		companion,
	};
	return { host, settings, hellos, receipts, delivered, exits, runListeners, state };
}

const eventFile = (id: string) => path.join(root, "run", INBOX_DIR, `${id}.json`);
const beatFile = () => path.join(root, "run", BEAT_FILE);
const external = (id: string): PersonalEvent => ({
	id,
	source: "email",
	kind: "event",
	at: 1,
	title: "t",
	body: "b",
	trust: "external",
});

/** Waits for real filesystem work and the runtime's own timers to land; there is no event to await, so it polls. */
async function until(check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(20);
	}
}

describe("PersonalRuntime.createIf", () => {
	it("creates nothing without personal.enabled", async () => {
		const r = rig({ "personal.enabled": false });
		expect(PersonalRuntime.createIf(r.host)).toBeUndefined();
		expect(r.runListeners.size).toBe(0);
		expect(await fs.stat(path.join(root, "run")).catch(() => undefined)).toBeUndefined();
	});

	it("creates nothing for a subagent", () => {
		expect(PersonalRuntime.createIf(rig({}, false).host)).toBeUndefined();
	});
});

describe("live runtime", () => {
	it("says hello, beats, delivers an inbox event, and cleans up on dispose", async () => {
		const r = rig();
		const runtime = PersonalRuntime.createIf(r.host);
		expect(runtime?.runKind).toBe("live");
		runtime?.start();
		await until(() => Bun.file(beatFile()).exists());
		const beat = (await Bun.file(beatFile()).json()) as PersonalBeat;
		expect(beat).toMatchObject({ sessionId: "sess-1", pid: process.pid, busy: false, inputRequired: false });
		expect(r.hellos).toEqual([{ sessionId: "sess-1", pid: process.pid }]);

		await Bun.write(eventFile("e1"), JSON.stringify(external("e1")));
		await until(() => r.delivered.length === 1);
		expect(r.delivered[0].details).toMatchObject({ id: "e1", trust: "external" });
		await until(() => r.receipts.length === 1);
		expect(r.receipts[0]).toEqual({ eventId: "e1", outcome: "delivered" });

		await runtime?.dispose();
		expect(await Bun.file(beatFile()).exists()).toBe(false);
		expect(r.runListeners.size).toBe(0);
	});

	it("looks at the inbox when the session goes idle, not only on the timer", async () => {
		const r = rig({ "personal.events.pollSeconds": 3600 });
		const runtime = PersonalRuntime.createIf(r.host);
		runtime?.start();
		await Bun.write(eventFile("e1"), JSON.stringify(external("e1")));
		for (const listener of r.runListeners) listener("idle");
		await until(() => r.delivered.length === 1);
		await runtime?.dispose();
	});

	it("reports a spend cap and a pending ask in the beat", async () => {
		const r = rig({ "personal.events.pollSeconds": 3600 });
		r.state.capped = "day";
		const runtime = PersonalRuntime.createIf(r.host);
		runtime?.start();
		await until(() => Bun.file(beatFile()).exists());
		expect(((await Bun.file(beatFile()).json()) as PersonalBeat).capped).toBe("day");
		runtime?.onAgentEvent({ type: "tool_execution_start", toolName: "ask", toolCallId: "c1" });
		await until(async () => ((await Bun.file(beatFile()).json()) as PersonalBeat).inputRequired === true);
		runtime?.onAgentEvent({ type: "tool_execution_end", toolName: "ask", toolCallId: "c1" });
		await until(async () => ((await Bun.file(beatFile()).json()) as PersonalBeat).inputRequired === false);
		await runtime?.dispose();
	});

	it("exits through the host once for a signed control exit, and keeps no claim on later events", async () => {
		const r = rig();
		const key = "k".repeat(43);
		await Bun.write(path.join(root, "agent", "collab-companion-personal-owner.key"), key);
		const control: PersonalEvent = {
			id: "c1",
			source: "owner-control",
			kind: "control",
			at: 1,
			title: "exit",
			body: "exit",
			trust: "owner",
		};
		await Bun.write(eventFile("c1"), JSON.stringify({ ...control, mac: signPersonalEvent(key, control) }));
		const runtime = PersonalRuntime.createIf(r.host);
		runtime?.start();
		await until(() => r.exits.requested === 1);
		await runtime?.dispose();
		expect(r.exits).toEqual({ requested: 1, forced: 0 });
	});
});

describe("review runtime", () => {
	it("takes no events, beats not and greets not", async () => {
		const r = rig({ "personal.runKind": "review" });
		const runtime = PersonalRuntime.createIf(r.host);
		expect(runtime?.runKind).toBe("review");
		runtime?.start();
		await Bun.write(eventFile("e1"), JSON.stringify(external("e1")));
		for (const listener of r.runListeners) listener("idle");
		expect(r.delivered).toEqual([]);
		expect(r.hellos).toEqual([]);
		expect(await Bun.file(beatFile()).exists()).toBe(false);
		await runtime?.dispose();
	});
});

const noDevice = () => undefined;

describe("turn origin and refusals through the runtime", () => {
	it("judges a write to an xd:// device as the device, not as write", async () => {
		const r = rig();
		const runtime = PersonalRuntime.createIf(r.host);
		runtime?.onAgentEvent({ type: "agent_start" });
		runtime?.onAgentEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "personal-event",
				details: { id: "e1", source: "x", kind: "event", trust: "external" },
			},
		});
		const devices: Record<string, { name: string; approval: "write" | "exec" }> = {
			memory_edit: { name: "memory_edit", approval: "write" },
			schedule: { name: "schedule", approval: "exec" },
		};
		const lookup = (name: string) => devices[name];
		const write = { name: "write", approval: "write" as const };
		for (const device of ["memory_edit", "schedule", "XD://schedule"]) {
			const args = { path: device.startsWith("XD") ? device : `xd://${device}`, content: '{"op":"forget"}' };
			expect(runtime?.refuseToolCall(write, args, lookup)).toContain("Refused");
		}
		expect(runtime?.refuseToolCall(write, { path: "xd://recall", content: "{}" }, lookup)).toBeUndefined();
		expect(runtime?.refuseToolCall(write, { path: "xd://memory_edit", content: "not json" }, lookup)).toContain(
			"Refused",
		);
		await runtime?.dispose();
	});

	it("refuses memory_edit in an external turn and gives approval mode back when idle", async () => {
		const r = rig();
		const runtime = PersonalRuntime.createIf(r.host);
		expect(runtime?.currentOrigin()).toBe("agent");
		runtime?.start();
		runtime?.onAgentEvent({ type: "agent_start" });
		runtime?.onAgentEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "personal-event",
				details: { id: "e1", source: "x", kind: "event", trust: "external" },
			},
		});
		expect(runtime?.currentOrigin()).toBe("external");
		expect(cfgToolsApprovalMode.get(r.settings)).toBe("always-ask");
		expect(runtime?.refuseToolCall({ name: "memory_edit", approval: "write" }, {}, noDevice)).toContain("Refused");
		expect(runtime?.refuseToolCall({ name: "read", approval: "read" }, {}, noDevice)).toBeUndefined();
		for (const listener of r.runListeners) listener("idle");
		expect(runtime?.currentOrigin()).toBe("agent");
		expect(cfgToolsApprovalMode.get(r.settings)).toBe("yolo");
		expect(runtime?.refuseToolCall({ name: "memory_edit", approval: "write" }, {}, noDevice)).toBeUndefined();
		await runtime?.dispose();
	});

	it("an owner prompt makes an owner turn that refuses nothing", async () => {
		const r = rig();
		const runtime = PersonalRuntime.createIf(r.host);
		runtime?.onAgentEvent({ type: "agent_start" });
		runtime?.onAgentEvent({ type: "message_start", message: { role: "user", content: "hi" } });
		expect(runtime?.currentOrigin()).toBe("owner");
		expect(runtime?.refuseToolCall({ name: "schedule", approval: "exec" }, {}, noDevice)).toBeUndefined();
		await runtime?.dispose();
	});
});
