/**
 * Backups of the Personal agent (docs/personal-agent.md "Backups"): once a day, at `PERSONAL_DEFAULTS.backup.time`
 * local, a snapshot of the memory bank and About you goes to `<folder>/omp-personal/daily/YYYY-MM-DD/`, the first
 * snapshot of a month is kept as `monthly/YYYY-MM/`, and new or longer session logs are copied into
 * `sessions-mirror/`. Only snapshots are pruned (30 daily, 12 monthly); the mirror never loses or shortens a file.
 * `agent.db` (the login) is never copied. The module owns no timer: the companion's poll calls {@link PersonalBackup.tick}.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AdminSnapshot, MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import {
	PERSONAL_DEFAULTS,
	type PersonalBackupStatus,
	type PersonalChangeKind,
	type PersonalSettings,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalPaths, PersonalStateStore } from "./companion-personal-store";
import { writeFileAtomic } from "./companion-personal-store";

export interface BackupDeps {
	paths: PersonalPaths;
	now(): number;
	settings(): PersonalSettings;
	state: PersonalStateStore;
	openAdmin(options?: { readOnly?: boolean }): MemoryAdmin;
	alert(a: { title: string; body: string; tag: string }): Promise<unknown>;
	changed(what: PersonalChangeKind[]): void;
}

export interface PersonalBackupResult {
	ok: boolean;
	skipped?: "unchanged";
	error?: string;
}

export interface PersonalBackup {
	/** Run the daily backup when it is due (at or after the backup time, once per local day). */
	tick(): Promise<void>;
	/** Back up now. `force` ignores the "nothing changed" check. A backup failure is reported in the result, not thrown. */
	run(options?: { force?: boolean }): Promise<PersonalBackupResult>;
	/** A backup (scheduled or asked for) is being made now. */
	running(): boolean;
	status(): Promise<PersonalBackupStatus>;
}

/** One file of a snapshot, as `manifest.json` lists it. */
export interface BackupManifestFile {
	/** Relative to the snapshot folder. */
	path: string;
	bytes: number;
	sha256: string;
}

export interface BackupManifest {
	v: 1;
	day: string;
	createdAt: number;
	rows: AdminSnapshot["rows"];
	files: BackupManifestFile[];
	mirror: { files: number; copied: number };
}

const ROOT_NAME = "omp-personal";
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DIR = /^\d{4}-\d{2}$/;
const TMP_PREFIX = ".tmp-";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD`. */
function localDay(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const statOrNull = (file: string) => fs.stat(file).catch(() => null);

/** Every regular file under `dir` (relative paths, `/`-joined by the platform); none when the folder is missing. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(dir, rel)));
		else if (entry.isFile()) files.push(rel);
	}
	return files;
}

/** Names of the snapshot folders in `dir` that match `pattern`, newest (largest) first. */
async function snapshotNames(dir: string, pattern: RegExp): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter(entry => entry.isDirectory() && pattern.test(entry.name))
		.map(entry => entry.name)
		.sort()
		.reverse();
}

/** The folder itself, or the nearest ancestor that exists. */
async function nearestExisting(target: string): Promise<string | null> {
	let current = path.resolve(target);
	for (;;) {
		if (await statOrNull(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

interface SessionFile {
	rel: string;
	size: number;
	mtimeMs: number;
}

async function scanSessions(sessionsDir: string): Promise<SessionFile[]> {
	const found: SessionFile[] = [];
	for (const rel of await listFiles(sessionsDir)) {
		if (!rel.endsWith(".jsonl")) continue;
		const stat = await statOrNull(path.join(sessionsDir, rel));
		if (stat) found.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
	}
	return found;
}

/** Copy new or longer session logs; a destination that is longer than its source is left alone. Returns the number copied. */
async function mirrorSessions(sessionsDir: string, mirrorDir: string, sources: SessionFile[]): Promise<number> {
	let copied = 0;
	for (const source of sources) {
		const from = path.join(sessionsDir, source.rel);
		const to = path.join(mirrorDir, source.rel);
		const existing = await statOrNull(to);
		if (existing) {
			if (source.size < existing.size) continue;
			if (source.size === existing.size && source.mtimeMs <= existing.mtimeMs) continue;
		}
		await fs.mkdir(path.dirname(to), { recursive: true });
		const partial = `${to}${TMP_PREFIX}${process.pid}`;
		try {
			await fs.copyFile(from, partial);
			const mtime = new Date(source.mtimeMs);
			await fs.utimes(partial, mtime, mtime);
			await fs.rename(partial, to);
		} catch (error) {
			await fs.rm(partial, { force: true });
			throw error;
		}
		copied++;
	}
	return copied;
}

/** Local time `HH:MM` of the day containing `at`, as ms. */
function backupTimeOn(at: number): number {
	const [hour = 0, minute = 0] = PERSONAL_DEFAULTS.backup.time.split(":").map(Number);
	const d = new Date(at);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

function nextBackupAfter(at: number): number {
	const today = backupTimeOn(at);
	if (today > at) return today;
	const d = new Date(today);
	return backupTimeOn(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime());
}

export function createPersonalBackup(deps: BackupDeps): PersonalBackup {
	const { paths } = deps;
	const folderOf = (): string => deps.settings().backup.folder ?? paths.backupsDir;
	let inflight: Promise<PersonalBackupResult> | null = null;
	let ticking: Promise<void> | null = null;

	/** The backup folder exists (created below an existing parent) or the backup fails. */
	const ensureFolder = async (folder: string): Promise<void> => {
		const stat = await statOrNull(folder);
		if (stat) {
			if (!stat.isDirectory()) throw new Error("backup folder is not a folder");
			return;
		}
		const parent = await statOrNull(path.dirname(folder));
		if (!parent?.isDirectory()) throw new Error("backup folder is missing");
		await fs.mkdir(folder);
	};

	/** What a backup would cover, boiled down so an unchanged one can be skipped. */
	const fingerprint = async (admin: MemoryAdmin, sessions: SessionFile[]): Promise<string> => {
		const db = await statOrNull(admin.dbPath);
		const about = await statOrNull(paths.aboutFile);
		const history = await statOrNull(path.join(paths.aboutHistoryDir, "index.jsonl"));
		return createHash("sha256")
			.update(
				JSON.stringify({
					bank: admin.stats(),
					db: db && [db.size, db.mtimeMs],
					about: about && [about.size, about.mtimeMs],
					history: history && [history.size, history.mtimeMs],
					sessions: [
						sessions.length,
						sessions.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0),
						sessions.reduce((total, file) => total + file.size, 0),
					],
				}),
			)
			.digest("hex");
	};

	const buildDaily = async (
		root: string,
		day: string,
		at: number,
		admin: MemoryAdmin,
		sessions: SessionFile[],
	): Promise<void> => {
		const dailyDir = path.join(root, "daily");
		const target = path.join(dailyDir, day);
		const staging = path.join(dailyDir, `${TMP_PREFIX}${day}`);
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(staging, { recursive: true });
		try {
			const snapshot = await admin.snapshot(path.join(staging, "mnemopi"));
			const files: BackupManifestFile[] = snapshot.files.map(file => ({
				path: path.join("mnemopi", file.name),
				bytes: file.bytes,
				sha256: file.sha256,
			}));

			const aboutDir = path.join(staging, "about");
			if (await statOrNull(paths.aboutFile)) {
				await fs.mkdir(aboutDir, { recursive: true });
				await fs.copyFile(paths.aboutFile, path.join(aboutDir, path.basename(paths.aboutFile)));
			}
			if (await statOrNull(paths.aboutHistoryDir)) {
				await fs.mkdir(aboutDir, { recursive: true });
				await fs.cp(paths.aboutHistoryDir, path.join(aboutDir, "about-history"), { recursive: true });
			}
			for (const rel of await listFiles(aboutDir)) {
				const file = path.join(aboutDir, rel);
				files.push({
					path: path.join("about", rel),
					bytes: (await fs.stat(file)).size,
					sha256: createHash("sha256")
						.update(await fs.readFile(file))
						.digest("hex"),
				});
			}

			const copied = await mirrorSessions(paths.sessionsDir, path.join(root, "sessions-mirror"), sessions);
			const manifest: BackupManifest = {
				v: 1,
				day,
				createdAt: at,
				rows: snapshot.rows,
				files,
				mirror: { files: sessions.length, copied },
			};
			await writeFileAtomic(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
			await fs.rm(target, { recursive: true, force: true });
			await fs.rename(staging, target);
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true });
			throw error;
		}
	};

	/** The first daily snapshot of a month is copied to `monthly/YYYY-MM/` once and never recomputed. */
	const promoteMonthly = async (root: string, day: string): Promise<void> => {
		const monthlyDir = path.join(root, "monthly");
		const month = day.slice(0, 7);
		const target = path.join(monthlyDir, month);
		if (await statOrNull(target)) return;
		const staging = path.join(monthlyDir, `${TMP_PREFIX}${month}`);
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(monthlyDir, { recursive: true });
		try {
			await fs.cp(path.join(root, "daily", day), staging, { recursive: true });
			await fs.rename(staging, target);
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true });
			throw error;
		}
	};

	/** Snapshots only: the newest `keepDaily` dailies and `keepMonthly` monthlies stay; the session mirror is not touched. */
	const prune = async (root: string): Promise<void> => {
		const rules = [
			{ dir: "daily", pattern: DAY_DIR, keep: PERSONAL_DEFAULTS.backup.keepDaily },
			{ dir: "monthly", pattern: MONTH_DIR, keep: PERSONAL_DEFAULTS.backup.keepMonthly },
		];
		for (const rule of rules) {
			const dir = path.join(root, rule.dir);
			for (const name of (await snapshotNames(dir, rule.pattern)).slice(rule.keep)) {
				await fs.rm(path.join(dir, name), { recursive: true, force: true });
			}
		}
	};

	const record = async (
		at: number,
		outcome: { ok: true; fingerprint: string } | { ok: false; error: string },
	): Promise<void> => {
		await deps.state.update(state => {
			const backup = { ...state.backup, lastAt: at, lastOk: outcome.ok };
			delete backup.lastError;
			if (outcome.ok) backup.fingerprint = outcome.fingerprint;
			else backup.lastError = outcome.error;
			return { ...state, backup };
		});
		deps.changed(["status"]);
	};

	const execute = async (force: boolean): Promise<PersonalBackupResult> => {
		const at = deps.now();
		const folder = folderOf();
		try {
			await ensureFolder(folder);
			const root = path.join(folder, ROOT_NAME);
			const day = localDay(at);
			const admin = deps.openAdmin({ readOnly: true });
			let print: string;
			try {
				const sessions = await scanSessions(paths.sessionsDir);
				print = await fingerprint(admin, sessions);
				const last = deps.state.read().backup;
				if (!force && last.lastOk === true && last.fingerprint === print) return { ok: true, skipped: "unchanged" };
				await fs.mkdir(path.join(root, "daily"), { recursive: true });
				await buildDaily(root, day, at, admin, sessions);
			} finally {
				admin.close();
			}
			await promoteMonthly(root, day);
			await prune(root);
			await record(at, { ok: true, fingerprint: print });
			return { ok: true };
		} catch (error) {
			const message = errorMessage(error);
			await record(at, { ok: false, error: message });
			try {
				await deps.alert({ title: "Backup failed", body: message, tag: "personal-backup" });
			} catch (alertError) {
				console.error(`personal backup: could not raise the failure alert: ${errorMessage(alertError)}`);
			}
			return { ok: false, error: message };
		}
	};

	const run: PersonalBackup["run"] = options => {
		inflight ??= execute(options?.force === true).finally(() => {
			inflight = null;
		});
		return inflight;
	};

	return {
		run,
		running: () => inflight !== null,
		tick() {
			ticking ??= (async () => {
				const at = deps.now();
				const today = localDay(at);
				if (at < backupTimeOn(at) || deps.state.read().backup.lastDay === today) return;
				await deps.state.update(state => ({ ...state, backup: { ...state.backup, lastDay: today } }));
				await run();
			})().finally(() => {
				ticking = null;
			});
			return ticking;
		},
		async status() {
			const folder = folderOf();
			const bankDir = path.dirname(path.join(paths.agentDir, "memories", "mnemopi", "mnemopi.db"));
			const [folderRoot, bankRoot] = await Promise.all([nearestExisting(folder), nearestExisting(bankDir)]);
			const [folderStat, bankStat] = await Promise.all([
				folderRoot === null ? null : statOrNull(folderRoot),
				bankRoot === null ? null : statOrNull(bankRoot),
			]);
			const root = path.join(folder, ROOT_NAME);
			const backup = deps.state.read().backup;
			return {
				folder,
				sameDisk: folderStat !== null && bankStat !== null && folderStat.dev === bankStat.dev,
				lastAt: backup.lastAt,
				lastOk: backup.lastOk,
				...(backup.lastError === undefined ? {} : { lastError: backup.lastError }),
				dailyKept: (await snapshotNames(path.join(root, "daily"), DAY_DIR)).length,
				monthlyKept: (await snapshotNames(path.join(root, "monthly"), MONTH_DIR)).length,
				nextAt: nextBackupAfter(deps.now()),
			};
		},
	};
}
