import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listCollabHosts } from "@oh-my-pi/pi-coding-agent/collab/registry";
import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ForeignHost, type ForeignHostOptions } from "../scripts/foreign/foreign-host";
import { readForeignIndex } from "../scripts/foreign/foreign-index";
import { transcriptPath } from "../scripts/foreign/transcript-store";
import { type LocalRelay, startLocalRelay } from "../scripts/local-relay";
import { GuestClient, type GuestSnapshot } from "../src/lib/client";

setDefaultTimeout(30_000);

const FAKE_AGENT = path.join(import.meta.dir, "fixtures", "fake-acp-agent.ts");
const WAIT_MS = 15_000;

interface Rig {
	dir: string;
	configDir: string;
	agentDir: string;
	cwd: string;
	registryDir: string;
	relay: LocalRelay;
	host: ForeignHost;
	guest: GuestClient;
}

let rigs: Rig[] = [];
const guests: GuestClient[] = [];

function waitFor(
	guest: GuestClient,
	ok: (snapshot: GuestSnapshot) => boolean,
	label: string,
	ms = WAIT_MS,
): Promise<GuestSnapshot> {
	const { promise, resolve, reject } = Promise.withResolvers<GuestSnapshot>();
	let unsubscribe: (() => void) | null = null;
	const timer = setTimeout(() => {
		unsubscribe?.();
		reject(new Error(`timed out waiting for ${label}`));
	}, ms);
	const check = (): void => {
		const snapshot = guest.getSnapshot();
		if (!ok(snapshot)) return;
		clearTimeout(timer);
		unsubscribe?.();
		resolve(snapshot);
	};
	unsubscribe = guest.subscribe(check);
	check();
	return promise;
}

function hostOptions(
	rig: Pick<Rig, "configDir" | "agentDir" | "cwd" | "registryDir" | "relay">,
	extra: Partial<ForeignHostOptions> = {},
	env: Record<string, string> = {},
): ForeignHostOptions {
	return {
		configDir: rig.configDir,
		agent: { id: "claude", name: "Claude Code" },
		cwd: rig.cwd,
		permission: "supervised",
		relayUrl: rig.relay.url,
		registryDir: rig.registryDir,
		launch: async (_id, launch) => ({
			command: [process.execPath, FAKE_AGENT],
			env: { PATH: process.env.PATH ?? "", FAKE_ACP_DIR: rig.agentDir, ...env },
			cwd: launch.cwd,
		}),
		...extra,
	};
}

function connect(link: string, name = "tester"): GuestClient {
	const guest = new GuestClient(link, name, null);
	guests.push(guest);
	guest.connect();
	return guest;
}

async function boot(
	extra: Partial<ForeignHostOptions> = {},
	options: { git?: boolean; plantedGitDir?: boolean; env?: Record<string, string> } = {},
): Promise<Rig> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreign-host-"));
	const rig = {
		dir,
		configDir: path.join(dir, "config"),
		agentDir: path.join(dir, "agent"),
		cwd: path.join(dir, "work"),
		registryDir: path.join(dir, "run"),
		relay: startLocalRelay(0),
	};
	await fs.mkdir(rig.agentDir, { recursive: true });
	await fs.mkdir(rig.cwd, { recursive: true });
	if (options.git) {
		await fs.writeFile(path.join(rig.cwd, "tracked.txt"), "one\n");
		const run = (...args: string[]): void => {
			execFileSync("git", args, {
				cwd: rig.cwd,
				stdio: "ignore",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
		};
		run("init", "-q", ...(options.plantedGitDir ? ["--separate-git-dir", path.join(rig.cwd, "planted.git")] : []));
		run("add", ".");
		run("commit", "-q", "-m", "init");
	}
	const host = new ForeignHost(hostOptions(rig, extra, options.env));
	await host.start();
	const guest = connect(host.links.control);
	const full: Rig = { ...rig, host, guest };
	rigs.push(full);
	await waitFor(guest, snapshot => snapshot.phase === "live" && snapshot.loading === null, "the guest to go live");
	return full;
}

async function agentLog(rig: Rig): Promise<Record<string, unknown>[]> {
	const text = await Bun.file(path.join(rig.agentDir, "log.jsonl"))
		.text()
		.catch(() => "");
	return text
		.split("\n")
		.filter(line => line !== "")
		.map(line => JSON.parse(line));
}

function assistants(snapshot: GuestSnapshot): AssistantMessage[] {
	return snapshot.entries.flatMap(entry =>
		entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
	);
}

function results(snapshot: GuestSnapshot): ToolResultMessage[] {
	return snapshot.entries.flatMap(entry =>
		entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
	);
}

function textOf(message: AssistantMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function hasText(snapshot: GuestSnapshot, text: string): boolean {
	return assistants(snapshot).some(message => textOf(message).includes(text));
}

function idle(snapshot: GuestSnapshot): boolean {
	return snapshot.state?.isStreaming === false && !snapshot.working;
}

function promptEntries(snapshot: GuestSnapshot): SessionEntry[] {
	return snapshot.entries.filter(entry => entry.type === "custom_message");
}

async function storedEntries(rig: Rig): Promise<Record<string, unknown>[]> {
	const text = await Bun.file(transcriptPath(rig.configDir, rig.host.sessionId)).text();
	return text
		.split("\n")
		.filter(line => line !== "")
		.map(line => JSON.parse(line));
}

beforeEach(() => {
	rigs = [];
});

afterEach(async () => {
	for (const guest of guests.splice(0)) guest.close();
	for (const rig of rigs) {
		await rig.host.stop("test over");
		rig.relay.stop();
		await fs.rm(rig.dir, { recursive: true, force: true });
	}
});

describe("foreign host: the room", () => {
	it("welcomes a guest with the agent, its models, commands and the host's features", async () => {
		const rig = await boot();
		const snapshot = rig.guest.getSnapshot();
		expect(snapshot.agent).toEqual({ id: "claude", name: "Claude Code" });
		expect(snapshot.models?.map(model => `${model.provider}/${model.id}`)).toEqual(["claude/fast", "claude/smart"]);
		expect(snapshot.models?.[0]?.thinkingLevels).toEqual(["low", "high"]);
		expect(snapshot.commands).toEqual([{ name: "review", description: "Review code", args: "path" }]);
		expect(Object.keys(snapshot.features).sort()).toEqual([
			"approval-grants",
			"commands",
			"follow-up",
			"permission-mode",
			"prompt-model",
			"rewind",
		]);
		expect(snapshot.state).toMatchObject({
			permission: "supervised",
			cwd: rig.cwd,
			thinkingLevel: "low",
			thinkingLevels: ["low", "high"],
		});
		expect(snapshot.state?.model).toMatchObject({ id: "fast", provider: "claude" });
		expect(snapshot.agents).toMatchObject([
			{ id: "main", displayName: "Claude Code", kind: "main", hasSessionFile: true },
		]);
		expect(snapshot.header).toMatchObject({ id: rig.host.sessionId, cwd: rig.cwd });
	});

	it("publishes the session to the local registry with its agent", async () => {
		const rig = await boot();
		const hosts = await listCollabHosts({ dir: rig.registryDir });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({
			sessionId: rig.host.sessionId,
			cwd: rig.cwd,
			agent: { id: "claude", name: "Claude Code" },
			model: { provider: "claude", id: "fast" },
			busy: false,
			relayConnected: true,
		});
	});

	it("serves a read-only guest the same session without its controls", async () => {
		const rig = await boot();
		const viewer = connect(rig.host.links.view, "viewer");
		const snapshot = await waitFor(viewer, s => s.phase === "live" && s.loading === null, "the viewer to go live");
		expect(snapshot.readOnly).toBe(true);
		expect(snapshot.models).toBeNull();
		expect(snapshot.agent).toEqual({ id: "claude", name: "Claude Code" });
		await waitFor(rig.guest, s => (s.state?.participants.length ?? 0) === 3, "both guests in the roster");
	});
});

describe("foreign host: a turn", () => {
	it("streams the agent's text, keeps the transcript and updates the index", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("hello there");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "Hello from the fake agent.") && idle(s), "the answer");
		const [prompt] = promptEntries(snapshot);
		expect(prompt).toMatchObject({
			type: "custom_message",
			customType: "collab-prompt",
			content: "hello there",
			details: { from: "tester" },
		});
		const [answer] = assistants(snapshot);
		expect(answer).toMatchObject({ stopReason: "stop", model: "fast", provider: "claude" });
		expect(snapshot.state?.contextUsage).toMatchObject({ tokens: 1234, contextWindow: 200000 });

		const stored = await storedEntries(rig);
		expect(stored[0]).toMatchObject({ type: "session", id: rig.host.sessionId, version: 3 });
		expect(stored.filter(entry => entry.type === "message" || entry.type === "custom_message")).toHaveLength(2);
		const row = (await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId];
		expect(row).toMatchObject({
			agent: "claude",
			model: "fast",
			permission: "supervised",
			adapterVersion: "9.9.9",
			cwd: rig.cwd,
		});
		expect(row?.nativeId).toMatch(/^fake-/);
		expect(row?.costUsd).toBeCloseTo(0.01, 5);
		expect(answer?.usage.cost.total).toBeCloseTo(0.01, 5);
	});

	it("serves the transcript file by byte range", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("hello");
		await waitFor(rig.guest, s => hasText(s, "Hello from") && idle(s), "the answer");
		const first = await rig.guest.fetchTranscript("main", 0);
		expect(first?.kind).toBe("rows");
		if (first?.kind !== "rows") throw new Error("no rows");
		expect(first.text).toContain('"type":"session"');
		expect(first.text).toContain("Hello ");
		const again = await rig.guest.fetchTranscript("main", first.newSize);
		expect(again).toEqual({ kind: "rows", text: "", newSize: first.newSize });
		expect(await rig.guest.fetchTranscript("nobody", 0)).toEqual({
			kind: "error",
			message: "no transcript available",
		});
	});

	it("shows a plan as a todo list", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("make a plan");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "Plan made.") && idle(s), "the plan");
		const call = assistants(snapshot)
			.flatMap(message => message.content)
			.find(block => block.type === "toolCall" && block.name === "todo");
		expect(call).toMatchObject({
			arguments: { op: "replace", list: [{ phase: "Plan", items: ["Look around", "Fix it"] }] },
		});
		expect(results(snapshot).find(result => result.toolName === "todo")?.details).toMatchObject({
			phases: [
				{
					name: "Plan",
					tasks: [
						{ content: "Look around", status: "completed" },
						{ content: "Fix it", status: "in_progress" },
					],
				},
			],
		});
	});

	it("stops a running turn and marks it aborted", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("go slow");
		await waitFor(rig.guest, s => hasText(s, "tick 1") || s.stream !== null, "streaming to start");
		rig.guest.sendAbort();
		const snapshot = await waitFor(
			rig.guest,
			s => idle(s) && assistants(s).some(m => m.stopReason === "aborted"),
			"the turn to end aborted",
		);
		expect(assistants(snapshot).at(-1)?.stopReason).toBe("aborted");
		expect((await agentLog(rig)).some(entry => entry.event === "cancel")).toBe(true);
	});

	it("queues a follow-up behind the running turn and runs it afterwards", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the permission prompt");
		rig.guest.sendPrompt("a second thing", undefined, "follow-up");
		const queued = await waitFor(rig.guest, s => (s.state?.followUps ?? []).length === 1, "the follow-up to queue");
		expect(queued.state?.followUps).toEqual(["a second thing"]);
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "Approve once");
		const snapshot = await waitFor(
			rig.guest,
			s => hasText(s, "Hello from the fake agent.") && idle(s),
			"the follow-up's answer",
		);
		expect(promptEntries(snapshot).map(entry => (entry.type === "custom_message" ? entry.content : null))).toEqual([
			"use the tool",
			"a second thing",
		]);
		expect(snapshot.state?.followUps).toEqual([]);
	});

	it("tells the agent about the spend cap and refuses prompts once it is reached", async () => {
		const rig = await boot({ maxCostUsd: 1 });
		expect(rig.guest.getSnapshot().features["spend-cap"]).toBe(true);
		expect(rig.guest.getSnapshot().state?.spend).toMatchObject({ costUsd: 0, maxCostUsd: 1, capped: false });
		rig.guest.sendPrompt("costly please");
		const snapshot = await waitFor(rig.guest, s => s.state?.spend?.capped === true && idle(s), "the cap");
		expect(snapshot.state?.spend).toMatchObject({ capped: true });
		expect(snapshot.state?.spend?.costUsd).toBeCloseTo(1.5, 5);
		expect(snapshot.notices.some(notice => notice.message.includes("spend cap"))).toBe(true);
		rig.guest.sendPrompt("one more");
		await waitFor(
			rig.guest,
			s => s.notices.some(notice => notice.message.includes("spend cap of $1.00 is reached")),
			"the refusal",
		);
		expect((await agentLog(rig)).filter(entry => entry.event === "prompt")).toHaveLength(1);
	});
});

describe("foreign host: tool permission", () => {
	it("asks once, runs the tool after approval and shows its card", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the permission prompt");
		const request = asked.uiRequest;
		expect(request).toMatchObject({ kind: "select", options: ["Approve once", "Approve for this session", "Deny"] });
		expect(request?.kind === "select" ? request.title : "").toContain("Command: echo hi");
		expect(request?.kind === "select" ? request.approval : null).toMatchObject({
			tool: "bash",
			rule: "bash: echo hi",
			guestProject: false,
			choices: [
				{ label: "Approve once", kind: "once" },
				{ label: "Approve for this session", kind: "session" },
				{ label: "Deny", kind: "deny" },
			],
		});
		expect(asked.state?.isStreaming).toBe(true);
		rig.guest.sendUiResponse(request?.reqId ?? -1, "Approve once");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the tool to finish");
		const call = assistants(snapshot)
			.flatMap(message => message.content)
			.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ name: "bash", arguments: { command: "echo hi" } });
		expect(results(snapshot)[0]).toMatchObject({
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "hi" }],
			details: { exitCode: 0 },
		});
		const permissions = (await agentLog(rig)).filter(entry => entry.event === "permission");
		expect(permissions).toEqual([{ event: "permission", outcome: { outcome: "selected", optionId: "allow" } }]);
		const approvals = (await storedEntries(rig)).filter(entry => entry.customType === "tool-approval");
		expect(approvals).toMatchObject([
			{ type: "custom", data: { tool: "bash", approved: true, by: "tester", choice: "once" } },
		]);
		expect(snapshot.uiRequest).toBeNull();
	});

	it("denies on request and the agent sees a rejection", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the permission prompt");
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "Deny");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "denied") && idle(s), "the denial");
		expect(results(snapshot)[0]).toMatchObject({ isError: true });
		expect((await agentLog(rig)).filter(entry => entry.event === "permission")).toEqual([
			{ event: "permission", outcome: { outcome: "selected", optionId: "reject" } },
		]);
	});

	it("keeps a session grant itself and never sends the agent's always option", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the first prompt");
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "Approve for this session");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the first tool");
		rig.guest.sendPrompt("use the tool again");
		await waitFor(
			rig.guest,
			s => assistants(s).filter(message => textOf(message) === "done").length === 2 && idle(s),
			"the second tool",
		);
		expect(rig.guest.getSnapshot().uiRequest).toBeNull();
		const permissions = (await agentLog(rig)).filter(entry => entry.event === "permission");
		expect(permissions).toHaveLength(2);
		expect(permissions.every(entry => JSON.stringify(entry.outcome).includes('"allow"'))).toBe(true);
		expect(JSON.stringify(permissions)).not.toContain("always");
		const approvals = (await storedEntries(rig)).filter(entry => entry.customType === "tool-approval");
		expect(approvals).toMatchObject([
			{ data: { by: "tester", choice: "session" } },
			{ data: { by: "grant", choice: "grant" } },
		]);
	});

	it("shows an edit as a diff", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("edit the file");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the permission prompt");
		expect(asked.uiRequest?.kind === "select" ? asked.uiRequest.title : "").toContain("Path: /work/src/app.ts");
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "Approve once");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the edit");
		expect(
			assistants(snapshot)
				.flatMap(message => message.content)
				.find(block => block.type === "toolCall"),
		).toMatchObject({
			name: "edit",
			arguments: { path: "/work/src/app.ts" },
		});
		const details = results(snapshot)[0]?.details;
		expect(details).toMatchObject({ path: "/work/src/app.ts", op: "update", firstChangedLine: 2 });
		expect(details).toMatchObject({ diff: expect.stringContaining("+const b = 3;") });
	});

	it("approves everything in full access and records it, and asks again when switched back", async () => {
		const rig = await boot();
		rig.guest.sendSessionCommand("permission", "full");
		await waitFor(rig.guest, s => s.state?.permission === "full", "full access");
		rig.guest.sendPrompt("use the tool");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the silent approval");
		expect(rig.guest.getSnapshot().uiRequest).toBeNull();
		const approvals = (await storedEntries(rig)).filter(entry => entry.customType === "tool-approval");
		expect(approvals).toMatchObject([{ data: { tool: "bash", approved: true, by: "full-access" } }]);

		rig.guest.sendSessionCommand("permission", "supervised");
		await waitFor(rig.guest, s => s.state?.permission === "supervised", "supervised again");
		expect((await agentLog(rig)).filter(entry => entry.event === "mode")).toEqual([
			{ event: "mode", modeId: "default" },
		]);
		rig.guest.sendPrompt("use the tool once more");
		await waitFor(rig.guest, s => s.uiRequest !== null, "the prompt after switching back");
		expect((await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId]?.permission).toBe("supervised");
	});

	it("answers a form the agent asks and shows it as an ask card", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("ask me");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the question");
		expect(asked.uiRequest).toMatchObject({ kind: "select", options: ["sqlite", "postgres"] });
		const call = assistants(asked)
			.flatMap(message => message.content)
			.find(block => block.type === "toolCall");
		expect(call).toMatchObject({
			name: "ask",
			arguments: {
				questions: [
					{
						id: "db",
						question: "Which database?\nDatabase",
						options: [{ label: "sqlite" }, { label: "postgres" }],
						multi: false,
					},
				],
			},
		});
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "postgres");
		const snapshot = await waitFor(
			rig.guest,
			s => hasText(s, 'You chose {"db":"postgres"}.') && idle(s),
			"the answer",
		);
		expect(results(snapshot)[0]).toMatchObject({
			toolName: "ask",
			isError: false,
			content: [{ type: "text", text: "db: postgres" }],
		});
	});
});

describe("foreign host: session controls", () => {
	it("switches model and thinking level through the agent's config options", async () => {
		const rig = await boot();
		rig.guest.sendSessionCommand("model", "claude/smart");
		await waitFor(rig.guest, s => s.state?.model?.id === "smart", "the model switch");
		rig.guest.sendSessionCommand("thinking", "high");
		await waitFor(rig.guest, s => s.state?.thinkingLevel === "high", "the thinking switch");
		const configs = (await agentLog(rig)).filter(entry => entry.event === "config");
		expect(configs).toEqual([
			{ event: "config", configId: "model", value: "smart" },
			{ event: "config", configId: "effort", value: "high" },
		]);
		const snapshot = rig.guest.getSnapshot();
		expect(snapshot.entries.map(entry => entry.type)).toEqual(["model_change", "thinking_level_change"]);
		expect((await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId]?.model).toBe("smart");
	});

	it("runs one prompt on another model and puts the session's back", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("hello", undefined, undefined, { model: "claude/smart" });
		await waitFor(rig.guest, s => hasText(s, "Hello from") && idle(s), "the prompt");
		const configs = (await agentLog(rig)).filter(entry => entry.event === "config");
		expect(configs).toEqual([
			{ event: "config", configId: "model", value: "smart" },
			{ event: "config", configId: "model", value: "fast" },
		]);
		expect(rig.guest.getSnapshot().state?.model?.id).toBe("fast");
	});

	it("renames the session", async () => {
		const rig = await boot();
		rig.guest.sendSessionCommand("rename", "Fix the build");
		await waitFor(rig.guest, s => s.state?.sessionName === "Fix the build", "the rename");
		expect((await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId]?.title).toBe("Fix the build");
		const hosts = await listCollabHosts({ dir: rig.registryDir });
		expect(hosts[0]?.sessionName).toBe("Fix the build");
		expect(
			(await storedEntries(rig)).some(entry => entry.type === "title_change" && entry.title === "Fix the build"),
		).toBe(true);
	});

	it("refuses controls it does not have", async () => {
		const rig = await boot();
		rig.guest.sendSessionCommand("compact");
		await waitFor(
			rig.guest,
			s => s.notices.some(notice => notice.message.includes("compact is not available with Claude Code")),
			"the refusal",
		);
	});

	it("rewinds the conversation, and the agent starts over with a digest of what is left", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("echo first");
		await waitFor(rig.guest, s => hasText(s, "echo: echo first") && idle(s), "the first answer");
		rig.guest.sendPrompt("echo second");
		const both = await waitFor(rig.guest, s => hasText(s, "echo: echo second") && idle(s), "the second answer");
		const second = promptEntries(both)[1];
		rig.guest.sendSessionCommand("rewind", second?.id);
		const rewound = await waitFor(rig.guest, s => promptEntries(s).length === 1 && idle(s), "the rewind");
		expect(assistants(rewound).map(textOf)).toEqual(["echo: echo first"]);
		rig.guest.sendPrompt("echo third");
		await waitFor(rig.guest, s => hasText(s, "echo third") && idle(s), "the third answer");
		const prompts = (await agentLog(rig)).filter(entry => entry.event === "prompt").map(entry => String(entry.text));
		expect(prompts).toHaveLength(3);
		expect(prompts[2]).toContain("This conversation was restored without your own memory of it");
		expect(prompts[2]).toContain("User: echo first");
		expect(prompts[2]).toContain("Assistant: echo: echo first");
		expect(prompts[2]).not.toContain("echo second");
		expect(prompts[2]).toEndWith("echo third");
		expect((await agentLog(rig)).filter(entry => entry.event === "new")).toHaveLength(2);
		// The rewind is in the file, so a restart finds the session where it was left.
		const marker = (await storedEntries(rig)).find(entry => entry.customType === "rewind");
		expect(marker).toBeDefined();
	});

	it("passes a slash command through as the prompt text", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("/review src/app.ts echo");
		await waitFor(rig.guest, s => hasText(s, "echo: /review src/app.ts echo") && idle(s), "the command");
	});
});

describe("foreign host: the agent's lifetime", () => {
	it("restarts a crashed agent from its stored session and carries on", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("hello");
		await waitFor(rig.guest, s => hasText(s, "Hello from") && idle(s), "the first turn");
		rig.guest.sendPrompt("now crash");
		const crashed = await waitFor(
			rig.guest,
			s => assistants(s).some(m => m.stopReason === "error") && idle(s),
			"the failed turn",
		);
		expect(crashed.notices.some(notice => notice.message.includes("Claude Code stopped"))).toBe(true);
		await waitFor(rig.guest, s => s.notices.some(notice => notice.message.includes("was restarted")), "the restart");
		const row = (await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId];
		expect((await agentLog(rig)).filter(entry => entry.event === "load")).toMatchObject([
			{ sessionId: row?.nativeId },
		]);
		rig.guest.sendPrompt("hello again");
		await waitFor(
			rig.guest,
			s =>
				assistants(s).filter(message => textOf(message).includes("Hello from the fake agent.")).length === 2 &&
				idle(s),
			"the turn after the restart",
		);
		// Replayed history from the reload is not added to the transcript again.
		expect(hasText(rig.guest.getSnapshot(), "replayed answer")).toBe(false);
	});

	it("continues a session by id in a new process, with the same transcript and the agent's own session", async () => {
		const first = await boot();
		first.guest.sendPrompt("hello");
		await waitFor(first.guest, s => hasText(s, "Hello from") && idle(s), "the first turn");
		const sessionId = first.host.sessionId;
		const row = (await readForeignIndex(first.configDir)).sessions[sessionId];
		await first.host.stop("done for now");
		await waitFor(first.guest, s => s.phase === "ended", "the room to end");

		const resumed = new ForeignHost(hostOptions(first, { resume: sessionId }));
		await resumed.start();
		const guest = connect(resumed.links.control, "again");
		const snapshot = await waitFor(guest, s => s.phase === "live" && s.loading === null, "the resumed room");
		expect(resumed.sessionId).toBe(sessionId);
		expect(snapshot.entries.map(entry => entry.type)).toEqual(["custom_message", "message"]);
		expect((await agentLog(first)).filter(entry => entry.event === "load")).toMatchObject([
			{ sessionId: row?.nativeId },
		]);
		guest.sendPrompt("hello again");
		await waitFor(guest, s => assistants(s).length === 2 && idle(s), "a turn in the resumed session");
		await resumed.stop("test over");
	});

	it("refuses to resume a session of another agent or one that is not in the index", async () => {
		const first = await boot();
		await expect(new ForeignHost(hostOptions(first, { resume: "claude-0000000000000000" })).start()).rejects.toThrow(
			"no such session",
		);
		await expect(
			new ForeignHost(
				hostOptions(first, { resume: first.host.sessionId, agent: { id: "codex", name: "Codex" } }),
			).start(),
		).rejects.toThrow("belongs to claude");
	});

	it("ends the room, the registry entry and the process when stopped", async () => {
		const rig = await boot();
		await rig.host.stop("see you");
		expect(await rig.host.done).toBe(0);
		const ended = await waitFor(rig.guest, s => s.phase === "ended", "the guest to see the end");
		expect(ended.endedReason).toBe("see you");
		expect(await listCollabHosts({ dir: rig.registryDir })).toEqual([]);
	});

	it("fails to start when the agent cannot be launched, naming why", async () => {
		const rig = await boot();
		const broken = new ForeignHost(
			hostOptions(rig, {
				launch: async (_id, launch) => ({
					command: [process.execPath, "-e", "console.error('login required'); process.exit(3)"],
					env: { PATH: process.env.PATH ?? "" },
					cwd: launch.cwd,
				}),
			}),
		);
		await expect(broken.start()).rejects.toThrow("login required");
	});
});

describe("foreign host: file snapshots", () => {
	it("diffs and restores the files a turn changed in a git repository", async () => {
		const rig = await boot({}, { git: true });
		expect(rig.guest.getSnapshot().features["turn-diff"]).toBe(true);
		expect(rig.guest.getSnapshot().features["rewind-files"]).toBe(true);
		rig.guest.sendPrompt("touch a file");
		const done = await waitFor(rig.guest, s => hasText(s, "Hello from") && idle(s), "the turn");
		const prompt = promptEntries(done)[0];
		expect(await Bun.file(path.join(rig.cwd, "touched.txt")).exists()).toBe(true);

		rig.guest.sendSessionCommand("turn-diff", prompt?.id);
		const diff = await waitFor(rig.guest, s => s.turnDiff !== null, "the turn diff");
		expect(JSON.stringify(diff.turnDiff)).toContain("touched.txt");

		rig.guest.sendSessionCommand("rewind-preview", prompt?.id);
		const preview = await waitFor(rig.guest, s => s.rewindPreview !== null, "the preview");
		expect(JSON.stringify(preview.rewindPreview)).toContain('"remove":1');

		rig.guest.sendSessionCommand("rewind", prompt?.id, true);
		await waitFor(rig.guest, s => s.entries.length === 0 && s.fileRestore !== null, "the restore");
		expect(await Bun.file(path.join(rig.cwd, "touched.txt")).exists()).toBe(false);

		rig.guest.sendSessionCommand("redo-files");
		await waitFor(rig.guest, s => s.fileRestore?.kind === "redo", "the redo");
		expect(await Bun.file(path.join(rig.cwd, "touched.txt")).exists()).toBe(true);
	});

	it("does not offer file features outside a git repository", async () => {
		const rig = await boot();
		expect(rig.guest.getSnapshot().features["turn-diff"]).toBeUndefined();
		expect(rig.guest.getSnapshot().features["rewind-files"]).toBeUndefined();
	});

	it("turns file features off and says so when the session folder holds a git directory it cannot trust", async () => {
		const rig = await boot({}, { git: true, plantedGitDir: true });
		expect(rig.guest.getSnapshot().features["turn-diff"]).toBeUndefined();
		expect(rig.guest.getSnapshot().features["rewind-files"]).toBeUndefined();
		rig.guest.sendPrompt("hello");
		const snapshot = await waitFor(
			rig.guest,
			s => hasText(s, "Hello from") && idle(s),
			"the turn that runs without snapshots",
		);
		const refusals = snapshot.notices.filter(notice => notice.message.includes("file snapshots are off"));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]?.message).toContain("git directory inside the session folder");
		rig.guest.sendPrompt("hello again");
		await waitFor(rig.guest, s => assistants(s).length === 2 && idle(s), "the second turn");
		expect(
			rig.guest.getSnapshot().notices.filter(notice => notice.message.includes("file snapshots are off")),
		).toHaveLength(1);
	});
});

async function answerPrompt(rig: Rig, title: string, value: string, options?: string[]): Promise<GuestSnapshot> {
	// The options tell this prompt from the one just answered, which the guest's snapshot may still hold.
	const asked = await waitFor(
		rig.guest,
		s =>
			s.uiRequest?.kind === "select" &&
			s.uiRequest.title.includes(title) &&
			(options === undefined || s.uiRequest.options.join("|") === options.join("|")),
		`the prompt "${title}"`,
	);
	rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, value);
	return asked;
}

describe("foreign host: Cursor extension methods", () => {
	it("asks the questions of cursor/ask_question one by one, several picks for a multiple choice", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("cursorq now");
		const first = await answerPrompt(rig, "Which mode?", "Plan");
		const card = assistants(first)
			.flatMap(message => message.content)
			.find(block => block.type === "toolCall");
		expect(card).toMatchObject({
			name: "ask",
			arguments: {
				questions: [
					{ id: "q1", question: "Which mode?", options: [{ label: "Agent" }, { label: "Plan" }], multi: false },
					{ id: "q2", question: "Which checks?", options: [{ label: "Lint" }, { label: "Test" }], multi: true },
				],
			},
		});
		const second = await answerPrompt(rig, "Which checks?", "Test", ["Lint", "Test"]);
		expect(second.uiRequest).toMatchObject({ options: ["Lint", "Test"] });
		await answerPrompt(rig, "Which checks?", "Done", ["Lint", "Done"]);
		const snapshot = await waitFor(rig.guest, s => hasText(s, "answer:") && idle(s), "the agent's answer");
		expect((await agentLog(rig)).find(entry => entry.event === "cursor-answer")).toMatchObject({
			response: {
				result: {
					outcome: {
						outcome: "answered",
						answers: [
							{ questionId: "q1", selectedOptionIds: ["plan"] },
							{ questionId: "q2", selectedOptionIds: ["test"] },
						],
					},
				},
			},
		});
		expect(results(snapshot).find(result => result.toolName === "ask")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "Which mode?: Plan\nWhich checks?: Test" }],
		});
	});

	it("tells the agent a dismissed question was cancelled", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("cursorq now");
		await waitFor(rig.guest, s => s.uiRequest !== null, "the question");
		rig.guest.sendAbort();
		await waitFor(rig.guest, s => hasText(s, "answer:") && idle(s), "the turn to end");
		expect((await agentLog(rig)).find(entry => entry.event === "cursor-answer")).toMatchObject({
			response: { result: { outcome: { outcome: "cancelled" } } },
		});
		expect(rig.guest.getSnapshot().uiRequest).toBeNull();
	});

	it("shows cursor/create_plan as text and a todo card, and sends the approval back", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("cursorp now");
		const asked = await answerPrompt(rig, 'Approve the plan "Ship it"?', "Approve plan");
		expect(asked.uiRequest).toMatchObject({ options: ["Approve plan", "Reject plan"] });
		const snapshot = await waitFor(rig.guest, s => hasText(s, "plan: ") && idle(s), "the agent's answer");
		const text = assistants(snapshot).map(textOf).join("");
		expect(text).toContain("## Ship it\n\nA short plan.\n\n1. Draft\n2. Review");
		expect(
			results(snapshot)
				.filter(result => result.toolName === "todo")
				.at(-1)?.details,
		).toMatchObject({
			phases: [
				{
					name: "Plan",
					tasks: [
						{ content: "Draft", status: "completed" },
						{ content: "Review", status: "pending" },
					],
				},
			],
		});
		expect((await agentLog(rig)).find(entry => entry.event === "cursor-plan")).toMatchObject({
			response: { result: { outcome: { outcome: "accepted" } } },
		});
		const approvals = (await storedEntries(rig)).filter(entry => entry.customType === "tool-approval");
		expect(approvals).toMatchObject([{ data: { tool: "plan", toolCallId: "p-1", approved: true, by: "tester" } }]);
	});

	it("rejects a plan on request, and accepts it without asking in full access", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("cursorp now");
		await answerPrompt(rig, "Approve the plan", "Reject plan");
		await waitFor(rig.guest, s => hasText(s, "plan: ") && idle(s), "the rejection");
		expect((await agentLog(rig)).find(entry => entry.event === "cursor-plan")).toMatchObject({
			response: { result: { outcome: { outcome: "rejected", reason: "rejected by tester" } } },
		});

		rig.guest.sendSessionCommand("permission", "full");
		await waitFor(rig.guest, s => s.state?.permission === "full", "full access");
		rig.guest.sendPrompt("cursorp again");
		await waitFor(
			rig.guest,
			s => assistants(s).filter(message => textOf(message).includes("plan: ")).length === 2 && idle(s),
			"the second plan",
		);
		expect((await agentLog(rig)).filter(entry => entry.event === "cursor-plan").at(-1)).toMatchObject({
			response: { result: { outcome: { outcome: "accepted" } } },
		});
	});

	it("answers an extension request it does not know with an error and a notice", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("cursoro now");
		const snapshot = await waitFor(rig.guest, s => hasText(s, "odd: ") && idle(s), "the answer");
		expect(
			snapshot.notices.some(notice => notice.message.includes("cursor/frobnicate, which is not supported here")),
		).toBe(true);
		expect(assistants(snapshot).map(textOf).join("")).toContain('"code":-32601');
	});
});

describe("foreign host: calls that leave the vendor's sandbox", () => {
	const approvals = async (rig: Rig) =>
		(await storedEntries(rig)).filter(entry => entry.customType === "tool-approval");

	it("labels it, offers once or deny, and never remembers it", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool escalate");
		const asked = await waitFor(rig.guest, s => s.uiRequest !== null, "the prompt");
		const request = asked.uiRequest;
		expect(request?.kind === "select" ? request.title.split("\n")[0] : "").toContain("Leaves the sandbox");
		expect(request).toMatchObject({ options: ["Approve once", "Deny"] });
		expect(request?.kind === "select" ? request.approval?.rule : "x").toBeUndefined();
		rig.guest.sendUiResponse(request?.reqId ?? -1, "Approve once");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the first call");

		rig.guest.sendPrompt("use the tool escalate again");
		await waitFor(
			rig.guest,
			s => s.uiRequest !== null && s.uiRequest.reqId !== request?.reqId,
			"a second prompt for the same call",
		);
	});

	it("approves it without asking in full access", async () => {
		const rig = await boot({ permission: "full" });
		rig.guest.sendPrompt("use the tool escalate");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the approval");
		expect(await approvals(rig)).toMatchObject([{ data: { approved: true, by: "full-access" } }]);
	});
});

describe("foreign host: session grants", () => {
	it("covers the same command later, but not a compound line, which is offered once or deny only", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("use the tool");
		const first = await waitFor(rig.guest, s => s.uiRequest !== null, "the first prompt");
		expect(first.uiRequest).toMatchObject({ options: ["Approve once", "Approve for this session", "Deny"] });
		rig.guest.sendUiResponse(first.uiRequest?.reqId ?? -1, "Approve for this session");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the first call");

		rig.guest.sendPrompt("use the tool compound");
		const asked = await waitFor(
			rig.guest,
			s => s.uiRequest !== null && s.uiRequest.reqId !== first.uiRequest?.reqId,
			"the prompt for the compound line",
		);
		expect(asked.uiRequest).toMatchObject({ options: ["Approve once", "Deny"] });
		expect(asked.uiRequest?.kind === "select" ? asked.uiRequest.title : "").toContain("echo hi && echo there");
		rig.guest.sendUiResponse(asked.uiRequest?.reqId ?? -1, "Deny");
		await waitFor(
			rig.guest,
			s => assistants(s).filter(m => textOf(m) === "denied").length === 1 && idle(s),
			"the denial",
		);
	});

	it("scopes an edit grant to its file inside the folder, and offers none outside it", async () => {
		const rig = await boot();
		rig.guest.sendPrompt("edit inside the folder");
		const inside = await waitFor(rig.guest, s => s.uiRequest !== null, "the prompt for a file inside");
		expect(inside.uiRequest).toMatchObject({ options: ["Approve once", "Approve for this session", "Deny"] });
		expect(inside.uiRequest?.kind === "select" ? inside.uiRequest.approval?.rule : "").toBe(
			`edit: ${path.join("src", "app.ts")}`,
		);
		rig.guest.sendUiResponse(inside.uiRequest?.reqId ?? -1, "Approve for this session");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the edit");
		rig.guest.sendPrompt("edit inside the folder again");
		await waitFor(
			rig.guest,
			s => assistants(s).filter(m => textOf(m) === "done").length === 2 && idle(s),
			"the covered edit",
		);

		rig.guest.sendPrompt("edit the file");
		const outside = await waitFor(
			rig.guest,
			s => s.uiRequest !== null && s.uiRequest.reqId !== inside.uiRequest?.reqId,
			"the prompt for a file outside",
		);
		expect(outside.uiRequest).toMatchObject({ options: ["Approve once", "Deny"] });
	});
});

describe("foreign host: supervised means supervised", () => {
	it("stays in full access when the agent refuses to switch, and says so", async () => {
		const rig = await boot({ permission: "full" }, { env: { FAKE_ACP_FAIL_MODE: "1" } });
		rig.guest.sendSessionCommand("permission", "supervised");
		await waitFor(
			rig.guest,
			s => s.notices.some(notice => notice.message.includes("stays in full access")),
			"the notice",
		);
		expect(rig.guest.getSnapshot().state?.permission).toBe("full");
		expect((await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId]?.permission).toBe("full");
		rig.guest.sendPrompt("use the tool");
		await waitFor(rig.guest, s => hasText(s, "done") && idle(s), "the unprompted call of a full-access session");
	});

	it("does not start a supervised session whose agent cannot be put in its ask-first mode", async () => {
		const rig = await boot();
		const failing = new ForeignHost(
			hostOptions(rig, {}, { FAKE_ACP_MODE: "bypassPermissions", FAKE_ACP_FAIL_MODE: "1" }),
		);
		await expect(failing.start()).rejects.toThrow("could not switch Claude Code to its ask-first mode");
	});
});

describe("foreign host: the index", () => {
	it("puts its row back whole when the index lost it", async () => {
		const rig = await boot({ worktree: true, fanout: { group: "g1", model: "claude:fast" } });
		await fs.rm(path.join(rig.configDir, "agent", "collab-foreign.json"));
		rig.guest.sendPrompt("hello");
		await waitFor(rig.guest, s => hasText(s, "Hello from") && idle(s), "the turn");
		const row = (await readForeignIndex(rig.configDir)).sessions[rig.host.sessionId];
		expect(row).toMatchObject({
			agent: "claude",
			cwd: rig.cwd,
			worktree: true,
			fanout: { group: "g1", model: "claude:fast" },
			permission: "supervised",
		});
		expect(row?.nativeId).toMatch(/^fake-/);
	});
});
