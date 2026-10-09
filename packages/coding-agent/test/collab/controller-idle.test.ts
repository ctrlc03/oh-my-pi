/**
 * Contract: while a process hosts nothing, `CollabController.publishIdle()`
 * keeps an idle registry entry that `omp collab list` shows under `idle` and
 * `omp collab start` turns into a room through the same `start()` path as
 * `/collab`. The entry disappears from `idle` whenever the process cannot be
 * started (hosting, guest, shutdown) and is withdrawn on shutdown.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import type { CollabAccess } from "@oh-my-pi/pi-coding-agent/collab/registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

let tmp: string;
let controller: CollabController | undefined;
let publishSpy: Mock<typeof registry.publishCollabIdle>;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-idle-"));
	fakeStops.length = 0;
	const real = registry.publishCollabIdle;
	publishSpy = spyOn(registry, "publishCollabIdle").mockImplementation((source, options) =>
		real(source, { ...options, dir: tmp }),
	);
});

afterEach(async () => {
	await controller?.shutdown("test cleanup");
	controller = undefined;
	publishSpy.mockRestore();
	await fs.rm(tmp, { recursive: true, force: true });
});

function makeContext(): InteractiveModeContext {
	return {
		collabGuest: undefined,
		showStatus: () => {},
		sessionManager: { getSessionId: () => "sess-idle", getCwd: () => "/work/idle" },
		session: {
			model: { provider: "test", id: "model-1" },
			sessionName: "Idle Session",
			isStreaming: false,
			isSessionTransitioning: false,
		},
	} as unknown as InteractiveModeContext;
}

const fakeStops: string[] = [];

function fakeHost(access: CollabAccess, generation = 1): CollabHost {
	return {
		access,
		generation,
		ending: false,
		sessionId: "sess-idle",
		webLink: `https://collab.test/control/${generation}`,
		webViewLink: `https://collab.test/view/${generation}`,
		stop: async (reason: string) => {
			fakeStops.push(reason);
		},
	} as unknown as CollabHost;
}

describe("CollabController idle registry entry", () => {
	it("lists the process as idle with its session state, and withdraws the entry on shutdown", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		await controller.publishIdle();

		const { hosts, idle } = await registry.listCollabSessions({ dir: tmp });
		expect(hosts).toEqual([]);
		expect(idle).toEqual([
			{
				instanceId: controller.instanceId,
				pid: process.pid,
				sessionId: "sess-idle",
				sessionName: "Idle Session",
				cwd: "/work/idle",
				model: { provider: "test", id: "model-1" },
				startedAt: expect.any(Number),
				busy: false,
			},
		]);

		(ctx.session as unknown as { isStreaming: boolean }).isStreaming = true;
		expect((await registry.listCollabSessions({ dir: tmp })).idle[0]?.busy).toBe(true);

		await controller.shutdown("done");
		expect((await fs.readdir(tmp)).filter(name => name.endsWith(".json"))).toEqual([]);
	});

	it("is not offered while the process hosts, is a guest, or is switching sessions, and returns when that ends", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		await controller.publishIdle();
		const idleIds = async (): Promise<string[]> =>
			(await registry.listCollabSessions({ dir: tmp })).idle.map(entry => entry.instanceId);
		const self = [controller.instanceId];
		expect(await idleIds()).toEqual(self);

		Object.defineProperty(controller, "host", { configurable: true, get: () => fakeHost("control") });
		expect(await idleIds()).toEqual([]);
		Reflect.deleteProperty(controller, "host");
		expect(await idleIds()).toEqual(self);

		ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
		expect(await idleIds()).toEqual([]);
		ctx.collabGuest = undefined;
		expect(await idleIds()).toEqual(self);

		(ctx.session as unknown as { isSessionTransitioning: boolean }).isSessionTransitioning = true;
		expect(await idleIds()).toEqual([]);
	});

	it("starts hosting through start() with the requested access and returns that link", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		await controller.publishIdle();
		const start = spyOn(controller, "start").mockImplementation(async options => fakeHost(options.access, 3));

		expect(await registry.startCollabSession(controller.instanceId, "control", { dir: tmp })).toEqual({
			instanceId: controller.instanceId,
			generation: 3,
			access: "control",
			url: "https://collab.test/control/3",
		});
		expect(await registry.startCollabSession(String(process.pid), "view", { dir: tmp })).toMatchObject({
			access: "view",
			url: "https://collab.test/view/3",
		});
		expect(start.mock.calls.map(([options]) => options.access)).toEqual(["control", "view"]);
	});

	it("refuses to start a guest or a shut-down process and reports a failed start with its reason", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		await controller.publishIdle();

		const start = spyOn(controller, "start").mockRejectedValue(new Error("No relay configured."));
		await expect(registry.startCollabSession(controller.instanceId, "control", { dir: tmp })).rejects.toMatchObject({
			code: "start_failed",
			message: expect.stringContaining("No relay configured."),
		});

		// A guest is not listed as startable, and a request that raced the join is refused outright.
		ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
		start.mockClear();
		await expect(registry.startCollabSession(controller.instanceId, "control", { dir: tmp })).rejects.toMatchObject({
			code: "not_found",
		});
		expect(start).not.toHaveBeenCalled();
	});

	it("never replaces or upgrades a live room from outside", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		await controller.publishIdle();
		Object.defineProperty(controller, "host", { configurable: true, get: () => fakeHost("view", 2) });

		// The listing already hides it; a request that raced the room opening gets
		// its existing view link, and a control request is refused.
		const meta = JSON.parse(
			await Bun.file(path.join(tmp, (await fs.readdir(tmp)).find(name => name.endsWith(".json")) ?? "")).text(),
		) as { endpoint: string; token: string };
		const reply = async (access: CollabAccess): Promise<Record<string, unknown>> => {
			const socket = await Bun.connect({
				unix: meta.endpoint,
				socket: {
					data(_socket, data) {
						received.resolve(JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>);
					},
				},
			});
			const received = Promise.withResolvers<Record<string, unknown>>();
			socket.write(
				`${JSON.stringify({ v: registry.COLLAB_IDLE_REGISTRY_VERSION, token: meta.token, op: "start", access })}\n`,
			);
			const result = await received.promise;
			socket.end();
			return result;
		};
		expect(await reply("view")).toMatchObject({ ok: true, generation: 2, url: "https://collab.test/view/2" });
		expect(await reply("control")).toMatchObject({ ok: false, error: "access_unavailable" });
		expect(fakeStops).toEqual([]);
	});

	it("keeps a view room that was installed while an external control start waited in the queue", async () => {
		const ctx = makeContext();
		controller = new CollabController(ctx);
		// No room at arrival; a view room appears by the time the queued request runs.
		let installed = false;
		Object.defineProperty(controller, "host", {
			configurable: true,
			get: () => (installed ? fakeHost("view", 2) : undefined),
		});
		const queued = controller.start({ access: "control", external: true });
		installed = true;

		await expect(queued).rejects.toMatchObject({ code: "access_unavailable" });
		expect(fakeStops).toEqual([]);
	});
});
