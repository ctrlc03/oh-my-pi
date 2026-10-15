import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import { quizPassed, STAKES_REFUSAL_LEAD, type StakesChangedFrame } from "@oh-my-pi/pi-wire/stakes";
import type { CompanionHost, CompanionReply, CompanionRequest } from "../src/lib/companion";
import { createMockQuiz } from "../scripts/mock-quiz";
import { createMockStakes } from "../scripts/mock-stakes";

const host: CompanionHost = {
	instanceId: "inst-7",
	sessionId: "session-7",
	sessionName: "api-pagination",
	cwd: "/work/api-pagination",
	model: "anthropic/claude-sonnet-5-5",
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
};

const dirs: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(options: { enabled?: boolean; on?: boolean } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-stakes-test-"));
	dirs.push(dir);
	const frames: StakesChangedFrame[] = [];
	const marker = path.join(dir, "stakes-markers.txt");
	// The stakes mock makes its quizzes in the quiz mock, and the quiz mock tells it of a finished attempt.
	const stakes = createMockStakes({
		enabled: options.enabled ?? true,
		dir,
		hosts: [host],
		idle: [],
		initiallyOn: options.on === false ? [] : ["inst-7"],
		marker: { instanceId: "inst-7", file: marker },
		addQuiz: (id, sessionId, delta) => quiz.addStakesQuiz(id, sessionId, delta),
		broadcastFrame: frame => frames.push(frame),
		onHostsChanged: () => {},
	});
	const quiz = createMockQuiz({
		instanceId: "inst-7",
		stageMs: 5,
		gradeMs: 0,
		stakes: stakes.quizHook,
		onChanged: () => {},
	});
	stops.push(() => quiz.stop());
	let reqId = 0;
	const ask = <T extends CompanionReply["t"]>(
		request: Record<string, unknown> & { t: string },
		_expect?: T,
	): Promise<Extract<CompanionReply, { t: T }>> => {
		const framed = { ...request, reqId: ++reqId } as unknown as CompanionRequest;
		const target = quiz.handles(framed) ? quiz.answer(framed) : stakes.answer(framed, "device-1");
		return target as Promise<Extract<CompanionReply, { t: T }>>;
	};
	const status = async () => (await ask({ t: "stakes-get", instanceId: "inst-7" }, "stakes")).status;
	/** Answer the first attempt of the quiz: `right` of its questions with `a` (right), the rest with `b`. Returns the finished attempt. */
	const take = async (id: string, right: number): Promise<QuizAttempt> => {
		const got = await ask({ t: "quiz-get", id }, "quiz-get");
		let attempt = got.attempts[0]!;
		for (const [at, question] of got.quiz.questions.entries()) {
			const reply = await ask(
				{
					t: "quiz-answer",
					id,
					attempt: attempt.id,
					question: question.id,
					choice: at < right ? "a" : "b",
				},
				"quiz-answer",
			);
			attempt = reply.attempt;
		}
		return attempt;
	};
	const stakesQuiz = () => ask({ t: "stakes-quiz", instanceId: "inst-7" }, "stakes-quiz");
	return { dir, marker, frames, stakes, quiz, ask, status, take, stakesQuiz };
}

describe("the mock companion's high-stakes mode", () => {
	it("blocks the push, the pull request and the merge of a high-stakes session, and lets commits through", async () => {
		const { ask, status, stakes } = await setup();
		expect(stakes.capabilities).toEqual({ canHighStakes: true, canPr: true, canPrReview: true });
		expect(stakes.decorate([host])[0]?.highStakes).toBe(true);
		expect(await status()).toMatchObject({
			on: true,
			covered: false,
			needs: "full",
			passMark: 90,
			hook: "installed",
		});
		expect((await status()).message).toBe("Pass a quiz on this session's changes to push.");
		const review = (await ask({ t: "git-review", instanceId: "inst-7" }, "review")).review;
		expect(review.stakes).toMatchObject({ on: true, covered: false });
		await ask({ t: "git-commit", instanceId: "inst-7", message: "Paginate" }, "ok");
		for (const request of [
			{ t: "git-push", instanceId: "inst-7" },
			{ t: "pr-create", instanceId: "inst-7", title: "t", body: "b" },
			{ t: "pr-merge", instanceId: "inst-7", number: 1, method: "squash", deleteBranch: false, head: "abc" },
		]) {
			await expect(ask(request)).rejects.toThrow(STAKES_REFUSAL_LEAD);
		}
	});

	it("stays blocked after a failed attempt (60 %), and the best score shows on the status", async () => {
		const { ask, status, stakesQuiz, take, frames } = await setup();
		const made = await stakesQuiz();
		expect(made).toMatchObject({ delta: false, created: true });
		expect((await status()).quiz).toMatchObject({ id: made.id, status: "ready", delta: false });
		const attempt = await take(made.id, 6);
		expect(attempt.score).toMatchObject({ points: 6, total: 10 });
		const after = await status();
		expect(after.covered).toBe(false);
		expect(after.quiz?.best).toEqual({ points: 6, total: 10 });
		const got = await ask({ t: "quiz-get", id: made.id }, "quiz-get");
		expect(got.stakes).toEqual({ sessionId: "session-7", delta: false, passMark: 90 });
		expect(frames.some(frame => frame.sessionId === "session-7")).toBe(true);
		await expect(ask({ t: "git-push", instanceId: "inst-7" })).rejects.toThrow(STAKES_REFUSAL_LEAD);
	});

	it("unlocks the push once an attempt at every question reaches 90 %, and records the passing attempt", async () => {
		const { ask, status, stakesQuiz, take } = await setup();
		const made = await stakesQuiz();
		const attempt = await take(made.id, 9);
		expect(quizPassed(attempt.score.points, attempt.score.total, 90)).toBe(true);
		expect(await status()).toMatchObject({ covered: true, needs: "none", coveredBy: "pass", message: "" });
		const got = await ask({ t: "quiz-get", id: made.id }, "quiz-get");
		expect(got.stakes?.passedAttempt).toBe(attempt.id);
		const listed = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(row => row.id === made.id);
		expect(listed?.stakes).toEqual({ delta: false, passed: true });
		await ask({ t: "git-commit", instanceId: "inst-7", message: "Paginate" }, "ok");
		await ask({ t: "git-push", instanceId: "inst-7" }, "ok");
		await ask({ t: "pr-create", instanceId: "inst-7", title: "Paginate", body: "" }, "link");
		const stakesQuizAgain = ask({ t: "stakes-quiz", instanceId: "inst-7" });
		await expect(stakesQuizAgain).rejects.toThrow("already covered");
	});

	it("does not count an attempt that skips questions, even when every answer in it is right", async () => {
		const { ask, status, stakesQuiz, take } = await setup();
		const made = await stakesQuiz();
		await take(made.id, 6);
		const retry = await ask({ t: "quiz-retry", id: made.id, only: "missed" }, "quiz-retry");
		expect(retry.attempt.questions).toHaveLength(4);
		for (const question of retry.attempt.questions) {
			await ask({ t: "quiz-answer", id: made.id, attempt: retry.attempt.id, question, choice: "a" }, "quiz-answer");
		}
		expect((await status()).covered).toBe(false);
		const full = await ask({ t: "quiz-retry", id: made.id, only: "all" }, "quiz-retry");
		for (const question of full.attempt.questions) {
			await ask({ t: "quiz-answer", id: made.id, attempt: full.attempt.id, question, choice: "a" }, "quiz-answer");
		}
		expect((await status()).covered).toBe(true);
	});

	it("compares the score exactly: a mark of 100 is not met by 9 of 10, and the mark is read when the attempt finishes", async () => {
		const { ask, status, stakesQuiz, take } = await setup();
		expect((await ask({ t: "stakes-settings" }, "stakes-settings")).settings).toEqual({ passMark: 90 });
		await ask({ t: "stakes-settings", passMark: 100 }, "stakes-settings");
		expect((await status()).passMark).toBe(100);
		const made = await stakesQuiz();
		await take(made.id, 9);
		expect((await status()).covered).toBe(false);
		const again = await ask({ t: "quiz-retry", id: made.id, only: "all" }, "quiz-retry");
		for (const question of again.attempt.questions) {
			await ask({ t: "quiz-answer", id: made.id, attempt: again.attempt.id, question, choice: "a" }, "quiz-answer");
		}
		expect((await status()).covered).toBe(true);
	});

	it("keeps a half point and the rounded percent apart: 17.5 of 20 is 87.5 % and does not pass 90", () => {
		expect(quizPassed(17.5, 20, 90)).toBe(false);
		expect(quizPassed(18, 20, 90)).toBe(true);
		expect(quizPassed(8.5, 10, 85)).toBe(true);
		expect(quizPassed(8.5, 10, 86)).toBe(false);
	});

	it("refuses a pass mark that is not a whole percent from 50 to 100", async () => {
		const { ask } = await setup();
		for (const passMark of [49, 101, 90.5, Number.NaN]) {
			await expect(ask({ t: "stakes-settings", passMark })).rejects.toThrow("whole percent from 50 to 100");
		}
		expect((await ask({ t: "stakes-settings", passMark: 50 }, "stakes-settings")).settings.passMark).toBe(50);
	});

	it("asks for a quiz on only what is new after the agent edits again", async () => {
		const { ask, status, stakesQuiz, take, dir, stakes } = await setup();
		const first = await stakesQuiz();
		await take(first.id, 10);
		expect((await status()).covered).toBe(true);
		// The trigger a person uses in the browser: a file in the state directory.
		await Bun.write(path.join(dir, "stakes-edit"), "");
		await stakes.tick();
		const blocked = await status();
		expect(blocked).toMatchObject({ covered: false, needs: "delta" });
		expect(blocked.message).toBe("Pass a quiz on the changes since your last pass to push.");
		expect(blocked.passed).toMatchObject({ quizId: first.id, points: 10, total: 10, delta: false });
		expect(blocked.quiz).toBeUndefined();
		await expect(ask({ t: "git-push", instanceId: "inst-7" })).rejects.toThrow("since the last passed quiz");
		const second = await stakesQuiz();
		expect(second).toMatchObject({ delta: true, created: true });
		expect(second.id).not.toBe(first.id);
		expect(await stakesQuiz()).toMatchObject({ id: second.id, created: false });
		const listed = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(row => row.id === second.id);
		expect(listed?.stakes).toEqual({ delta: true, passed: false });
		await take(second.id, 10);
		expect(await status()).toMatchObject({ covered: true, passed: { quizId: second.id, delta: true } });
	});

	it("turns off only with confirmation, writes a marker for either change, and unblocks the push", async () => {
		const { ask, status, marker, frames } = await setup();
		await expect(ask({ t: "stakes-set", instanceId: "inst-7", on: false })).rejects.toThrow("confirmation");
		await expect(ask({ t: "stakes-set", instanceId: "inst-7", on: false, confirmOff: false })).rejects.toThrow(
			"confirmation",
		);
		expect((await status()).on).toBe(true);
		const off = (await ask({ t: "stakes-set", instanceId: "inst-7", on: false, confirmOff: true }, "stakes")).status;
		expect(off).toMatchObject({ on: false, covered: true, needs: "none" });
		await ask({ t: "git-push", instanceId: "inst-7" }, "ok");
		await ask({ t: "stakes-set", instanceId: "inst-7", on: true }, "stakes");
		const lines = (await Bun.file(marker).text()).split("\n").filter(line => line !== "");
		expect(lines).toEqual([
			"High-stakes mode was turned off by device-1. Pushes and pull requests are no longer blocked.",
			"High-stakes mode was turned on by device-1. Pushes and pull requests need a passed quiz.",
		]);
		expect(frames.length).toBeGreaterThanOrEqual(2);
	});

	it("turning the mode on needs nothing, and a session started high stakes is blocked from the start", async () => {
		const { ask, status, stakes } = await setup({ on: false });
		expect((await status()).on).toBe(false);
		expect(stakes.decorate([host])[0]?.highStakes).toBeUndefined();
		await ask({ t: "git-push", instanceId: "inst-7" }, "ok");
		await ask({ t: "stakes-set", instanceId: "inst-7", on: true }, "stakes");
		expect(await status()).toMatchObject({ on: true, covered: false });
	});

	it("plays an older companion with enabled: false: no capability, no highStakes, no stakes, never refuses", async () => {
		const { ask, stakes } = await setup({ enabled: false });
		expect(stakes.capabilities).toEqual({ canPr: true, canPrReview: true });
		expect(stakes.handles({ t: "stakes-get", reqId: 1, instanceId: "inst-7" })).toBe(false);
		expect(stakes.handles({ t: "git-review", reqId: 1, instanceId: "inst-7" })).toBe(true);
		expect(stakes.decorate([host])[0]?.highStakes).toBeUndefined();
		const review = (await ask({ t: "git-review", instanceId: "inst-7" }, "review")).review;
		expect(review.stakes).toBeUndefined();
		await ask({ t: "git-push", instanceId: "inst-7" }, "ok");
	});
});
