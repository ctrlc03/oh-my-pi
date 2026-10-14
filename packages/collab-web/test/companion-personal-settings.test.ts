import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	PersonalChangeKind,
	PersonalSettings,
	PersonalSettingsPatch,
	PersonalSource,
} from "@oh-my-pi/pi-wire/personal";
import { createPersonalSettings, mergeSettings, readMcpServers } from "../scripts/companion-personal-settings";
import { openPersonalState, personalPaths } from "../scripts/companion-personal-store";

const source = (over: Partial<PersonalSource> = {}): PersonalSource => ({
	id: "mail",
	label: "Mail",
	kind: "mcp-poll",
	mcpServer: "gmail",
	everyMinutes: 15,
	prompt: "Unread mail from my landlord",
	enabled: true,
	...over,
});

describe("companion-personal-settings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-settings-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function harness(opts: { mcp?: unknown; applyFails?: boolean } = {}) {
		const configRoot = path.join(dir, ".omp");
		const paths = personalPaths(configRoot);
		await fs.mkdir(paths.agentDir, { recursive: true });
		if (opts.mcp !== undefined)
			await fs.writeFile(paths.mcpJson, typeof opts.mcp === "string" ? opts.mcp : JSON.stringify(opts.mcp));
		const state = await openPersonalState(paths.stateFile);
		const applied: PersonalSettings[] = [];
		const changes: PersonalChangeKind[][] = [];
		const service = createPersonalSettings({
			paths,
			state,
			profile: {
				applySettings: async settings => {
					if (opts.applyFails) throw new Error("config.yml is read-only");
					applied.push(settings);
				},
			},
			changed: what => void changes.push(what),
		});
		const set = (patch: PersonalSettingsPatch) => service.handle({ t: "personal-settings-set", reqId: 7, patch });
		return { paths, configRoot, state, applied, changes, service, set };
	}

	const gmail = { mcp: { mcpServers: { gmail: { command: "x" }, calendar: { url: "http://x" } } } };

	it("answers get with the defaults and the server names of mcp.json, sorted", async () => {
		const h = await harness(gmail);
		const reply = await h.service.handle({ t: "personal-settings-get", reqId: 1 });
		expect(reply).toMatchObject({
			t: "personal-settings-get",
			reqId: 1,
			mcpServers: ["calendar", "gmail"],
			settings: {
				limits: { dayUsd: 5, monthUsd: 50 },
				review: { enabled: true, time: "03:30", budgetUsd: 0.5 },
				rollover: { time: "04:00" },
				backup: { folder: null },
				sources: [],
			},
		});
		await expect(fs.stat(h.paths.stateFile)).rejects.toThrow();
	});

	it("reads no servers from a missing, damaged or oddly shaped mcp.json", async () => {
		expect(await readMcpServers(path.join(dir, "none.json"))).toEqual([]);
		await fs.writeFile(path.join(dir, "bad.json"), "{nope");
		expect(await readMcpServers(path.join(dir, "bad.json"))).toEqual([]);
		await fs.writeFile(path.join(dir, "arr.json"), JSON.stringify({ mcpServers: [1] }));
		expect(await readMcpServers(path.join(dir, "arr.json"))).toEqual([]);
		expect(await (await harness()).service.mcpServers()).toEqual([]);
	});

	it("merges sections, mirrors them to config.yml first, persists, and announces the change", async () => {
		const h = await harness(gmail);
		const reply = await h.set({
			limits: { dayUsd: 2 },
			review: { enabled: false, time: "02:15" },
			rollover: { time: "05:00" },
		});
		expect(reply).toMatchObject({
			t: "personal-settings-set",
			reqId: 7,
			settings: {
				limits: { dayUsd: 2, monthUsd: 50 },
				review: { enabled: false, time: "02:15", budgetUsd: 0.5 },
				rollover: { time: "05:00" },
			},
		});
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]?.limits).toEqual({ dayUsd: 2, monthUsd: 50 });
		expect(h.changes).toEqual([["settings", "status"]]);
		const reopened = await openPersonalState(h.paths.stateFile);
		expect(reopened.read().settings.limits.dayUsd).toBe(2);
		expect(h.service.get().rollover.time).toBe("05:00");
	});

	it("refuses bad limits, times and budgets, changing nothing", async () => {
		const h = await harness(gmail);
		const bad: PersonalSettingsPatch[] = [
			{ limits: { dayUsd: -1 } },
			{ limits: { monthUsd: Number.NaN } },
			{ limits: { dayUsd: "5" as never } },
			{ limits: { dayUsd: 1e9 } },
			{ review: { time: "25:00" } },
			{ review: { time: "3:30" } },
			{ review: { budgetUsd: -0.1 } },
			{ review: { enabled: "yes" as never } },
			{ rollover: { time: "noon" } },
			{ limits: 5 as never },
		];
		for (const patch of bad) await expect(h.set(patch)).rejects.toThrow();
		expect(h.applied).toEqual([]);
		expect(h.changes).toEqual([]);
		expect(h.service.get().limits).toEqual({ dayUsd: 5, monthUsd: 50 });
		// Zero means no limit and is allowed.
		expect(await h.set({ limits: { dayUsd: 0, monthUsd: 0 }, review: { budgetUsd: 0 } })).toMatchObject({
			settings: { limits: { dayUsd: 0, monthUsd: 0 }, review: { budgetUsd: 0 } },
		});
	});

	describe("backup folder", () => {
		it("must be absolute, outside the config folder, and creatable", async () => {
			const h = await harness(gmail);
			await expect(h.set({ backup: { folder: "backups" } })).rejects.toThrow("absolute");
			await expect(h.set({ backup: { folder: path.join(h.configRoot, "profiles", "x") } })).rejects.toThrow(
				"config folder",
			);
			await expect(h.set({ backup: { folder: h.configRoot } })).rejects.toThrow("config folder");
			await expect(h.set({ backup: { folder: 5 as never } })).rejects.toThrow();
			const file = path.join(dir, "a-file");
			await fs.writeFile(file, "x");
			await expect(h.set({ backup: { folder: path.join(file, "inside") } })).rejects.toThrow("cannot be created");
			expect(h.applied).toEqual([]);
		});

		it("creates a missing folder, normalises it, and null or empty goes back to the default", async () => {
			const h = await harness(gmail);
			const target = path.join(dir, "disk2", "x", "..", "backups");
			const reply = await h.set({ backup: { folder: target } });
			expect(reply).toMatchObject({ settings: { backup: { folder: path.join(dir, "disk2", "backups") } } });
			expect((await fs.stat(path.join(dir, "disk2", "backups"))).isDirectory()).toBe(true);
			expect(await h.set({ backup: { folder: null } })).toMatchObject({ settings: { backup: { folder: null } } });
			await h.set({ backup: { folder: target } });
			expect(await h.set({ backup: { folder: "  " } })).toMatchObject({ settings: { backup: { folder: null } } });
		});
	});

	describe("sources", () => {
		it("adds, replaces the whole list, and removes", async () => {
			const h = await harness(gmail);
			const added = await h.set({
				sources: [source(), source({ id: "cal", label: "Calendar", mcpServer: "calendar", enabled: false })],
			});
			expect(added).toMatchObject({ settings: { sources: [{ id: "mail" }, { id: "cal", enabled: false }] } });
			expect(await h.set({ sources: [source({ id: "cal", mcpServer: "calendar" })] })).toMatchObject({
				settings: { sources: [{ id: "cal" }] },
			});
			expect(await h.set({ sources: [] })).toMatchObject({ settings: { sources: [] } });
		});

		it("refuses an unknown server, a too-frequent poll and other bad sources", async () => {
			const h = await harness(gmail);
			const bad: Partial<PersonalSource>[] = [
				{ mcpServer: "slack" },
				{ everyMinutes: 4 },
				{ everyMinutes: 5.5 },
				{ everyMinutes: 10_081 },
				{ id: "has space" },
				{ id: "" },
				{ id: "x".repeat(33) },
				{ label: " " },
				{ prompt: "" },
				{ prompt: "p".repeat(2_001) },
				{ kind: "imap" as never },
				{ enabled: "true" as never },
			];
			for (const over of bad) await expect(h.set({ sources: [source(over)] })).rejects.toThrow();
			await expect(h.set({ sources: [source(), source()] })).rejects.toThrow("same id");
			await expect(h.set({ sources: "none" as never })).rejects.toThrow("list");
			await expect(
				h.set({ sources: Array.from({ length: 21 }, (_, i) => source({ id: `s${i}` })) }),
			).rejects.toThrow("at most");
			expect(h.service.get().sources).toEqual([]);
			expect(h.applied).toEqual([]);
		});

		it("accepts the minimum interval and an empty mcp.json only for no sources", async () => {
			const h = await harness();
			await expect(h.set({ sources: [source({ everyMinutes: 5 })] })).rejects.toThrow("mcp.json");
			const withServer = await harness(gmail);
			expect(await withServer.set({ sources: [source({ everyMinutes: 5 })] })).toMatchObject({
				settings: { sources: [{ everyMinutes: 5 }] },
			});
		});

		it("keeps the poll bookkeeping the companion wrote and ignores what the app sends for it", async () => {
			const h = await harness(gmail);
			await h.set({ sources: [source()] });
			await h.state.update(s => ({
				...s,
				settings: {
					...s.settings,
					sources: s.settings.sources.map(x => ({ ...x, lastPollAt: 111, lastError: "timed out" })),
				},
			}));
			const reply = await h.set({
				sources: [
					source({ label: "Mail 2", lastPollAt: 999, lastError: "forged" }),
					source({ id: "new", lastPollAt: 5 }),
				],
			});
			expect(reply).toMatchObject({ settings: { sources: [{ id: "mail", label: "Mail 2" }, { id: "new" }] } });
			const [kept, fresh] = h.service.get().sources;
			expect(kept).toMatchObject({ lastPollAt: 111, lastError: "timed out" });
			expect(fresh).not.toHaveProperty("lastPollAt");
			expect(fresh).not.toHaveProperty("lastError");
		});
	});

	it("changes nothing when config.yml cannot be written", async () => {
		const h = await harness({ ...gmail, applyFails: true });
		await expect(h.set({ limits: { dayUsd: 1 } })).rejects.toThrow("read-only");
		expect(h.service.get().limits.dayUsd).toBe(5);
		expect(h.changes).toEqual([]);
	});

	it("answers nothing for a request that is not its own", async () => {
		const h = await harness();
		expect(await h.service.handle({ t: "personal-status", reqId: 1 })).toBeUndefined();
	});

	it("mergeSettings leaves the current settings untouched", () => {
		const current = (): PersonalSettings => ({
			limits: { dayUsd: 5, monthUsd: 50 },
			review: { enabled: true, time: "03:30", budgetUsd: 0.5 },
			rollover: { time: "04:00" },
			backup: { folder: null },
			sources: [],
		});
		const before = current();
		const next = mergeSettings(before, { limits: { dayUsd: 9 }, review: { enabled: false } }, [], "/c");
		expect(before).toEqual(current());
		expect(next.limits.dayUsd).toBe(9);
		expect(next.review.enabled).toBe(false);
	});
});
