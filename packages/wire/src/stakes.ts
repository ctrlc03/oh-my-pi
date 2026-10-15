/**
 * High-stakes sessions: a session mode in which pushing and pull requests are blocked until the user passes a quiz
 * ({@link ./quiz}) on the session's changes. Design, layers and residual risks: docs/collab.md, *High-stakes sessions*.
 *
 * Shared by the collab companion (which keeps the mode and the passes and decides), the web app (which shows the
 * state and disables the buttons) and `packages/coding-agent` (whose command gate reads the state file the companion
 * publishes). Pure: the shapes, the pass rule, and the text format of that file. No I/O.
 *
 * A pass is tied to the exact tree it covered. A tree is covered when a pass names it, when its diff against the
 * default branch is the same patch as a passed one (a rebase), or when it has no changes at all; otherwise the next
 * quiz is made for the changes since the latest pass only (a *delta* quiz), or for the whole diff when there is none.
 */

/** Pass mark, in percent, when the companion has none set. */
export const STAKES_DEFAULT_PASS_MARK = 90;
/** Lowest pass mark: below half a quiz mostly measures guessing. */
export const STAKES_MIN_PASS_MARK = 50;
/** Highest pass mark: every answer right. Open answers are graded by a small model, so this is a gamble; allowed, not the default. */
export const STAKES_MAX_PASS_MARK = 100;
/** Passes kept per session, newest first; older ones are dropped. */
export const STAKES_MAX_PASSES = 50;
/** Covered trees published to the state file, newest first. */
export const STAKES_MAX_PUBLISHED_TREES = 200;

/** Folder of the state files, inside the agent directory. The `collab-companion` prefix keeps it unreadable to omp's shell sandbox. */
export const STAKES_STATE_DIR = "collab-companion-stakes";
/** The loopback endpoint of the pre-push hook (`port=`, `token=`, `pid=` lines), inside the agent directory. */
export const STAKES_IPC_FILE = "collab-companion-stakes-ipc";
/** `customType` of the visible marker a session writes when its mode changes. */
export const STAKES_MARKER_TYPE = "high-stakes";
/** `customType` of the session entry that records the mode the session last saw (so a resume writes a marker only for a change). */
export const STAKES_ENTRY_TYPE = "high-stakes";

/**
 * True when `points` of `total` meet `mark` percent. Exact: a half point counts, and the rounded percent of a score
 * (`QuizScore.percent`) is never used, so 89.6 % does not pass a 90 % mark. No questions never pass.
 */
export function quizPassed(points: number, total: number, mark: number): boolean {
	if (!(total > 0) || !Number.isFinite(points)) return false;
	return Math.round(points * 2) * 100 >= mark * total * 2;
}

/** A usable pass mark: a whole percent from {@link STAKES_MIN_PASS_MARK} to {@link STAKES_MAX_PASS_MARK}. */
export function isPassMark(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= STAKES_MIN_PASS_MARK &&
		value <= STAKES_MAX_PASS_MARK
	);
}

/** Companion-wide high-stakes settings. */
export interface StakesSettings {
	/** Percent of a quiz's points a finished attempt needs to pass. */
	passMark: number;
}

/** What the next quiz must cover. */
export type StakesNeeds = "none" | "full" | "delta";

/** Why a state is covered. */
export type StakesCoveredBy = "pass" | "same-diff" | "nothing-to-publish";

/** The pre-push hook of the repository: `installed`; `missing` (the mode is on and it is not there yet); `unavailable` (see `hookNote`). */
export type StakesHook = "installed" | "missing" | "unavailable";

/** The stored pass most recently earned. */
export interface StakesPassInfo {
	at: number;
	quizId: string;
	points: number;
	total: number;
	/** The pass covered only the changes since an earlier one. */
	delta: boolean;
}

/** The stakes quiz for exactly the diff that is needed right now, when one exists. */
export interface StakesQuizInfo {
	id: string;
	status: "running" | "ready" | "failed";
	/** Covers only the changes since the latest pass. */
	delta: boolean;
	/** The best finished attempt that asks every question, when there is one. */
	best?: { points: number; total: number };
	error?: string;
}

/** What a device needs to know of a session's high-stakes state. */
export interface StakesStatus {
	sessionId: string;
	on: boolean;
	/** The pass mark now in force, percent. */
	passMark: number;
	/** Pushing, creating and merging pull requests are allowed: the mode is off, or the session's changes are covered. */
	covered: boolean;
	needs: StakesNeeds;
	coveredBy?: StakesCoveredBy;
	/** Latest pass of this session. */
	passed?: StakesPassInfo;
	/** The quiz for the diff that is needed, when it exists (the *Take the quiz* action opens it). */
	quiz?: StakesQuizInfo;
	hook: StakesHook;
	hookNote?: string;
	/** Why no quiz can be made or the state could not be read (no default branch, not a repository). */
	error?: string;
	/** What the app shows beside the disabled buttons, and what a refusal says; empty while covered. */
	message: string;
}

/** Quiz-side facts of a stakes quiz, on the quiz the app opens. */
export interface QuizStakes {
	sessionId: string;
	/** Only the changes since the latest pass. */
	delta: boolean;
	/** The pass mark in force, percent. */
	passMark: number;
	/** The attempt that passed, once one did. */
	passedAttempt?: string;
}

/**
 * Companion requests (sent in the companion room like the other `t`-tagged requests, answered by `reqId`). The
 * companion advertises `canHighStakes` in its hello when it supports them; `instanceId` is a listed session.
 *
 * - `stakes-get` `{ instanceId }` → `{ status }`
 * - `stakes-set` `{ instanceId, on, confirmOff? }` → `{ status }`. Turning the mode off is refused unless
 *   `confirmOff` is `true`: the app asks the user first. Either change is logged, and the session writes a marker.
 * - `stakes-quiz` `{ instanceId }` → `{ id, delta, created }`: the quiz for exactly the diff that is needed (the one
 *   that exists, or a new one). Refused when the session is covered or not high stakes.
 * - `stakes-settings` `{ passMark? }` → `{ settings }`: read, or set (a whole percent from 50 to 100).
 *
 * The companion pushes `{ t: "stakes-changed", instanceId?, sessionId }` when a status changes (mode, pass, the quiz).
 */
export type StakesRequest =
	| { t: "stakes-get"; reqId: number; instanceId: string }
	| { t: "stakes-set"; reqId: number; instanceId: string; on: boolean; confirmOff?: boolean }
	| { t: "stakes-quiz"; reqId: number; instanceId: string }
	| { t: "stakes-settings"; reqId: number; passMark?: number };

export type StakesReply =
	| { t: "stakes"; reqId: number; status: StakesStatus }
	| { t: "stakes-quiz"; reqId: number; id: string; delta: boolean; created: boolean }
	| { t: "stakes-settings"; reqId: number; settings: StakesSettings };

/** Push frame: a session's status changed. */
export interface StakesChangedFrame {
	t: "stakes-changed";
	sessionId: string;
}

// ── the state file ───────────────────────────────────────────────────────────

const STATE_MAGIC = "omp-high-stakes 1";
const TREE_RE = /^[0-9a-f]{40}$/;

/**
 * What the companion publishes per checkout for the agent's command gate and the pre-push hook: whether the mode is
 * on for any session there, and the trees every such session has covered (the intersection when there are several).
 */
export interface StakesState {
	/** Counts up on every change, so a session notices one. */
	rev: number;
	on: boolean;
	/** Absolute path of the checkout. */
	checkout: string;
	passMark: number;
	/** Who last changed the mode (a device name), for the marker; may be empty. */
	by: string;
	/** Epoch ms of the last change. */
	at: number;
	/** Covered trees, newest first. */
	trees: string[];
}

/** The state file's name for a checkout: a hash of its absolute path. */
export function stakesStateKey(checkout: string): string {
	return new Bun.CryptoHasher("sha256").update(checkout).digest("hex").slice(0, 24);
}

/** One line per fact, so the pre-push hook can read it with `grep`: no JSON, no quoting. A newline in `by` or `checkout` is dropped. */
export function formatStakesState(state: StakesState): string {
	const line = (value: string): string => value.replace(/[\r\n]+/g, " ");
	return [
		STATE_MAGIC,
		`rev ${state.rev}`,
		`mode ${state.on ? "on" : "off"}`,
		`mark ${state.passMark}`,
		`at ${state.at}`,
		`by ${line(state.by)}`,
		`checkout ${line(state.checkout)}`,
		...state.trees.filter(tree => TREE_RE.test(tree)).map(tree => `tree ${tree}`),
		"",
	].join("\n");
}

/** Parse {@link formatStakesState}; null for anything else (a half-written or foreign file). */
export function parseStakesState(text: string): StakesState | null {
	const lines = text.split("\n");
	if (lines[0] !== STATE_MAGIC) return null;
	const state: StakesState = {
		rev: 0,
		on: false,
		checkout: "",
		passMark: STAKES_DEFAULT_PASS_MARK,
		by: "",
		at: 0,
		trees: [],
	};
	let seenMode = false;
	for (const line of lines.slice(1)) {
		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? "" : line.slice(space + 1);
		switch (key) {
			case "rev":
				state.rev = Number(value);
				break;
			case "mode":
				state.on = value === "on";
				seenMode = value === "on" || value === "off";
				break;
			case "mark":
				if (isPassMark(Number(value))) state.passMark = Number(value);
				break;
			case "at":
				state.at = Number(value);
				break;
			case "by":
				state.by = value;
				break;
			case "checkout":
				state.checkout = value;
				break;
			case "tree":
				if (TREE_RE.test(value)) state.trees.push(value);
				break;
		}
	}
	if (!seenMode || !Number.isSafeInteger(state.rev) || !Number.isFinite(state.at)) return null;
	return state;
}

/**
 * The pre-push hook's call, `POST /stakes/pre-push` on the companion's loopback server (bearer token from
 * {@link STAKES_IPC_FILE}): a `text/plain` body of the folder `git push` ran in on the first line and one commit id (or
 * tag object id) per line after it. The reply is `text/plain` too, so a shell script can read it: the first line is
 * `allow` or `deny`, and the lines after it are the message for the person at the terminal.
 */
export const STAKES_PRE_PUSH_PATH = "/stakes/pre-push";

/** The sentence every refusal starts with, so an agent recognises it; what follows says what to do. */
export const STAKES_REFUSAL_LEAD =
	"Blocked: this is a high-stakes session, so pushing and opening, merging or closing pull requests need the user to pass a quiz on this session's changes first.";
/** What every refusal tells the agent to do. The agent cannot take the quiz: answers only come from the user's app. */
export const STAKES_REFUSAL_ASK =
	"Ask the user to open the quiz in the collab app (Push → Take the quiz) and tell you when they have passed, then try again. Do not try to work around this block: you cannot answer the quiz, and pushing by another route is refused too.";
