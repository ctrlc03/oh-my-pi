/**
 * The Personal agent's settings frames (`personal-settings-get` / `-set`): what the owner may change from the
 * app (spend limits, review and rollover times, the backup folder, the list of sources), validated here, kept
 * in `state.json`, and mirrored into the profile's `config.yml` so the next session launch enforces the same
 * limits. A running session keeps the limits it started with until its next rollover.
 *
 * Errors are thrown as `Error`; the companion answers them as `{ t: "error", reqId, message }`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	PersonalChangeKind,
	PersonalReply,
	PersonalRequest,
	PersonalSettings,
	PersonalSettingsPatch,
	PersonalSource,
} from "@oh-my-pi/pi-wire/personal";
import { MAX_EVENT_SOURCE_CHARS } from "@oh-my-pi/pi-wire/personal-ipc";
import type { PersonalPaths, PersonalStateStore } from "./companion-personal-store";

/** A source is polled at most this often: each poll is a model run that costs money. */
export const MIN_SOURCE_EVERY_MINUTES = 5;
const MAX_SOURCE_EVERY_MINUTES = 7 * 24 * 60;
const MAX_SOURCES = 20;
const MAX_SOURCE_LABEL_CHARS = 80;
const MAX_SOURCE_PROMPT_CHARS = 2_000;
/** Far above any real budget: a typo like 1e9 is refused rather than silently never limiting. */
const MAX_LIMIT_USD = 1_000_000;
const MAX_REVIEW_BUDGET_USD = 1_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface SettingsDeps {
	paths: Pick<PersonalPaths, "configRoot" | "mcpJson">;
	state: Pick<PersonalStateStore, "read" | "update">;
	profile: {
		/** Rewrite the managed keys of `config.yml` for `settings` (spend limits, the backup folder's path rule). */
		applySettings(settings: PersonalSettings): Promise<void>;
	};
	/** Bump the status revision and tell the paired devices (`personal-changed`). */
	changed(what: PersonalChangeKind[]): void;
}

export type SettingsRequest = Extract<PersonalRequest, { t: "personal-settings-get" | "personal-settings-set" }>;

export interface PersonalSettingsService {
	/** The settings now. */
	get(): PersonalSettings;
	/** Server names in the profile's `mcp.json` (read only; empty when there is none). */
	mcpServers(): Promise<string[]>;
	/** Answers `personal-settings-get` and `-set`; undefined for any other type. */
	handle(request: PersonalRequest): Promise<PersonalReply | undefined>;
}

/** Server names of an `mcp.json` (`{ "mcpServers": { name: … } }`); none when the file is missing or damaged. */
export async function readMcpServers(file: string): Promise<string[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(file).text());
	} catch {
		return [];
	}
	if (!isRecord(raw) || !isRecord(raw.mcpServers)) return [];
	return Object.keys(raw.mcpServers).sort();
}

function limit(value: unknown, name: string, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
		throw new Error(`${name} must be a number from 0 to ${max}`);
	}
	return value;
}

function time(value: unknown, name: string): string {
	if (typeof value !== "string" || !TIME_RE.test(value)) throw new Error(`${name} must be a time, HH:MM`);
	return value;
}

function section(value: unknown, name: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${name} must be an object`);
	return value;
}

function parseSource(raw: unknown, current: readonly PersonalSource[], servers: readonly string[]): PersonalSource {
	if (!isRecord(raw)) throw new Error("a source must be an object");
	const { id, label, kind, mcpServer, everyMinutes, prompt, enabled } = raw;
	if (typeof id !== "string" || !SOURCE_ID_RE.test(id) || `source:${id}`.length > MAX_EVENT_SOURCE_CHARS) {
		throw new Error("a source id is letters, digits, - and _ (up to 32)");
	}
	if (typeof label !== "string" || label.trim() === "" || label.length > MAX_SOURCE_LABEL_CHARS) {
		throw new Error(`source ${id}: the name is required (at most ${MAX_SOURCE_LABEL_CHARS} characters)`);
	}
	if (kind !== "mcp-poll") throw new Error(`source ${id}: kind must be mcp-poll`);
	if (typeof mcpServer !== "string" || !servers.includes(mcpServer)) {
		throw new Error(
			`source ${id}: ${typeof mcpServer === "string" ? mcpServer : "the server"} is not in the profile's mcp.json`,
		);
	}
	if (
		typeof everyMinutes !== "number" ||
		!Number.isInteger(everyMinutes) ||
		everyMinutes < MIN_SOURCE_EVERY_MINUTES ||
		everyMinutes > MAX_SOURCE_EVERY_MINUTES
	) {
		throw new Error(`source ${id}: check every ${MIN_SOURCE_EVERY_MINUTES} to ${MAX_SOURCE_EVERY_MINUTES} minutes`);
	}
	if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_SOURCE_PROMPT_CHARS) {
		throw new Error(`source ${id}: say what to check (at most ${MAX_SOURCE_PROMPT_CHARS} characters)`);
	}
	if (typeof enabled !== "boolean") throw new Error(`source ${id}: enabled must be true or false`);
	// The poll bookkeeping is the companion's: whatever the app sent for it is ignored.
	const prev = current.find(source => source.id === id);
	return {
		id,
		label: label.trim(),
		kind,
		mcpServer,
		everyMinutes,
		prompt: prompt.trim(),
		enabled,
		...(prev?.lastPollAt === undefined ? {} : { lastPollAt: prev.lastPollAt }),
		...(prev?.lastError === undefined ? {} : { lastError: prev.lastError }),
	};
}

/**
 * `current` with `patch` applied. Sections merge, `sources` replaces the list. Throws the reason when any
 * field is invalid; nothing is changed then. A backup folder is returned absolute and still unchecked on disk
 * (see {@link checkBackupFolder}).
 */
export function mergeSettings(
	current: PersonalSettings,
	patch: PersonalSettingsPatch,
	servers: readonly string[],
	configRoot: string,
): PersonalSettings {
	if (!isRecord(patch)) throw new Error("patch must be an object");
	const limits = section(patch.limits, "limits");
	const review = section(patch.review, "review");
	const rollover = section(patch.rollover, "rollover");
	const backup = section(patch.backup, "backup");
	const next: PersonalSettings = {
		limits: {
			dayUsd:
				limits.dayUsd === undefined
					? current.limits.dayUsd
					: limit(limits.dayUsd, "the daily limit", MAX_LIMIT_USD),
			monthUsd:
				limits.monthUsd === undefined
					? current.limits.monthUsd
					: limit(limits.monthUsd, "the monthly limit", MAX_LIMIT_USD),
		},
		review: {
			enabled: current.review.enabled,
			time: review.time === undefined ? current.review.time : time(review.time, "the review time"),
			budgetUsd:
				review.budgetUsd === undefined
					? current.review.budgetUsd
					: limit(review.budgetUsd, "the review budget", MAX_REVIEW_BUDGET_USD),
		},
		rollover: {
			time: rollover.time === undefined ? current.rollover.time : time(rollover.time, "the rollover time"),
		},
		backup: { folder: current.backup.folder },
		sources: current.sources,
	};
	if (review.enabled !== undefined) {
		if (typeof review.enabled !== "boolean") throw new Error("review.enabled must be true or false");
		next.review.enabled = review.enabled;
	}
	if (backup.folder !== undefined) {
		if (backup.folder !== null && typeof backup.folder !== "string")
			throw new Error("the backup folder must be a path or null");
		const folder = backup.folder === null ? "" : backup.folder.trim();
		if (folder === "") {
			next.backup.folder = null;
		} else {
			if (!path.isAbsolute(folder)) throw new Error("the backup folder must be an absolute path");
			const resolved = path.resolve(folder);
			const inside = path.relative(configRoot, resolved);
			if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) {
				throw new Error("the backup folder cannot be inside the omp config folder");
			}
			next.backup.folder = resolved;
		}
	}
	if (patch.sources !== undefined) {
		if (!Array.isArray(patch.sources)) throw new Error("sources must be a list");
		if (patch.sources.length > MAX_SOURCES) throw new Error(`at most ${MAX_SOURCES} sources`);
		const sources = patch.sources.map(raw => parseSource(raw, current.sources, servers));
		const ids = sources.map(source => source.id);
		if (new Set(ids).size !== ids.length) throw new Error("two sources have the same id");
		next.sources = sources;
	}
	return next;
}

/** @throws Error when `folder` cannot be created or written. Creates it (and its parents) when missing. */
export async function checkBackupFolder(folder: string): Promise<void> {
	try {
		await fs.mkdir(folder, { recursive: true });
		await fs.access(folder, fs.constants.W_OK);
	} catch {
		throw new Error("the backup folder cannot be created or written");
	}
}

export function createPersonalSettings(deps: SettingsDeps): PersonalSettingsService {
	const mcpServers = (): Promise<string[]> => readMcpServers(deps.paths.mcpJson);

	async function set(reqId: number, patch: PersonalSettingsPatch): Promise<PersonalReply> {
		const servers = await mcpServers();
		const current = deps.state.read().settings;
		const next = mergeSettings(current, patch, servers, deps.paths.configRoot);
		if (next.backup.folder !== null && next.backup.folder !== current.backup.folder) {
			await checkBackupFolder(next.backup.folder);
		}
		// `config.yml` first: when it cannot be written the settings stay as they were.
		await deps.profile.applySettings(next);
		const saved = await deps.state.update(state => ({
			...state,
			// The poll bookkeeping of a source may have moved while this ran: merge on what is stored now.
			settings: mergeSettings(state.settings, patch, servers, deps.paths.configRoot),
		}));
		deps.changed(["settings", "status"]);
		return { t: "personal-settings-set", reqId, settings: saved.settings, mcpServers: servers };
	}

	return {
		get: () => deps.state.read().settings,
		mcpServers,
		async handle(request) {
			if (request.t === "personal-settings-get") {
				return {
					t: "personal-settings-get",
					reqId: request.reqId,
					settings: deps.state.read().settings,
					mcpServers: await mcpServers(),
				};
			}
			if (request.t === "personal-settings-set") return await set(request.reqId, request.patch);
			return undefined;
		},
	};
}
