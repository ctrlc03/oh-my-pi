/**
 * High-stakes sessions for scripts/mock-companion.ts, so the mode, the blocked buttons and the quiz that unlocks them can be
 * tried in a browser: `stakes-get`, `-set`, `-quiz` and `-settings` (the contract is `@oh-my-pi/pi-wire/stakes`), the host rows'
 * `highStakes`, and, because a push needs something to push, canned `git-review`, `git`, `git-diff`, `git-commit`, `git-push`,
 * `pr-create`, `git-message` and `pr-merge` for every listed session (the push, pull request and merge refuse as the real
 * companion's endpoints do while the session is high stakes and its changes are not covered).
 *
 * State lives in memory. A session is covered once a finished attempt that asks every question of its stakes quiz scores at
 * least the pass mark (compared with `quizPassed`, so 17.5 of 20 does not pass 90 %). The stakes quiz has ten choice questions
 * (`a` is right), so answering six of them `a` fails at 60 % and ten of them passes. Anything the agent edits afterwards makes
 * the next quiz cover only the changes since the pass (`needs: "delta"`): `touch <--dir>/stakes-edit` simulates such an edit in
 * every high-stakes session (the file is consumed on the next request or tick).
 *
 * A change of the mode appends the marker text to `<markers file>`, which `scripts/mock-host.ts --stakes-markers <file>` turns
 * into the visible `high-stakes` message the real session writes into its transcript.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Quiz, QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import {
	isPassMark,
	quizPassed,
	STAKES_DEFAULT_PASS_MARK,
	STAKES_MAX_PASS_MARK,
	STAKES_MIN_PASS_MARK,
	STAKES_REFUSAL_ASK,
	STAKES_REFUSAL_LEAD,
	type QuizStakes,
	type StakesChangedFrame,
	type StakesPassInfo,
	type StakesStatus,
} from "@oh-my-pi/pi-wire/stakes";
import type {
	CompanionHost,
	CompanionIdleSession,
	CompanionReply,
	CompanionRequest,
	GitCommit,
	GitFileChange,
	GitReview,
} from "../src/lib/companion";
import type { MockQuizStakes } from "./mock-quiz";

const HANDLED_ALWAYS = new Set([
	"git",
	"git-diff",
	"git-review",
	"git-review-diff",
	"git-commit",
	"git-push",
	"pr-create",
	"git-message",
	"pr-merge",
]);
const HANDLED_STAKES = new Set(["stakes-get", "stakes-set", "stakes-quiz", "stakes-settings"]);

const REMOTE = "https://github.com/example/app";
const FILES: GitFileChange[] = [
	{ path: "src/api/list.ts", status: " M", added: 42, removed: 7 },
	{ path: "src/api/cursor.ts", status: "??", added: 18, removed: 0 },
	{ path: "test/list.test.ts", status: " M", added: 25, removed: 3 },
];
const DIFF = `--- a/src/api/list.ts
+++ b/src/api/list.ts
@@ -1,6 +1,9 @@
 export async function list(db: Db, query: ListQuery) {
-	return db.all("select * from items");
+	const page = await db.page("items", { after: query.cursor, limit: query.limit ?? 50 });
+	return { items: page.rows, next: page.next };
 }
`;

/** One session's mode, passes and the canned checkout its push would publish. */
interface Session {
	on: boolean;
	/** The checkout's changes are covered by a pass (always so while the mode is off). */
	covered: boolean;
	passes: number;
	passed?: StakesPassInfo;
	/** The quiz for what is needed now; cleared when the agent edits again. */
	quiz?: { id: string; delta: boolean };
	best?: { points: number; total: number };
	git: { dirty: boolean; pushed: boolean; commits: GitCommit[]; pr: GitReview["pr"] };
}

/** A quiz made for a session's push. */
interface StakesQuizRecord {
	instanceId: string;
	sessionId: string;
	delta: boolean;
	passedAttempt?: string;
}

export interface MockStakes {
	/** Fields the mock companion's `hosts` frame needs: `canHighStakes` (unless the mock plays an older companion) and the push and pull request flows. */
	capabilities: { canHighStakes?: true; canPr: true; canPrReview: true };
	handles(request: CompanionRequest): boolean;
	/** `device` is the name the mode change is logged under. */
	answer(request: CompanionRequest, device: string): Promise<CompanionReply>;
	/** Rows of the `hosts` frame, with `highStakes` set on the high-stakes sessions. */
	decorate<T extends CompanionHost | CompanionIdleSession>(rows: readonly T[]): T[];
	/** A session started with `highStakes: true`. */
	started(instanceId: string): void;
	/** The agent edited the checkout of `instanceId` (every high-stakes session when omitted): the next push needs a quiz on what is new. */
	edit(instanceId?: string): void;
	/** Consume the `stakes-edit` trigger file when it exists. */
	tick(): Promise<void>;
	/** What the mock quiz needs to carry the stakes of its quizzes. */
	quizHook: MockQuizStakes;
}

export function createMockStakes(options: {
	/** False plays a companion that predates high stakes: no capability, no `highStakes`, no `stakes` anywhere. */
	enabled: boolean;
	/** The state directory: `stakes-edit` in it is the edit trigger. */
	dir: string;
	hosts: readonly CompanionHost[];
	idle: readonly CompanionIdleSession[];
	/** Instance ids that start high stakes. */
	initiallyOn: readonly string[];
	/** The session whose transcript the mock host serves, and the file its markers are appended to. */
	marker: { instanceId: string; file: string } | undefined;
	/** Make the ready quiz of `delta`'s kind in the mock quiz. */
	addQuiz(id: string, sessionId: string, delta: boolean): void;
	/** Push a frame to every device. */
	broadcastFrame(frame: StakesChangedFrame): void;
	/** The mode of a row changed: the `hosts` frame is sent again. */
	onHostsChanged(): void;
}): MockStakes {
	const sessions = new Map<string, Session>();
	const quizzes = new Map<string, StakesQuizRecord>();
	const editFile = path.join(options.dir, "stakes-edit");
	let passMark = STAKES_DEFAULT_PASS_MARK;
	let quizCounter = 0;

	const rowOf = (instanceId: string): CompanionHost | CompanionIdleSession => {
		const row =
			options.hosts.find(host => host.instanceId === instanceId) ??
			options.idle.find(s => s.instanceId === instanceId);
		if (row === undefined) throw new Error(`no session ${instanceId}`);
		return row;
	};
	const sessionOf = (instanceId: string): Session => {
		let session = sessions.get(instanceId);
		if (session === undefined) {
			const on = options.initiallyOn.includes(instanceId);
			session = {
				on,
				covered: !on,
				passes: 0,
				git: { dirty: true, pushed: false, commits: [], pr: null },
			};
			sessions.set(instanceId, session);
		}
		return session;
	};
	const blocked = (session: Session): boolean => options.enabled && session.on && !session.covered;
	const needs = (session: Session): StakesStatus["needs"] =>
		!blocked(session) ? "none" : session.passes > 0 ? "delta" : "full";

	const statusOf = (instanceId: string): StakesStatus => {
		const row = rowOf(instanceId);
		const session = sessionOf(instanceId);
		const status: StakesStatus = {
			sessionId: row.sessionId,
			on: session.on,
			passMark,
			covered: !blocked(session),
			needs: needs(session),
			hook: "installed",
			message: "",
		};
		if (session.passed !== undefined) status.passed = session.passed;
		if (session.on && session.covered && session.passed !== undefined) status.coveredBy = "pass";
		if (!blocked(session)) return status;
		status.message =
			status.needs === "delta"
				? "Pass a quiz on the changes since your last pass to push."
				: "Pass a quiz on this session's changes to push.";
		if (session.quiz !== undefined) {
			status.quiz = { id: session.quiz.id, status: "ready", delta: session.quiz.delta };
			if (session.best !== undefined) status.quiz.best = session.best;
		}
		return status;
	};

	const refusal = (session: Session): string =>
		`${STAKES_REFUSAL_LEAD} ${
			needs(session) === "delta"
				? "The changes since the last passed quiz are not covered yet."
				: "No passed quiz covers this session's changes yet."
		} ${STAKES_REFUSAL_ASK}`;
	/** The companion's endpoints for a push, a pull request and a merge refuse while the session is high stakes and not covered. */
	const refuseIfBlocked = (instanceId: string): Session => {
		const session = sessionOf(instanceId);
		if (blocked(session)) throw new Error(refusal(session));
		return session;
	};

	const changed = (instanceId: string): void =>
		options.broadcastFrame({ t: "stakes-changed", sessionId: rowOf(instanceId).sessionId });

	const writeMarker = async (instanceId: string, on: boolean, device: string): Promise<void> => {
		if (options.marker === undefined || options.marker.instanceId !== instanceId) return;
		const text = on
			? `High-stakes mode was turned on by ${device}. Pushes and pull requests need a passed quiz.`
			: `High-stakes mode was turned off by ${device}. Pushes and pull requests are no longer blocked.`;
		await fs.appendFile(options.marker.file, `${text}\n`);
	};

	const edit = (instanceId?: string): void => {
		for (const row of [...options.hosts, ...options.idle]) {
			const session = sessionOf(row.instanceId);
			if (!session.on || (instanceId !== undefined && row.instanceId !== instanceId)) continue;
			session.covered = false;
			session.quiz = undefined;
			session.best = undefined;
			session.git.dirty = true;
			session.git.pushed = false;
			changed(row.instanceId);
		}
	};

	const tick = async (): Promise<void> => {
		if (!(await Bun.file(editFile).exists())) return;
		await fs.rm(editFile, { force: true });
		edit();
	};

	const reviewOf = (instanceId: string): GitReview => {
		const row = rowOf(instanceId);
		const { git } = sessionOf(instanceId);
		const review: GitReview = {
			root: row.cwd,
			branch: "feature/pagination",
			base: "origin/main",
			mergeBase: "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22",
			isDefaultBranch: false,
			dirty: git.dirty,
			files: FILES.map(file => ({ ...file })),
			commits: git.commits.map(commit => ({ ...commit })),
			remote: REMOTE,
			pushed: git.pushed,
			pr: git.pr,
			worktree: false,
		};
		if (options.enabled) review.stakes = statusOf(instanceId);
		return review;
	};

	const quizHook: MockQuizStakes = {
		of(id): QuizStakes | undefined {
			const record = quizzes.get(id);
			if (record === undefined) return undefined;
			const stakes: QuizStakes = { sessionId: record.sessionId, delta: record.delta, passMark };
			if (record.passedAttempt !== undefined) stakes.passedAttempt = record.passedAttempt;
			return stakes;
		},
		finished(quiz: Quiz, attempt: QuizAttempt): void {
			const record = quizzes.get(quiz.id);
			if (record === undefined || record.passedAttempt !== undefined) return;
			// Only an attempt at every question can pass.
			if (!quiz.questions.every(question => attempt.questions.includes(question.id))) return;
			const session = sessionOf(record.instanceId);
			const { points, total } = attempt.score;
			if (!quizPassed(points, total, passMark)) {
				if (session.best === undefined || points > session.best.points) session.best = { points, total };
				changed(record.instanceId);
				return;
			}
			record.passedAttempt = attempt.id;
			session.covered = true;
			session.passes++;
			session.passed = { at: Date.now(), quizId: quiz.id, points, total, delta: record.delta };
			changed(record.instanceId);
		},
	};

	return {
		capabilities: {
			...(options.enabled ? { canHighStakes: true as const } : {}),
			canPr: true,
			canPrReview: true,
		},
		handles: request => HANDLED_ALWAYS.has(request.t) || (options.enabled && HANDLED_STAKES.has(request.t)),
		decorate: rows =>
			options.enabled
				? rows.map(row => (sessionOf(row.instanceId).on ? { ...row, highStakes: true } : row))
				: [...rows],
		started(instanceId) {
			if (!options.enabled) return;
			const session = sessionOf(instanceId);
			session.on = true;
			session.covered = false;
			options.onHostsChanged();
		},
		edit,
		tick,
		quizHook,
		async answer(request, device): Promise<CompanionReply> {
			await tick();
			switch (request.t) {
				case "stakes-get":
					return { t: "stakes", reqId: request.reqId, status: statusOf(request.instanceId) };
				case "stakes-set": {
					const session = sessionOf(request.instanceId);
					if (!request.on && request.confirmOff !== true)
						throw new Error("Turning high stakes off needs the person's confirmation.");
					if (session.on !== request.on) {
						session.on = request.on;
						session.covered = !request.on;
						await writeMarker(request.instanceId, request.on, device);
						changed(request.instanceId);
						options.onHostsChanged();
					}
					return { t: "stakes", reqId: request.reqId, status: statusOf(request.instanceId) };
				}
				case "stakes-quiz": {
					const row = rowOf(request.instanceId);
					const session = sessionOf(request.instanceId);
					if (!blocked(session))
						throw new Error("This session is not high stakes, or its changes are already covered.");
					if (session.quiz !== undefined)
						return { t: "stakes-quiz", reqId: request.reqId, ...session.quiz, created: false };
					const delta = session.passes > 0;
					const id = `qz-stakes-${++quizCounter}`;
					quizzes.set(id, { instanceId: request.instanceId, sessionId: row.sessionId, delta });
					options.addQuiz(id, row.sessionId, delta);
					session.quiz = { id, delta };
					changed(request.instanceId);
					return { t: "stakes-quiz", reqId: request.reqId, id, delta, created: true };
				}
				case "stakes-settings": {
					if (request.passMark !== undefined) {
						if (!isPassMark(request.passMark))
							throw new Error(
								`The pass mark is a whole percent from ${STAKES_MIN_PASS_MARK} to ${STAKES_MAX_PASS_MARK}.`,
							);
						passMark = request.passMark;
						for (const [id, session] of sessions) if (session.on) changed(id);
					}
					return { t: "stakes-settings", reqId: request.reqId, settings: { passMark } };
				}
				case "git": {
					const row = rowOf(request.instanceId);
					const { git } = sessionOf(request.instanceId);
					return {
						t: "git",
						reqId: request.reqId,
						git: {
							root: row.cwd,
							branch: "feature/pagination",
							upstream: git.pushed ? "origin/feature/pagination" : null,
							ahead: git.pushed ? 0 : git.commits.length,
							behind: 0,
							files: git.dirty ? FILES.map(file => ({ ...file })) : [],
							commits: git.commits.map(commit => ({ ...commit })),
						},
					};
				}
				case "git-diff":
				case "git-review-diff":
					return { t: "diff", reqId: request.reqId, diff: DIFF, truncated: false };
				case "git-review":
					return { t: "review", reqId: request.reqId, review: reviewOf(request.instanceId) };
				case "git-commit": {
					const { git } = sessionOf(request.instanceId);
					git.dirty = false;
					git.pushed = false;
					git.commits = [
						{
							hash: Math.random().toString(16).slice(2, 9),
							subject: request.message.split("\n", 1)[0] ?? "",
							author: "mock-user",
							time: Date.now(),
						},
						...git.commits,
					];
					return { t: "ok", reqId: request.reqId };
				}
				case "git-push": {
					const { git } = refuseIfBlocked(request.instanceId);
					git.pushed = true;
					return { t: "ok", reqId: request.reqId };
				}
				case "pr-create": {
					const { git } = refuseIfBlocked(request.instanceId);
					if (!git.pushed) throw new Error("Push the branch first.");
					git.pr = { number: 501, url: `${REMOTE}/pull/501`, state: "OPEN", title: request.title };
					return { t: "link", reqId: request.reqId, url: git.pr.url };
				}
				case "git-message":
					return {
						t: "git-message",
						reqId: request.reqId,
						text: {
							commit: request.commit ? "Paginate the list endpoints" : "",
							prTitle: request.pr ? "Paginate the list endpoints" : "",
							prBody: request.pr ? "List endpoints take a cursor and a limit and return the next cursor." : "",
							source: "fallback",
							note: "The mock companion writes no text with a model.",
						},
					};
				case "pr-merge":
					refuseIfBlocked(request.instanceId);
					return { t: "ok", reqId: request.reqId };
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
