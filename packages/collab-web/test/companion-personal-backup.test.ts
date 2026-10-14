import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdminStats, MemoryAdmin } from "@oh-my-pi/pi-mnemopi/admin-types";
import type { PersonalChangeKind } from "@oh-my-pi/pi-wire/personal";
import { type BackupManifest, createPersonalBackup, type PersonalBackup } from "../scripts/companion-personal-backup";
import {
	defaultSettings,
	openPersonalState,
	type PersonalPaths,
	type PersonalStateStore,
	personalPaths,
} from "../scripts/companion-personal-store";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

interface Harness {
	root: string;
	paths: PersonalPaths;
	folder: string;
	state: PersonalStateStore;
	backup: PersonalBackup;
	clock: { now: number };
	bank: { stats: AdminStats; snapshots: number; opens: { readOnly: boolean | undefined }[]; failWith?: string };
	alerts: { title: string; body: string; tag: string }[];
	changes: PersonalChangeKind[][];
	setFolder(folder: string | null): void;
}

let dirs: string[] = [];

async function harness(): Promise<Harness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-backup-"));
	dirs.push(root);
	const paths = personalPaths(path.join(root, "config"));
	fs.mkdirSync(paths.agentDir, { recursive: true });
	fs.mkdirSync(paths.personalDir, { recursive: true });
	const dbDir = path.join(paths.agentDir, "memories", "mnemopi");
	fs.mkdirSync(dbDir, { recursive: true });
	fs.writeFileSync(path.join(dbDir, "mnemopi.db"), "bank");
	const folder = path.join(root, "backups");
	const settings = defaultSettings();
	settings.backup.folder = folder;
	const state = await openPersonalState(paths.stateFile);
	const clock = { now: at(2026, 10, 14, 3, 5) };
	const bank: Harness["bank"] = {
		stats: { working: 2, episodic: 1, invalid: 0, pinned: 0 },
		snapshots: 0,
		opens: [],
	};
	const alerts: Harness["alerts"] = [];
	const changes: PersonalChangeKind[][] = [];
	const openAdmin = (options?: { readOnly?: boolean }): MemoryAdmin => {
		bank.opens.push({ readOnly: options?.readOnly });
		return {
			dbPath: path.join(dbDir, "mnemopi.db"),
			stats: () => bank.stats,
			async snapshot(destDir: string) {
				bank.snapshots++;
				if (bank.failWith !== undefined) throw new Error(bank.failWith);
				fs.mkdirSync(destDir, { recursive: true });
				const target = path.join(destDir, "mnemopi.db");
				const db = new Database(target);
				db.run("CREATE TABLE working_memory (id TEXT, content TEXT)");
				for (let i = 0; i < bank.stats.working; i++)
					db.run("INSERT INTO working_memory VALUES (?, ?)", [`w${i}`, `row ${i}`]);
				db.close();
				const bytes = fs.readFileSync(target);
				return {
					files: [
						{ name: "mnemopi.db", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
					],
					rows: { working: bank.stats.working, episodic: bank.stats.episodic, invalid: bank.stats.invalid },
				};
			},
			close() {},
		} as unknown as MemoryAdmin;
	};
	const h: Harness = {
		root,
		paths,
		folder,
		state,
		clock,
		bank,
		alerts,
		changes,
		setFolder(next) {
			settings.backup.folder = next;
		},
		backup: createPersonalBackup({
			paths,
			now: () => clock.now,
			settings: () => settings,
			state,
			openAdmin,
			alert: async a => {
				alerts.push(a);
			},
			changed: what => {
				changes.push(what);
			},
		}),
	};
	return h;
}

const base = (h: Harness) => path.join(h.folder, "omp-personal");
const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const day = (h: Harness, d: string) => path.join(base(h), "daily", d);

function writeSession(h: Harness, rel: string, text: string, mtime?: number): string {
	const file = path.join(h.paths.sessionsDir, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
	return file;
}

beforeEach(() => {
	dirs = [];
});
afterEach(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("daily snapshot", () => {
	it("writes mnemopi, about and a manifest whose sizes and checksums match the files", async () => {
		const h = await harness();
		fs.writeFileSync(h.paths.aboutFile, "# About me\n");
		fs.mkdirSync(h.paths.aboutHistoryDir, { recursive: true });
		fs.writeFileSync(path.join(h.paths.aboutHistoryDir, "index.jsonl"), '{"rev":1}\n');
		fs.writeFileSync(path.join(h.paths.aboutHistoryDir, "1-x.md"), "# About me\n");

		expect(await h.backup.run()).toEqual({ ok: true });

		const dir = day(h, "2026-10-14");
		expect(fs.readFileSync(path.join(dir, "about", "AGENTS.md"), "utf8")).toBe("# About me\n");
		expect(names(path.join(dir, "about", "about-history"))).toEqual(["1-x.md", "index.jsonl"]);
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
		expect(manifest.day).toBe("2026-10-14");
		expect(manifest.rows).toEqual({ working: 2, episodic: 1, invalid: 0 });
		expect(manifest.files.map(f => f.path).sort()).toEqual([
			path.join("about", "AGENTS.md"),
			path.join("about", "about-history", "1-x.md"),
			path.join("about", "about-history", "index.jsonl"),
			path.join("mnemopi", "mnemopi.db"),
		]);
		for (const file of manifest.files) {
			expect(fs.statSync(path.join(dir, file.path)).size).toBe(file.bytes);
			expect(sha(path.join(dir, file.path))).toBe(file.sha256);
		}
		const db = new Database(path.join(dir, "mnemopi", "mnemopi.db"), { readonly: true });
		expect(db.query("SELECT COUNT(*) AS n FROM working_memory").get()).toEqual({ n: 2 });
		db.close();
		expect(h.bank.opens.every(o => o.readOnly === true)).toBe(true);
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-14"]);
	});

	it("works without About you or a session folder", async () => {
		const h = await harness();
		expect(await h.backup.run()).toEqual({ ok: true });
		const dir = day(h, "2026-10-14");
		expect(names(dir)).toEqual(["manifest.json", "mnemopi"]);
		expect(fs.existsSync(path.join(base(h), "sessions-mirror"))).toBe(false);
	});

	it("never copies agent.db or non-session files", async () => {
		const h = await harness();
		fs.writeFileSync(h.paths.agentDb, "login");
		writeSession(h, "a/one.jsonl", "{}\n");
		writeSession(h, "a/agent.db", "login");
		writeSession(h, "a/notes.txt", "x");
		await h.backup.run();
		const all: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(path.join(dir, entry.name));
				else all.push(entry.name);
			}
		};
		walk(h.folder);
		expect(all).not.toContain("agent.db");
		expect(all).not.toContain("notes.txt");
		expect(all).toContain("one.jsonl");
	});

	it("rebuilds the same day on a forced second run without leaving staging folders", async () => {
		const h = await harness();
		await h.backup.run();
		h.bank.stats = { ...h.bank.stats, working: 3 };
		await h.backup.run({ force: true });
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-14"]);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(day(h, "2026-10-14"), "manifest.json"), "utf8"),
		) as BackupManifest;
		expect(manifest.rows.working).toBe(3);
	});
});

describe("retention", () => {
	it("keeps the newest 30 dailies and 12 monthlies and leaves the mirror alone", async () => {
		const h = await harness();
		for (let d = 1; d <= 31; d++) fs.mkdirSync(day(h, `2026-01-${String(d).padStart(2, "0")}`), { recursive: true });
		for (let m = 1; m <= 14; m++) {
			const name = m <= 12 ? `2025-${String(m).padStart(2, "0")}` : `2026-${String(m - 12).padStart(2, "0")}`;
			fs.mkdirSync(path.join(base(h), "monthly", name), { recursive: true });
		}
		const mirrored = path.join(base(h), "sessions-mirror", "old", "kept.jsonl");
		fs.mkdirSync(path.dirname(mirrored), { recursive: true });
		fs.writeFileSync(mirrored, "old\n");
		fs.mkdirSync(path.join(base(h), "daily", "not-a-snapshot"), { recursive: true });

		expect(await h.backup.run()).toEqual({ ok: true });

		const daily = names(path.join(base(h), "daily"));
		expect(daily.filter(n => /^\d/.test(n))).toHaveLength(30);
		expect(daily).toContain("2026-10-14");
		expect(daily).toContain("2026-01-31");
		expect(daily).not.toContain("2026-01-01");
		expect(daily).not.toContain("2026-01-02");
		expect(daily).toContain("not-a-snapshot");

		const monthly = names(path.join(base(h), "monthly"));
		expect(monthly).toHaveLength(12);
		expect(monthly).toContain("2026-10");
		expect(monthly).not.toContain("2025-01");
		expect(monthly).not.toContain("2025-03");
		expect(monthly).toContain("2026-02");
		// a monthly outlives the daily it came from
		expect(monthly).toContain("2025-12");
		expect(fs.readFileSync(mirrored, "utf8")).toBe("old\n");
	});

	it("promotes the first daily of a month as the monthly and does not recompute it", async () => {
		const h = await harness();
		h.clock.now = at(2026, 10, 3);
		await h.backup.run();
		const monthly = path.join(base(h), "monthly", "2026-10");
		expect(names(monthly)).toEqual(["manifest.json", "mnemopi"]);
		const first = fs.readFileSync(path.join(monthly, "manifest.json"), "utf8");
		expect(JSON.parse(first).day).toBe("2026-10-03");

		h.clock.now = at(2026, 10, 9);
		h.bank.stats = { ...h.bank.stats, working: 5 };
		await h.backup.run();
		expect(names(path.join(base(h), "monthly"))).toEqual(["2026-10"]);
		expect(fs.readFileSync(path.join(monthly, "manifest.json"), "utf8")).toBe(first);
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-03", "2026-10-09"]);

		h.clock.now = at(2026, 11, 1);
		await h.backup.run({ force: true });
		expect(names(path.join(base(h), "monthly"))).toEqual(["2026-10", "2026-11"]);
	});
});

describe("session mirror", () => {
	it("copies new session logs with their relative paths and appends as they grow", async () => {
		const h = await harness();
		const file = writeSession(h, "--work--/2026-10-14_a.jsonl", "one\n", at(2026, 10, 14, 1));
		writeSession(h, "b.jsonl", "b\n", at(2026, 10, 14, 1));
		await h.backup.run();
		const mirror = path.join(base(h), "sessions-mirror");
		expect(fs.readFileSync(path.join(mirror, "--work--", "2026-10-14_a.jsonl"), "utf8")).toBe("one\n");
		expect(fs.readFileSync(path.join(mirror, "b.jsonl"), "utf8")).toBe("b\n");

		fs.appendFileSync(file, "two\n");
		await h.backup.run({ force: true });
		expect(fs.readFileSync(path.join(mirror, "--work--", "2026-10-14_a.jsonl"), "utf8")).toBe("one\ntwo\n");
		expect(names(mirror).filter(n => n.includes(".tmp-"))).toEqual([]);
	});

	it("never deletes a file the source lost and never replaces a longer copy with a shorter source", async () => {
		const h = await harness();
		const gone = writeSession(h, "gone.jsonl", "will vanish\n", at(2026, 10, 1));
		const shrunk = writeSession(h, "shrunk.jsonl", "a long long line\nand another\n", at(2026, 10, 1));
		await h.backup.run();

		fs.rmSync(gone);
		fs.writeFileSync(shrunk, "short\n");
		fs.utimesSync(shrunk, at(2026, 10, 14) / 1000, at(2026, 10, 14) / 1000);
		await h.backup.run({ force: true });

		const mirror = path.join(base(h), "sessions-mirror");
		expect(fs.readFileSync(path.join(mirror, "gone.jsonl"), "utf8")).toBe("will vanish\n");
		expect(fs.readFileSync(path.join(mirror, "shrunk.jsonl"), "utf8")).toBe("a long long line\nand another\n");
	});

	it("recopies an equal-length file only when the source is newer", async () => {
		const h = await harness();
		const file = writeSession(h, "same.jsonl", "aaaa\n", at(2026, 10, 1));
		await h.backup.run();
		const copy = path.join(base(h), "sessions-mirror", "same.jsonl");
		fs.writeFileSync(file, "bbbb\n");
		fs.utimesSync(file, at(2026, 10, 1) / 1000, at(2026, 10, 1) / 1000);
		await h.backup.run({ force: true });
		expect(fs.readFileSync(copy, "utf8")).toBe("aaaa\n");
		fs.utimesSync(file, at(2026, 10, 2) / 1000, at(2026, 10, 2) / 1000);
		await h.backup.run({ force: true });
		expect(fs.readFileSync(copy, "utf8")).toBe("bbbb\n");
	});
});

describe("skipping unchanged", () => {
	it("skips when nothing changed since the last successful backup and force overrides", async () => {
		const h = await harness();
		expect(await h.backup.run()).toEqual({ ok: true });
		expect(h.bank.snapshots).toBe(1);
		expect(h.state.read().backup.fingerprint).toMatch(/^[0-9a-f]{64}$/);

		h.clock.now = at(2026, 10, 15, 3, 5);
		expect(await h.backup.run()).toEqual({ ok: true, skipped: "unchanged" });
		expect(h.bank.snapshots).toBe(1);
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-14"]);

		expect(await h.backup.run({ force: true })).toEqual({ ok: true });
		expect(h.bank.snapshots).toBe(2);
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-14", "2026-10-15"]);
	});

	it("runs again when the bank, About you or the session logs changed", async () => {
		const h = await harness();
		await h.backup.run();

		h.bank.stats = { ...h.bank.stats, working: 3 };
		expect(await h.backup.run()).toEqual({ ok: true });
		expect(h.bank.snapshots).toBe(2);

		fs.writeFileSync(h.paths.aboutFile, "changed\n");
		expect(await h.backup.run()).toEqual({ ok: true });
		expect(h.bank.snapshots).toBe(3);

		writeSession(h, "new.jsonl", "x\n");
		expect(await h.backup.run()).toEqual({ ok: true });
		expect(h.bank.snapshots).toBe(4);

		expect(await h.backup.run()).toEqual({ ok: true, skipped: "unchanged" });
	});

	it("does not touch the recorded state or notify on a skip", async () => {
		const h = await harness();
		await h.backup.run();
		const before = structuredClone(h.state.read().backup);
		const notified = h.changes.length;
		h.clock.now += 3_600_000;
		await h.backup.run();
		expect(h.state.read().backup).toEqual(before);
		expect(h.changes).toHaveLength(notified);
	});
});

describe("recording and failures", () => {
	it("records a success and tells the devices the status changed", async () => {
		const h = await harness();
		await h.backup.run();
		const backup = h.state.read().backup;
		expect(backup.lastAt).toBe(h.clock.now);
		expect(backup.lastOk).toBe(true);
		expect(backup.lastError).toBeUndefined();
		expect(h.changes).toEqual([["status"]]);
		expect(h.alerts).toEqual([]);
	});

	it("fails with 'backup folder is missing' when neither the folder nor its parent exists", async () => {
		const h = await harness();
		h.setFolder(path.join(h.root, "unplugged", "drive", "backups"));
		const result = await h.backup.run();
		expect(result).toEqual({ ok: false, error: "backup folder is missing" });
		expect(h.state.read().backup.lastOk).toBe(false);
		expect(h.state.read().backup.lastError).toBe("backup folder is missing");
		expect(h.alerts).toEqual([{ title: "Backup failed", body: "backup folder is missing", tag: "personal-backup" }]);
		expect(fs.existsSync(path.join(h.root, "unplugged"))).toBe(false);
		expect(h.changes).toEqual([["status"]]);
	});

	it("creates the folder below an existing parent", async () => {
		const h = await harness();
		expect(fs.existsSync(h.folder)).toBe(false);
		expect(await h.backup.run()).toEqual({ ok: true });
		expect(fs.existsSync(path.join(h.folder, "omp-personal", "daily", "2026-10-14"))).toBe(true);
	});

	it("fails when the folder is a file", async () => {
		const h = await harness();
		fs.writeFileSync(h.folder, "x");
		const result = await h.backup.run();
		expect(result.ok).toBe(false);
		expect(result.error).toBe("backup folder is not a folder");
		expect(h.alerts).toHaveLength(1);
	});

	it("records a snapshot failure, leaves no half-written snapshot, and a forced run recovers", async () => {
		const h = await harness();
		h.bank.failWith = "disk full";
		expect(await h.backup.run()).toEqual({ ok: false, error: "disk full" });
		expect(h.state.read().backup).toMatchObject({ lastOk: false, lastError: "disk full" });
		expect(h.alerts).toEqual([{ title: "Backup failed", body: "disk full", tag: "personal-backup" }]);
		expect(names(path.join(base(h), "daily"))).toEqual([]);

		delete h.bank.failWith;
		expect(await h.backup.run({ force: true })).toEqual({ ok: true });
		const backup = h.state.read().backup;
		expect(backup.lastOk).toBe(true);
		expect(backup.lastError).toBeUndefined();
		expect(h.alerts).toHaveLength(1);
	});

	it("does not skip as unchanged after a failure", async () => {
		const h = await harness();
		await h.backup.run();
		h.clock.now = at(2026, 10, 15, 4);
		h.bank.failWith = "boom";
		await h.backup.run({ force: true });
		delete h.bank.failWith;
		expect(await h.backup.run()).toEqual({ ok: true });
	});

	it("keeps a failed backup's failure when the alert itself fails", async () => {
		const h = await harness();
		h.bank.failWith = "nope";
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const backup = createPersonalBackup({
				paths: h.paths,
				now: () => h.clock.now,
				settings: () => ({ ...defaultSettings(), backup: { folder: h.folder } }),
				state: h.state,
				openAdmin: () =>
					({
						dbPath: "",
						stats: () => h.bank.stats,
						snapshot: () => Promise.reject(new Error("nope")),
						close() {},
					}) as unknown as MemoryAdmin,
				alert: () => Promise.reject(new Error("push down")),
				changed: () => {},
			});
			expect(await backup.run()).toEqual({ ok: false, error: "nope" });
		} finally {
			console.error = original;
		}
		expect(errors).toHaveLength(1);
	});

	it("is single-flight", async () => {
		const h = await harness();
		expect(h.backup.running()).toBe(false);
		const first = h.backup.run();
		expect(h.backup.running()).toBe(true);
		const [a, b] = await Promise.all([first, h.backup.run()]);
		expect(a).toEqual(b);
		expect(h.bank.snapshots).toBe(1);
		expect(h.backup.running()).toBe(false);
	});
});

describe("tick", () => {
	it("does nothing before the backup time and creates nothing", async () => {
		const h = await harness();
		h.clock.now = at(2026, 10, 14, 2, 59);
		await h.backup.tick();
		expect(h.bank.opens).toEqual([]);
		expect(fs.existsSync(h.folder)).toBe(false);
		expect(fs.existsSync(h.paths.stateFile)).toBe(false);
	});

	it("runs once per local day, at or after the time", async () => {
		const h = await harness();
		h.clock.now = at(2026, 10, 14, 3, 0);
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(1);
		expect(h.state.read().backup.lastDay).toBe("2026-10-14");

		h.clock.now = at(2026, 10, 14, 15);
		h.bank.stats = { ...h.bank.stats, working: 4 };
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(1);

		h.clock.now = at(2026, 10, 15, 2, 59);
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(1);

		h.clock.now = at(2026, 10, 15, 9);
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(2);
		expect(h.state.read().backup.lastDay).toBe("2026-10-15");
		expect(names(path.join(base(h), "daily"))).toEqual(["2026-10-14", "2026-10-15"]);
	});

	it("tries a failed day once and then waits for the next day (or a forced run)", async () => {
		const h = await harness();
		h.bank.failWith = "no space";
		await h.backup.tick();
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(1);
		expect(h.alerts).toHaveLength(1);
		expect(h.state.read().backup).toMatchObject({ lastDay: "2026-10-14", lastOk: false });

		delete h.bank.failWith;
		h.clock.now = at(2026, 10, 15, 3, 1);
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(2);
		expect(h.state.read().backup).toMatchObject({ lastDay: "2026-10-15", lastOk: true });
	});

	it("runs once for concurrent ticks", async () => {
		const h = await harness();
		await Promise.all([h.backup.tick(), h.backup.tick(), h.backup.tick()]);
		expect(h.bank.snapshots).toBe(1);
	});

	it("records the day even when the due run is skipped as unchanged", async () => {
		const h = await harness();
		await h.backup.run();
		h.clock.now = at(2026, 10, 15, 3, 30);
		await h.backup.tick();
		expect(h.bank.snapshots).toBe(1);
		expect(h.state.read().backup.lastDay).toBe("2026-10-15");
	});
});

describe("status", () => {
	it("reports the folder, counts, last result and next time", async () => {
		const h = await harness();
		const before = await h.backup.status();
		expect(before).toMatchObject({ folder: h.folder, lastAt: null, lastOk: null, dailyKept: 0, monthlyKept: 0 });
		expect(before.lastError).toBeUndefined();
		expect(before.nextAt).toBe(at(2026, 10, 15, 3, 0));

		await h.backup.run();
		h.clock.now = at(2026, 10, 14, 1, 0);
		const after = await h.backup.status();
		expect(after).toMatchObject({ lastAt: at(2026, 10, 14, 3, 5), lastOk: true, dailyKept: 1, monthlyKept: 1 });
		expect(after.nextAt).toBe(at(2026, 10, 14, 3, 0));
	});

	it("reports the last error", async () => {
		const h = await harness();
		h.bank.failWith = "bad";
		await h.backup.run();
		expect(await h.backup.status()).toMatchObject({ lastOk: false, lastError: "bad" });
	});

	it("defaults to the profile's backups folder", async () => {
		const h = await harness();
		h.setFolder(null);
		expect((await h.backup.status()).folder).toBe(h.paths.backupsDir);
	});

	it("compares the disk of the folder (or its nearest existing ancestor) with the bank's", async () => {
		const h = await harness();
		expect((await h.backup.status()).sameDisk).toBe(true);
		h.setFolder(path.join(h.root, "does", "not", "exist"));
		expect((await h.backup.status()).sameDisk).toBe(true);
		h.setFolder("/dev/omp-personal-backup-test-never-created");
		expect((await h.backup.status()).sameDisk).toBe(fs.statSync("/dev").dev === fs.statSync(h.root).dev);
	});
});
