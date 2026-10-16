import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ABOUT_BYTES, PERSONAL_LOGIN_COMMAND } from "@oh-my-pi/pi-wire/personal";
import { createPersonalProfile, managedConfig, renderConfig } from "../scripts/companion-personal-profile";
import {
	createAboutStore,
	defaultSettings,
	openJsonlStore,
	openPersonalState,
	parseJsonl,
	personalPaths,
} from "../scripts/companion-personal-store";
import { ABOUT_TEMPLATE, APPEND_SYSTEM, APPEND_SYSTEM_MARKER } from "../scripts/companion-personal-templates";

let root: string;
let clock: number;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-profile-"));
	clock = Date.UTC(2026, 9, 10, 12);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const mode = async (file: string): Promise<number> => (await fs.stat(file)).mode & 0o777;

function build(local: string | undefined = undefined) {
	const paths = personalPaths(root);
	const about = createAboutStore(paths, () => clock);
	const settings = defaultSettings();
	const profile = createPersonalProfile({
		paths,
		now: () => clock,
		about,
		relayUrl: "wss://relay.example/ws",
		webUrl: "https://app.example",
		localRelayUrl: () => local,
		limits: () => settings.limits,
		memoryMode: () => settings.memoryMode ?? "recall",
	});
	return { paths, about, settings, profile };
}

describe("the Personal profile on disk", () => {
	it("reads nothing and writes nothing before setup", async () => {
		const { paths, profile } = build();
		expect(await profile.exists()).toBe(false);
		expect(await profile.ownerKey()).toBeNull();
		expect(await profile.mcpServers()).toEqual([]);
		expect((await profile.login()).state).toBe("missing");
		await expect(fs.stat(paths.profile)).rejects.toThrow();
		await expect(fs.stat(path.join(root, "run", "personal"))).rejects.toThrow();
	});

	it("setup creates the layout with private modes, and running it again changes nothing", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		expect(await profile.exists()).toBe(true);
		for (const dir of [paths.agentDir, paths.personalDir, paths.workspace]) expect(await mode(dir)).toBe(0o700);
		for (const file of [paths.configYml, paths.appendSystemFile, paths.aboutFile, paths.ownerKeyFile])
			expect(await mode(file)).toBe(0o600);
		expect(await Bun.file(paths.aboutFile).text()).toBe(ABOUT_TEMPLATE);
		expect(await Bun.file(paths.appendSystemFile).text()).toBe(APPEND_SYSTEM);
		const key = await profile.ownerKey();
		expect(key).not.toBeNull();
		expect(key!.length).toBeGreaterThanOrEqual(32);

		const before = await Bun.file(paths.configYml).text();
		await profile.setup(settings);
		expect(await Bun.file(paths.configYml).text()).toBe(before);
		expect(await profile.ownerKey()).toBe(key);
	});

	it("keeps the About-you text the owner already wrote and refuses to overwrite it", async () => {
		const { paths, profile, settings } = build();
		await fs.mkdir(path.dirname(paths.aboutFile), { recursive: true });
		await Bun.write(paths.aboutFile, "I prefer short answers.\n");
		await expect(profile.setup(settings, "Something else")).rejects.toThrow();
		expect(await Bun.file(paths.aboutFile).text()).toBe("I prefer short answers.\n");
		await profile.setup(settings);
		expect(await Bun.file(paths.aboutFile).text()).toBe("I prefer short answers.\n");
	});

	it("writes a config.yml that parses and holds every managed key", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		const parsed = Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>;
		expect(parsed.personal).toMatchObject({
			enabled: true,
			runKind: "live",
			memoryMode: "recall",
			notifyOwner: { maxPerHour: 6, maxOpenQuestions: 5 },
			events: { maxPerSourcePerHour: 4, maxPerHour: 12 },
			externalTurns: { policy: "always-ask" },
			allowShareLinks: false,
		});
		expect(parsed.memory).toEqual({ backend: "mnemopi" });
		expect(parsed.mnemopi).toMatchObject({
			scoping: "global",
			retention: "permanent",
			autoRecall: true,
			autoRetain: true,
		});
		expect(parsed.tools).toMatchObject({ approvalMode: "write", outsideProject: "prompt" });
		expect(parsed.sandbox).toMatchObject({ mode: "workspace-write", network: "off", failOpen: false });
		expect(parsed.session.spendLimits).toEqual({
			dayUsd: settings.limits.dayUsd,
			monthUsd: settings.limits.monthUsd,
		});
		const globs = (parsed.tools.pathRules as { glob: string; action: string }[]).map(rule => rule.glob);
		expect(globs).toContain(`${paths.agentDir}/**`);
		expect(globs).toContain(`${paths.personalDir}/**`);
		expect(globs).toContain(`${path.join(root, "run")}/**`);
		expect(globs).toContain(`${paths.backupsDir}/**`);
	});

	it("repair restores only the managed keys and APPEND_SYSTEM.md, never About you", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		const edited = Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>;
		edited.sandbox.network = "on";
		edited.theme = { dark: "mine" };
		edited.tools.pathRules.push({ glob: "/keep/**", tools: ["read"], action: "deny" });
		await Bun.write(paths.configYml, Bun.YAML.stringify(edited, null, 2));
		await Bun.write(paths.appendSystemFile, "tampered");
		await Bun.write(paths.aboutFile, "my own words\n");

		const { restored } = await profile.repair(settings);
		expect(restored.length).toBeGreaterThan(0);
		const after = Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>;
		expect(after.sandbox.network).toBe("off");
		expect(after.theme).toEqual({ dark: "mine" });
		expect(after.tools.pathRules.map((rule: { glob: string }) => rule.glob)).toContain("/keep/**");
		expect(await Bun.file(paths.appendSystemFile).text()).toContain(APPEND_SYSTEM_MARKER);
		expect(await Bun.file(paths.aboutFile).text()).toBe("my own words\n");
	});

	it("a moved backup folder replaces the old deny rule instead of leaving it behind", () => {
		const paths = personalPaths(root);
		const settings = defaultSettings();
		const first = renderConfig({}, paths, { ...settings, backup: { ...settings.backup, folder: "/mnt/one" } });
		const second = renderConfig(Bun.YAML.parse(first) as Record<string, unknown>, paths, {
			...settings,
			backup: { ...settings.backup, folder: "/mnt/two" },
		});
		expect(second).toContain("/mnt/two/**");
		expect(second).not.toContain("/mnt/one/**");
		expect(managedConfig(paths, settings).session).toBeDefined();
	});

	it("applySettings follows the limits and does nothing before setup", async () => {
		const { paths, profile, settings } = build();
		await profile.applySettings(settings);
		await expect(fs.stat(paths.configYml)).rejects.toThrow();
		await profile.setup(settings);
		await profile.applySettings({ ...settings, limits: { dayUsd: 7, monthUsd: 70 } });
		const parsed = Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>;
		expect(parsed.session.spendLimits).toEqual({ dayUsd: 7, monthUsd: 70 });
	});
});

describe("login detection", () => {
	it("is ready with an enabled credential and missing once every one is disabled", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		const db = new Database(paths.agentDb, { create: true });
		db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, disabled_cause TEXT)");
		expect((await profile.login()).state).toBe("missing");
		db.run(
			"INSERT INTO auth_credentials (provider, disabled_cause) VALUES ('anthropic', NULL), ('openai', 'expired')",
		);
		const ready = await profile.login();
		expect(ready).toMatchObject({ state: "ready", providers: ["anthropic"], command: PERSONAL_LOGIN_COMMAND });
		db.run("UPDATE auth_credentials SET disabled_cause = 'revoked'");
		expect((await profile.login()).state).toBe("missing");
		db.close();
	});

	it("counts a models.yml provider with a key or no auth", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		await Bun.write(paths.modelsYml, "providers:\n  ollama:\n    auth: none\n  empty:\n    apiKey: ''\n");
		expect(await profile.login()).toMatchObject({ state: "ready", providers: ["ollama"] });
	});

	it("is missing for a database that has no credentials table", async () => {
		const { paths, profile, settings } = build();
		await profile.setup(settings);
		new Database(paths.agentDb, { create: true }).close();
		expect((await profile.login()).state).toBe("missing");
	});
});

describe("launch overlays", () => {
	it("a live overlay hosts collab with the companion's addresses, a review overlay does not", async () => {
		const { profile, settings } = build("ws://127.0.0.1:4000");
		await profile.setup(settings);
		const live = Bun.YAML.parse(profile.overlayText("live")) as Record<string, any>;
		expect(live.collab).toMatchObject({
			autoStart: "control",
			relayUrl: "wss://relay.example/ws",
			webUrl: "https://app.example",
			localRelayUrl: "ws://127.0.0.1:4000",
		});
		expect(live.personal.runKind).toBe("live");
		expect(live.session.spendLimits).toEqual({ dayUsd: settings.limits.dayUsd, monthUsd: settings.limits.monthUsd });
		const review = Bun.YAML.parse(profile.overlayText("review")) as Record<string, any>;
		expect(review.collab).toBeUndefined();
		expect(review.personal.runKind).toBe("review");

		const file = path.join(root, "overlay.yml");
		expect(await profile.writeOverlay("review", file)).toBe(file);
		expect(await mode(file)).toBe(0o600);
	});

	it("carries the memory mode into config.yml and the live overlay only", async () => {
		const { paths, profile, settings } = build();
		settings.memoryMode = "chat-tree";
		await profile.setup(settings);
		const parsed = Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>;
		expect(parsed.personal.memoryMode).toBe("chat-tree");
		expect((Bun.YAML.parse(profile.overlayText("live")) as Record<string, any>).personal.memoryMode).toBe(
			"chat-tree",
		);
		expect(
			(Bun.YAML.parse(profile.overlayText("review")) as Record<string, any>).personal.memoryMode,
		).toBeUndefined();

		// Switching back rewrites the managed key: the file follows the setting.
		settings.memoryMode = "recall";
		await profile.applySettings(settings);
		expect((Bun.YAML.parse(await Bun.file(paths.configYml).text()) as Record<string, any>).personal.memoryMode).toBe(
			"recall",
		);
	});
});

describe("the stores", () => {
	it("keeps the latest line of an id and survives a torn last line", async () => {
		const file = path.join(root, "rows.jsonl");
		const store = openJsonlStore<{ id: string; n: number }>(file);
		expect(await store.list()).toEqual([]);
		await store.put({ id: "a", n: 1 });
		await store.put({ id: "b", n: 2 });
		await store.put({ id: "a", n: 3 });
		expect(await store.list()).toEqual([
			{ id: "a", n: 3 },
			{ id: "b", n: 2 },
		]);
		expect(await store.get("a")).toEqual({ id: "a", n: 3 });
		expect(await store.get("missing")).toBeUndefined();
		await fs.appendFile(file, '{"id":"c","n":');
		expect((await store.list()).map(row => row.id)).toEqual(["a", "b"]);
		expect(parseJsonl('{"id":"x"}\n{"id":')).toEqual([{ id: "x" }]);
		expect(await mode(file)).toBe(0o600);
	});

	it("serialises concurrent puts", async () => {
		const store = openJsonlStore<{ id: string }>(path.join(root, "many.jsonl"));
		await Promise.all(Array.from({ length: 40 }, (_, i) => store.put({ id: `r${i}` })));
		expect(await store.list()).toHaveLength(40);
	});

	it("persists the state atomically and falls back to defaults on damage", async () => {
		const file = path.join(root, "state.json");
		const state = await openPersonalState(file);
		expect(state.read().setUp).toBe(false);
		await state.update(s => ({ ...s, setUp: true, rev: s.rev + 1 }));
		expect((await openPersonalState(file)).read()).toMatchObject({ setUp: true, rev: 1 });
		await Bun.write(file, "{ nope");
		expect((await openPersonalState(file)).read().setUp).toBe(false);
	});
});

describe("About you", () => {
	it("records revisions, keeps the old text, and refuses an oversized one", async () => {
		const { paths, about } = build();
		await fs.mkdir(path.dirname(paths.aboutFile), { recursive: true });
		await Bun.write(paths.aboutFile, "first\n");
		const seeded = await about.seed();
		expect(seeded.rev).toBe(1);
		expect((await about.seed()).rev).toBe(1);

		clock += 1000;
		const second = await about.write("second\n", "owner");
		expect(second.rev).toBe(2);
		clock += 1000;
		const third = await about.write("third\n", "proposal", "prop-1");
		expect(third.rev).toBe(3);
		expect((await about.read()).text).toBe("third\n");
		const history = await about.history();
		expect(history.map(v => v.rev)).toEqual([3, 2, 1]);
		expect(history[0]).toMatchObject({ by: "proposal", proposalId: "prop-1" });
		await expect(about.write("x".repeat(MAX_ABOUT_BYTES + 1), "owner")).rejects.toThrow();
		expect((await about.read()).rev).toBe(3);
	});

	it("records a hand edit of AGENTS.md as an owner revision", async () => {
		const { paths, about } = build();
		await fs.mkdir(path.dirname(paths.aboutFile), { recursive: true });
		await Bun.write(paths.aboutFile, "first\n");
		await about.seed();
		await Bun.write(paths.aboutFile, "edited by hand\n");
		const read = await about.read();
		expect(read).toMatchObject({ text: "edited by hand\n", rev: 2 });
		expect((await about.history())[0]?.by).toBe("owner");
	});
});
