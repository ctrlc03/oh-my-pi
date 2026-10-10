import { describe, expect, it } from "bun:test";
import type { CollabCommand, HostFrame, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { applySlash, matchArgument, matchSlash, slashQuery, usableCommands } from "../src/lib/slash-menu";

const COMMANDS: CollabCommand[] = [
	{ name: "plan", description: "Start plan mode" },
	{ name: "skill:review", description: "Review the current changes" },
	{ name: "fix-tests", description: "Make the failing tests pass", args: "[file]" },
	{ name: "retry" },
];

describe("slashQuery", () => {
	it("opens only while the draft is one slash token", () => {
		expect(slashQuery("/")).toBe("");
		expect(slashQuery("/pl")).toBe("pl");
		expect(slashQuery("/skill:rev")).toBe("skill:rev");
		expect(slashQuery("")).toBeNull();
		expect(slashQuery("plan")).toBeNull();
		expect(slashQuery("look at /plan")).toBeNull();
		// An argument or a second line means the command is written: no popup.
		expect(slashQuery("/plan ")).toBeNull();
		expect(slashQuery("/plan the work")).toBeNull();
		expect(slashQuery("/plan\nmore")).toBeNull();
	});
});

describe("matchSlash", () => {
	it("lists every host command for a bare slash, in host order", () => {
		const items = matchSlash("", COMMANDS, []);
		expect(items.map(i => (i.kind === "saved" ? i.text : i.command.name))).toEqual([
			"plan",
			"skill:review",
			"fix-tests",
			"retry",
		]);
	});

	it("ranks a prefix above a later word, above a substring, above a description hit", () => {
		const commands: CollabCommand[] = [
			{ name: "xtest" },
			{ name: "run-test" },
			{ name: "a", description: "runs the test suite" },
			{ name: "test-all" },
		];
		const names = matchSlash("test", commands, []).map(i => (i.kind === "command" ? i.command.name : ""));
		expect(names).toEqual(["test-all", "run-test", "xtest", "a"]);
	});

	it("matches case-insensitively and drops non-matches", () => {
		const names = matchSlash("REV", COMMANDS, []).map(i => (i.kind === "command" ? i.command.name : ""));
		expect(names).toEqual(["skill:review"]);
		expect(matchSlash("zzz", COMMANDS, [])).toEqual([]);
	});

	it("appends saved prompts that contain the query after the commands", () => {
		const items = matchSlash("plan", COMMANDS, ["Plan the next steps", "Run the tests"]);
		expect(items).toEqual([
			{ kind: "command", command: COMMANDS[0] },
			{ kind: "saved", text: "Plan the next steps" },
		]);
	});

	it("offers saved prompts when the host lists no commands (older host)", () => {
		expect(matchSlash("", [], ["Continue"])).toEqual([{ kind: "saved", text: "Continue" }]);
	});
});

describe("applySlash", () => {
	it("completes a command to `/name ` and a saved prompt to its text", () => {
		expect(applySlash({ kind: "command", command: COMMANDS[1]! })).toBe("/skill:review ");
		expect(applySlash({ kind: "saved", text: "Run the tests" })).toBe("Run the tests");
	});
});

describe("argument suggestions", () => {
	const resume: CollabCommand = {
		name: "resume",
		args: "<session>",
		choices: [
			{ value: "5f3a9c1e", label: "migrate settings", description: "42 messages" },
			{ value: "c07d44b2", label: "relay audit", description: "18 messages" },
		],
		switchesSession: true,
	};
	const commands: CollabCommand[] = [
		{ name: "model", args: "<provider/id>" },
		{ name: "effort", args: "<level>" },
		resume,
	];
	const sources = {
		models: [
			{ id: "big", name: "Big", provider: "acme", contextWindow: null },
			{ id: "small", name: "Small", provider: "acme", contextWindow: null },
		],
		thinkingLevels: ["off", "low", "high"],
	};
	const values = (draft: string) =>
		matchArgument(draft, commands, sources).map(item => (item.kind === "choice" ? item.choice.value : ""));

	it("suggests models for /model and the session's thinking levels for /effort", () => {
		expect(values("/model ")).toEqual(["acme/big", "acme/small"]);
		expect(values("/model sma")).toEqual(["acme/small"]);
		expect(values("/effort h")).toEqual(["high"]);
		expect(values("/effort ")).toEqual(["off", "low", "high"]);
	});

	it("suggests what the host listed for a command, matching its title and description too", () => {
		expect(values("/resume ")).toEqual(["5f3a9c1e", "c07d44b2"]);
		expect(values("/resume audit")).toEqual(["c07d44b2"]);
		expect(values("/resume 18 mess")).toEqual(["c07d44b2"]);
	});

	it("offers nothing without a space after the name, for an unlisted command, or once the argument spans lines", () => {
		expect(values("/model")).toEqual([]);
		expect(values("/ghost ")).toEqual([]);
		expect(values("/resume x\ny")).toEqual([]);
		expect(matchArgument("/model ", commands, { models: null, thinkingLevels: undefined })).toEqual([]);
	});

	it("completes a picked suggestion to the full command", () => {
		const [first] = matchArgument("/resume ", commands, sources);
		expect(first && applySlash(first)).toBe("/resume 5f3a9c1e");
	});

	it("hides the commands that end the room unless a paired computer brings the guest along", () => {
		expect(usableCommands(commands, true)).toEqual(commands);
		expect(usableCommands(commands, false).map(command => command.name)).toEqual(["model", "effort"]);
	});
});

describe("GuestClient commands", () => {
	const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(48))}`;
	const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
	const STATE: SessionState = {
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/work",
		participants: [{ name: "host", role: "host" }],
	};
	const welcome = (commands?: CollabCommand[]): HostFrame => ({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: [],
		entryCount: 0,
		features: commands ? ["commands"] : [],
		commands,
	});

	it("takes the command list from the welcome and has none from a host that predates it", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().commands).toEqual([]);
		client.applyFrameForTest(welcome(COMMANDS));
		expect(client.getSnapshot().commands).toEqual(COMMANDS);
		client.applyFrameForTest(welcome());
		expect(client.getSnapshot().commands).toEqual([]);
	});
});
