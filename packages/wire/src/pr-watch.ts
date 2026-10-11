/**
 * Pull request watching, shared by the two pollers (the omp harness in-process, and the collab
 * companion) and the web app: how a pull request is read through GitHub's REST API with
 * conditional requests, how two successive readings become events, and which events may wake
 * the agent (and how often). Pure: the caller supplies the HTTP call and the clock.
 */

/** Pull request lifecycle. */
export type PrState = "open" | "merged" | "closed";

/** Rollup of the checks that gate a pull request. */
export type PrChecksState = "passing" | "failing" | "pending" | "none";

/** Overall review verdict as reviews leave it. */
export type PrReviewState = "approved" | "changes-requested";

/** One check run or commit status on the head commit. */
export interface PrCheck {
	name: string;
	state: "passing" | "failing" | "pending" | "ignored";
	/** The check's details page; empty when GitHub gives none. */
	url: string;
	/** Required by the base branch's protection (or all checks, when none are known to be required). */
	required: boolean;
}

/** A review, a review comment on the diff, or a comment in the conversation. */
export interface PrFeedback {
	/** Unique across the three kinds (`review:<id>`, `inline:<id>`, `comment:<id>`). */
	id: string;
	kind: "review" | "inline" | "comment";
	author: string;
	body: string;
	/** `APPROVED`, `CHANGES_REQUESTED` or `COMMENTED` for a review. */
	reviewState?: string;
	/** File an inline comment is about. */
	path?: string;
	line?: number;
	url: string;
	at: string;
}

/** A pull request as one poll reads it. */
export interface PrSnapshot {
	repo: string;
	number: number;
	url: string;
	title: string;
	state: PrState;
	draft: boolean;
	headSha: string;
	baseRef: string;
	mergeable: "mergeable" | "conflicting" | "unknown";
	checks: PrCheck[];
	review?: PrReviewState;
	/** Reviews and comments written since the watch began, oldest first. */
	feedback: PrFeedback[];
}

/** What was already reported of one pull request. */
export interface PrSeen {
	state: PrState;
	headSha: string;
	checks: PrChecksState;
	conflict: boolean;
	/** Ids of the feedback already reported (the newest {@link MAX_SEEN_FEEDBACK}). */
	feedbackIds: string[];
}

export type PrEvent =
	| { kind: "checks-failed"; failed: PrCheck[]; headSha: string }
	| { kind: "checks-green"; headSha: string }
	| { kind: "feedback"; items: PrFeedback[] }
	| { kind: "conflict" }
	| { kind: "merged" }
	| { kind: "closed" };

export const MAX_SEEN_FEEDBACK = 300;

/** The state of the checks that gate a pull request: the required ones, or all of them when none is known to be required. */
export function rollupChecks(checks: PrCheck[]): PrChecksState {
	const gating = checks.filter(check => check.required && check.state !== "ignored");
	if (gating.length === 0) return "none";
	if (gating.some(check => check.state === "failing"))
		return gating.some(check => check.state === "pending") ? "pending" : "failing";
	if (gating.some(check => check.state === "pending")) return "pending";
	return "passing";
}

/** Verdict of the latest review of each reviewer (changes requested beats approved). */
export function reviewVerdict(reviews: readonly { author: string; state: string }[]): PrReviewState | undefined {
	const latest: Record<string, string> = Object.create(null);
	for (const review of reviews) {
		if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED")
			latest[review.author] = review.state;
	}
	const states = Object.values(latest);
	if (states.includes("CHANGES_REQUESTED")) return "changes-requested";
	return states.includes("APPROVED") ? "approved" : undefined;
}

/**
 * What a poll makes of the previous one: the state to remember and the events due.
 *
 * - The first reading of a pull request is a baseline and reports only that it is already merged or closed.
 * - Failing checks are reported once the gating checks have settled (a failure among still-pending checks
 *   waits), once per head commit; a push starts over. Green is reported when they settle passing.
 * - Feedback is reported once, and never your own (`self`).
 * - A merge conflict is reported when it appears, and again if it clears and comes back.
 * - Merged and closed are reported once.
 */
export function diffPr(
	prev: PrSeen | undefined,
	next: PrSnapshot,
	self: string | undefined,
): { seen: PrSeen; events: PrEvent[] } {
	const checks = rollupChecks(next.checks);
	const conflict =
		next.mergeable === "conflicting" ? true : next.mergeable === "mergeable" ? false : (prev?.conflict ?? false);
	const known = new Set(prev?.feedbackIds ?? []);
	const fresh = next.feedback.filter(item => !known.has(item.id));
	const feedbackIds = [...(prev?.feedbackIds ?? []), ...fresh.map(item => item.id)].slice(-MAX_SEEN_FEEDBACK);
	const sameHead = prev?.headSha === next.headSha;
	// Pending reports nothing and keeps what was reported before, so it never hides a later failure.
	const reported: PrChecksState = checks === "pending" ? (sameHead ? (prev?.checks ?? "none") : "none") : checks;
	const seen: PrSeen = { state: next.state, headSha: next.headSha, checks: reported, conflict, feedbackIds };
	if (!prev) return { seen: { ...seen, checks }, events: terminalEvents(next.state, undefined) };

	const events: PrEvent[] = [];
	if (next.state === "open") {
		if (checks === "failing" && !(sameHead && prev.checks === "failing")) {
			events.push({
				kind: "checks-failed",
				failed: next.checks.filter(check => check.required && check.state === "failing"),
				headSha: next.headSha,
			});
		} else if (checks === "passing" && !(sameHead && prev.checks === "passing")) {
			events.push({ kind: "checks-green", headSha: next.headSha });
		}
		if (conflict && !prev.conflict) events.push({ kind: "conflict" });
	}
	const items = fresh.filter(item => item.author !== self);
	if (items.length > 0) events.push({ kind: "feedback", items });
	events.push(...terminalEvents(next.state, prev.state));
	return { seen, events };
}

function terminalEvents(state: PrState, before: PrState | undefined): PrEvent[] {
	if (state === before || state === "open") return [];
	return [{ kind: state === "merged" ? "merged" : "closed" }];
}

/** Whether an event asks the agent to act, as opposed to just telling the user. */
export function isActionable(event: PrEvent): boolean {
	switch (event.kind) {
		case "checks-failed":
		case "conflict":
			return true;
		case "feedback":
			return event.items.some(
				item => item.kind !== "review" || item.reviewState !== "APPROVED" || item.body.trim() !== "",
			);
		case "checks-green":
		case "merged":
		case "closed":
			return false;
	}
}

export function isTerminalEvent(event: PrEvent): boolean {
	return event.kind === "merged" || event.kind === "closed";
}

// ── wake queue ───────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/** The actionable events waiting to wake the agent for one pull request. */
export interface PrWake {
	key: string;
	events: PrEvent[];
}

/**
 * Actionable events wait here until the agent may be woken: it is idle, and the pull request has
 * woken it fewer than `maxPerHour` times in the last hour. Events for one pull request are delivered
 * together and count as one wake. A newer failure replaces an older one, a green or a new push
 * discards a failure it fixes, and a merge or close discards everything: nothing queued outlives its use.
 */
export class PrWakeQueue {
	readonly #maxPerHour: () => number;
	readonly #now: () => number;
	readonly #waiting = new Map<string, PrEvent[]>();
	readonly #wakes = new Map<string, number[]>();

	constructor(maxPerHour: () => number, now: () => number = Date.now) {
		this.#maxPerHour = maxPerHour;
		this.#now = now;
	}

	/** Queue the actionable events of one poll; non-actionable ones only discard what they supersede. */
	push(key: string, events: readonly PrEvent[]): void {
		let waiting = this.#waiting.get(key) ?? [];
		for (const event of events) {
			if (isTerminalEvent(event)) {
				waiting = [];
				continue;
			}
			if (event.kind === "checks-green") waiting = waiting.filter(held => held.kind !== "checks-failed");
			if (!isActionable(event)) continue;
			if (event.kind === "checks-failed") waiting = waiting.filter(held => held.kind !== "checks-failed");
			if (event.kind === "conflict") waiting = waiting.filter(held => held.kind !== "conflict");
			if (event.kind === "feedback") {
				const held = waiting.find(
					(candidate): candidate is Extract<PrEvent, { kind: "feedback" }> => candidate.kind === "feedback",
				);
				if (held) {
					held.items.push(...event.items);
					continue;
				}
				waiting.push({ kind: "feedback", items: [...event.items] });
				continue;
			}
			waiting.push(event);
		}
		if (waiting.length === 0) this.#waiting.delete(key);
		else this.#waiting.set(key, waiting);
	}

	/** A new commit: failures and conflicts found on the old head no longer describe the pull request. */
	supersede(key: string, headSha: string): void {
		const waiting = this.#waiting.get(key);
		if (!waiting) return;
		const kept = waiting.filter(
			event => event.kind === "feedback" || (event.kind === "checks-failed" && event.headSha === headSha),
		);
		if (kept.length === 0) this.#waiting.delete(key);
		else this.#waiting.set(key, kept);
	}

	drop(key: string): void {
		this.#waiting.delete(key);
	}

	/** How many pull requests have something waiting. */
	get pending(): number {
		return this.#waiting.size;
	}

	/** Wakes of `key` within the last hour. */
	wakesInLastHour(key: string): number {
		return this.#recent(key).length;
	}

	/** Whether `key` has events waiting. */
	has(key: string): boolean {
		return this.#waiting.has(key);
	}

	/**
	 * The wakes due now, each counted against its pull request's hour. Nothing while `busy`; pull
	 * requests at their cap stay queued until their oldest wake leaves the hour.
	 */
	take(busy: boolean): PrWake[] {
		if (busy) return [];
		const limit = this.#maxPerHour();
		const due: PrWake[] = [];
		const now = this.#now();
		for (const [key, events] of this.#waiting) {
			const recent = this.#recent(key);
			if (recent.length >= limit) continue;
			recent.push(now);
			this.#wakes.set(key, recent);
			due.push({ key, events });
			this.#waiting.delete(key);
		}
		return due;
	}

	#recent(key: string): number[] {
		const cutoff = this.#now() - HOUR_MS;
		const recent = (this.#wakes.get(key) ?? []).filter(at => at > cutoff);
		if (recent.length === 0) this.#wakes.delete(key);
		else this.#wakes.set(key, recent);
		return recent;
	}
}

// ── reading a pull request ───────────────────────────────────────────────────

/** Answer of one REST call; `status` 304 carries no body (the caller keeps the cached one). */
export interface PrApiResponse {
	status: number;
	etag?: string;
	body?: unknown;
}

/** GET `endpoint` (a path under the API root, query included), conditional on `etag` when given. */
export type PrApi = (endpoint: string, etag?: string) => Promise<PrApiResponse>;

/** Arguments for `gh` that GET `endpoint` and print the HTTP status line, headers and body ({@link parseGhApiResponse}). */
export function ghApiArgs(endpoint: string, etag?: string): string[] {
	return ["api", "--include", "--method", "GET", ...(etag ? ["-H", `If-None-Match: ${etag}`] : []), endpoint];
}

/** Read what `gh api --include` printed: the status line, the `ETag` header and the JSON body. Undefined when it printed no HTTP response (gh failed before asking). */
export function parseGhApiResponse(stdout: string): PrApiResponse | undefined {
	const split = /\r?\n\r?\n/.exec(stdout);
	const head = split ? stdout.slice(0, split.index) : stdout;
	const status = /^HTTP\/\S+\s+(\d{3})/.exec(head);
	if (!status) return undefined;
	const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1];
	const raw = split ? stdout.slice(split.index + split[0].length).trim() : "";
	let body: unknown;
	if (raw !== "") {
		try {
			body = JSON.parse(raw);
		} catch {
			body = undefined;
		}
	}
	return { status: Number(status[1]), etag, body };
}

/** What the poller remembers between polls of one pull request: ETags and the bodies they stand for. */
export interface PrPollCache {
	etags: Record<string, string>;
	bodies: Record<string, unknown>;
	/** ISO time the watch began: feedback older than that is not reported. */
	since: string;
	required?: { at: number; names: string[] };
}

export function newPrPollCache(now: number): PrPollCache {
	return { etags: {}, bodies: {}, since: new Date(now).toISOString() };
}

/** A failed API call; `status` is the HTTP status (0: no answer). */
export class PrApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "PrApiError";
		this.status = status;
	}
}

const REQUIRED_TTL_MS = 10 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		: [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function login(user: unknown): string {
	return text(record(user).login) || "ghost";
}

async function cached(api: PrApi, cache: PrPollCache, endpoint: string, optional = false): Promise<unknown> {
	const response = await api(endpoint, cache.etags[endpoint]);
	if (response.status === 304) return cache.bodies[endpoint];
	if (response.status >= 200 && response.status < 300) {
		if (response.etag) cache.etags[endpoint] = response.etag;
		cache.bodies[endpoint] = response.body;
		return response.body;
	}
	if (optional && (response.status === 403 || response.status === 404)) return undefined;
	throw new PrApiError(`GitHub answered ${response.status} for ${endpoint}`, response.status);
}

async function requiredContexts(
	api: PrApi,
	cache: PrPollCache,
	repo: string,
	baseRef: string,
	now: number,
): Promise<string[]> {
	if (cache.required && now - cache.required.at < REQUIRED_TTL_MS) return cache.required.names;
	const response = await api(`repos/${repo}/branches/${encodeURIComponent(baseRef)}`);
	const names: string[] = [];
	if (response.status >= 200 && response.status < 300) {
		const status = record(record(record(response.body).protection).required_status_checks);
		for (const context of Array.isArray(status.contexts) ? status.contexts : [])
			if (typeof context === "string") names.push(context);
		for (const check of list(status.checks)) if (text(check.context)) names.push(text(check.context));
	}
	cache.required = { at: now, names };
	return names;
}

function checkRunState(run: Record<string, unknown>): PrCheck["state"] {
	if (text(run.status) !== "completed") return "pending";
	switch (text(run.conclusion)) {
		case "success":
		case "neutral":
		case "skipped":
			return "passing";
		case "failure":
		case "timed_out":
		case "action_required":
		case "startup_failure":
			return "failing";
		default:
			return "ignored";
	}
}

function statusState(state: string): PrCheck["state"] {
	if (state === "success") return "passing";
	if (state === "failure" || state === "error") return "failing";
	return "pending";
}

/**
 * Read one pull request. Every call is conditional on the ETag of the last answer, so an unchanged
 * pull request costs only 304s, which GitHub does not count against the rate limit.
 * @throws PrApiError when GitHub refuses or fails.
 */
export async function fetchPrSnapshot(
	api: PrApi,
	cache: PrPollCache,
	repo: string,
	number: number,
	now: number,
): Promise<PrSnapshot> {
	const pull = record(await cached(api, cache, `repos/${repo}/pulls/${number}`));
	const head = text(record(pull.head).sha);
	const baseRef = text(record(pull.base).ref);
	const state: PrState = pull.merged === true ? "merged" : text(pull.state) === "closed" ? "closed" : "open";
	const since = encodeURIComponent(cache.since);
	const [runs, statuses, reviews, issueComments, inlineComments, required] = await Promise.all([
		head ? cached(api, cache, `repos/${repo}/commits/${head}/check-runs?per_page=100`, true) : undefined,
		head ? cached(api, cache, `repos/${repo}/commits/${head}/status?per_page=100`, true) : undefined,
		cached(api, cache, `repos/${repo}/pulls/${number}/reviews?per_page=100`),
		cached(api, cache, `repos/${repo}/issues/${number}/comments?per_page=100&since=${since}`),
		cached(api, cache, `repos/${repo}/pulls/${number}/comments?per_page=100&since=${since}`),
		state === "open" && baseRef ? requiredContexts(api, cache, repo, baseRef, now) : Promise.resolve<string[]>([]),
	]);

	const byName: Record<string, PrCheck> = Object.create(null);
	for (const run of list(record(runs).check_runs)) {
		const name = text(run.name);
		if (name) byName[name] = { name, state: checkRunState(run), url: text(run.html_url), required: false };
	}
	for (const status of list(record(statuses).statuses)) {
		const name = text(status.context);
		if (name && !(name in byName))
			byName[name] = { name, state: statusState(text(status.state)), url: text(status.target_url), required: false };
	}
	const checks = Object.values(byName);
	const anyRequired = required.length > 0;
	for (const check of checks) check.required = anyRequired ? required.includes(check.name) : true;

	const sinceMs = Date.parse(cache.since);
	const feedback: PrFeedback[] = [];
	const reviewList = list(reviews);
	for (const review of reviewList) {
		const submitted = text(review.submitted_at);
		const reviewState = text(review.state);
		if (reviewState === "PENDING" || !(Date.parse(submitted) >= sinceMs)) continue;
		feedback.push({
			id: `review:${String(review.id)}`,
			kind: "review",
			author: login(review.user),
			body: text(review.body),
			reviewState,
			url: text(review.html_url),
			at: submitted,
		});
	}
	// GitHub's `since` matches a comment edited after it, so an old comment edited now must be dropped here.
	for (const comment of list(inlineComments)) {
		if (!(Date.parse(text(comment.created_at)) >= sinceMs)) continue;
		feedback.push({
			id: `inline:${String(comment.id)}`,
			kind: "inline",
			author: login(comment.user),
			body: text(comment.body),
			path: text(comment.path) || undefined,
			line: typeof comment.line === "number" ? comment.line : undefined,
			url: text(comment.html_url),
			at: text(comment.created_at),
		});
	}
	for (const comment of list(issueComments)) {
		if (!(Date.parse(text(comment.created_at)) >= sinceMs)) continue;
		feedback.push({
			id: `comment:${String(comment.id)}`,
			kind: "comment",
			author: login(comment.user),
			body: text(comment.body),
			url: text(comment.html_url),
			at: text(comment.created_at),
		});
	}
	feedback.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	const mergeable =
		pull.mergeable === false || text(pull.mergeable_state) === "dirty"
			? "conflicting"
			: pull.mergeable === true
				? "mergeable"
				: "unknown";
	return {
		repo,
		number,
		url: text(pull.html_url) || `https://github.com/${repo}/pull/${number}`,
		title: text(pull.title),
		state,
		draft: pull.draft === true,
		headSha: head,
		baseRef,
		mergeable,
		checks,
		review: reviewVerdict(reviewList.map(review => ({ author: login(review.user), state: text(review.state) }))),
		feedback,
	};
}

// ── references ───────────────────────────────────────────────────────────────

/** A pull request named by the user or the agent. */
export interface PrRef {
	repo: string;
	number: number;
}

export const prKey = (ref: PrRef): string => `${ref.repo}#${ref.number}`;

const PR_URL = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const PR_SHORT = /^([A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)#(\d+)$/;

/** `owner/repo#N` or a pull request URL; undefined for anything else (a bare number needs the caller's repository). */
export function parsePrRef(text: string): PrRef | undefined {
	const value = text.trim();
	const match = PR_URL.exec(value) ?? PR_SHORT.exec(value);
	if (!match) return undefined;
	const number = Number(match[2]);
	return Number.isSafeInteger(number) && number > 0 ? { repo: match[1]!, number } : undefined;
}

// ── what the app shows ───────────────────────────────────────────────────────

/** A watched pull request as the session sheet shows it. */
export interface WirePrWatch {
	key: string;
	repo: string;
	number: number;
	url: string;
	title: string;
	state: PrState;
	checks: PrChecksState;
	conflict: boolean;
	review?: PrReviewState;
	/** Times it woke the session in the last hour. */
	wakes: number;
	/** Events waiting for the agent to be idle (or for the hourly cap). */
	queued: boolean;
	/** The last poll's failure, while it keeps failing. */
	error?: string;
}

// ── the files the harness and the companion share ────────────────────────────

/**
 * Under `<config root>/run/pr-watch/`: a session's watches (`watches/<sessionId>.json`, written by the
 * session, mtime refreshed while it lives), the latest reading of each pull request the companion polled
 * for it (`inbox/<sessionId>/<name>.json`, written by the companion, deleted by the session once read),
 * and the companion's heartbeat (`companion.json`).
 */
export interface PrWatchFile {
	sessionId: string;
	cwd: string;
	/** Login whose feedback is not reported (the signed-in user; the agent writes as them). */
	self?: string;
	updatedAt: number;
	prs: { repo: string; number: number; since: string }[];
}

/** The companion's latest reading of one pull request of a session. */
export interface PrInboxEntry {
	key: string;
	at: number;
	snapshot: PrSnapshot;
}

/** The companion's heartbeat: written at least this often while it polls. */
export interface PrCompanionBeat {
	at: number;
}

/** A heartbeat older than this means no companion is polling. */
export const PR_COMPANION_FRESH_MS = 90_000;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read a {@link PrWatchFile}; undefined when `raw` is not one. */
export function parsePrWatchFile(raw: unknown): PrWatchFile | undefined {
	if (!isObject(raw) || typeof raw.sessionId !== "string" || typeof raw.cwd !== "string" || !Array.isArray(raw.prs))
		return undefined;
	const prs: PrWatchFile["prs"] = [];
	for (const pr of raw.prs) {
		if (!isObject(pr) || typeof pr.repo !== "string" || typeof pr.number !== "number" || typeof pr.since !== "string")
			continue;
		prs.push({ repo: pr.repo, number: pr.number, since: pr.since });
	}
	return {
		sessionId: raw.sessionId,
		cwd: raw.cwd,
		self: typeof raw.self === "string" ? raw.self : undefined,
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
		prs,
	};
}

/** Read a {@link PrInboxEntry}; undefined when `raw` is not one. */
export function parsePrInboxEntry(raw: unknown): PrInboxEntry | undefined {
	if (!isObject(raw) || typeof raw.key !== "string" || typeof raw.at !== "number" || !isObject(raw.snapshot))
		return undefined;
	const snapshot = raw.snapshot;
	if (
		typeof snapshot.repo !== "string" ||
		typeof snapshot.number !== "number" ||
		typeof snapshot.headSha !== "string" ||
		typeof snapshot.state !== "string" ||
		!Array.isArray(snapshot.checks) ||
		!Array.isArray(snapshot.feedback)
	)
		return undefined;
	return { key: raw.key, at: raw.at, snapshot: snapshot as unknown as PrSnapshot };
}
