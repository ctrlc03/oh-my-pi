/**
 * Scheduled runs: prompts the companion starts on a timetable by launching a
 * hosted omp session (see ./companion-start: `omp "<prompt>"` in tmux), so the
 * agent starts working at once and the app opens the session later like any
 * other. Everything here is pure or takes its effects as options, so the
 * timing, missed-run and spend rules are testable without a clock or omp.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	MAX_SCHEDULE_COST_USD,
	MAX_SCHEDULE_PROMPT_CHARS,
	MAX_SCHEDULE_TITLE_CHARS,
	nextRunAfter,
	parseScheduleWhen,
	type Schedule,
	type ScheduleInput,
	type ScheduleRun,
	type ScheduleWhen,
} from "@oh-my-pi/pi-wire/schedule";
import { SAFE_ID_RE } from "./companion-sessions";

/** Under the `skip` policy, a run missed while the computer slept still happens when it wakes within this long; later ones are only recorded. */
export const MISSED_GRACE_MS = 60 * 60 * 1000;
export const MAX_SCHEDULES = 50;
const MAX_CWD_CHARS = 4096;

/**
 * `run`: due, and either not too late to be worth running or the schedule catches up (`run-once`);
 * `missed`: due long ago under `skip` (the computer was off or asleep).
 */
export function dueState(schedule: Schedule, now: number): "run" | "missed" | null {
	if (!schedule.enabled || schedule.nextRun === null || now < schedule.nextRun) return null;
	if (schedule.catchUp === "run-once") return "run";
	return now - schedule.nextRun <= MISSED_GRACE_MS ? "run" : "missed";
}

function optionalFlag(value: unknown, name: string): true | undefined {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`invalid ${name}`);
	return value === true ? true : undefined;
}

/** The fields every schedule carries, checked for shape only (not against the disk, the clock or the platform). */
function parseFields(raw: unknown): ScheduleInput {
	const given = raw as Partial<Record<keyof ScheduleInput, unknown>> | null;
	if (typeof given !== "object" || given === null) throw new Error("invalid schedule");
	if (given.deliverTo !== undefined && given.deliverTo !== "personal") throw new Error("invalid delivery");
	// A schedule for the Personal agent starts no process: where, how and at what cost are not part of it.
	const input: Partial<Record<keyof ScheduleInput, unknown>> =
		given.deliverTo === "personal"
			? {
					...given,
					cwd: path.sep,
					mode: "new",
					sessionId: undefined,
					worktree: undefined,
					sandboxed: undefined,
					maxCostUsd: undefined,
				}
			: given;
	if (input.id !== undefined && (typeof input.id !== "string" || !SAFE_ID_RE.test(input.id)))
		throw new Error("invalid schedule id");
	if (typeof input.prompt !== "string" || input.prompt.includes("\0")) throw new Error("invalid prompt");
	const prompt = input.prompt.trim();
	if (prompt === "") throw new Error("the prompt is empty");
	if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS)
		throw new Error(`the prompt is over ${MAX_SCHEDULE_PROMPT_CHARS} characters`);
	if (input.title !== undefined && typeof input.title !== "string") throw new Error("invalid title");
	const title =
		(input.title ?? "").trim() || (prompt.split("\n").find(line => line.trim() !== "") ?? "").trim().slice(0, 60);
	if (title.length > MAX_SCHEDULE_TITLE_CHARS)
		throw new Error(`the title is over ${MAX_SCHEDULE_TITLE_CHARS} characters`);
	if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || input.cwd.includes("\0"))
		throw new Error("folder must be an absolute path");
	if (input.cwd.length > MAX_CWD_CHARS) throw new Error("folder path is too long");
	if (input.mode !== "new" && input.mode !== "resume") throw new Error("invalid mode");
	const worktree = optionalFlag(input.worktree, "worktree");
	const sandboxed = optionalFlag(input.sandboxed, "sandboxed");
	let sessionId: string | undefined;
	if (input.mode === "resume") {
		if (typeof input.sessionId !== "string" || !SAFE_ID_RE.test(input.sessionId))
			throw new Error("pick the session to resume");
		if (worktree) throw new Error("a worktree needs a new session, not a resumed one");
		sessionId = input.sessionId;
	} else if (input.sessionId !== undefined) {
		throw new Error("only a resumed run names a session");
	}
	if (input.maxCostUsd !== undefined) {
		if (
			typeof input.maxCostUsd !== "number" ||
			!Number.isFinite(input.maxCostUsd) ||
			input.maxCostUsd <= 0 ||
			input.maxCostUsd > MAX_SCHEDULE_COST_USD
		)
			throw new Error(`the spend limit must be between $0 and $${MAX_SCHEDULE_COST_USD}`);
		if (input.mode === "resume")
			throw new Error("a spend limit needs a new session: a resumed session's cap counts all it has spent");
	}
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("invalid enabled");
	if (input.catchUp !== undefined && input.catchUp !== "skip" && input.catchUp !== "run-once")
		throw new Error("catch-up must be skip or run-once");
	if (input.createdBy !== undefined && input.createdBy !== "agent") throw new Error("invalid creator");
	return {
		id: input.id,
		title,
		prompt,
		cwd: path.normalize(input.cwd),
		mode: input.mode,
		sessionId,
		worktree,
		sandboxed,
		maxCostUsd: input.maxCostUsd,
		when: parseScheduleWhen(input.when),
		catchUp: input.catchUp === "run-once" ? "run-once" : undefined,
		createdBy: input.createdBy,
		deliverTo: given.deliverTo === "personal" ? "personal" : undefined,
		enabled: input.enabled !== false,
	};
}

/** Same refusals as starting omp there would give, so a bad folder fails when saved rather than at 03:00. */
export async function checkDirectory(dir: string): Promise<void> {
	try {
		if (!(await fs.stat(await fs.realpath(dir))).isDirectory()) throw new Error("not a directory");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES")
			throw new Error(
				"macOS blocked the companion from this folder: allow bun under System Settings → Privacy & Security → Files and Folders, then restart the companion",
			);
		throw new Error("folder does not exist on this computer");
	}
}

export interface ValidateDeps {
	now(): number;
	sandboxAvailable: boolean;
	checkDirectory(dir: string): Promise<void>;
	/** The Personal agent is set up and on, on this computer: only then is a schedule for it accepted. Absent: never. */
	personalEnabled?(): boolean;
}

/** @throws Error with a message fit for the app when `raw` is not a schedule the companion can run. */
export async function parseScheduleInput(raw: unknown, deps: ValidateDeps): Promise<ScheduleInput> {
	const input = parseFields(raw);
	if (input.deliverTo === "personal") {
		if (deps.personalEnabled?.() !== true) throw new Error("the Personal agent is not turned on on this computer");
	} else if (input.sandboxed && !deps.sandboxAvailable) {
		throw new Error("sandboxed sessions need macOS sandbox-exec");
	}
	if (input.enabled && input.when.kind === "once" && input.when.at <= deps.now())
		throw new Error("that date and time has already passed");
	if (input.deliverTo !== "personal") await deps.checkDirectory(input.cwd);
	return input;
}

/** The persisted file: damaged entries are dropped, and a missing `nextRun` of an enabled schedule is recomputed. */
export function parseSchedules(raw: unknown, now: number): Schedule[] {
	const stored = (raw as { schedules?: unknown } | null)?.schedules;
	if (!Array.isArray(stored)) return [];
	const out: Schedule[] = [];
	for (const entry of stored.slice(0, MAX_SCHEDULES)) {
		let input: ScheduleInput;
		try {
			input = parseFields(entry);
		} catch {
			continue;
		}
		if (input.id === undefined) continue;
		const { lastRun, nextRun } = entry as { lastRun?: Partial<ScheduleRun> | null; nextRun?: unknown };
		const last: ScheduleRun | undefined =
			typeof lastRun?.at === "number"
				? {
						at: lastRun.at,
						instanceId: typeof lastRun.instanceId === "string" ? lastRun.instanceId : undefined,
						error: typeof lastRun.error === "string" ? lastRun.error : undefined,
						missedAt: typeof lastRun.missedAt === "number" ? lastRun.missedAt : undefined,
					}
				: undefined;
		out.push({
			...input,
			id: input.id,
			lastRun: last,
			nextRun: !input.enabled ? null : typeof nextRun === "number" ? nextRun : nextRunAfter(input.when, now),
		});
	}
	return out;
}

export async function loadSchedules(file: string, now: number): Promise<Schedule[]> {
	try {
		return parseSchedules(JSON.parse(await Bun.file(file).text()), now);
	} catch {
		return [];
	}
}

/** Written whole through a temporary file, so a crash never leaves half a list. */
export async function saveSchedules(file: string, schedules: Schedule[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify({ schedules }, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(tmp, 0o600);
	await fs.rename(tmp, file);
}

export interface ScheduleNotice {
	title: string;
	body: string;
	/** The started session, opened by tapping the notification. */
	instanceId?: string;
	tag: string;
}

export interface SchedulerOptions {
	now(): number;
	/** The persisted list at startup. */
	initial: Schedule[];
	save(schedules: Schedule[]): Promise<void>;
	/** Launch the session and resolve with its instance id once it hosts; rejects with a readable message. */
	start(schedule: Schedule): Promise<string | undefined>;
	/** Whether today's spend has reached the daily limit the user set (false when none is set). Rejects when it cannot tell. */
	spendLimitReached(): Promise<boolean>;
	/** Re-read the session list, which is stale while no device watches; awaited before `isWorking` is asked. */
	refreshSessions(): Promise<void>;
	/** Whether the session an earlier run started is still working. */
	isWorking(instanceId: string): boolean;
	notify(notice: ScheduleNotice): void;
	onError(err: unknown): void;
}

export interface Scheduler {
	list(): Schedule[];
	/** Create (no `input.id`) or replace a schedule; resolves with it as stored. */
	save(input: ScheduleInput): Promise<Schedule>;
	remove(id: string): Promise<void>;
	/** Start the schedule's session now, whatever its timetable says; rejects with why when it did not start. */
	runNow(id: string): Promise<Schedule>;
	/** Start what is due, record what was missed. Cheap enough for every poll. */
	tick(): Promise<void>;
	/** Some schedule will fire: the companion must keep watching the clock. */
	hasUpcoming(): boolean;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function stamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Owns the schedule list. A trigger moves `nextRun` on (and persists it) before anything is started, so a
 * crash mid-start never fires the same slot twice, and a schedule never has two starts in flight.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
	let schedules = [...options.initial];
	const starting: Record<string, true> = {};
	let writing: Promise<void> = Promise.resolve();

	const persist = (): Promise<void> => {
		writing = writing.catch(() => {}).then(() => options.save(schedules));
		return writing;
	};
	const find = (id: string): Schedule | undefined => schedules.find(s => s.id === id);
	const replace = (next: Schedule): void => {
		schedules = schedules.map(s => (s.id === next.id ? next : s));
	};
	/** Record a result against the stored copy (the user may have edited the schedule meanwhile). */
	const record = async (id: string, lastRun: ScheduleRun): Promise<Schedule | undefined> => {
		const current = find(id);
		if (!current) return undefined;
		const next = { ...current, lastRun };
		replace(next);
		await persist();
		return next;
	};

	const skipReason = async (schedule: Schedule): Promise<string | null> => {
		// Delivered to the Personal agent, a firing is an event that waits for the session to be idle, and its own limits apply to it.
		if (schedule.deliverTo === "personal") return null;
		if (schedule.lastRun?.instanceId !== undefined) {
			try {
				await options.refreshSessions();
			} catch (err) {
				options.onError(err);
				return "could not check whether the previous run is still working";
			}
			if (options.isWorking(schedule.lastRun.instanceId)) return "previous run is still working";
		}
		try {
			return (await options.spendLimitReached()) ? "daily spend limit" : null;
		} catch (err) {
			options.onError(err);
			return "could not check the daily spend limit";
		}
	};

	const trigger = async (id: string, manual: boolean): Promise<Schedule> => {
		const found = find(id);
		if (!found) throw new Error("no such schedule");
		if (Object.hasOwn(starting, id)) throw new Error("this schedule is already starting");
		starting[id] = true;
		try {
			const now = options.now();
			// A slot long past is only started because the schedule catches up.
			const caughtUp =
				!manual && found.nextRun !== null && now - found.nextRun > MISSED_GRACE_MS ? found.nextRun : undefined;
			// Claim the slot first (see above). A manual run leaves a repeating schedule's timetable alone.
			const once = found.when.kind === "once";
			const claimed: Schedule =
				manual && !once
					? found
					: {
							...found,
							nextRun: once ? null : nextRunAfter(found.when, now),
							enabled: once ? false : found.enabled,
						};
			replace(claimed);
			await persist();
			const skip = await skipReason(claimed);
			if (skip !== null) {
				await record(id, { at: now, error: `skipped: ${skip}` });
				throw new Error(`Not started: ${skip}`);
			}
			try {
				const instanceId = await options.start(claimed);
				if (claimed.deliverTo !== "personal")
					options.notify({
						title: `Scheduled: ${claimed.title} ${caughtUp === undefined ? "started" : "started (caught up)"}`,
						body: `Working in ${path.basename(claimed.cwd) || claimed.cwd}`,
						instanceId,
						tag: `schedule:${id}`,
					});
				return (await record(id, { at: now, instanceId, missedAt: caughtUp })) ?? claimed;
			} catch (err) {
				const message = errorText(err);
				options.notify({
					title: `Scheduled: ${claimed.title} failed to start`,
					body: message.slice(0, 200),
					tag: `schedule:${id}`,
				});
				await record(id, { at: now, error: message });
				throw err;
			}
		} finally {
			delete starting[id];
		}
	};

	return {
		list: () => schedules,
		hasUpcoming: () => schedules.some(s => s.enabled && s.nextRun !== null),
		async save(input) {
			const now = options.now();
			const existing = input.id === undefined ? undefined : find(input.id);
			if (input.id !== undefined && !existing) throw new Error("no such schedule");
			if (!existing && schedules.length >= MAX_SCHEDULES) throw new Error(`at most ${MAX_SCHEDULES} schedules`);
			// An interval counts from when it was first saved, so slots do not drift by the poll delay; editing around it keeps the phase.
			const when: ScheduleWhen =
				input.when.kind === "interval" && input.when.anchor === undefined
					? {
							...input.when,
							anchor:
								existing?.when.kind === "interval" && existing.when.everyMin === input.when.everyMin
									? (existing.when.anchor ?? now)
									: now,
						}
					: input.when;
			const sameTimetable =
				existing !== undefined &&
				existing.enabled === input.enabled &&
				JSON.stringify(existing.when) === JSON.stringify(when);
			const nextRun = !input.enabled
				? null
				: existing !== undefined && sameTimetable && existing.nextRun !== null
					? existing.nextRun
					: nextRunAfter(when, now);
			if (input.enabled && nextRun === null)
				throw new Error(
					when.kind === "once" ? "that date and time has already passed" : "that schedule never runs",
				);
			const next: Schedule = {
				...input,
				when,
				id: existing?.id ?? crypto.randomUUID(),
				lastRun: existing?.lastRun,
				nextRun,
			};
			schedules = existing ? schedules.map(s => (s.id === next.id ? next : s)) : [...schedules, next];
			await persist();
			return next;
		},
		async remove(id) {
			if (!find(id)) throw new Error("no such schedule");
			schedules = schedules.filter(s => s.id !== id);
			await persist();
		},
		runNow: id => trigger(id, true),
		async tick() {
			const now = options.now();
			const runs: Promise<void>[] = [];
			for (const schedule of schedules) {
				if (Object.hasOwn(starting, schedule.id)) continue;
				const due = dueState(schedule, now);
				if (due === "run") {
					runs.push(
						trigger(schedule.id, false).then(
							() => {},
							err => {
								// A skip is already recorded in the list: only a failure to record or to start needs a log line.
								if (!(err instanceof Error) || !err.message.startsWith("Not started: ")) options.onError(err);
							},
						),
					);
				} else if (due === "missed" && schedule.nextRun !== null) {
					const once = schedule.when.kind === "once";
					replace({
						...schedule,
						nextRun: once ? null : nextRunAfter(schedule.when, now),
						enabled: once ? false : schedule.enabled,
						lastRun: { at: now, error: `skipped: missed (was due ${stamp(schedule.nextRun)})` },
					});
					await persist().catch(options.onError);
				}
			}
			await Promise.all(runs);
		},
	};
}
