/**
 * Subscription limits for the collab host (feature `usage-limits`): the account windows the
 * session's providers report, whether the session is stopped or slowed by its account's limit,
 * and the one timer that sends `continue` once that limit resets. Parsing and the limit/reset
 * rules are pure; {@link HostUsageLimits} owns the cache, the poll and the timer, and takes the
 * clock and timer functions as options so the countdown and rescheduling are testable.
 */
import { type AssistantMessage, resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";
import type { LimitWindowStatus, SessionLimited, WireLimitWindow } from "@oh-my-pi/pi-wire";
import type { UsageLimitState } from "../session/usage-limit";

/** A usage report read this recently answers `usage-limits` without another provider round trip. */
export const USAGE_LIMITS_TTL_MS = 60_000;
/** While a writer is connected the host re-reads the windows this often and pushes what changed. */
export const USAGE_LIMITS_POLL_MS = 5 * 60_000;
/** `continue` goes out this long after the reported reset, so the provider has certainly reopened. */
export const RESUME_GRACE_MS = 30_000;
/** How often the armed timer compares the wall clock with its target: a sleeping laptop pauses timers but not the clock. */
export const RESUME_CHECK_MS = 30_000;
/** A resume that is refused by the limit again re-arms itself this many times before it gives up. */
export const RESUME_MAX_REARMS = 3;
/** A new limit hit this soon after `continue` went out counts as that continue being refused. */
const REARM_WINDOW_MS = 5 * 60_000;
const MAX_WINDOWS = 60;
/** The text sent to the session when a limit resets. */
export const RESUME_PROMPT = "continue";
/** The author the room sees on the `continue` prompt. */
export const RESUME_AUTHOR = "usage limit reset";

function accountLabel(report: UsageReport, accountId: string | undefined): string | undefined {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const metaAccountId = report.metadata?.accountId;
	if (typeof metaAccountId === "string" && metaAccountId) return metaAccountId;
	return accountId || undefined;
}

function windowStatus(status: LimitWindowStatus | undefined, usedFraction: number | undefined): LimitWindowStatus {
	if (status !== undefined) return status;
	if (usedFraction === undefined) return "unknown";
	return usedFraction >= 1 ? "exhausted" : "ok";
}

/** The windows a provider's reports carry, one row per limit that has an amount or a reset time. */
export function limitWindows(reports: readonly UsageReport[] | null | undefined): WireLimitWindow[] {
	const out: WireLimitWindow[] = [];
	if (!reports) return out;
	for (const report of collapseSharedUsageReports([...reports])) {
		for (const limit of report.limits) {
			const usedFraction = resolveUsedFraction(limit);
			const resetsAt = limit.window?.resetsAt;
			if (usedFraction === undefined && resetsAt === undefined) continue;
			const windowLabel = limit.window?.label;
			const suffix =
				windowLabel &&
				windowLabel.toLowerCase() !== "quota window" &&
				!limit.label.toLowerCase().includes(windowLabel.toLowerCase())
					? ` · ${windowLabel}`
					: "";
			out.push({
				provider: report.provider,
				account: accountLabel(report, limit.scope.accountId),
				windowId: limit.window?.id,
				label: `${limit.label}${suffix}`,
				usedFraction:
					usedFraction !== undefined && Number.isFinite(usedFraction) ? Math.max(0, usedFraction) : undefined,
				resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
				status: windowStatus(limit.status, usedFraction),
			});
			if (out.length >= MAX_WINDOWS) return out;
		}
	}
	return out;
}

/** Compare two window lists ignoring when they were read. */
export function sameWindows(a: readonly WireLimitWindow[], b: readonly WireLimitWindow[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * When `provider` serves requests again according to `windows`: every account of the provider has an
 * exhausted window, and an account is free once its last exhausted window resets, so the answer is the
 * earliest such moment. Undefined when some account still has room (the session rotates to it), when
 * the provider has no exhausted window, or when an exhausted one reports no reset time.
 */
export function blockedUntil(windows: readonly WireLimitWindow[], provider: string, now: number): number | undefined {
	const accounts = new Map<string, { exhausted: boolean; until: number | undefined; known: boolean }>();
	for (const window of windows) {
		if (window.provider !== provider) continue;
		const key = window.account ?? "";
		const entry = accounts.get(key) ?? { exhausted: false, until: undefined, known: true };
		if (window.status === "exhausted") {
			entry.exhausted = true;
			if (window.resetsAt === undefined) entry.known = false;
			else if (window.resetsAt > now) entry.until = Math.max(entry.until ?? 0, window.resetsAt);
		}
		accounts.set(key, entry);
	}
	if (accounts.size === 0) return undefined;
	let earliest: number | undefined;
	for (const entry of accounts.values()) {
		if (!entry.exhausted || !entry.known || entry.until === undefined) return undefined;
		earliest = earliest === undefined ? entry.until : Math.min(earliest, entry.until);
	}
	return earliest;
}

/** The provider-reported wrap-up / low-priority stage as a session's limited state. */
export function limitedFromStage(
	state: UsageLimitState | undefined,
	provider: string | undefined,
): SessionLimited | undefined {
	if (state === undefined) return undefined;
	return {
		kind: state.stage === "wrap_up" ? "wrap-up" : "low-priority",
		provider,
		until: state.resetsAtSec === undefined ? undefined : state.resetsAtSec * 1000,
	};
}

/** The slice of an assistant message {@link HostUsageLimits.observe} reads. */
export type LimitMessage = Partial<
	Pick<AssistantMessage, "stopReason" | "provider" | "model" | "api" | "errorId" | "errorMessage" | "errorStatus">
> & { role?: string };

/** Session events {@link HostUsageLimits.observe} reads; a `message_end` carries the finished message. */
export type LimitEvent = { type: string; message?: unknown };

/** Whether `message` is a turn that failed on the account's usage limit. */
export function isLimitError(message: LimitMessage | undefined): boolean {
	if (message?.role !== "assistant" || message.stopReason !== "error") return false;
	return AIError.is(AIError.classifyMessage(message), AIError.Flag.UsageLimit);
}

/** Epoch ms the provider says it serves again, from the error text; undefined when it states no time. */
export function limitErrorReset(message: LimitMessage, now: number): number | undefined {
	const delay = extractProviderRetryHint(message.provider, message.errorMessage);
	return delay === undefined || !Number.isFinite(delay) ? undefined : now + delay;
}

export interface UsageLimitsSession {
	model?: { provider: string } | undefined;
	isStreaming: boolean;
	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;
	getUsageLimitState?(): UsageLimitState | undefined;
}

export interface UsageLimitsSnapshot {
	windows: WireLimitWindow[];
	/** Epoch ms the host read them. */
	fetchedAt: number;
}

export interface HostUsageLimitsOptions {
	session: UsageLimitsSession;
	/** Send `continue` into the session; resolves once it was handed over. */
	sendContinue(): Promise<void>;
	/** The state guests render changed (limited stage, armed resume). */
	onStateChange(): void;
	/** The windows changed since the last read; push them to the writers. */
	onWindows(snapshot: UsageLimitsSnapshot): void;
	/** Whether a writer is connected: the poll reads the providers only for someone watching. */
	hasWriters(): boolean;
	onError(message: string, err: unknown): void;
	now?(): number;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

interface Hit {
	provider: string | undefined;
	until: number | undefined;
	at: number;
}

interface Armed {
	/** Epoch ms `continue` goes out. */
	at: number;
	rearmsLeft: number;
}

export type ArmResult = { ok: true; at: number } | { ok: false; error: string };

/** Per-session limit tracking for a collab host. */
export class HostUsageLimits {
	readonly #options: HostUsageLimitsOptions;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	#snapshot: UsageLimitsSnapshot | undefined;
	#inflight: Promise<UsageLimitsSnapshot | undefined> | undefined;
	#hit: Hit | undefined;
	#armed: Armed | undefined;
	#armTimer: unknown;
	#poll: unknown;
	/** Set when `continue` was just sent: a refusal within {@link REARM_WINDOW_MS} re-arms. */
	#fired: { at: number; rearmsLeft: number } | undefined;
	#disposed = false;
	#pushes = 0;

	constructor(options: HostUsageLimitsOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as Timer));
	}

	/** Start the poll that keeps the windows current while writers are connected. */
	start(): void {
		if (this.#poll !== undefined || this.#disposed) return;
		const handle = setInterval(() => {
			if (this.#options.hasWriters()) void this.refresh(true);
		}, USAGE_LIMITS_POLL_MS);
		handle.unref();
		this.#poll = handle;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#poll !== undefined) clearInterval(this.#poll as Timer);
		this.#poll = undefined;
		this.#cancelTimer();
		this.#armed = undefined;
	}

	/** Whether the host can read usage reports at all. */
	get available(): boolean {
		return typeof this.#options.session.fetchUsageReports === "function";
	}

	/**
	 * How many reads changed the windows and were pushed to every writer. A caller that sees it move
	 * while it waited for its own read already received that push and need not be answered again.
	 */
	get pushCount(): number {
		return this.#pushes;
	}

	/** The windows, from the cache while it is fresh (or `force` is false and a read is running). */
	async refresh(force: boolean): Promise<UsageLimitsSnapshot | undefined> {
		const fresh = this.#snapshot !== undefined && this.#now() - this.#snapshot.fetchedAt < USAGE_LIMITS_TTL_MS;
		if (!force && fresh) return this.#snapshot;
		if (this.#inflight) return this.#inflight;
		const fetch = this.#options.session.fetchUsageReports;
		if (typeof fetch !== "function") return this.#snapshot;
		const read = (async (): Promise<UsageLimitsSnapshot | undefined> => {
			try {
				const reports = await fetch.call(this.#options.session);
				if (this.#disposed) return this.#snapshot;
				// A failed or empty read keeps what was known: the windows are advisory, not a reason to blank the app.
				if (reports === null) return this.#snapshot;
				const next: UsageLimitsSnapshot = { windows: limitWindows(reports), fetchedAt: this.#now() };
				const changed = this.#snapshot === undefined || !sameWindows(this.#snapshot.windows, next.windows);
				this.#snapshot = next;
				if (changed) {
					this.#pushes++;
					this.#options.onWindows(next);
					// `until` may come from the windows, so the state guests render can change too.
					this.#options.onStateChange();
				}
				return next;
			} catch (err) {
				this.#options.onError("collab usage limits could not be read", err);
				return this.#snapshot;
			} finally {
				this.#inflight = undefined;
			}
		})();
		this.#inflight = read;
		return read;
	}

	/** Feed every session event; tracks the turn that hit the limit and the first one that works again. */
	observe(event: LimitEvent): void {
		if (event.type !== "message_end") return;
		const message = event.message as LimitMessage | undefined;
		if (message?.role !== "assistant") return;
		if (isLimitError(message)) {
			this.#onLimitHit(message);
			return;
		}
		if (message.stopReason === "aborted") return;
		if (message.stopReason !== "error" && this.#hit !== undefined) {
			// The session works again (another account, another model, or the limit reset).
			this.#hit = undefined;
			if (this.#armed !== undefined) this.#disarm();
			this.#fired = undefined;
			this.#options.onStateChange();
		}
	}

	#onLimitHit(message: LimitMessage): void {
		const now = this.#now();
		const until = limitErrorReset(message, now);
		const provider = message.provider ?? this.#options.session.model?.provider;
		this.#hit = { provider, until, at: now };
		this.#options.onStateChange();
		const fired = this.#fired;
		if (fired !== undefined && now - fired.at <= REARM_WINDOW_MS) {
			this.#fired = undefined;
			if (fired.rearmsLeft > 0) {
				const next = this.#resetOf(this.#hit);
				if (next !== undefined && next > now) this.#arm(next + RESUME_GRACE_MS, fired.rearmsLeft - 1);
			}
		}
		// The usage windows know a reset the error text may not state; they also feed the countdown.
		void this.refresh(true);
	}

	#resetOf(hit: Hit): number | undefined {
		if (hit.until !== undefined) return hit.until;
		if (hit.provider === undefined || this.#snapshot === undefined) return undefined;
		return blockedUntil(this.#snapshot.windows, hit.provider, this.#now());
	}

	/** The session's limited state for the footer snapshot; undefined while it is not limited. */
	limited(): SessionLimited | undefined {
		const now = this.#now();
		const session = this.#options.session;
		const resumeAt = this.#armed?.at;
		if (this.#hit !== undefined) {
			const until = this.#resetOf(this.#hit);
			// A reset that has passed (and was not acted on) no longer limits the session.
			if (until === undefined || now < until + RESUME_GRACE_MS || resumeAt !== undefined) {
				return { kind: "blocked", provider: this.#hit.provider, until, resumeAt };
			}
			return undefined;
		}
		const staged = limitedFromStage(session.getUsageLimitState?.(), session.model?.provider);
		return staged === undefined ? undefined : { ...staged, resumeAt };
	}

	/** Send `continue` once the current limit has reset. */
	arm(): ArmResult {
		const limited = this.limited();
		if (limited === undefined) return { ok: false, error: "this session is not limited" };
		if (limited.until === undefined) return { ok: false, error: "the provider does not say when the limit resets" };
		const now = this.#now();
		if (limited.until <= now) return { ok: false, error: "the limit has already reset: send continue instead" };
		const at = limited.until + RESUME_GRACE_MS;
		this.#arm(at, RESUME_MAX_REARMS);
		return { ok: true, at };
	}

	/** Disarm; false when nothing was armed. */
	cancel(): boolean {
		if (this.#armed === undefined) return false;
		this.#disarm();
		this.#options.onStateChange();
		return true;
	}

	get armedAt(): number | undefined {
		return this.#armed?.at;
	}

	#arm(at: number, rearmsLeft: number): void {
		this.#cancelTimer();
		this.#armed = { at, rearmsLeft };
		this.#schedule();
		this.#options.onStateChange();
	}

	#disarm(): void {
		this.#cancelTimer();
		this.#armed = undefined;
	}

	#cancelTimer(): void {
		if (this.#armTimer !== undefined) this.#clearTimer(this.#armTimer);
		this.#armTimer = undefined;
	}

	#schedule(): void {
		const armed = this.#armed;
		if (armed === undefined || this.#disposed) return;
		const wait = Math.max(0, Math.min(armed.at - this.#now(), RESUME_CHECK_MS));
		this.#armTimer = this.#setTimer(() => {
			this.#armTimer = undefined;
			this.#tick();
		}, wait);
		if (typeof this.#armTimer === "object" && this.#armTimer !== null && "unref" in this.#armTimer) {
			(this.#armTimer as Timer).unref();
		}
	}

	#tick(): void {
		const armed = this.#armed;
		if (armed === undefined || this.#disposed) return;
		if (this.#now() < armed.at) {
			this.#schedule();
			return;
		}
		this.#armed = undefined;
		// The user already took the session over, or it is still working: nothing to continue.
		if (this.#options.session.isStreaming) {
			this.#options.onStateChange();
			return;
		}
		this.#hit = undefined;
		this.#fired = { at: this.#now(), rearmsLeft: armed.rearmsLeft };
		this.#options.onStateChange();
		this.#options.sendContinue().catch(err => this.#options.onError("collab resume at reset failed", err));
	}
}
