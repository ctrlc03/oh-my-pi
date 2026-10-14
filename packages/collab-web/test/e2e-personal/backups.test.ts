import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { describeE2e, realTime, SCENARIO_TIMEOUT_MS } from "./support";

const localDay = (ms: number): string => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const sha256 = async (file: string): Promise<string> =>
	createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");

async function walk(dir: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true }).catch(() => [])) {
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(dir, rel)));
		else out.push(rel);
	}
	return out;
}

interface Manifest {
	day: string;
	createdAt: number;
	rows: { working: number; episodic: number; invalid: number };
	files: Array<{ path: string; bytes: number; sha256: string }>;
	mirror: { files: number; copied: number };
}

/** Scenario 10: backups, daily snapshots with a manifest, the session mirror, pruning, a missing folder, and the app's Back up now. */
describeE2e("backups", () => {
	let h: PersonalHarness;
	let root: string;

	beforeAll(async () => {
		h = await PersonalHarness.start();
		await h.setUp("Sam, a baker.");
		await h.waitIdle();
		root = path.join(h.profile, "backups", "omp-personal");
		const guest = await h.openSession();
		await h.turn(guest, "Please remember that my oven runs hot.");
		await until(
			"the turn's retention",
			() => h.memoryRows("SELECT id FROM working_memory WHERE content LIKE '%oven%'").length > 0,
			{ timeoutMs: 60_000 },
		);
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const today = (): string => localDay(h.clockNow());

	/** Back up now; a scheduled backup that happens to be running answers "already running": try again. */
	async function backupNow(): Promise<{ ok: boolean; error?: string }> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await h.call({ t: "personal-backup-now" });
			} catch (err) {
				if (attempt > 20 || !/already running/.test(String(err))) throw err;
				await realTime(500);
			}
		}
	}

	async function manifestOf(day: string): Promise<Manifest> {
		return JSON.parse(await Bun.file(path.join(root, "daily", day, "manifest.json")).text()) as Manifest;
	}

	it(
		"makes a snapshot: databases that open with the same rows, a manifest whose checksums match, a session mirror",
		async () => {
			const result = await backupNow();
			expect(result).toMatchObject({ ok: true });
			const day = today();
			const manifest = await manifestOf(day);
			const live = h.memoryRows("SELECT COUNT(*) AS n FROM working_memory")[0]!.n;
			expect(manifest.rows.working).toBe(Number(live));
			expect(manifest.rows.working).toBeGreaterThan(0);

			const copyPath = path.join(root, "daily", day, "mnemopi", "mnemopi.db");
			const copy = new Database(copyPath, { readonly: true });
			try {
				expect((copy.query("SELECT COUNT(*) AS n FROM working_memory").get() as { n: number }).n).toBe(
					manifest.rows.working,
				);
			} finally {
				copy.close();
			}
			expect(manifest.files.length).toBeGreaterThanOrEqual(2);
			for (const file of manifest.files) {
				const full = path.join(root, "daily", day, file.path);
				expect((await fs.stat(full)).size).toBe(file.bytes);
				expect(await sha256(full)).toBe(file.sha256);
			}
			expect(manifest.files.map(f => f.path)).toContain(path.join("about", "AGENTS.md"));

			const mirrored = await walk(path.join(root, "sessions-mirror"));
			const sessions = await h.sessionFiles();
			expect(sessions.length).toBeGreaterThan(0);
			expect(mirrored.filter(rel => rel.endsWith(".jsonl")).map(rel => path.basename(rel))).toContain(
				path.basename(sessions[0]!),
			);
			expect(manifest.mirror.files).toBeGreaterThan(0);
			// The login never leaves the profile.
			expect((await walk(path.join(h.profile, "backups"))).filter(rel => /agent\.db/.test(rel))).toEqual([]);
			expect((await h.status()).backups).toMatchObject({ lastOk: true, dailyKept: 1 });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"Back up now ignores 'nothing changed' and writes a newer snapshot",
		async () => {
			const first = (await manifestOf(today())).createdAt;
			expect(await backupNow()).toMatchObject({ ok: true });
			expect((await manifestOf(today())).createdAt).toBeGreaterThan(first);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"keeps 30 daily snapshots and every month's first, and never touches the session mirror",
		async () => {
			const firstDay = today();
			const firstMonth = firstDay.slice(0, 7);
			const mirrorBefore = await walk(path.join(root, "sessions-mirror"));
			const mirrorStat = await fs.stat(path.join(root, "sessions-mirror", mirrorBefore[0]!));
			for (let i = 1; i <= 30; i++) {
				await h.advanceToNextDay();
				expect(await backupNow()).toMatchObject({ ok: true });
			}
			const dailies = (await fs.readdir(path.join(root, "daily"))).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
			expect(dailies).toHaveLength(30);
			expect(dailies).not.toContain(firstDay);
			expect(dailies).toContain(today());
			const monthlies = (await fs.readdir(path.join(root, "monthly"))).filter(name => /^\d{4}-\d{2}$/.test(name));
			expect(monthlies).toContain(firstMonth);
			expect(monthlies.length).toBeGreaterThanOrEqual(1);
			expect(await manifestOf(today())).toMatchObject({ day: today() });
			// The monthly snapshot is a full one.
			const monthly = JSON.parse(
				await Bun.file(path.join(root, "monthly", firstMonth, "manifest.json")).text(),
			) as Manifest;
			expect(monthly.files.length).toBeGreaterThanOrEqual(2);
			expect(await walk(path.join(root, "sessions-mirror"))).toEqual(mirrorBefore);
			expect((await fs.stat(path.join(root, "sessions-mirror", mirrorBefore[0]!))).size).toBeGreaterThanOrEqual(
				mirrorStat.size,
			);
			expect((await h.status()).backups).toMatchObject({ dailyKept: 30 });
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"alerts the owner when the backup folder is missing, and recovers when it is back",
		async () => {
			// Saving the setting creates the folder; the disk is then "unplugged" (its folder removed) before the next backup.
			const disk = path.join(h.home, "unplugged-disk");
			await h.call({ t: "personal-settings-set", patch: { backup: { folder: path.join(disk, "backups") } } });
			await fs.rm(disk, { recursive: true });
			const failed = await backupNow();
			expect(failed).toMatchObject({ ok: false });
			expect(failed.error).toMatch(/backup folder is missing/);
			expect((await h.status()).backups).toMatchObject({
				lastOk: false,
				lastError: expect.stringMatching(/missing/),
			});
			const { items } = await h.call({ t: "personal-inbox", includeDone: true });
			expect(items.filter(item => item.kind === "alert" && item.title === "Backup failed")).toHaveLength(1);

			await h.call({ t: "personal-settings-set", patch: { backup: { folder: null } } });
			expect(await backupNow()).toMatchObject({ ok: true });
			expect((await h.status()).backups).toMatchObject({ lastOk: true });
		},
		SCENARIO_TIMEOUT_MS,
	);
});
