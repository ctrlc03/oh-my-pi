import { afterEach, describe, expect, it } from "bun:test";
import type { Quiz, QuizFolder } from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_VERSION } from "@oh-my-pi/pi-wire/quiz";
import {
	aboutTags,
	buildCreate,
	effectiveFocus,
	focusChoices,
	isGitFolder,
	NO_CODE_REASON,
	type QuizFormValues,
	quizChoices,
	subjectOf,
} from "../src/components/quiz/quiz-flow";
import {
	CompanionClient,
	type CompanionHost,
	type CompanionReply,
	type CompanionRequest,
	INITIAL_SNAPSHOT,
} from "../src/lib/companion";
import { generateRoomKey, importRoomKey } from "../src/lib/codec";
import { topicQuizOffered } from "../src/lib/computers";
import { formatCollabLink, generateRoomId, parseCollabLink } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";
import { startLocalRelay } from "../scripts/local-relay";

const folder = (over: Partial<QuizFolder> = {}): QuizFolder => ({
	git: true,
	code: true,
	files: 12,
	name: "repo",
	...over,
});

const values: QuizFormValues = {
	cwd: "/work/repo",
	subject: { kind: "topic" },
	sessionId: "session-1",
	useConversation: true,
	stack: [],
	scope: "stack",
	focus: "mixed",
	canTopic: true,
	limit: "1",
	model: "",
};

describe("which subjects the new-quiz form offers", () => {
	const session = { sessionId: "session-1", subject: { kind: "changes" } as const };

	it("offers the diff subjects and, beside them, the topic where the computer writes topic quizzes and a session is open", () => {
		expect(quizChoices({ ...session, canTopic: true, git: true })).toEqual(["changes", "branch", "pr", "topic"]);
		expect(quizChoices({ ...session, canTopic: false, git: true })).toEqual(["changes", "branch", "pr"]);
		expect(
			quizChoices({
				...session,
				canTopic: true,
				git: true,
				sessionId: null,
				subject: { kind: "branch", name: "x" },
			}),
		).toEqual(["branch", "pr"]);
	});

	it("keeps the session's changes for a form that was opened on them even without a session id", () => {
		expect(quizChoices({ ...session, canTopic: false, git: true, sessionId: null })).toEqual([
			"changes",
			"branch",
			"pr",
		]);
		expect(
			quizChoices({ sessionId: null, canTopic: false, git: true, subject: { kind: "branch", name: "x" } }),
		).toEqual(["branch", "pr"]);
	});

	it("offers only the topic for a folder that is not a git repository", () => {
		expect(quizChoices({ ...session, canTopic: true, git: false })).toEqual(["topic"]);
	});

	it("takes a scratch folder or a folder the companion calls not-git for one, and assumes a repository otherwise", () => {
		expect(isGitFolder("/work/repo", true, null)).toBe(true);
		expect(isGitFolder("/work/repo", true, folder({ git: false }))).toBe(false);
		expect(isGitFolder("/home/me/.omp/agent/scratch/2026-10-15-notes-ab12cd", true, null)).toBe(false);
		// A companion that writes no topic quizzes cannot quiz such a folder at all: the form stays as it was.
		expect(isGitFolder("/work/repo", false, folder({ git: false }))).toBe(true);
	});
});

describe("the focus of a quiz", () => {
	it("lists Mixed, Understanding, Design and Implementation, all enabled when nothing is known about the folder", () => {
		const choices = focusChoices("topic", null);
		expect(choices.map(choice => choice.value)).toEqual(["mixed", "understanding", "design", "implementation"]);
		expect(choices.map(choice => choice.label)).toEqual(["Mixed", "Understanding", "Design", "Implementation"]);
		expect(choices.every(choice => choice.disabled === null)).toBe(true);
		expect(focusChoices("topic", folder()).every(choice => choice.disabled === null)).toBe(true);
	});

	it("disables Implementation, with the reason, for the topic of a folder without code", () => {
		const choices = focusChoices("topic", folder({ code: false }));
		expect(choices.find(choice => choice.value === "implementation")?.disabled).toBe(NO_CODE_REASON);
		expect(choices.filter(choice => choice.disabled !== null)).toHaveLength(1);
		// A diff quiz has code by definition.
		expect(focusChoices("changes", folder({ code: false })).every(choice => choice.disabled === null)).toBe(true);
	});

	it("falls back to Mixed when the picked focus became disabled", () => {
		const none = focusChoices("topic", folder({ code: false }));
		expect(effectiveFocus("implementation", none)).toBe("mixed");
		expect(effectiveFocus("design", none)).toBe("design");
		expect(effectiveFocus("implementation", focusChoices("topic", null))).toBe("implementation");
	});
});

describe("the request a topic form makes", () => {
	it("asks for the topic of the session, with no ref, base, pull request or stack", () => {
		expect(buildCreate(values)).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, subject: "session", sessionId: "session-1" },
		});
		const made = buildCreate({
			...values,
			stack: [
				{ number: 1, title: "one", head: "a", base: "b" },
				{ number: 2, title: "two", head: "b", base: "c" },
			],
		});
		if (!("request" in made)) throw new Error(made.error);
		for (const key of ["ref", "base", "pr", "stack"] as const) expect(made.request[key]).toBeUndefined();
	});

	it("sends the focus unless it is Mixed, for every subject", () => {
		expect(buildCreate({ ...values, focus: "design" })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, subject: "session", sessionId: "session-1", focus: "design" },
		});
		expect(buildCreate({ ...values, subject: { kind: "changes" }, focus: "implementation" })).toEqual({
			request: {
				cwd: "/work/repo",
				maxCostUsd: 1,
				ref: "@worktree",
				base: "@default",
				sessionId: "session-1",
				focus: "implementation",
			},
		});
		expect(
			buildCreate({ ...values, subject: { kind: "branch", name: "feature/x" }, focus: "understanding" }),
		).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, ref: "feature/x", base: "@default", focus: "understanding" },
		});
		expect(buildCreate({ ...values, subject: { kind: "pr", number: 7, title: "seven" }, focus: "design" })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, pr: 7, focus: "design" },
		});
		const mixed = buildCreate({ ...values, subject: { kind: "changes" } });
		expect("request" in mixed && "focus" in mixed.request).toBe(false);
	});

	it("leaves the focus and the subject out for a companion without topic quizzes", () => {
		const made = buildCreate({ ...values, subject: { kind: "changes" }, canTopic: false, focus: "design" });
		expect(made).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, ref: "@worktree", base: "@default", sessionId: "session-1" },
		});
	});

	it("needs a session for the topic", () => {
		expect(buildCreate({ ...values, sessionId: null })).toHaveProperty("error");
	});
});

describe("quizzes that are about a topic", () => {
	const quiz = (over: Partial<Quiz>): Quiz => ({
		v: QUIZ_VERSION,
		id: "q",
		title: "t",
		repo: { root: "/work/repo", name: "repo" },
		createdAt: 1,
		parts: [{ index: 0, title: "Topic", head: { commit: "folder" } }],
		questions: [],
		warnings: [],
		...over,
	});

	it("offers another quiz on the topic of a topic quiz, and the changes otherwise", () => {
		expect(subjectOf(quiz({ about: "session" }))).toEqual({ kind: "topic" });
		expect(subjectOf(quiz({ about: "changes" }))).toEqual({ kind: "changes" });
		expect(subjectOf(quiz({}))).toEqual({ kind: "changes" });
	});

	it("tags a topic quiz and a focus that is not Mixed, and an old quiz with nothing", () => {
		expect(aboutTags({})).toEqual([]);
		expect(aboutTags({ about: "changes", focus: "mixed" })).toEqual([]);
		expect(aboutTags({ about: "session" })).toEqual(["Topic"]);
		expect(aboutTags({ about: "session", focus: "implementation" })).toEqual(["Topic", "Implementation"]);
		expect(aboutTags({ focus: "design" })).toEqual(["Design"]);
	});
});

const host: CompanionHost = {
	instanceId: "inst-7",
	sessionId: "session-7",
	sessionName: "notes",
	cwd: "/work/notes",
	model: null,
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
};

const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** A companion room over the local relay whose hello carries `capabilities`, and a client paired to it. */
async function connect(capabilities: { canQuiz?: boolean; canQuizTopic?: boolean }): Promise<CompanionClient> {
	const relay = startLocalRelay(0);
	stops.push(() => relay.stop());
	const rawKey = generateRoomKey();
	const link = formatCollabLink(relay.url, generateRoomId(), rawKey);
	const room = parseCollabLink(link);
	if ("error" in room) throw new Error(room.error);
	const socket = new CollabSocket<CompanionReply, CompanionRequest>({
		wsUrl: room.wsUrl,
		role: "host",
		key: importRoomKey(rawKey),
	});
	stops.push(() => socket.close());
	socket.onFrame = (frame, peer) => {
		if (frame.t !== "auth") return;
		socket.send({ t: "authed", deviceId: `device-${peer}` }, peer);
		socket.send({ t: "hosts", machine: "mock", hosts: [host], idle: [], vapidKey: "", ...capabilities }, peer);
	};
	socket.connect();
	const client = new CompanionClient({ link }, () => {});
	stops.push(() => client.close());
	const live = new Promise<void>(resolve => {
		const stop = client.subscribe(() => {
			if (client.getSnapshot().phase !== "live") return;
			stop();
			resolve();
		});
	});
	client.connect();
	await live;
	return client;
}

describe("a companion that predates topic quizzes (compatibility)", () => {
	it("reads no canQuizTopic in its hello as false, with canQuiz as sent", async () => {
		expect(INITIAL_SNAPSHOT.canQuizTopic).toBe(false);
		const { canQuiz, canQuizTopic } = (await connect({ canQuiz: true })).getSnapshot();
		expect(canQuiz).toBe(true);
		expect(canQuizTopic).toBe(false);
	});

	it("offers the diff quiz only: no topic subject, no Focus request, no ⋯ entry", async () => {
		const { canQuizTopic, canQuiz } = (await connect({ canQuiz: true })).getSnapshot();
		expect(topicQuizOffered({ canQuiz, canQuizTopic }, "session-7")).toBe(false);
		expect(
			quizChoices({
				canTopic: canQuizTopic,
				sessionId: "session-7",
				git: isGitFolder("/work/notes", canQuizTopic, null),
				subject: { kind: "changes" },
			}),
		).toEqual(["changes", "branch", "pr"]);
		// Even a stale focus choice is not put on the wire.
		const made = buildCreate({ ...values, subject: { kind: "changes" }, canTopic: canQuizTopic, focus: "design" });
		if (!("request" in made)) throw new Error(made.error);
		expect(made.request.focus).toBeUndefined();
		expect(made.request.subject).toBeUndefined();
	});

	it("offers the topic, the Focus and the ⋯ entry once the hello carries canQuizTopic", async () => {
		const { canQuizTopic, canQuiz } = (await connect({ canQuiz: true, canQuizTopic: true })).getSnapshot();
		expect(canQuizTopic).toBe(true);
		expect(topicQuizOffered({ canQuiz, canQuizTopic }, "session-7")).toBe(true);
		expect(topicQuizOffered({ canQuiz, canQuizTopic }, null)).toBe(false);
		expect(topicQuizOffered({ canQuiz: false, canQuizTopic }, "session-7")).toBe(false);
		expect(
			quizChoices({ canTopic: canQuizTopic, sessionId: "session-7", git: true, subject: { kind: "changes" } }),
		).toContain("topic");
	});
});
