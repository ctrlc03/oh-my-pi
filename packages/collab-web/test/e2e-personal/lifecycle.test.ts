import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalStatus } from "@oh-my-pi/pi-wire/personal";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { describeE2e, realTime, SCENARIO_TIMEOUT_MS } from "./support";

const exists = (file: string): Promise<boolean> =>
	fs.stat(file).then(
		() => true,
		() => false,
	);
const mode = async (file: string): Promise<number> => (await fs.stat(file)).mode & 0o777;

/** Scenarios 1, 2, 11, 7 and 6: off by default, setup, disable and enable, keep-alive, rollover. One computer, in this order. */
describeE2e("the Personal agent's lifecycle", () => {
	let h: PersonalHarness;
	let P: string;
	let C: string;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		C = h.configDir;
		P = h.profile;
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const sessionName = async (): Promise<string[]> => {
		const listed = await h.tmux("list-sessions", "-F", "#{session_name}");
		return listed.code === 0 ? listed.out.split("\n").filter(Boolean) : [];
	};

	it(
		"is off on a fresh computer: no profile, no event channel, nothing running",
		async () => {
			expect(await exists(path.join(C, "profiles", "personal"))).toBe(false);
			expect(await exists(path.join(C, "run", "personal"))).toBe(false);
			const snapshot = h.client.getSnapshot();
			expect(snapshot.canPersonal).toBe(true);
			expect(snapshot.hosts).toEqual([]);
			expect(await h.status()).toMatchObject({ setUp: false, enabled: false, run: "off", session: null });
			expect(await sessionName()).toEqual([]);
			expect(h.stub.requests).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"sets up the layout of the spec, reads the login as missing until models.yml exists, then starts the session",
		async () => {
			const status = (
				await h.call({ t: "personal-setup", about: "# About you\n\n## Who I am\n\n- Sam, a baker.\n" })
			).status;
			expect(status).toMatchObject({ setUp: true, enabled: true });
			expect(status.login.state).toBe("missing");
			expect(["off", "stopped", "starting"]).toContain(status.run);
			expect(h.personalHost()).toBeUndefined();

			// The layout.
			for (const dir of ["agent", "workspace", "personal", "personal/about-history", "backups"]) {
				expect((await fs.stat(path.join(P, dir))).isDirectory()).toBe(true);
			}
			for (const file of ["agent/config.yml", "agent/AGENTS.md", "agent/APPEND_SYSTEM.md", "personal/state.json"]) {
				expect(await exists(path.join(P, file))).toBe(true);
			}
			expect(await Bun.file(path.join(P, "agent", "AGENTS.md")).text()).toContain("Sam, a baker.");
			expect(await exists(path.join(P, "agent", "agent.db"))).toBe(false);
			expect(await exists(path.join(C, "run", "personal", "inbox"))).toBe(true);

			// The channel files the companion writes: private to the owner.
			for (const file of ["collab-companion-personal-ipc.json", "collab-companion-personal-owner.key"]) {
				expect(await mode(path.join(P, "agent", file))).toBe(0o600);
			}

			// The managed config: the spec's keys.
			const config = Bun.YAML.parse(await Bun.file(path.join(P, "agent", "config.yml")).text()) as Record<
				string,
				any
			>;
			expect(config.personal).toMatchObject({
				enabled: true,
				runKind: "live",
				notifyOwner: { maxPerHour: 6, maxOpenQuestions: 5 },
				events: { maxPerSourcePerHour: 4, maxPerHour: 12, pollSeconds: 5 },
				externalTurns: { policy: "always-ask" },
				allowShareLinks: false,
			});
			expect(config.memory).toEqual({ backend: "mnemopi" });
			expect(config.mnemopi).toMatchObject({
				scoping: "global",
				retention: "permanent",
				provenance: true,
				recallEveryTurn: true,
				consolidateIntervalMinutes: 60,
			});
			expect(config.session.spendLimits).toEqual({ dayUsd: 5, monthUsd: 50 });
			expect(config.sandbox).toMatchObject({
				mode: "workspace-write",
				network: "off",
				failOpen: false,
				autoEscalate: false,
			});
			expect(config.tools.approvalMode).toBe("write");
			const denied = config.tools.pathRules.map(
				(rule: { glob: string; action: string }) => `${rule.action} ${rule.glob}`,
			);
			expect(denied).toEqual(
				expect.arrayContaining([
					`deny ${path.join(P, "agent")}/**`,
					`deny ${path.join(P, "personal")}/**`,
					`deny ${path.join(C, "run")}/**`,
				]),
			);

			// The owner's model file makes the login ready; the companion then starts the session on its own.
			await h.writeModels();
			await Bun.write(
				path.join(P, "agent", "config.yml"),
				`${(await Bun.file(path.join(P, "agent", "config.yml")).text()).trimEnd()}\nmodelRoles:\n  default: stub/stub-model\n`,
			);
			const seen = new Set<string>();
			await until(
				"the session to start",
				async () => {
					const now = await h.status();
					seen.add(now.run);
					return now.run === "idle" && h.personalHost() !== undefined;
				},
				{ timeoutMs: 180_000, everyMs: 250 },
			);
			expect(seen.has("starting")).toBe(true);
			const ready = await h.status();
			expect(ready.login).toMatchObject({ state: "ready" });
			expect(ready.login.providers).toContain("stub");
			expect(ready.session).toMatchObject({ generation: 1 });
			const host = h.personalHost()!;
			expect(host).toMatchObject({ personal: true, instanceId: ready.session!.instanceId });
			expect(await sessionName()).toHaveLength(1);
			expect(await Bun.file(path.join(P, "personal", "state.json")).json()).toMatchObject({ enabled: true });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"survives the session organiser: a device that settles and ends it changes nothing",
		async () => {
			const status = await h.status();
			const now = Date.now();
			await h.client.syncSessionOrg({
				entries: { [status.session!.sessionId]: { at: now, status: "settled", reason: "user" } },
				settings: { at: now, idleDays: 1, settleOnPr: false, endOnSettle: true },
			});
			// The organiser looks at the sessions on every hosts poll (3 s): give it several.
			await realTime(15_000);
			const after = await h.status();
			expect(after.run).toBe("idle");
			expect(after.session!.sessionId).toBe(status.session!.sessionId);
			expect(h.personalHost()?.instanceId).toBe(status.session!.instanceId ?? undefined);
			expect(await sessionName()).toHaveLength(1);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"restarts a killed session within the keep-alive tick, and resumes the recorded session",
		async () => {
			// A session that never took a turn has no file to resume: give it one.
			const guest = await h.openSession();
			await h.turn(guest, "Hello, this session needs a history to come back to.");
			const before = await h.status();
			const [name] = await sessionName();
			expect((await h.tmux("kill-session", "-t", name!)).code).toBe(0);
			await until("the session to be gone", async () => (await sessionName()).length === 0, { timeoutMs: 10_000 });

			await until(
				"the keep-alive to restart it",
				async () => {
					const now = await h.status();
					return now.run === "idle" && h.personalHost() !== undefined && (await sessionName()).length === 1;
				},
				{ timeoutMs: 120_000, everyMs: 500 },
			);
			const after = await h.status();
			expect(after.session!.sessionId).toBe(before.session!.sessionId);
			expect(after.session!.generation).toBe(before.session!.generation);
			expect(h.personalHost()).toMatchObject({ personal: true });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"disables: stops the session and keeps memory, history and settings; enabling again resumes",
		async () => {
			await h.call({ t: "personal-settings-set", patch: { limits: { dayUsd: 7 } } });
			h.seedWorkingRows(3, 1, "keep");
			const rowsBefore = h.memoryRows("SELECT COUNT(*) AS n FROM working_memory")[0]!.n;
			const filesBefore = await h.sessionFiles();
			const before = await h.status();

			const disabled = (await h.call({ t: "personal-disable" })).status;
			expect(disabled.enabled).toBe(false);
			await until(
				"the session to stop",
				async () => (await sessionName()).length === 0 && h.personalHost() === undefined,
				{ timeoutMs: 90_000, everyMs: 500 },
			);
			expect((await h.status()).run).toBe("off");
			// Nothing comes back by itself: the keep-alive tick passes twice.
			await realTime(32_000);
			expect(await sessionName()).toEqual([]);

			expect(h.memoryRows("SELECT COUNT(*) AS n FROM working_memory")[0]!.n).toBe(rowsBefore);
			expect(await h.sessionFiles()).toEqual(filesBefore);
			expect((await h.call({ t: "personal-settings-get" })).settings.limits.dayUsd).toBe(7);
			expect((await h.call({ t: "personal-about-get" })).about.text).toContain("Sam, a baker.");
			expect(await exists(path.join(P, "agent", "config.yml"))).toBe(true);

			const enabled = (await h.call({ t: "personal-enable" })).status;
			expect(enabled.enabled).toBe(true);
			await h.waitIdle();
			const after = await h.status();
			expect(after.session!.sessionId).toBe(before.session!.sessionId);
			expect(h.memoryRows("SELECT COUNT(*) AS n FROM working_memory")[0]!.n).toBeGreaterThanOrEqual(
				Number(rowsBefore),
			);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"rolls over on demand: handoff note, the old session exits through control exit, the next one starts with the note",
		async () => {
			const before: PersonalStatus = await h.status();
			const oldHost = h.personalHost()!;
			h.stub.enqueue({ text: "HANDOFF-NOTE-42: we were drafting the bakery's tax summary." }, r =>
				r.lastUser.includes("handoff note for your next session"),
			);

			const hostRows: Array<{ instanceId: string; personal: boolean | undefined }> = [];
			const watcher = setInterval(() => {
				for (const host of h.client.getSnapshot().hosts) {
					if (host.instanceId !== undefined)
						hostRows.push({ instanceId: host.instanceId, personal: host.personal });
				}
			}, 250);
			try {
				await h.call({ t: "personal-control", action: "restart" });
				const first = await h.stub.waitForRequest(
					r =>
						r.transcript.includes("previous session left you this handoff note") &&
						r.transcript.includes("HANDOFF-NOTE-42"),
					{ timeoutMs: 180_000 },
				);
				expect(first.transcript).toContain("bakery's tax summary");
				await until(
					"the new session to be idle",
					async () => {
						const now = await h.status();
						return now.run === "idle" && now.session?.generation === before.session!.generation + 1;
					},
					{ timeoutMs: 180_000, everyMs: 500 },
				).catch(async err => {
					throw new Error(
						`${String(err)}; before ${JSON.stringify(before.session)}, now ${JSON.stringify(await h.status())}`,
					);
				});
			} finally {
				clearInterval(watcher);
			}
			const after = await h.status();
			expect(after.session!.sessionId).not.toBe(before.session!.sessionId);
			expect(after.session!.instanceId).not.toBe(oldHost.instanceId);
			expect(h.personalHost()).toMatchObject({ personal: true, instanceId: after.session!.instanceId });
			// Every row the thread showed for a Personal instance carried the mark.
			expect(hostRows.length).toBeGreaterThan(0);
			expect(hostRows.every(row => row.personal === true)).toBe(true);
			expect(await sessionName()).toHaveLength(1);
			expect(await h.sessionFiles()).toHaveLength(2);
			const log = await h.companionLog();
			expect(log).not.toMatch(/\bkill-session\b/);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
