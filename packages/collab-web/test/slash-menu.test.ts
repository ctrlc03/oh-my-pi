import { describe, expect, it } from "bun:test";
import type { CollabCommand, HostFrame, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { applySlash, matchSlash, slashQuery } from "../src/lib/slash-menu";

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
		expect(items.map(i => (i.kind === "command" ? i.command.name : i.text))).toEqual([
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
