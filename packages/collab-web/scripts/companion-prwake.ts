/**
 * Polls the pull requests omp sessions on this computer asked to have watched (`watch_pr`, `/watch-pr`,
 * the app's "Watch this PR"), so one `gh` and one set of ETags serves every session and the sessions
 * themselves only read the answer. Each session publishes its watches as
 * `<config>/run/pr-watch/watches/<sessionId>.json`; this leaves its latest reading of each pull request in
 * `inbox/<sessionId>/` and a heartbeat in `companion.json`, which tells the sessions not to poll. The
 * session decides what a reading means (events, waking the agent, hourly caps; see the wire package's
 * `pr-watch`); the companion only pushes to the user's devices when a watched pull request merges or closes
 * (checks and reviews already reach them through the GitHub alerts).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	diffPr,
	fetchPrSnapshot,
	ghApiArgs,
	type PrApi,
	PrApiError,
	type PrChecksState,
	type PrPollCache,
	type PrSeen,
	parseGhApiResponse,
	parsePrWatchFile,
	newPrPollCache,
	prKey,
	rollupChecks,
} from "@oh-my-pi/pi-wire/pr-watch";
import { gh } from "./companion-gitflow";
import { pushTopic } from "./companion-prwatch";

/** Interval between readings of a pull request while its checks run. */
export const PR_WAKE_PENDING_MS = 60_000;
/** Interval between readings otherwise. */
export const PR_WAKE_IDLE_MS = 120_000;
/** A watch file nobody refreshed for this long belongs to a session that is gone. */
export const PR_WAKE_SESSION_STALE_MS = 3 * 60_000;
const GH_TIMEOUT_MS = 30_000;
/** The heartbeat is rewritten this often (sessions trust one for 90 seconds). */
const BEAT_MS = 15_000;
const MAX_FAILURE_DOUBLINGS = 4;
const MAX_TITLE_CHARS = 80;

export interface PrWakeAlert {
	title: string;
	body: string;
	url: string;
	tag: string;
	topic: string;
}

export interface PrWakeOptions {
	/** `<config>/run/pr-watch`. */
	dir: string;
	now(): number;
	/** Whether `gh` can read: without it no heartbeat is written, so sessions poll for themselves. */
	canRead(): boolean | Promise<boolean>;
	/** The REST client for a watch's folder. */
	api?(cwd: string): PrApi;
	alert(alert: PrWakeAlert): void;
	onError(err: unknown): void;
}

interface Watched {
	cache: PrPollCache;
	seen?: PrSeen;
	nextAt: number;
	failures: number;
	checks: PrChecksState;
}

/** {@link PrApi} over the signed-in `gh`. */
export function ghRestApi(cwd: string): PrApi {
	return async (endpoint, etag) => {
		const result = await gh(cwd, ghApiArgs(endpoint, etag), GH_TIMEOUT_MS);
		const response = parseGhApiResponse(result.out);
		if (response) return response;
		throw new PrApiError(result.err || `gh api ${endpoint} failed`, 0);
	};
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await Bun.file(file).text());
	} catch {
		return undefined;
	}
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	await Bun.write(temp, `${JSON.stringify(value)}\n`);
	await fs.rename(temp, file);
}

/** One round per call, never two at once; sleeps between readings of a pull request on its own clock. */
export function createPrWake(options: PrWakeOptions): { tick(): Promise<void> } {
	const watched: Record<string, Watched> = Object.create(null);
	const api = options.api ?? ghRestApi;
	let running = false;
	let lastBeat = Number.NEGATIVE_INFINITY;

	async function reading(
		sessionId: string,
		cwd: string,
		self: string | undefined,
		repo: string,
		number: number,
		since: string,
	): Promise<void> {
		const id = `${sessionId}/${prKey({ repo, number })}`;
		const now = options.now();
		const entry = (watched[id] ??= {
			cache: newPrPollCache(Date.parse(since)),
			nextAt: 0,
			failures: 0,
			checks: "none",
		});
		if (now < entry.nextAt) return;
		try {
			const snapshot = await fetchPrSnapshot(api(cwd), entry.cache, repo, number, now);
			entry.failures = 0;
			const { seen, events } = diffPr(entry.seen, snapshot, self);
			entry.seen = seen;
			entry.checks = rollupChecks(snapshot.checks);
			const inbox = path.join(
				options.dir,
				"inbox",
				sessionId,
				`${Bun.hash(prKey({ repo, number })).toString(36)}.json`,
			);
			await writeAtomic(inbox, { key: prKey({ repo, number }), at: now, snapshot });
			for (const event of events) {
				if (event.kind !== "merged" && event.kind !== "closed") continue;
				const tag = `prwake:${prKey({ repo, number })}:${event.kind}`;
				options.alert({
					title: `${prKey({ repo, number })} ${snapshot.title}`.slice(0, MAX_TITLE_CHARS),
					body: event.kind === "merged" ? "Merged" : "Closed without merging",
					url: snapshot.url,
					tag,
					topic: pushTopic(tag),
				});
			}
		} catch (err) {
			entry.failures += 1;
			if (!(err instanceof PrApiError)) options.onError(err);
		}
		const base = entry.checks === "pending" ? PR_WAKE_PENDING_MS : PR_WAKE_IDLE_MS;
		entry.nextAt = now + base * 2 ** Math.min(entry.failures, MAX_FAILURE_DOUBLINGS);
	}

	return {
		async tick() {
			if (running) return;
			running = true;
			try {
				if (!(await options.canRead())) return;
				const now = options.now();
				const live = new Set<string>();
				let names: string[] = [];
				try {
					names = await fs.readdir(path.join(options.dir, "watches"));
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				for (const name of names) {
					if (!name.endsWith(".json")) continue;
					const file = path.join(options.dir, "watches", name);
					const mtime = await fs.stat(file).then(
						stat => stat.mtimeMs,
						() => 0,
					);
					if (now - mtime > PR_WAKE_SESSION_STALE_MS) continue;
					const watch = parsePrWatchFile(await readJson(file));
					if (!watch) continue;
					for (const pr of watch.prs) {
						live.add(`${watch.sessionId}/${prKey(pr)}`);
						await reading(watch.sessionId, watch.cwd, watch.self, pr.repo, pr.number, pr.since);
					}
				}
				for (const id of Object.keys(watched)) if (!live.has(id)) delete watched[id];
				if (options.now() - lastBeat >= BEAT_MS) {
					lastBeat = options.now();
					await writeAtomic(path.join(options.dir, "companion.json"), { at: lastBeat, pid: process.pid });
				}
			} catch (err) {
				options.onError(err);
			} finally {
				running = false;
			}
		},
	};
}
