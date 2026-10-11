/**
 * The mock host's pull request watcher (feature `pr-watch`). It runs the real event logic (the wire
 * package's `diffPr` and `PrWakeQueue`) over a scripted timeline instead of GitHub, so the session
 * sheet's chips, the unwatch button, the hourly cap and the wake can all be seen in a browser: after a
 * pull request is watched its test job fails (the agent is woken with a log), a push re-runs the checks,
 * they pass, a reviewer comments (woken again), and it merges (unwatched).
 */
import {
	diffPr,
	isActionable,
	isTerminalEvent,
	type PrCheck,
	type PrEvent,
	type PrFeedback,
	type PrRef,
	type PrSeen,
	type PrSnapshot,
	PrWakeQueue,
	parsePrRef,
	prKey,
	reviewVerdict,
	rollupChecks,
	type WirePrWatch,
} from "@oh-my-pi/pi-wire/pr-watch";

const DEFAULT_PR: PrRef = { repo: "acme/web", number: 42 };
const MAX_WAKES_PER_HOUR = 3;
const SELF = "you";

/** Seconds into the script at which each thing happens. */
const FAIL_AT = 6;
const PUSH_AT = 24;
const GREEN_AT = 36;
const COMMENT_AT = 48;
const MERGE_AT = 72;

interface Watched {
	ref: PrRef;
	startedAt: number;
	seen?: PrSeen;
	snapshot?: PrSnapshot;
}

export interface MockPrWatchOptions {
	/** The state changed: broadcast it. */
	onState(): void;
	notice(level: "info" | "warning" | "error", message: string): void;
	/** The agent is running a turn. */
	busy(): boolean;
	/** Start a turn on a hidden message. */
	wake(text: string): void;
	now?: () => number;
}

function check(name: string, state: PrCheck["state"]): PrCheck {
	return { name, state, url: `https://github.com/acme/web/actions/runs/1/job/${name}`, required: true };
}

function snapshotAt(ref: PrRef, seconds: number): PrSnapshot {
	const pushed = seconds >= PUSH_AT;
	const checks =
		seconds < FAIL_AT
			? [check("build", "passing"), check("test", "pending")]
			: seconds < PUSH_AT
				? [check("build", "passing"), check("test", "failing")]
				: seconds < GREEN_AT
					? [check("build", "pending"), check("test", "pending")]
					: [check("build", "passing"), check("test", "passing")];
	const feedback: PrFeedback[] = [];
	if (seconds >= GREEN_AT)
		feedback.push({
			id: "review:1",
			kind: "review",
			author: "maria",
			body: "",
			reviewState: "APPROVED",
			url: `https://github.com/${ref.repo}/pull/${ref.number}#pullrequestreview-1`,
			at: "2026-01-01T00:00:01Z",
		});
	if (seconds >= COMMENT_AT)
		feedback.push({
			id: "comment:2",
			kind: "comment",
			author: "maria",
			body: "Nice. Can the retry delay be configurable?",
			url: `https://github.com/${ref.repo}/pull/${ref.number}#issuecomment-2`,
			at: "2026-01-01T00:00:02Z",
		});
	return {
		repo: ref.repo,
		number: ref.number,
		url: `https://github.com/${ref.repo}/pull/${ref.number}`,
		title: "Retry flaky uploads",
		state: seconds >= MERGE_AT ? "merged" : "open",
		draft: false,
		headSha: pushed ? "b7c1f9e0000000000000000000000000000000aa" : "a41d3c20000000000000000000000000000000bb",
		baseRef: "main",
		mergeable: "mergeable",
		checks,
		review: reviewVerdict(
			feedback
				.filter(item => item.kind === "review")
				.map(item => ({ author: item.author, state: item.reviewState ?? "" })),
		),
		feedback,
	};
}

const FAKE_LOG = [
	"--- CI / test (https://github.com/acme/web/actions/runs/1/job/test) ---",
	"FAIL src/upload.test.ts",
	"  ✕ retries a failed chunk three times (31 ms)",
	"    expected 3 calls, received 1",
].join("\n");

export class MockPrWatch {
	readonly #options: MockPrWatchOptions;
	readonly #now: () => number;
	readonly #watched = new Map<string, Watched>();
	readonly #queue: PrWakeQueue;

	constructor(options: MockPrWatchOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#queue = new PrWakeQueue(() => MAX_WAKES_PER_HOUR, this.#now);
	}

	/** The watched pull requests for `state.prWatch`; undefined while none. */
	list(): WirePrWatch[] | undefined {
		if (this.#watched.size === 0) return undefined;
		return [...this.#watched.values()].map(entry => {
			const snapshot = entry.snapshot ?? snapshotAt(entry.ref, 0);
			const key = prKey(entry.ref);
			return {
				key,
				repo: entry.ref.repo,
				number: entry.ref.number,
				url: snapshot.url,
				title: snapshot.title,
				state: snapshot.state,
				checks: rollupChecks(snapshot.checks),
				conflict: snapshot.mergeable === "conflicting",
				review: snapshot.review,
				wakes: this.#queue.wakesInLastHour(key),
				queued: this.#queue.has(key),
			};
		});
	}

	/** `session-cmd` `pr-watch`; returns an error message, or undefined on success. */
	watch(arg: string | undefined): string | undefined {
		const text = (arg ?? "").trim();
		const ref = text === "" ? DEFAULT_PR : parsePrRef(text);
		if (!ref) return `"${text}" is not a pull request: use a URL or owner/repo#N`;
		if (this.#watched.has(prKey(ref))) return undefined;
		const entry: Watched = { ref, startedAt: this.#now() };
		const { seen } = diffPr(undefined, snapshotAt(ref, 0), SELF);
		entry.seen = seen;
		entry.snapshot = snapshotAt(ref, 0);
		this.#watched.set(prKey(ref), entry);
		this.#options.notice("info", `started watching pull request ${prKey(ref)}`);
		this.#options.onState();
		return undefined;
	}

	/** `session-cmd` `pr-unwatch`; returns an error message, or undefined on success. */
	unwatch(arg: string | undefined): string | undefined {
		const key = (arg ?? "").trim();
		if (!this.#watched.delete(key)) return `${key || "(none given)"} is not a watched pull request`;
		this.#queue.drop(key);
		this.#options.notice("info", `stopped watching ${key}`);
		this.#options.onState();
		return undefined;
	}

	/** Advance the script, queue what needs the agent, wake it when it may be woken. */
	tick(): void {
		const now = this.#now();
		const before = JSON.stringify(this.list());
		for (const [key, entry] of Array.from(this.#watched)) {
			const snapshot = snapshotAt(entry.ref, (now - entry.startedAt) / 1000);
			const { seen, events } = diffPr(entry.seen, snapshot, SELF);
			if (entry.snapshot && entry.snapshot.headSha !== snapshot.headSha)
				this.#queue.supersede(key, snapshot.headSha);
			entry.seen = seen;
			entry.snapshot = snapshot;
			for (const event of events)
				if (!isActionable(event)) this.#options.notice("info", `Pull request ${key}: ${describe(event)}`);
			this.#queue.push(key, events);
			if (events.some(isTerminalEvent)) {
				this.#queue.drop(key);
				this.#watched.delete(key);
			}
		}
		this.nudge();
		if (JSON.stringify(this.list()) !== before) this.#options.onState();
	}

	/** The agent went idle (or a tick ran): wake it if something waits and the cap allows. */
	nudge(): void {
		if (this.#options.busy()) return;
		const due = this.#queue.take(false);
		if (due.length === 0) return;
		const sections = due.map(wake => `Pull request ${wake.key}:\n${wake.events.map(text).join("\n")}`);
		this.#options.notice(
			"info",
			`Pull request ${due.map(wake => wake.key).join(", ")} needs attention: waking the agent`,
		);
		this.#options.wake(
			`[pr-watch] A pull request you were asked to watch needs attention.\n\n${sections.join("\n\n")}`,
		);
		this.#options.onState();
	}
}

function describe(event: PrEvent): string {
	switch (event.kind) {
		case "checks-green":
			return "all required checks passed";
		case "merged":
			return "merged";
		case "closed":
			return "closed without merging";
		case "feedback":
			return "approved";
		case "checks-failed":
			return "required checks failed";
		case "conflict":
			return "merge conflict with the base branch";
	}
}

function text(event: PrEvent): string {
	if (event.kind === "checks-failed")
		return `Required checks failed: ${event.failed.map(failed => failed.name).join(", ")}.\n${FAKE_LOG}`;
	if (event.kind === "feedback")
		return `New feedback:\n${event.items.map(item => `- comment by ${item.author}: ${item.body}`).join("\n")}`;
	return describe(event);
}
