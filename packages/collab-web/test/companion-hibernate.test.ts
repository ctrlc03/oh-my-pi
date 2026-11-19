import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hibernateRefusalText, parseHibernateSettings } from "@oh-my-pi/pi-wire/hibernate";
import {
	createHibernation,
	type HibernateFacts,
	type HibernateHostFacts,
	type HibernateHost,
	hibernateRefusal,
	idleLongEnough,
	loadHibernateFile,
	parseHibernateFile,
	requireHibernateSettings,
	saveHibernateFile,
	stateRefusal,
	trackQuiet,
	watchesPullRequest,
} from "../scripts/companion-hibernate";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 10, 12);

const host = (over: Partial<HibernateHost> = {}): HibernateHost => ({
	instanceId: "inst0001",
	sessionId: "sess0001",
	sessionName: "work",
	cwd: "/work/app",
	model: null,
	startedAt: T0 - 60 * MINUTE,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
	background: false,
	...over,
});

const facts = (over: Partial<HibernateFacts> = {}): HibernateFacts => ({
	startedHere: true,
	personal: false,
	launch: { sandboxed: false, restricted: false },
	watchingPr: false,
	attached: false,
	...over,
});

describe("hibernateRefusal", () => {
	it("allows a session the companion started that is finished, unwatched and closed everywhere", () => {
		expect(hibernateRefusal(host(), facts())).toBeNull();
	});

	it("refuses each reason, in the order a user should hear about them", () => {
		expect(hibernateRefusal(host(), facts({ startedHere: false }))).toBe("not-started-here");
		expect(hibernateRefusal(host(), facts({ personal: true }))).toBe("personal");
		expect(hibernateRefusal(host(), facts({ launch: { sandboxed: false, restricted: true } }))).toBe("system");
		expect(hibernateRefusal(host(), facts({ launch: null }))).toBe("unknown-launch");
		expect(hibernateRefusal(host({ agent: { id: "claude", name: "Claude" } }), facts())).toBe("vendor-agent");
		expect(hibernateRefusal(host({ busy: true }), facts())).toBe("working");
		expect(hibernateRefusal(host({ inputRequired: true }), facts())).toBe("needs-input");
		expect(hibernateRefusal(host({ background: true }), facts())).toBe("background-work");
		expect(hibernateRefusal(host({ participants: 2 }), facts())).toBe("open-elsewhere");
		expect(hibernateRefusal(host(), facts({ watchingPr: true }))).toBe("watching-pr");
		expect(hibernateRefusal(host(), facts({ attached: true }))).toBe("terminal-attached");
		// A session that was not started here is told so before anything about its state.
		expect(hibernateRefusal(host({ busy: true }), facts({ startedHere: false }))).toBe("not-started-here");
		expect(hibernateRefusal(host({ busy: true, background: true }), facts())).toBe("working");
	});

	it("counts an unreported signal as work in progress, never as idle", () => {
		expect(hibernateRefusal(host({ busy: null }), facts())).toBe("unknown-state");
		expect(hibernateRefusal(host({ background: null }), facts())).toBe("unknown-state");
		expect(hibernateRefusal(host({ busy: true, background: null }), facts())).toBe("working");
	});

	it("has a sentence for every reason", () => {
		expect(hibernateRefusalText("working")).toContain("working");
		expect(hibernateRefusalText("open-elsewhere")).toContain("open");
	});
});

describe("idle tracking", () => {
	it("starts a session's idle time when first seen quiet and keeps it while it stays so", () => {
		const first = trackQuiet(new Map(), [host()], T0);
		expect(first.get("inst0001")).toBe(T0);
		expect(trackQuiet(first, [host()], T0 + 10 * MINUTE).get("inst0001")).toBe(T0);
	});

	it("resets when work, a question, background work or a viewer shows, and starts again afterwards", () => {
		const quiet = new Map([["inst0001", T0]]);
		for (const busy of [host({ busy: true }), host({ inputRequired: true }), host({ background: true }), host({ participants: 2 })]) {
			expect(trackQuiet(quiet, [busy], T0 + MINUTE).has("inst0001")).toBe(false);
		}
		const again = trackQuiet(new Map(), [host()], T0 + 20 * MINUTE);
		expect(again.get("inst0001")).toBe(T0 + 20 * MINUTE);
	});

	it("never tracks a session whose state is unknown", () => {
		expect(trackQuiet(new Map(), [host({ background: null })], T0).size).toBe(0);
	});
});

describe("idleLongEnough", () => {
	it("is never true with the setting off or for a session not seen quiet", () => {
		expect(idleLongEnough(0, T0, null, T0 + 10_000 * MINUTE)).toBe(false);
		expect(idleLongEnough(30, undefined, null, T0 + 10_000 * MINUTE)).toBe(false);
	});

	it("is true from exactly the threshold on", () => {
		expect(idleLongEnough(30, T0, null, T0 + 30 * MINUTE - 1)).toBe(false);
		expect(idleLongEnough(30, T0, null, T0 + 30 * MINUTE)).toBe(true);
	});

	it("lets a recently written session file push the start later, never earlier", () => {
		expect(idleLongEnough(30, T0, T0 + 20 * MINUTE, T0 + 40 * MINUTE)).toBe(false);
		expect(idleLongEnough(30, T0, T0 + 20 * MINUTE, T0 + 50 * MINUTE)).toBe(true);
		expect(idleLongEnough(30, T0 + 20 * MINUTE, T0, T0 + 40 * MINUTE)).toBe(false);
	});
});

describe("settings and the file", () => {
	it("falls back to 30 minutes for anything but a listed delay", () => {
		expect(parseHibernateSettings({ afterMinutes: 240 })).toEqual({ afterMinutes: 240 });
		expect(parseHibernateSettings({ afterMinutes: 0 })).toEqual({ afterMinutes: 0 });
		expect(parseHibernateSettings({ afterMinutes: 7 })).toEqual({ afterMinutes: 30 });
		expect(parseHibernateSettings("15")).toEqual({ afterMinutes: 30 });
		expect(parseHibernateSettings(null)).toEqual({ afterMinutes: 30 });
	});

	it("rejects a request that is not a listed delay instead of resetting the setting", () => {
		expect(requireHibernateSettings({ afterMinutes: 60 })).toEqual({ afterMinutes: 60 });
		expect(() => requireHibernateSettings({ afterMinutes: 7 })).toThrow("invalid hibernation settings");
		expect(() => requireHibernateSettings(undefined)).toThrow("invalid hibernation settings");
	});

	it("keeps well-formed records and drops damaged, unsafe and duplicate ones", () => {
		const good = {
			sessionId: "sess0001",
			instanceId: "inst0001",
			sessionName: null,
			cwd: "/work/app",
			model: "a/b",
			startedAt: 1,
			hibernatedAt: 2,
			sandboxed: true,
			maxCostUsd: 1.5,
		};
		const parsed = parseHibernateFile({
			settings: { afterMinutes: 15 },
			sessions: [
				good,
				{ ...good, instanceId: "inst0002" },
				{ ...good, sessionId: "sess0002", cwd: "relative" },
				{ ...good, sessionId: "--flag" },
				{ ...good, sessionId: "sess0003", hibernatedAt: "yesterday" },
				// A spend limit that is damaged is never read as "no limit".
				{ ...good, sessionId: "sess0004", maxCostUsd: -1 },
				"garbage",
			],
			launches: [
				{ sessionId: "sess0001", sandboxed: true, restricted: false, maxCostUsd: 2 },
				{ sessionId: "sess0001", sandboxed: false, restricted: false },
				{ sessionId: "sess0002", sandboxed: "yes", restricted: false },
				{ sessionId: "sess0003", sandboxed: false, restricted: true },
			],
		});
		expect(parsed.settings).toEqual({ afterMinutes: 15 });
		expect(parsed.sessions).toEqual([good]);
		expect(parsed.launches).toEqual([
			{ sessionId: "sess0001", sandboxed: true, restricted: false, maxCostUsd: 2 },
			{ sessionId: "sess0003", sandboxed: false, restricted: true },
		]);
	});

	describe("on disk", () => {
		const dirs: string[] = [];
		afterEach(async () => {
			for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
		});

		it("round-trips, and a missing or unreadable file reads as the defaults", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hibernate-"));
			dirs.push(dir);
			const file = path.join(dir, "hibernate.json");
			expect(await loadHibernateFile(file)).toEqual({ settings: { afterMinutes: 30 }, sessions: [], launches: [] });
			await Bun.write(file, "{not json");
			expect(await loadHibernateFile(file)).toEqual({ settings: { afterMinutes: 30 }, sessions: [], launches: [] });
			const contents = {
				settings: { afterMinutes: 60 },
				sessions: [
					{
						sessionId: "sess0001",
						instanceId: "inst0001",
						sessionName: "work",
						cwd: "/work/app",
						model: null,
						startedAt: 1,
						hibernatedAt: 2,
					},
				],
				launches: [{ sessionId: "sess0001", sandboxed: false, restricted: false, maxCostUsd: 3 }],
			};
			await saveHibernateFile(file, contents);
			expect(await loadHibernateFile(file)).toEqual(contents);
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		});

		it("reads a pull request watch only while it is fresh and names a pull request", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hibernate-pr-"));
			dirs.push(dir);
			await fs.mkdir(path.join(dir, "watches"));
			const file = path.join(dir, "watches", "sess0001.json");
			const body = (prs: unknown[]) => JSON.stringify({ sessionId: "sess0001", cwd: "/w", updatedAt: 1, prs });
			await Bun.write(file, body([{ repo: "o/r", number: 4, since: "2026-01-01T00:00:00Z" }]));
			const mtime = (await fs.stat(file)).mtimeMs;
			expect(await watchesPullRequest(dir, "sess0001", mtime + MINUTE)).toBe(true);
			expect(await watchesPullRequest(dir, "sess0001", mtime + 10 * MINUTE)).toBe(false);
			expect(await watchesPullRequest(dir, "sess0002", mtime)).toBe(false);
			await Bun.write(file, body([]));
			expect(await watchesPullRequest(dir, "sess0001", (await fs.stat(file)).mtimeMs)).toBe(false);
		});
	});
});

describe("createHibernation", () => {
	function harness(afterMinutes = 30, launched = true) {
		let clock = T0;
		const hosts = [host()];
		const saved: unknown[] = [];
		const stopped: string[] = [];
		const resumed: unknown[] = [];
		const calls = { list: 0, facts: 0 };
		const state = {
			exists: true,
			folder: true,
			stopResult: true,
			stopThrows: false,
			factsOver: {} as Partial<HibernateHostFacts>,
		};
		const hibernation = createHibernation({
			now: () => clock,
			initial: { settings: { afterMinutes }, sessions: [], launches: [] },
			save: async file => void saved.push(file),
			list: async () => {
				calls.list++;
				return { hosts: [...hosts], idle: [] };
			},
			facts: async () => {
				calls.facts++;
				const { launch: _launch, ...rest } = facts(state.factsOver);
				return rest;
			},
			touchedAt: async () => null,
			exists: async () => state.exists,
			folderExists: async () => state.folder,
			stop: async stopping => {
				if (state.stopThrows) throw new Error("no such process");
				stopped.push(stopping.instanceId);
				if (state.stopResult) hosts.splice(0, hosts.length);
				return state.stopResult;
			},
			resume: async session => {
				resumed.push(session);
				hosts.push(host({ instanceId: "inst0002", sessionId: session.sessionId }));
				return "inst0002";
			},
			lock: (_key, work) => work(),
			onChange: () => {},
			onError: err => {
				throw err;
			},
		});
		if (launched) hibernation.noteLaunch("sess0001", { sandboxed: false, restricted: false });
		return { hibernation, hosts, stopped, resumed, calls, state, advance: (ms: number) => void (clock += ms) };
	}

	it("hibernates only after the session has been quiet for the whole delay", async () => {
		const h = harness(30);
		await h.hibernation.tick();
		h.advance(29 * MINUTE);
		await h.hibernation.tick();
		expect(h.stopped).toEqual([]);
		h.advance(MINUTE);
		await h.hibernation.tick();
		expect(h.stopped).toEqual(["inst0001"]);
		expect(h.hibernation.list().map(s => [s.sessionId, s.instanceId])).toEqual([["sess0001", "inst0001"]]);
	});

	it("never hibernates by itself with the setting off, but still on request, and does not even list", async () => {
		const h = harness(0);
		await h.hibernation.tick();
		h.advance(10_000 * MINUTE);
		await h.hibernation.tick();
		expect(h.stopped).toEqual([]);
		expect(h.calls.list).toBe(0);
		await h.hibernation.hibernate("inst0001");
		expect(h.stopped).toEqual(["inst0001"]);
	});

	it("restarts the clock when the session works again", async () => {
		const h = harness(30);
		await h.hibernation.tick();
		h.advance(20 * MINUTE);
		h.hosts[0] = host({ busy: true });
		await h.hibernation.tick();
		h.hosts[0] = host();
		h.advance(20 * MINUTE);
		await h.hibernation.tick();
		expect(h.stopped).toEqual([]);
	});

	it("does not ask again about a session that can never be hibernated", async () => {
		const h = harness(15, false);
		await h.hibernation.tick();
		h.advance(20 * MINUTE);
		await h.hibernation.tick();
		expect(h.calls.facts).toBe(1);
		h.advance(MINUTE);
		await h.hibernation.tick();
		expect(h.calls.facts).toBe(1);
		expect(h.stopped).toEqual([]);
		// One that is only attached for now is asked about again.
		const attached = harness(15);
		attached.state.factsOver = { attached: true };
		await attached.hibernation.tick();
		attached.advance(20 * MINUTE);
		await attached.hibernation.tick();
		await attached.hibernation.tick();
		expect(attached.calls.facts).toBe(2);
	});

	it("refuses a manual request with the reason, and leaves the session running", async () => {
		const h = harness();
		h.state.factsOver = { attached: true };
		await expect(h.hibernation.hibernate("inst0001")).rejects.toThrow(hibernateRefusalText("terminal-attached"));
		expect(h.stopped).toEqual([]);
		expect(h.hibernation.list()).toEqual([]);
		await expect(h.hibernation.hibernate("nope")).rejects.toThrow("unknown session");
	});

	it("never hibernates a session whose launch was not recorded or was restricted", async () => {
		const unknown = harness(30, false);
		await expect(unknown.hibernation.hibernate("inst0001")).rejects.toThrow(hibernateRefusalText("unknown-launch"));
		const restricted = harness(30, false);
		restricted.hibernation.noteLaunch("sess0001", { sandboxed: true, restricted: true });
		await expect(restricted.hibernation.hibernate("inst0001")).rejects.toThrow(hibernateRefusalText("system"));
		expect(unknown.stopped.concat(restricted.stopped)).toEqual([]);
	});

	it("keeps the record when omp is still closing after the stop timeout, and forgets it when nothing was sent", async () => {
		const h = harness();
		h.state.stopResult = false;
		await expect(h.hibernation.hibernate("inst0001")).rejects.toThrow("still closing");
		expect(h.hibernation.list().map(s => s.sessionId)).toEqual(["sess0001"]);
		// It is still running when it is opened: that process is the answer, and the record goes.
		expect(await h.hibernation.wake("inst0001")).toBe("inst0001");
		expect(h.resumed).toEqual([]);
		expect(h.hibernation.list()).toEqual([]);
		const failing = harness();
		failing.state.stopThrows = true;
		await expect(failing.hibernation.hibernate("inst0001")).rejects.toThrow("no such process");
		expect(failing.hibernation.list()).toEqual([]);
	});

	it("resumes a hibernated session once, however many devices open it, and drops the record", async () => {
		const h = harness();
		await h.hibernation.hibernate("inst0001");
		const [a, b] = await Promise.all([h.hibernation.wake("inst0001"), h.hibernation.wake("inst0001")]);
		expect([a, b]).toEqual(["inst0002", "inst0002"]);
		expect(h.resumed).toHaveLength(1);
		expect(h.hibernation.list()).toEqual([]);
		// An id that was never hibernated is not this feature's to answer.
		expect(await h.hibernation.wake("inst0002")).toBeNull();
	});

	it("resumes with the spend limit and the sandbox it was launched with", async () => {
		const h = harness(30, false);
		h.hibernation.noteLaunch("sess0001", { sandboxed: true, restricted: false, maxCostUsd: 2.5 });
		await h.hibernation.hibernate("inst0001");
		await h.hibernation.wake("inst0001");
		expect(h.resumed).toMatchObject([{ sessionId: "sess0001", sandboxed: true, maxCostUsd: 2.5 }]);
	});

	it("drops a record whose folder is gone, with a clear error, instead of failing every resume", async () => {
		const h = harness();
		await h.hibernation.hibernate("inst0001");
		h.state.folder = false;
		await expect(h.hibernation.wake("inst0001")).rejects.toThrow("folder this session ran in is gone");
		expect(h.resumed).toEqual([]);
		expect(h.hibernation.list()).toEqual([]);
	});

	it("keeps the record while a process it does not belong to is listed, and drops it when the session runs again elsewhere", async () => {
		const h = harness();
		await h.hibernation.hibernate("inst0001");
		// The stopped process lingering in the listing is not a resume.
		h.hibernation.observe([host({ instanceId: "inst0001" })], []);
		expect(h.hibernation.list()).toHaveLength(1);
		h.hibernation.observe([host({ instanceId: "inst0009" })], []);
		expect(h.hibernation.list()).toEqual([]);
	});

	it("drops a record whose session file is gone, on the first sweep", async () => {
		const h = harness();
		await h.hibernation.hibernate("inst0001");
		h.state.exists = false;
		await h.hibernation.tick();
		expect(h.hibernation.list()).toEqual([]);
	});

	it("forgets the record and the launch of a session that was ended", async () => {
		const h = harness();
		await h.hibernation.hibernate("inst0001");
		h.hibernation.forget("sess0001");
		expect(h.hibernation.list()).toEqual([]);
		expect(h.hosts).toEqual([]);
		h.hosts.push(host());
		await expect(h.hibernation.hibernate("inst0001")).rejects.toThrow(hibernateRefusalText("unknown-launch"));
	});

	it("is exposed as a pure decision too: an unknown state is not eligible", () => {
		expect(stateRefusal(host({ background: null }))).toBe("unknown-state");
	});
});
