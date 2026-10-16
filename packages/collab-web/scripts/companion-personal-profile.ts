/**
 * The Personal agent's profile on this computer (`omp --profile personal`): creating its layout, writing and
 * repairing the files the companion manages, reading whether the profile holds a login, the owner key that signs
 * events, and the config overlay of every launch. See docs/personal-agent.md "Profile layout".
 *
 * Nothing here is called until the owner sets Personal up, except the read-only {@link PersonalProfile.exists}.
 * `agent.db` and `models.yml` are only ever read.
 */

import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalLogin, PersonalMemoryMode, PersonalSettings } from "@oh-my-pi/pi-wire/personal";
import { PERSONAL_DEFAULTS, PERSONAL_LOGIN_COMMAND } from "@oh-my-pi/pi-wire/personal";
import { ABOUT_TEMPLATE, APPEND_SYSTEM } from "./companion-personal-templates";
import type { PersonalAboutStore, PersonalPaths } from "./companion-personal-store";
import { writeFileAtomic } from "./companion-personal-store";

const CONFIG_HEADER =
	"# Written by omp collab companion setup for the Personal agent.\n# Keys it manages are restored by Repair; other keys are yours.\n";
/** `edit`, `write` and `ast_edit`: what the managed path rules deny. */
const DENIED_TOOLS = ["edit", "write", "ast_edit"];

type YamlObject = Record<string, unknown>;

const isObject = (value: unknown): value is YamlObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The backup folder the settings name, or the default one inside the profile. */
export function backupFolder(paths: PersonalPaths, settings: PersonalSettings): string {
	return settings.backup.folder ?? paths.backupsDir;
}

/** The keys of `config.yml` the companion manages (docs/personal-agent.md "Settings"): `<P>`, `<C>` and the backup folder expanded. */
export function managedConfig(paths: PersonalPaths, settings: PersonalSettings): YamlObject {
	return {
		personal: {
			enabled: true,
			runKind: "live",
			memoryMode: settings.memoryMode ?? PERSONAL_DEFAULTS.memoryMode,
			notifyOwner: { maxPerHour: 6, maxOpenQuestions: 5 },
			events: { maxPerSourcePerHour: 4, maxPerHour: 12, pollSeconds: 5 },
			externalTurns: { policy: "always-ask" },
			allowShareLinks: false,
		},
		memory: { backend: "mnemopi" },
		mnemopi: {
			scoping: "global",
			retention: "permanent",
			provenance: true,
			autoRecall: true,
			autoRetain: true,
			recallEveryTurn: true,
			recallEveryTurnTokenLimit: 1500,
			pinnedTokenLimit: 800,
			retainEveryNTurns: 1,
			consolidateIntervalMinutes: 60,
			embeddingVariant: "en",
		},
		session: { spendLimits: { dayUsd: settings.limits.dayUsd, monthUsd: settings.limits.monthUsd } },
		tools: {
			approvalMode: "write",
			outsideProject: "prompt",
			pathRules: [
				{ glob: `${paths.agentDir}/**`, tools: [...DENIED_TOOLS], action: "deny" },
				{ glob: `${paths.personalDir}/**`, tools: [...DENIED_TOOLS], action: "deny" },
				{ glob: `${path.join(paths.configRoot, "run")}/**`, tools: [...DENIED_TOOLS], action: "deny" },
				{ glob: `${backupFolder(paths, settings)}/**`, tools: [...DENIED_TOOLS], action: "deny" },
			],
		},
		sandbox: { mode: "workspace-write", network: "off", failOpen: false, autoEscalate: false },
		secrets: { enabled: true },
		ask: { timeout: 0 },
		schedule: { enabled: true },
		// A fresh profile would otherwise open the first-run setup wizard in the session's tmux window and wait there for a person.
		startup: { setupWizard: false },
	};
}

/** `base` with `managed` laid over it: objects merge key by key, every other managed value replaces. */
function overlay(base: YamlObject, managed: YamlObject): YamlObject {
	const merged: YamlObject = { ...base };
	for (const [key, value] of Object.entries(managed)) {
		const existing = merged[key];
		merged[key] = isObject(value) && isObject(existing) ? overlay(existing, value) : value;
	}
	return merged;
}

function isDenyRule(rule: unknown): boolean {
	return (
		isObject(rule) &&
		rule.action === "deny" &&
		Array.isArray(rule.tools) &&
		rule.tools.length === DENIED_TOOLS.length &&
		DENIED_TOOLS.every(tool => (rule.tools as unknown[]).includes(tool))
	);
}

/** The text of `config.yml` for `existing` (the file's parsed content, `{}` for a new one) with the managed keys restored. */
export function renderConfig(existing: YamlObject, paths: PersonalPaths, settings: PersonalSettings): string {
	const managed = managedConfig(paths, settings);
	const merged = overlay(existing, managed);
	const tools = merged.tools as YamlObject;
	const own = isObject(existing.tools) && Array.isArray(existing.tools.pathRules) ? existing.tools.pathRules : [];
	// Deny rules of the managed shape are the companion's (a backup folder that moved must not leave the old rule behind); the owner's other rules stay.
	tools.pathRules = [
		...((managed.tools as YamlObject).pathRules as unknown[]),
		...own.filter(rule => !isDenyRule(rule)),
	];
	return `${CONFIG_HEADER}${Bun.YAML.stringify(merged, null, 2)}`;
}

async function readYaml(file: string): Promise<YamlObject> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch {
		return {};
	}
	const parsed: unknown = text.trim() === "" ? {} : Bun.YAML.parse(text);
	return isObject(parsed) ? parsed : {};
}

export interface PersonalProfileOptions {
	paths: PersonalPaths;
	now(): number;
	about: PersonalAboutStore;
	/** The companion's relay and web app addresses: a profile does not inherit the default config, so every launch's overlay carries them. */
	relayUrl: string;
	webUrl: string;
	/** The local relay of this companion (`ws://127.0.0.1:<port>`) once it runs. */
	localRelayUrl(): string | undefined;
	/** The settings the next launch gets (mirror the stored ones): the spend limits and the memory mode. */
	limits(): PersonalSettings["limits"];
	memoryMode(): PersonalMemoryMode;
}

export interface PersonalProfile {
	readonly paths: PersonalPaths;
	/** The layout can be served: setup wrote `config.yml`. Reads only. */
	exists(): Promise<boolean>;
	/** Create the layout (idempotent); throws when `about` would overwrite an About-you file the owner already wrote. */
	setup(settings: PersonalSettings, about?: string): Promise<void>;
	/** Restore only the managed keys of `config.yml` and `APPEND_SYSTEM.md`; never `AGENTS.md`. */
	repair(settings: PersonalSettings): Promise<{ restored: string[] }>;
	/** Rewrite the managed keys that follow the settings (limits, backup folder) when `config.yml` exists. */
	applySettings(settings: PersonalSettings): Promise<void>;
	login(): Promise<PersonalLogin>;
	/** Server names of the profile's `mcp.json`, read only. */
	mcpServers(): Promise<string[]>;
	/** The owner key (created at setup, never rotated); null before setup. */
	ownerKey(): Promise<string | null>;
	/**
	 * Write the config overlay of one launch and return its path. `live`: the session the companion keeps alive, hosting
	 * collab. `review`: a headless run (nightly review, a source poll): no collab hosting.
	 */
	writeOverlay(kind: "live" | "review", file: string, extraYaml?: string): Promise<string>;
	/** The text {@link writeOverlay} writes: for a launch that writes the overlay itself (`TmuxLaunch.profile`). */
	overlayText(kind: "live" | "review", extraYaml?: string): string;
}

export function createPersonalProfile(options: PersonalProfileOptions): PersonalProfile {
	const { paths } = options;

	const ensureDir = async (dir: string): Promise<void> => {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
	};

	const writeConfig = async (settings: PersonalSettings): Promise<void> => {
		await writeFileAtomic(paths.configYml, renderConfig(await readYaml(paths.configYml), paths, settings));
	};

	const writeAppend = async (): Promise<void> => {
		await writeFileAtomic(paths.appendSystemFile, APPEND_SYSTEM);
	};

	const ownerKey = async (): Promise<string | null> => {
		try {
			const key = (await Bun.file(paths.ownerKeyFile).text()).trim();
			return key === "" ? null : key;
		} catch {
			return null;
		}
	};

	const overlayText = (kind: "live" | "review", extraYaml?: string): string => {
		const limits = options.limits();
		const local = options.localRelayUrl();
		const collab =
			kind === "live"
				? `collab:\n  autoStart: control\n  relayUrl: ${JSON.stringify(options.relayUrl)}\n  webUrl: ${JSON.stringify(options.webUrl)}\n${local ? `  localRelayUrl: ${JSON.stringify(local)}\n` : ""}`
				: "";
		// A review or source-poll run is never the live chat: only the live session gets the memory mode.
		const mode = kind === "live" ? `  memoryMode: ${options.memoryMode()}\n` : "";
		return `${collab}personal:\n  runKind: ${kind}\n${mode}session:\n  spendLimits:\n    dayUsd: ${limits.dayUsd}\n    monthUsd: ${limits.monthUsd}\n${extraYaml ?? ""}`;
	};

	return {
		paths,
		async exists() {
			return await Bun.file(paths.configYml).exists();
		},
		async setup(settings, about) {
			for (const dir of [
				paths.profile,
				paths.agentDir,
				paths.personalDir,
				paths.aboutHistoryDir,
				paths.workspace,
				path.dirname(paths.runDir),
				paths.runDir,
				paths.inboxDir,
				paths.claimedDir,
				backupFolder(paths, settings),
			])
				await ensureDir(dir);
			const current = await Bun.file(paths.aboutFile)
				.text()
				.catch(() => null);
			const pristine = current === null || current.trim() === "" || current === ABOUT_TEMPLATE;
			if (about !== undefined && !pristine && current !== about)
				throw new Error("About you already has your text; edit it in Settings → Personal agent → About you");
			if (pristine || (about !== undefined && current !== about))
				await writeFileAtomic(paths.aboutFile, about ?? ABOUT_TEMPLATE);
			await writeConfig(settings);
			await writeAppend();
			if ((await ownerKey()) === null)
				await writeFileAtomic(paths.ownerKeyFile, `${crypto.randomBytes(32).toString("base64url")}\n`);
			await options.about.seed();
		},
		async repair(settings) {
			const restored: string[] = [];
			const before = await Bun.file(paths.configYml)
				.text()
				.catch(() => null);
			if (before !== renderConfig(await readYaml(paths.configYml), paths, settings)) {
				await writeConfig(settings);
				restored.push("config.yml");
			}
			if (
				(await Bun.file(paths.appendSystemFile)
					.text()
					.catch(() => null)) !== APPEND_SYSTEM
			) {
				await writeAppend();
				restored.push("APPEND_SYSTEM.md");
			}
			return { restored };
		},
		async applySettings(settings) {
			if (await Bun.file(paths.configYml).exists()) await writeConfig(settings);
		},
		async login() {
			const providers = new Set<string>();
			try {
				if (await Bun.file(paths.agentDb).exists()) {
					const db = new Database(paths.agentDb, { readonly: true });
					try {
						for (const row of db
							.query("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL")
							.all() as { provider: string }[])
							providers.add(row.provider);
					} finally {
						db.close();
					}
				}
			} catch {
				// no table yet, or the database is being written: not a login
			}
			const models = (await readYaml(paths.modelsYml)).providers;
			if (isObject(models))
				for (const [name, provider] of Object.entries(models))
					if (
						isObject(provider) &&
						((typeof provider.apiKey === "string" && provider.apiKey !== "") || provider.auth === "none")
					)
						providers.add(name);
			return {
				state: providers.size > 0 ? "ready" : "missing",
				providers: [...providers].sort(),
				command: PERSONAL_LOGIN_COMMAND,
				checkedAt: options.now(),
			};
		},
		async mcpServers() {
			try {
				const parsed: unknown = JSON.parse(await Bun.file(paths.mcpJson).text());
				return isObject(parsed) && isObject(parsed.mcpServers) ? Object.keys(parsed.mcpServers).sort() : [];
			} catch {
				return [];
			}
		},
		ownerKey,
		overlayText,
		async writeOverlay(kind, file, extraYaml) {
			await writeFileAtomic(file, overlayText(kind, extraYaml));
			return file;
		},
	};
}
