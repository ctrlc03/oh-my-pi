import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { Quiz, QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_VERSION } from "@oh-my-pi/pi-wire/quiz";
import { STAKES_MARKER_TYPE, type QuizStakes, type StakesStatus } from "@oh-my-pi/pi-wire/stakes";
import { stakesBannerOf } from "../src/components/quiz/quiz-flow";
import { buildChatItems } from "../src/components/transcript/chat-items";
import { INITIAL_SNAPSHOT } from "../src/lib/companion";
import { type ComputerHandle, unavailableReason } from "../src/lib/computers";
import { newSessionTarget, type StartDraft, startOptions } from "../src/lib/start-session";
import {
	stakesBlocked,
	stakesDetail,
	stakesGateLine,
	stakesOn,
	stakesToggleShown,
	takeQuizLabel,
} from "../src/lib/stakes";

const OLD = { ...INITIAL_SNAPSHOT, phase: "live" as const };
const NEW = { ...OLD, canHighStakes: true };

const status = (over: Partial<StakesStatus> = {}): StakesStatus => ({
	sessionId: "s1",
	on: true,
	passMark: 90,
	covered: false,
	needs: "full",
	hook: "installed",
	message: "Pass a quiz on this session's changes to push.",
	...over,
});

describe("a companion without canHighStakes (compatibility)", () => {
	it("shows no mode, no toggle and no chip, even when a row claims highStakes", () => {
		expect(INITIAL_SNAPSHOT.canHighStakes).toBe(false);
		expect(stakesOn(OLD, { highStakes: true })).toBe(false);
		expect(stakesToggleShown(OLD, null)).toBe(false);
		expect(stakesToggleShown(OLD, undefined)).toBe(false);
	});

	it("is named as the reason the feature is unavailable on that computer, and a new one is not", () => {
		const handle = (snap: typeof OLD): ComputerHandle => ({
			id: "c",
			name: "laptop",
			client: null,
			snap,
			error: null,
		});
		expect(unavailableReason(handle(OLD), "highStakes")).toBe(
			"This computer can't gate pushes behind a quiz. Update omp there.",
		);
		expect(unavailableReason(handle(NEW), "highStakes")).toBeNull();
	});

	it("never blocks a button for a session with no stakes status", () => {
		expect(stakesBlocked(undefined)).toBe(false);
	});
});

describe("a companion with canHighStakes", () => {
	it("shows the chip only on rows that are high stakes, and the toggle only for omp sessions", () => {
		expect(stakesOn(NEW, { highStakes: true })).toBe(true);
		expect(stakesOn(NEW, { highStakes: false })).toBe(false);
		expect(stakesOn(NEW, {})).toBe(false);
		expect(stakesToggleShown(NEW, null)).toBe(true);
		expect(stakesToggleShown(NEW, { id: "claude", name: "Claude Code" })).toBe(false);
	});

	it("blocks exactly while the mode is on and the changes are not covered", () => {
		expect(stakesBlocked(status())).toBe(true);
		expect(stakesBlocked(status({ covered: true, needs: "none", message: "" }))).toBe(false);
		expect(stakesBlocked(status({ on: false, covered: true, needs: "none", message: "" }))).toBe(false);
	});

	it("words the lines beside the disabled buttons and the quiz action", () => {
		expect(stakesGateLine("push")).toBe("Pass the quiz to push");
		expect(stakesGateLine("pr")).toBe("Pass the quiz to open a pull request");
		expect(stakesGateLine("merge")).toBe("Pass the quiz to merge");
		expect(takeQuizLabel(status())).toBe("Take the quiz");
		expect(takeQuizLabel(status({ needs: "delta" }))).toBe("Take the quiz on the new changes");
	});

	it("adds the companion's message only when it says more than the gate line", () => {
		expect(stakesDetail(status())).toBe("Pass a quiz on this session's changes to push.");
		expect(stakesDetail(status({ message: "" }))).toBeNull();
		expect(stakesDetail(status({ message: "Pass the quiz to push" }))).toBeNull();
		expect(stakesDetail(status({ message: "  Not a git repository.  " }))).toBe("Not a git repository.");
	});
});

describe("starting a session high stakes", () => {
	const draft: StartDraft = {
		cwd: "/work/app",
		sandboxed: false,
		worktree: false,
		branch: "",
		prompt: "",
		agent: null,
		model: "",
		permission: "supervised",
	};

	it("sends highStakes only for an omp session that asked for it", () => {
		expect(startOptions(newSessionTarget({ ...draft, highStakes: true })).highStakes).toBe(true);
		expect(startOptions(newSessionTarget(draft)).highStakes).toBeUndefined();
		expect(startOptions(newSessionTarget({ ...draft, highStakes: false })).highStakes).toBeUndefined();
		expect(newSessionTarget({ ...draft, highStakes: true, agent: "claude" }).highStakes).toBeUndefined();
	});

	it("does not send it when resuming", () => {
		const target = { cwd: "/work/app", sandboxed: false, resume: "session-1" };
		expect(startOptions(target).highStakes).toBeUndefined();
	});
});

describe("the results banner of a stakes quiz", () => {
	const quiz = {
		v: QUIZ_VERSION,
		id: "qz",
		title: "t",
		repo: { root: "/r", name: "r" },
		createdAt: 0,
		parts: [],
		questions: [1, 2, 3, 4].map(n => ({ id: `q${n}`, part: 0, kind: "choice", prompt: "p", topic: "t", refs: [] })),
		warnings: [],
	} as unknown as Quiz;
	const attempt = (id: string, points: number, over: Partial<QuizAttempt> = {}): QuizAttempt => ({
		id,
		startedAt: 1,
		finishedAt: 2,
		questions: ["q1", "q2", "q3", "q4"],
		answers: {},
		score: { points, total: 4, percent: Math.round((points / 4) * 100), byPart: [], revisit: [] },
		...over,
	});
	const stakes = (over: Partial<QuizStakes> = {}): QuizStakes => ({
		sessionId: "s1",
		delta: false,
		passMark: 90,
		...over,
	});

	it("says passed for the attempt the companion recorded, and 'earlier' for another attempt's pass", () => {
		expect(stakesBannerOf(quiz, attempt("a1", 4), stakes({ passedAttempt: "a1" }))).toEqual({
			tone: "passed",
			text: "Passed — you can push now",
		});
		expect(stakesBannerOf(quiz, attempt("a2", 1), stakes({ passedAttempt: "a1" }))).toEqual({
			tone: "passed",
			text: "Passed earlier — you can push now",
		});
	});

	it("reads a finished full attempt that meets the mark as passed before the companion has recorded it", () => {
		expect(stakesBannerOf(quiz, attempt("a1", 4), stakes())?.tone).toBe("passed");
	});

	it("says what is missing from a full attempt below the mark, with the exact points and the mark", () => {
		expect(stakesBannerOf(quiz, attempt("a1", 3.5), stakes())).toEqual({
			tone: "failed",
			text: "Not passed: 3.5 of 4 points, 90% needed",
		});
		// 87.5 % is shown as 88 % and still does not meet a mark of 88: the points are compared, not the rounded percent.
		expect(stakesBannerOf(quiz, attempt("a1", 3.5), stakes({ passMark: 88 }))?.tone).toBe("failed");
		expect(stakesBannerOf(quiz, attempt("a1", 3.5), stakes({ passMark: 87 }))?.tone).toBe("passed");
	});

	it("says nothing while the attempt is unfinished, and that a shorter attempt cannot pass", () => {
		expect(stakesBannerOf(quiz, attempt("a1", 2, { finishedAt: undefined }), stakes())).toBeNull();
		expect(stakesBannerOf(quiz, attempt("a2", 2, { questions: ["q1", "q2"] }), stakes())).toEqual({
			tone: "failed",
			text: "Only an attempt at every question can pass",
		});
	});
});

describe("the high-stakes marker in the transcript", () => {
	const marker: SessionEntry = {
		type: "custom_message",
		id: "m1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		customType: STAKES_MARKER_TYPE,
		content: "High-stakes mode was turned off by laptop. Pushes and pull requests are no longer blocked.",
		display: true,
	};

	it("stays in the chat view as an entry of its own", () => {
		const items = buildChatItems([marker], null, false, []);
		expect(items.map(item => item.kind)).toEqual(["entry"]);
		expect(items[0]).toMatchObject({ kind: "entry", entry: { id: "m1" } });
	});
});
