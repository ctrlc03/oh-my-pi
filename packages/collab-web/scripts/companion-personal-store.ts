/**
 * The companion's Personal-agent files (docs/personal-agent.md "Profile layout"): where everything lives
 * ({@link personalPaths}), append-only JSONL stores whose later lines replace earlier ones by id, the atomic
 * `state.json`, and the About-you file with its revision history. Nothing here creates a file or folder until
 * something is written, so a computer that never sets Personal up stays untouched.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PERSONAL_RUN_DIR } from "@oh-my-pi/pi-wire/personal-ipc";
import type {
	PersonalAbout,
	PersonalAboutVersion,
	PersonalDigest,
	PersonalEventRecord,
	PersonalInboxItem,
	PersonalMemoryMode,
	PersonalProposal,
	PersonalSettings,
} from "@oh-my-pi/pi-wire/personal";
import { MAX_ABOUT_BYTES, PERSONAL_DEFAULTS } from "@oh-my-pi/pi-wire/personal";
import type { SpendAlertState } from "./companion-personal-spend";

// ── paths ────────────────────────────────────────────────────────────────────

/** Every path of the Personal agent, from the config root `C` (`<home>/<PI_CONFIG_DIR or .omp>`); pure, creates nothing. */
export interface PersonalPaths {
	/** `C`. */
	configRoot: string;
	/** `P = C/profiles/personal`. */
	profile: string;
	/** `P/agent`: the profile's agent dir (`omp --profile personal`). */
	agentDir: string;
	/** `P/personal`: the companion's state; the agent can read but not write it. */
	personalDir: string;
	/** `P/workspace`: the agent's working folder and the cwd of its session. */
	workspace: string;
	/** `P/agent/AGENTS.md`: About you. */
	aboutFile: string;
	/** `P/personal/about-history`. */
	aboutHistoryDir: string;
	appendSystemFile: string;
	configYml: string;
	modelsYml: string;
	mcpJson: string;
	agentDb: string;
	/** `P/agent/sessions`. */
	sessionsDir: string;
	/** `P/agent/personal-chat`: the endless chat of chat-tree mode (`main/`, `tree/`, `view.json`, `lock`, `status.json`); the session owns it, the companion only reads it. */
	chatDir: string;
	/** `P/agent/personal-chat/status.json`. */
	chatStatusFile: string;
	/** `P/agent/spend-ledger.jsonl`. */
	ledgerFile: string;
	/** `P/agent/collab-companion-personal-ipc.json`. */
	ipcFile: string;
	/** `P/agent/collab-companion-personal-owner.key`. */
	ownerKeyFile: string;
	stateFile: string;
	/** The default backup folder, `P/backups`. */
	backupsDir: string;
	/** `C/run/personal`: the event channel, profile-independent. */
	runDir: string;
	inboxDir: string;
	claimedDir: string;
	beatFile: string;
}

export function personalPaths(configRoot: string): PersonalPaths {
	const profile = path.join(configRoot, "profiles", "personal");
	const agentDir = path.join(profile, "agent");
	const personalDir = path.join(profile, "personal");
	const runDir = path.join(configRoot, "run", PERSONAL_RUN_DIR);
	return {
		configRoot,
		profile,
		agentDir,
		personalDir,
		workspace: path.join(profile, "workspace"),
		aboutFile: path.join(agentDir, "AGENTS.md"),
		aboutHistoryDir: path.join(personalDir, "about-history"),
		appendSystemFile: path.join(agentDir, "APPEND_SYSTEM.md"),
		configYml: path.join(agentDir, "config.yml"),
		modelsYml: path.join(agentDir, "models.yml"),
		mcpJson: path.join(agentDir, "mcp.json"),
		agentDb: path.join(agentDir, "agent.db"),
		sessionsDir: path.join(agentDir, "sessions"),
		chatDir: path.join(agentDir, "personal-chat"),
		chatStatusFile: path.join(agentDir, "personal-chat", "status.json"),
		ledgerFile: path.join(agentDir, "spend-ledger.jsonl"),
		ipcFile: path.join(agentDir, "collab-companion-personal-ipc.json"),
		ownerKeyFile: path.join(agentDir, "collab-companion-personal-owner.key"),
		stateFile: path.join(personalDir, "state.json"),
		backupsDir: path.join(profile, "backups"),
		runDir,
		inboxDir: path.join(runDir, "inbox"),
		claimedDir: path.join(runDir, "claimed"),
		beatFile: path.join(runDir, "beat.json"),
	};
}

// ── files ────────────────────────────────────────────────────────────────────

/** Write `text` to `file` through a temp file in the same folder (mode 0600), so a reader never sees half of it. */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		await fs.writeFile(tmp, text, { mode });
		await fs.chmod(tmp, mode);
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

/** Lines of JSONL text that parse to an object; a torn or damaged line (a crash mid-append) is skipped. */
export function parseJsonl(text: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const row: unknown = JSON.parse(line);
			if (typeof row === "object" && row !== null && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
		} catch {
			// torn last line
		}
	}
	return rows;
}

/** Append-only records with an `id`: `put` appends a line, and the latest line of an id is its current value. */
export interface JsonlStore<T extends { id: string }> {
	/** Latest line per id, in order of first appearance. */
	list(): Promise<T[]>;
	get(id: string): Promise<T | undefined>;
	put(record: T): Promise<void>;
}

export function openJsonlStore<T extends { id: string }>(file: string): JsonlStore<T> {
	let writing: Promise<void> = Promise.resolve();
	const list = async (): Promise<T[]> => {
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const latest = new Map<string, T>();
		for (const row of parseJsonl(text)) if (typeof row.id === "string") latest.set(row.id, row as unknown as T);
		return [...latest.values()];
	};
	return {
		list,
		async get(id) {
			return (await list()).find(record => record.id === id);
		},
		put(record) {
			const run = writing
				.catch(() => undefined)
				.then(async () => {
					await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
					const handle = await fs.open(file, "a", 0o600);
					try {
						await handle.appendFile(`${JSON.stringify(record)}\n`);
					} finally {
						await handle.close();
					}
					await fs.chmod(file, 0o600);
				});
			writing = run;
			return run;
		},
	};
}

/** A proposal the owner rejected: the same one is never accepted from the agent again (see companion-personal-inbox). */
export interface PersonalRejected {
	id: string;
	/** What was proposed, as the owner saw it. */
	text: string;
	/** `text` lower-cased with markers and whitespace folded: what a repeat is compared on. */
	normalised: string;
	at: number;
	proposalId: string;
	section?: string;
	target?: string;
}

/** One review run, as `reviews.jsonl` keeps it. */
export interface PersonalReviewRecord {
	id: string;
	/** `YYYY-MM-DD` the review covers. */
	day: string;
	at: number;
	ok: boolean;
	costUsd: number | null;
	proposals: number;
	digestId?: string;
	error?: string;
	skipped?: "disabled" | "no-login" | "spend-limit" | "nothing-new" | "agent-busy";
	/** Ids of the memories of the day's record the run was shown: a second review of the day skips when nothing new arrived. */
	covered?: string[];
}

export interface PersonalStores {
	inbox: JsonlStore<PersonalInboxItem>;
	proposals: JsonlStore<PersonalProposal>;
	digests: JsonlStore<PersonalDigest>;
	rejected: JsonlStore<PersonalRejected>;
	events: JsonlStore<PersonalEventRecord>;
	reviews: JsonlStore<PersonalReviewRecord>;
}

export function openPersonalStores(paths: PersonalPaths): PersonalStores {
	const open = <T extends { id: string }>(name: string): JsonlStore<T> =>
		openJsonlStore<T>(path.join(paths.personalDir, name));
	return {
		inbox: open("inbox.jsonl"),
		proposals: open("proposals.jsonl"),
		digests: open("digests.jsonl"),
		rejected: open("rejected.jsonl"),
		events: open("events.jsonl"),
		reviews: open("reviews.jsonl"),
	};
}

// ── state.json ───────────────────────────────────────────────────────────────

/** The live session the companion tracks; the host with `cwd === P/workspace` whose `instanceId` matches is the Personal thread. */
export interface PersonalSessionRecord {
	sessionId: string;
	instanceId: string | null;
	startedAt: number;
	/** Counts rollovers: 1 for the first session. */
	generation: number;
	/** The memory mode the session was launched with; absent = `recall` (a session recorded before chat-tree mode existed). */
	mode?: PersonalMemoryMode;
}

export interface PersonalBackupState {
	lastAt: number | null;
	lastOk: boolean | null;
	lastError?: string;
	/** Local day (`YYYY-MM-DD`) of the last daily run that was due, so one day runs once. */
	lastDay: string | null;
	/** Cheap fingerprint of what the last backup covered; an unchanged one skips the run. */
	fingerprint?: string;
}

export interface PersonalState {
	v: 1;
	/** The profile layout exists (setup ran). */
	setUp: boolean;
	/** On: keep-alive, events, sources, review and backups run. */
	enabled: boolean;
	settings: PersonalSettings;
	/** Bumped on every change; mirrors `PersonalStatus.rev` and `hosts.personalRev`. */
	rev: number;
	/** The owner stopped the session: keep-alive leaves it alone until start, restart or enable. */
	stopped: boolean;
	session: PersonalSessionRecord | null;
	/** Generation of the newest session ever started. */
	generation: number;
	/** Handoff note of the session that ended, the next session's first prompt; consumed by the start. */
	handoff: string | null;
	/** Local day of the last daily rollover. */
	rolloverDay: string | null;
	backup: PersonalBackupState;
	/** Local day of the last review that was due (ran or was skipped with a reason). */
	reviewDay: string | null;
	/** Last start failure shown in the status. */
	error?: string;
	/** B: which spend alerts already went out for the current windows. */
	spendAlerts?: SpendAlertState;
}

export function defaultSettings(): PersonalSettings {
	return {
		limits: { ...PERSONAL_DEFAULTS.limits },
		review: {
			enabled: PERSONAL_DEFAULTS.review.enabled,
			time: PERSONAL_DEFAULTS.review.time,
			budgetUsd: PERSONAL_DEFAULTS.review.budgetUsd,
		},
		rollover: { time: PERSONAL_DEFAULTS.rollover.time },
		memoryMode: PERSONAL_DEFAULTS.memoryMode,
		backup: { folder: null },
		sources: [],
	};
}

export function defaultState(): PersonalState {
	return {
		v: 1,
		setUp: false,
		enabled: false,
		settings: defaultSettings(),
		rev: 0,
		stopped: false,
		session: null,
		generation: 0,
		handoff: null,
		rolloverDay: null,
		backup: { lastAt: null, lastOk: null, lastDay: null },
		reviewDay: null,
	};
}

export interface PersonalStateStore {
	/** The state in memory (loaded when the store was opened). */
	read(): PersonalState;
	/** Replace the state with what `change` returns and persist it atomically. Changes run one after another. */
	update(change: (state: PersonalState) => PersonalState): Promise<PersonalState>;
}

/** Fold a damaged or older `state.json` into a full state: missing parts take the defaults. */
export function parseState(raw: unknown): PersonalState {
	const base = defaultState();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
	const r = raw as Partial<PersonalState> & Record<string, unknown>;
	const settings = (
		typeof r.settings === "object" && r.settings !== null ? r.settings : {}
	) as Partial<PersonalSettings>;
	return {
		...base,
		...r,
		v: 1,
		setUp: r.setUp === true,
		enabled: r.enabled === true,
		stopped: r.stopped === true,
		rev: typeof r.rev === "number" && Number.isFinite(r.rev) ? r.rev : 0,
		generation: typeof r.generation === "number" && Number.isFinite(r.generation) ? r.generation : 0,
		handoff: typeof r.handoff === "string" ? r.handoff : null,
		settings: {
			limits: { ...base.settings.limits, ...settings.limits },
			review: { ...base.settings.review, ...settings.review },
			rollover: { ...base.settings.rollover, ...settings.rollover },
			memoryMode: settings.memoryMode === "chat-tree" ? "chat-tree" : "recall",
			backup: { ...base.settings.backup, ...settings.backup },
			sources: Array.isArray(settings.sources) ? settings.sources : [],
		},
		backup: { ...base.backup, ...(typeof r.backup === "object" && r.backup !== null ? r.backup : {}) },
		session: typeof r.session === "object" && r.session !== null ? (r.session as PersonalSessionRecord) : null,
		rolloverDay: typeof r.rolloverDay === "string" ? r.rolloverDay : null,
		reviewDay: typeof r.reviewDay === "string" ? r.reviewDay : null,
	};
}

/** Load `state.json` (the defaults when there is none; nothing is written until the first `update`). */
export async function openPersonalState(file: string): Promise<PersonalStateStore> {
	let state: PersonalState;
	try {
		state = parseState(JSON.parse(await Bun.file(file).text()));
	} catch {
		state = defaultState();
	}
	let writing: Promise<unknown> = Promise.resolve();
	return {
		read: () => state,
		update(change) {
			const run = writing
				.catch(() => undefined)
				.then(async () => {
					const next = change(state);
					await writeFileAtomic(file, `${JSON.stringify(next, null, "\t")}\n`);
					state = next;
					return next;
				});
			writing = run;
			return run;
		},
	};
}

// ── About you ────────────────────────────────────────────────────────────────

export interface PersonalAboutStore {
	/** The current About-you file with its revision. Hand edits of `AGENTS.md` are recorded as an owner revision. */
	read(): Promise<PersonalAbout>;
	/**
	 * Replace About you: `AGENTS.md` is written atomically, the old text stays in `about-history`, the revision
	 * moves up by one. Throws when `text` is over {@link MAX_ABOUT_BYTES}.
	 */
	write(text: string, by: "owner" | "proposal", proposalId?: string): Promise<PersonalAbout>;
	/** Every revision, newest first. */
	history(limit?: number): Promise<PersonalAboutVersion[]>;
	/** Record the first revision (`setup`) from what `AGENTS.md` holds now; a no-op when a history exists. */
	seed(): Promise<PersonalAbout>;
}

interface AboutIndexRow {
	rev: number;
	at: number;
	by: PersonalAboutVersion["by"];
	proposalId?: string;
	file: string;
}

/** Rough token count: four characters per token. */
export const aboutTokens = (text: string): number => Math.ceil(text.length / 4);

export function createAboutStore(paths: PersonalPaths, now: () => number): PersonalAboutStore {
	const indexFile = path.join(paths.aboutHistoryDir, "index.jsonl");
	let chain: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = chain.catch(() => undefined).then(work);
		chain = run;
		return run;
	};

	const readIndex = async (): Promise<AboutIndexRow[]> => {
		let text: string;
		try {
			text = await Bun.file(indexFile).text();
		} catch {
			return [];
		}
		return parseJsonl(text)
			.filter(
				(row): row is Record<string, unknown> & AboutIndexRow =>
					typeof row.rev === "number" && typeof row.file === "string",
			)
			.sort((a, b) => a.rev - b.rev);
	};
	const readText = async (): Promise<string | null> => {
		try {
			return await Bun.file(paths.aboutFile).text();
		} catch {
			return null;
		}
	};
	const record = async (text: string, by: PersonalAboutVersion["by"], proposalId?: string): Promise<AboutIndexRow> => {
		const rows = await readIndex();
		const rev = (rows.at(-1)?.rev ?? 0) + 1;
		const at = now();
		const file = `${rev}-${new Date(at).toISOString().replace(/[:.]/g, "-")}.md`;
		await writeFileAtomic(path.join(paths.aboutHistoryDir, file), text);
		const row: AboutIndexRow = { rev, at, by, ...(proposalId === undefined ? {} : { proposalId }), file };
		const handle = await fs.open(indexFile, "a", 0o600);
		try {
			await handle.appendFile(`${JSON.stringify(row)}\n`);
		} finally {
			await handle.close();
		}
		return row;
	};
	const current = async (): Promise<PersonalAbout> => {
		const text = (await readText()) ?? "";
		let rows = await readIndex();
		const last = rows.at(-1);
		const lastText =
			last === undefined
				? null
				: await Bun.file(path.join(paths.aboutHistoryDir, last.file))
						.text()
						.catch(() => null);
		if (last !== undefined && lastText !== text) {
			// The owner edited the file by hand: that is a revision too.
			await record(text, "owner");
			rows = await readIndex();
		}
		const head = rows.at(-1);
		let updatedAt = head?.at ?? 0;
		if (head === undefined)
			updatedAt = await fs.stat(paths.aboutFile).then(
				s => Math.floor(s.mtimeMs),
				() => 0,
			);
		return { text, rev: head?.rev ?? 0, updatedAt, tokens: aboutTokens(text) };
	};

	return {
		read: () => exclusive(current),
		write: (text, by, proposalId) =>
			exclusive(async () => {
				if (Buffer.byteLength(text) > MAX_ABOUT_BYTES) throw new Error("About you is too long");
				await current();
				await writeFileAtomic(paths.aboutFile, text);
				await record(text, by, proposalId);
				return await current();
			}),
		async history(limit = 50) {
			const rows = (await readIndex()).reverse().slice(0, Math.max(1, limit));
			return await Promise.all(
				rows.map(async (row): Promise<PersonalAboutVersion> => ({
					rev: row.rev,
					at: row.at,
					by: row.by,
					...(row.proposalId === undefined ? {} : { proposalId: row.proposalId }),
					text: await Bun.file(path.join(paths.aboutHistoryDir, row.file))
						.text()
						.catch(() => ""),
				})),
			);
		},
		seed: () =>
			exclusive(async () => {
				if ((await readIndex()).length === 0) await record((await readText()) ?? "", "setup");
				return await current();
			}),
	};
}
