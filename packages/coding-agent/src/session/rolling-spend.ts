/**
 * Rolling spend limits: `session.spendLimits.dayUsd` / `.monthUsd`, counted across every session of the profile
 * (an agent that never ends has no useful per-session cap). Each session appends its spend, one JSON line per
 * turn end, to `<agentDir>/spend-ledger.jsonl`; the day (local midnight to midnight) and month (local calendar
 * month) windows are summed from that file on every check, so concurrent sessions and the companion's headless
 * runs all count, and a window rolling over lifts the cap without a restart.
 *
 * Active when `personal.enabled` or either limit is above 0; with neither nothing is read or written. It plugs
 * into {@link SpendCapController}, which owns the prompt refusal, the loop's boundary stop and the notices.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { cfgPersonalEnabled } from "../personal/settings";
import type { Settings } from "../config/settings";
import { cfgSessionSpendLimitsDayUsd, cfgSessionSpendLimitsMonthUsd } from "./settings";
import {
	SPEND_CAP_NOTICE_SOURCE,
	SPEND_CAP_WARNING_RATIO,
	SpendCapExceededError,
	type SpendCapLevel,
	type SpendCapNoticeLevel,
	type SpendUsage,
} from "./spend-cap";

/** File name in the agent directory; the companion reads the same file for the app's spend bars. */
export const SPEND_LEDGER_FILE = "spend-ledger.jsonl";

/** One ledger line: what a session spent since its last line. */
export interface SpendLedgerEntry {
	/** Ms since epoch. */
	at: number;
	sessionId: string;
	costUsd: number;
	tokens: number;
}

export type RollingWindowName = "day" | "month";

export interface RollingWindowStatus {
	window: RollingWindowName;
	/** Window start, ms (local midnight / first of the month). */
	startsAt: number;
	/** First instant after the window: the cap lifts then. */
	endsAt: number;
	usedUsd: number;
	/** 0 = no limit. */
	limitUsd: number;
	level: SpendCapLevel;
}

export interface RollingSpendStatus {
	level: SpendCapLevel;
	/** The window at its limit, the day first. */
	capped?: RollingWindowName;
	day: RollingWindowStatus;
	month: RollingWindowStatus;
}

export interface RollingSpendHost {
	settings: Settings;
	/** The profile's agent directory: the ledger lives there. */
	agentDir: string;
	sessionId(): string;
	/** The session's cumulative spend, the same totals `SpendCapController` reads. */
	readSpend(): SpendUsage;
	emitNotice(level: SpendCapNoticeLevel, message: string, source: string): void;
}

export interface RollingSpendOptions {
	now?: () => number;
}

/** Start of the local day containing `at`. */
export function dayStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Start of the local calendar month containing `at`. */
export function monthStart(at: number): number {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function nextDayStart(at: number): number {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function nextMonthStart(at: number): number {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function parseLedgerLine(line: string): SpendLedgerEntry | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) return undefined;
	const { at, sessionId, costUsd, tokens } = raw;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
	return {
		at,
		sessionId: typeof sessionId === "string" ? sessionId : "",
		costUsd,
		tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0,
	};
}

/** Appends one entry with a single `write(2)` on an `O_APPEND` descriptor, so concurrent writers never interleave bytes. */
export function appendSpendLedger(file: string, entry: SpendLedgerEntry): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const fd = fs.openSync(file, "a", 0o600);
	try {
		fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

/** The ledger's entries since a time, read incrementally: only bytes appended since the last read are parsed. */
class LedgerReader {
	readonly #file: string;
	#offset = 0;
	#entries: SpendLedgerEntry[] = [];

	constructor(file: string) {
		this.#file = file;
	}

	/** Entries at or after `since`; older ones are dropped for good (windows only move forward). */
	read(since: number): readonly SpendLedgerEntry[] {
		this.#refresh();
		if (this.#entries.some(entry => entry.at < since))
			this.#entries = this.#entries.filter(entry => entry.at >= since);
		return this.#entries;
	}

	#refresh(): void {
		let size: number;
		try {
			size = fs.statSync(this.#file).size;
		} catch {
			size = 0;
		}
		if (size < this.#offset) {
			// Truncated or replaced: start over.
			this.#offset = 0;
			this.#entries = [];
		}
		if (size === this.#offset) return;
		const buffer = Buffer.alloc(size - this.#offset);
		let fd: number;
		try {
			fd = fs.openSync(this.#file, "r");
		} catch {
			return;
		}
		let read: number;
		try {
			read = fs.readSync(fd, buffer, 0, buffer.length, this.#offset);
		} finally {
			fs.closeSync(fd);
		}
		const text = buffer.subarray(0, read).toString("utf8");
		// A line still being written has no newline yet: leave it for the next read.
		const complete = text.lastIndexOf("\n") + 1;
		this.#offset += Buffer.byteLength(text.slice(0, complete));
		for (const line of text.slice(0, complete).split("\n")) {
			const entry = line === "" ? undefined : parseLedgerLine(line);
			if (entry) this.#entries.push(entry);
		}
	}
}

function levelOf(used: number, limit: number): SpendCapLevel {
	if (limit <= 0) return "off";
	const ratio = used / limit;
	return ratio >= 1 ? "capped" : ratio >= SPEND_CAP_WARNING_RATIO ? "warning" : "ok";
}

function formatUsd(value: number): string {
	return `$${value >= 0.01 || value === 0 ? value.toFixed(2) : value.toFixed(4)}`;
}

function describeWindow(status: RollingWindowStatus): string {
	return `${formatUsd(status.usedUsd)} of ${formatUsd(status.limitUsd)} ${status.window === "day" ? "today" : "this month"}`;
}

/** The refusal's text: what is spent, and when the window passes. */
export function formatRollingSpendReached(status: RollingWindowStatus): string {
	const until = new Date(status.endsAt).toLocaleString();
	return `Spend limit reached (${describeWindow(status)}). New prompts and events wait until the ${status.window} ends (${until}); the limit is session.spendLimits.${status.window}Usd.`;
}

/** Thrown by `AgentSession.prompt` while a rolling window is at its limit. A headless run ends with the spend-cap exit code. */
export class RollingSpendExceededError extends SpendCapExceededError {
	readonly window: RollingWindowStatus;

	constructor(window: RollingWindowStatus) {
		super(
			{
				maxCostUsd: window.limitUsd,
				maxTokens: 0,
				costUsd: window.usedUsd,
				tokens: 0,
				level: "capped",
			},
			formatRollingSpendReached(window),
		);
		this.name = "RollingSpendExceededError";
		this.window = window;
	}
}

/** Appends the session's spend to the profile ledger and evaluates the day and month windows against it. */
export class RollingSpendController {
	readonly #host: RollingSpendHost;
	readonly #now: () => number;
	readonly #reader: LedgerReader;
	readonly #file: string;
	/** What the ledger already holds of this session's cumulative spend. */
	#recorded: { sessionId: string; costUsd: number; tokens: number } | undefined;
	#level: SpendCapLevel = "off";

	constructor(host: RollingSpendHost, options: RollingSpendOptions = {}) {
		this.#host = host;
		this.#now = options.now ?? Date.now;
		this.#file = path.join(host.agentDir, SPEND_LEDGER_FILE);
		this.#reader = new LedgerReader(this.#file);
	}

	/** Whether the controller does anything: a Personal session, or a configured limit. */
	isActive(): boolean {
		return (
			cfgPersonalEnabled.get(this.#host.settings) ||
			cfgSessionSpendLimitsDayUsd.get(this.#host.settings) > 0 ||
			cfgSessionSpendLimitsMonthUsd.get(this.#host.settings) > 0
		);
	}

	/** Cumulative spend of the session now; the first look at a session id fixes what the ledger already holds. */
	#observe(): SpendUsage {
		const sessionId = this.#host.sessionId();
		const usage = this.#host.readSpend();
		if (this.#recorded?.sessionId !== sessionId) this.#recorded = { sessionId, ...usage };
		return usage;
	}

	status(): RollingSpendStatus {
		const now = this.#now();
		const usage = this.#observe();
		const pending = Math.max(0, usage.costUsd - (this.#recorded?.costUsd ?? usage.costUsd));
		const starts = { day: dayStart(now), month: monthStart(now) };
		const entries = this.#reader.read(starts.month);
		const used = { day: pending, month: pending };
		for (const entry of entries) {
			used.month += entry.costUsd;
			if (entry.at >= starts.day) used.day += entry.costUsd;
		}
		const day: RollingWindowStatus = {
			window: "day",
			startsAt: starts.day,
			endsAt: nextDayStart(now),
			usedUsd: used.day,
			limitUsd: cfgSessionSpendLimitsDayUsd.get(this.#host.settings),
			level: "off",
		};
		const month: RollingWindowStatus = {
			window: "month",
			startsAt: starts.month,
			endsAt: nextMonthStart(now),
			usedUsd: used.month,
			limitUsd: cfgSessionSpendLimitsMonthUsd.get(this.#host.settings),
			level: "off",
		};
		day.level = levelOf(day.usedUsd, day.limitUsd);
		month.level = levelOf(month.usedUsd, month.limitUsd);
		const levels = [day.level, month.level];
		const level: SpendCapLevel = levels.includes("capped")
			? "capped"
			: levels.includes("warning")
				? "warning"
				: levels.includes("ok")
					? "ok"
					: "off";
		const capped = day.level === "capped" ? "day" : month.level === "capped" ? "month" : undefined;
		return { level, ...(capped ? { capped } : {}), day, month };
	}

	/** The window at its limit, for the heartbeat. */
	capped(): RollingWindowName | undefined {
		return this.isActive() ? this.status().capped : undefined;
	}

	/** The agent loop's boundary stop predicate. */
	shouldStop(): boolean {
		return this.isActive() && this.status().level === "capped";
	}

	/** @throws RollingSpendExceededError when a window is at its limit. */
	assertCanPrompt(): void {
		if (!this.isActive()) return;
		const status = this.status();
		if (status.capped) throw new RollingSpendExceededError(status[status.capped]);
	}

	/** Append what the session spent since its last line, then announce a threshold crossing; call after each turn. */
	onTurnEnd(): void {
		if (!this.isActive()) return;
		const usage = this.#observe();
		const recorded = this.#recorded;
		if (recorded && (usage.costUsd > recorded.costUsd || usage.tokens > recorded.tokens)) {
			const entry: SpendLedgerEntry = {
				at: this.#now(),
				sessionId: recorded.sessionId,
				costUsd: Math.max(0, usage.costUsd - recorded.costUsd),
				tokens: Math.max(0, usage.tokens - recorded.tokens),
			};
			try {
				appendSpendLedger(this.#file, entry);
				this.#recorded = { sessionId: recorded.sessionId, costUsd: usage.costUsd, tokens: usage.tokens };
			} catch (error) {
				this.#host.emitNotice(
					"warning",
					`Could not record spend in ${this.#file}: ${error instanceof Error ? error.message : String(error)}`,
					SPEND_CAP_NOTICE_SOURCE,
				);
			}
		}
		this.#announce(this.status());
	}

	#announce(status: RollingSpendStatus): void {
		const previous = this.#level;
		this.#level = status.level;
		if (status.level === previous) return;
		if (status.capped) {
			this.#host.emitNotice("error", formatRollingSpendReached(status[status.capped]), SPEND_CAP_NOTICE_SOURCE);
		} else if (status.level === "warning" && previous !== "capped") {
			const nearing = status.day.level === "warning" ? status.day : status.month;
			this.#host.emitNotice(
				"warning",
				`Approaching the spend limit (${describeWindow(nearing)}).`,
				SPEND_CAP_NOTICE_SOURCE,
			);
		}
	}
}
