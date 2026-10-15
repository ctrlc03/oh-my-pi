/**
 * The disk guard (docs/collab.md → Disk space). Every few minutes the companion reads the free space of the volumes
 * holding its worktrees folders and the user's home. Below the limit the user set it warns the devices once (and again
 * only after free space recovered to the limit plus a margin), and — when the user turned it on — deletes rebuildable
 * build output in the worktrees it made, biggest first, until free space is back above the limit plus the margin.
 * The same cleaning is there on demand (*Clean now*), whether or not auto-clean is on.
 *
 * Why it exists: the settle cleanup (./companion-settle) only runs when a session settles, so a session that sat idle
 * for days beside a 90 GB `target/` was never cleaned. This runs on the clock instead, and looks at the disk.
 *
 * A worktree is left alone while a session works in it (host state not idle), while any process has it as its folder or
 * holds a file in it (language servers excepted; see ./companion-disk-fs), and — automatically — for `idleHours` after its
 * session was last active. A sandboxed session is no reason to skip one: the settle cleanup stays out of those worktrees
 * because a sandboxed agent can write the files a *command* runs (package.json scripts, a Makefile), but deleting
 * `target/` or `node_modules/` runs nothing from the repository — it is `rm -rf` of folders the guard itself found, never
 * following a symlink — and a sandboxed session that is working there is busy anyway.
 *
 * A manual clean may override "used recently" (the person picked it) but never "busy".
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DISK_ROUTE,
	type DiskArtifactKind,
	type DiskCandidate,
	type DiskClean,
	type DiskGuardSettings,
	type DiskHealth,
	type DiskReply,
	type DiskState,
	type DiskVolume,
	diskMarginBytes,
} from "@oh-my-pi/pi-wire/disk";
import {
	ARTIFACT_NAMES,
	busyBySession,
	type DiskSession,
	findArtifacts,
	type FreeSpace,
	gitActivity,
	listWorktrees,
	measureAll,
	measureBytes,
	newestChange,
	type ProcessProbe,
	probeProcesses,
	readFreeSpace,
	removeArtifact,
	toArtifacts,
	worktreeNames,
} from "./companion-disk-fs";
import {
	type DiskReading,
	limitBytes,
	lowestVolume,
	nextAlerts,
	parseDiskSettings,
	planClean,
} from "./companion-disk-plan";

/** How often free space is read: a read costs microseconds, so this is about how fast a disk can fill, not about cost. */
export const DISK_CHECK_INTERVAL_MS = 3 * 60_000;
/** After an auto-clean that found nothing it could delete, the next scan waits this long (scans cost disk reads). */
const AUTO_RETRY_MS = 10 * 60_000;
/** Size scans of one scan stop measuring after this long altogether; the rest are reported as "not measured". */
const SCAN_BUDGET_MS = 120_000;
const MAX_CLEANS = 100;
const MAX_PICKED = 50;
const HOUR_MS = 3_600_000;
const ROUND_BYTES = 100_000_000;
const SCAN_CONCURRENCY = 4;

export interface DiskFile {
	settings: DiskGuardSettings;
	/** Newest first. */
	cleans: DiskClean[];
	/** Volumes (by device) that already warned and have not recovered; see `nextAlerts`. */
	alerted: string[];
}

function parseClean(raw: unknown): DiskClean | null {
	const c = raw as Record<string, unknown> | null;
	if (typeof c !== "object" || c === null) return null;
	const kinds = Array.isArray(c.kinds)
		? c.kinds.filter(
				(kind): kind is DiskArtifactKind =>
					typeof kind === "string" && ARTIFACT_NAMES.includes(kind as DiskArtifactKind),
			)
		: [];
	if (
		typeof c.path !== "string" ||
		!path.isAbsolute(c.path) ||
		typeof c.repo !== "string" ||
		typeof c.name !== "string" ||
		typeof c.bytes !== "number" ||
		!Number.isFinite(c.bytes) ||
		c.bytes < 0 ||
		(c.trigger !== "auto" && c.trigger !== "manual") ||
		(c.freeBeforeBytes !== null && typeof c.freeBeforeBytes !== "number") ||
		typeof c.limitBytes !== "number" ||
		typeof c.at !== "number"
	)
		return null;
	return {
		path: c.path,
		repo: c.repo,
		name: c.name,
		kinds,
		bytes: c.bytes,
		trigger: c.trigger,
		freeBeforeBytes: c.freeBeforeBytes,
		limitBytes: c.limitBytes,
		at: c.at,
		...(typeof c.error === "string" ? { error: c.error } : {}),
	};
}

export function parseDiskFile(raw: unknown): DiskFile {
	const file = (typeof raw === "object" && raw !== null ? raw : {}) as {
		settings?: unknown;
		cleans?: unknown;
		alerted?: unknown;
	};
	return {
		settings: parseDiskSettings(file.settings, false),
		cleans: (Array.isArray(file.cleans) ? file.cleans : [])
			.flatMap(clean => parseClean(clean) ?? [])
			.slice(0, MAX_CLEANS),
		alerted: (Array.isArray(file.alerted) ? file.alerted : []).filter(
			(key): key is string => typeof key === "string",
		),
	};
}

export async function loadDiskFile(file: string): Promise<DiskFile> {
	try {
		return parseDiskFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return parseDiskFile(null);
	}
}

export async function saveDiskFile(file: string, contents: DiskFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

/** What a device is told when a volume runs low. */
export interface DiskNotice {
	title: string;
	body: string;
	tag: string;
	/** The route the notification opens (see src/lib/notify-route.ts). */
	open: string;
}

export interface DiskGuardOptions {
	/** What the guard remembers across restarts (the settings, the cleans, who warned). */
	initial: DiskFile;
	save(file: DiskFile): Promise<void>;
	/** The computer's name, for the notification. */
	machine: string;
	home: string;
	/** Every folder worktrees may live under (the current one, the default, past ones). */
	dirs(): string[];
	/** The open sessions, from a fresh listing: a failing listing stops a clean (nothing is deleted unchecked). */
	sessions(): Promise<readonly DiskSession[]>;
	/** Ids of the sessions the companion ran in this worktree, ended ones included. */
	sessionsIn(tree: string): readonly string[];
	/** When the session was last seen working (ms); undefined when unknown. */
	activity(sessionId: string): number | undefined;
	/** Processes the companion lists apart (itself, omp sessions): their state comes from `sessions` instead. */
	ignorePids(): ReadonlySet<number>;
	alert(notice: DiskNotice): void;
	/** Free space, or the warning, changed: the `hosts` frame should be sent again. */
	onChange(): void;
	onError(err: unknown): void;
	now?: () => number;
	intervalMs?: number;
	readFree?: (folder: string) => Promise<FreeSpace | null>;
	probe?: ProcessProbe;
	measure?: (dir: string) => Promise<number | null>;
}

/** What a `disk-scan` answers, less the frame's `t` and `reqId`. */
export type DiskScan = Omit<Extract<DiskReply, { t: "disk-scan" }>, "t" | "reqId">;
export type DiskCleaned = Omit<Extract<DiskReply, { t: "disk-clean" }>, "t" | "reqId">;

export interface DiskGuard {
	/** Start the clock: a first check soon, then one every {@link DISK_CHECK_INTERVAL_MS}. */
	start(): void;
	stop(): void;
	/** Read the volumes, warn if one just ran low, and auto-clean if that is on. One at a time. */
	check(): Promise<void>;
	/** The settings, the volumes as they are now and the recent cleans. */
	state(): Promise<DiskState>;
	/** @throws Error naming the invalid field. */
	setSettings(raw: unknown): Promise<DiskState>;
	scan(): Promise<DiskScan>;
	clean(paths: readonly string[]): Promise<DiskCleaned>;
	/** A watched volume is below the limit, as of the last read; null otherwise. */
	health(): DiskHealth | null;
}

interface Volume {
	key: string;
	path: string;
	worktrees: boolean;
	home: boolean;
	freeBytes: number;
	totalBytes: number;
}

/** A scanned worktree, with the device it is on. */
interface Scanned extends DiskCandidate {
	dev: string;
}

const holdsOf = (volume: Pick<Volume, "worktrees" | "home">): DiskVolume["holds"] =>
	volume.worktrees && volume.home ? "worktrees-and-home" : volume.worktrees ? "worktrees" : "home";

const HOLDS_TEXT: Record<DiskVolume["holds"], string> = {
	worktrees: "Worktrees",
	home: "Home folder",
	"worktrees-and-home": "Worktrees and home folder",
};

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB`;

/** Runs `work` over `items`, `size` at a time, keeping the order. */
async function mapPool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const out = Array.from<R>({ length: items.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let at = next++; at < items.length; at = next++) out[at] = await work(items[at]!);
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
	return out;
}

export function createDiskGuard(options: DiskGuardOptions): DiskGuard {
	const now = options.now ?? Date.now;
	const readFree = options.readFree ?? readFreeSpace;
	const probe = options.probe ?? probeProcesses;
	const measure = options.measure ?? ((dir: string) => measureBytes(dir));
	let file = options.initial;
	let volumes: Volume[] = [];
	let checkedAt = 0;
	let lastAutoAt = 0;
	let healthKey = "";
	let timers: Timer[] = [];
	let saving: Promise<void> = Promise.resolve();
	let checking: Promise<void> | null = null;
	let chain: Promise<unknown> = Promise.resolve();

	const persist = (): Promise<void> => {
		const snapshot = file;
		saving = saving.catch(() => {}).then(() => options.save(snapshot));
		return saving;
	};

	/** One at a time: a scan must not measure what a clean is deleting. */
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const result = chain.then(work);
		chain = result.catch(() => {});
		return result;
	};

	const readVolumes = async (): Promise<Volume[]> => {
		const targets = [...options.dirs().map(dir => ({ dir, home: false })), { dir: options.home, home: true }];
		const reads = await Promise.all(targets.map(async target => ({ target, space: await readFree(target.dir) })));
		const byKey = new Map<string, Volume>();
		for (const { target, space } of reads) {
			if (space === null) continue;
			const known = byKey.get(space.key);
			if (known === undefined)
				byKey.set(space.key, {
					key: space.key,
					path: target.dir,
					worktrees: !target.home,
					home: target.home,
					freeBytes: space.freeBytes,
					totalBytes: space.totalBytes,
				});
			else {
				known.worktrees ||= !target.home;
				known.home ||= target.home;
				// Worktrees are what the guard can clean: name that folder.
				if (!target.home && known.path === options.home) known.path = target.dir;
			}
		}
		volumes = [...byKey.values()];
		checkedAt = now();
		return volumes;
	};

	const exported = (): DiskVolume[] => {
		const limit = limitBytes(file.settings);
		return volumes.map(volume => ({
			path: volume.path,
			holds: holdsOf(volume),
			freeBytes: volume.freeBytes,
			totalBytes: volume.totalBytes,
			low: volume.freeBytes < limit,
		}));
	};

	const health = (): DiskHealth | null => {
		const lowest = lowestVolume(exported());
		if (lowest === null) return null;
		return {
			path: lowest.path,
			freeBytes: Math.floor(lowest.freeBytes / ROUND_BYTES) * ROUND_BYTES,
			limitBytes: limitBytes(file.settings),
		};
	};

	/** Tell the `hosts` frame when the warning appeared, went away or moved by a visible amount. */
	const announce = (): void => {
		const next = JSON.stringify(health());
		if (next === healthKey) return;
		healthKey = next;
		options.onChange();
	};

	const readings = (): DiskReading[] => volumes.map(v => ({ key: v.key, path: v.path, freeBytes: v.freeBytes }));

	/** Warn for volumes that just ran low; arm again those that recovered. Persists before telling anyone. */
	const warn = async (): Promise<void> => {
		const limit = limitBytes(file.settings);
		const { alerted, fresh } = nextAlerts(file.alerted, readings(), limit, diskMarginBytes(limit));
		if (alerted.join("\n") !== file.alerted.join("\n")) {
			file = { ...file, alerted };
			await persist();
		}
		if (fresh.length === 0) return;
		const where = (key: string): string =>
			HOLDS_TEXT[holdsOf(volumes.find(v => v.key === key) ?? { worktrees: false, home: true })];
		options.alert({
			title: `${options.machine} is low on disk space`,
			body: `${fresh.map(v => `${where(v.key)}: ${gb(v.freeBytes)} free`).join(" · ")} (limit ${file.settings.limitGb} GB). Tap to review.`,
			tag: "disk-low",
			open: DISK_ROUTE,
		});
	};

	// ── scanning ──

	const sessionsResolved = async (): Promise<DiskSession[]> =>
		Promise.all(
			(await options.sessions()).map(async session => ({
				...session,
				cwd: await fs.realpath(session.cwd).catch(() => session.cwd),
			})),
		);

	/** `measureSizes` false: only the busy and recent state is wanted (a look just before deleting), not the bytes. */
	const scanTrees = async (trees: readonly string[], measureSizes = true): Promise<Scanned[]> => {
		const startedAt = now();
		const sessions = await sessionsResolved();
		const found = (
			await mapPool(trees, SCAN_CONCURRENCY, async tree => ({ tree, found: await findArtifacts(tree) }))
		).filter(item => item.found.length > 0);
		const sizes = measureSizes
			? await measureAll(
					found.flatMap(item => item.found.map(artifact => artifact.path)),
					{ measure, startedAt, budgetMs: SCAN_BUDGET_MS, now },
				)
			: new Map<string, number | null>();
		const roots = found.map(item => item.tree);
		const bySession = busyBySession(roots, sessions);
		const hits = await probe(roots, options.ignorePids());
		const idleMs = file.settings.idleHours * HOUR_MS;
		return mapPool(found, SCAN_CONCURRENCY, async ({ tree, found: artifactsFound }): Promise<Scanned> => {
			const artifacts = toArtifacts(artifactsFound, sizes);
			const inside = sessions.filter(
				session => session.cwd === tree || session.cwd.startsWith(`${tree}${path.sep}`),
			);
			const ids = new Set([...inside.map(session => session.sessionId), ...options.sessionsIn(tree)]);
			const times = [
				await gitActivity(tree),
				...[...ids].map(id => options.activity(id) ?? 0),
				...(await Promise.all(artifacts.map(artifact => newestChange(artifact.path)))),
			];
			const idle = Math.max(0, now() - Math.max(...times));
			let skip: DiskCandidate["skip"] = null;
			let why: string | null = null;
			const hit = hits?.get(tree);
			if (bySession.has(tree)) [skip, why] = ["busy", bySession.get(tree)!];
			else if (hits === null) [skip, why] = ["busy", "the running processes could not be checked"];
			else if (hit !== undefined) [skip, why] = ["busy", `${hit.name} (pid ${hit.pid}) runs in it`];
			else if (idle < idleMs) [skip, why] = ["recent", `used within the last ${file.settings.idleHours} h`];
			const sized = artifacts.every(artifact => artifact.bytes !== null);
			return {
				path: tree,
				...worktreeNames(tree),
				artifacts,
				bytes: artifacts.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0),
				sized,
				idleMs: idle,
				skip,
				why,
				dev: String((await fs.stat(tree)).dev),
			};
		});
	};

	const scanAll = async (): Promise<Scanned[]> => scanTrees(await listWorktrees(options.dirs()));

	// ── cleaning ──

	const record = async (entry: DiskClean): Promise<void> => {
		file = { ...file, cleans: [entry, ...file.cleans].slice(0, MAX_CLEANS) };
		await persist();
	};

	/** Delete the build output of one scanned worktree (found again just now: only what is still an artifact goes). Null when nothing was there. */
	const cleanTree = async (
		tree: Scanned,
		trigger: DiskClean["trigger"],
		freeBefore: number | null,
	): Promise<DiskClean | null> => {
		const found = await findArtifacts(tree.path);
		if (found.length === 0) return null;
		const sizes = new Map(tree.artifacts.map(artifact => [artifact.path, artifact.bytes]));
		const kinds: DiskArtifactKind[] = [];
		const errors: string[] = [];
		let bytes = 0;
		let unmeasured = false;
		for (const artifact of found) {
			try {
				await removeArtifact(options.dirs(), artifact.path);
				if (!kinds.includes(artifact.kind)) kinds.push(artifact.kind);
				const size = sizes.get(artifact.path) ?? null;
				if (size === null) unmeasured = true;
				else bytes += size;
			} catch (err) {
				errors.push(`${artifact.kind}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (unmeasured && freeBefore !== null) {
			const after = await readFree(tree.path);
			if (after !== null) bytes += Math.max(0, after.freeBytes - freeBefore - bytes);
		}
		const entry: DiskClean = {
			path: tree.path,
			repo: tree.repo,
			name: tree.name,
			kinds,
			bytes,
			trigger,
			freeBeforeBytes: freeBefore,
			limitBytes: limitBytes(file.settings),
			at: now(),
			...(errors.length > 0 ? { error: errors.join("; ") } : {}),
		};
		await record(entry);
		return entry;
	};

	/** The worktree as it is now: a clean never acts on what a scan saw minutes ago. */
	const rescan = async (tree: Scanned): Promise<Scanned | null> => (await scanTrees([tree.path], false))[0] ?? null;

	const autoClean = async (): Promise<void> => {
		const limit = limitBytes(file.settings);
		const margin = diskMarginBytes(limit);
		const low = volumes.filter(volume => volume.worktrees && volume.freeBytes < limit);
		if (low.length === 0) return;
		const scanned = await scanAll();
		for (const volume of low) {
			const mine = scanned.filter(tree => tree.dev === volume.key);
			const plan = planClean({
				freeBytes: volume.freeBytes,
				limitBytes: limit,
				marginBytes: margin,
				idleHours: file.settings.idleHours,
				candidates: mine.map(tree => ({
					path: tree.path,
					bytes: tree.sized ? tree.bytes : null,
					idleMs: tree.idleMs,
					busy: tree.skip === "busy",
				})),
			});
			for (const item of plan.clean) {
				const space = await readFree(volume.path);
				if (space !== null && space.freeBytes >= plan.targetBytes) break;
				const tree = mine.find(candidate => candidate.path === item.path);
				const again = tree === undefined ? null : await rescan(tree);
				// Looked at again just before deleting: it may have become busy or been used since the scan.
				if (tree === undefined || again === null || again.skip !== null) continue;
				await cleanTree(tree, "auto", space?.freeBytes ?? null);
			}
		}
	};

	const doCheck = async (): Promise<void> => {
		await readVolumes();
		await warn();
		announce();
		const limit = limitBytes(file.settings);
		const wants = file.settings.autoClean && volumes.some(volume => volume.worktrees && volume.freeBytes < limit);
		if (!wants || now() - lastAutoAt < AUTO_RETRY_MS) return;
		lastAutoAt = now();
		await exclusive(autoClean);
		await readVolumes();
		await warn();
		announce();
	};

	const check = (): Promise<void> => {
		checking ??= doCheck().finally(() => {
			checking = null;
		});
		return checking;
	};

	const snapshot = (): DiskState => ({
		settings: file.settings,
		volumes: exported(),
		limitBytes: limitBytes(file.settings),
		marginBytes: diskMarginBytes(limitBytes(file.settings)),
		cleans: file.cleans,
		checkedAt,
	});

	return {
		start() {
			if (timers.length > 0) return;
			const tick = (): void => void check().catch(err => options.onError(err));
			timers = [setTimeout(tick, 10_000), setInterval(tick, options.intervalMs ?? DISK_CHECK_INTERVAL_MS)];
			for (const timer of timers) timer.unref();
		},
		stop() {
			for (const timer of timers) clearTimeout(timer);
			timers = [];
		},
		check,
		async state() {
			await readVolumes();
			announce();
			return snapshot();
		},
		async setSettings(raw) {
			const settings = parseDiskSettings(raw, true);
			file = { ...file, settings };
			await persist();
			// The new limit may already be crossed: look now, without making this answer wait for a clean.
			void check().catch(err => options.onError(err));
			await readVolumes();
			announce();
			return snapshot();
		},
		scan: () =>
			exclusive(async () => {
				const scanned = await scanAll();
				await readVolumes();
				const candidates = scanned
					.map(({ dev: _dev, ...candidate }) => candidate)
					.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
				return { candidates, volumes: exported(), scannedAt: now() };
			}),
		clean: paths =>
			exclusive(async () => {
				const cleans: DiskClean[] = [];
				const refused: { path: string; reason: string }[] = [];
				const known = new Set(await listWorktrees(options.dirs()));
				for (const picked of [...new Set(paths)].slice(0, MAX_PICKED)) {
					const tree =
						typeof picked === "string" && path.isAbsolute(picked)
							? await fs.realpath(picked).catch(() => null)
							: null;
					if (tree === null || !known.has(tree)) {
						refused.push({ path: String(picked), reason: "not a worktree the companion made" });
						continue;
					}
					const scanned = (await scanTrees([tree]))[0];
					if (scanned === undefined) {
						refused.push({ path: tree, reason: "no build output left to clean" });
						continue;
					}
					if (scanned.skip === "busy") {
						refused.push({ path: tree, reason: scanned.why ?? "busy" });
						continue;
					}
					const space = await readFree(tree);
					const entry = await cleanTree(scanned, "manual", space?.freeBytes ?? null);
					if (entry === null) refused.push({ path: tree, reason: "no build output left to clean" });
					else cleans.push(entry);
				}
				await readVolumes();
				await warn();
				announce();
				return { cleans, refused, volumes: exported() };
			}),
		health,
	};
}
