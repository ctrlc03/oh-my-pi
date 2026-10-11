import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const writeCall = (content: string): MockResponse => ({
	content: [{ type: "toolCall", name: "write", arguments: { path: "target.txt", content } }],
});

describe("AgentSession verification step", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-verify-session-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	/** Runs `prompt` against scripted model turns; `write` really writes into the temp cwd. */
	async function run(responses: MockResponse[], settings: Record<string, unknown>, options?: { bash?: boolean }) {
		const mock = createMockModel({ provider: "anthropic", id: "claude-test", responses });
		const writeTool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: type({ path: "string", content: "string" }),
			execute: async (_id, params) => {
				const args = params as { path: string; content: string };
				fs.writeFileSync(path.join(tempDir.path(), args.path), args.content);
				return { content: [{ type: "text", text: "written" }] };
			},
		};
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};
		const tools = options?.bash === false ? [writeTool] : [writeTool, bashTool];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: (model, context, streamOptions) => mock.stream(model, context, streamOptions),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		const notices: Extract<AgentSessionEvent, { type: "notice" }>[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "verify") notices.push(event);
		});
		await session.prompt("fix it");
		await session.waitForIdle();
		return { mock, notices, contextOf: (call: number) => JSON.stringify(mock.calls[call]?.context.messages) };
	}

	const failsUntilFixed = "cat target.txt; grep -q fixed target.txt";

	it("hands a failing check back to the agent at turn end and stops once it passes", async () => {
		const { mock, notices, contextOf } = await run(
			[writeCall("broken"), { content: ["done"] }, writeCall("fixed"), { content: ["done again"] }],
			{ "verify.command": failsUntilFixed },
		);
		expect(mock.calls).toHaveLength(4);
		expect(contextOf(1)).not.toContain("verification step");
		expect(contextOf(2)).toContain("verification step");
		expect(contextOf(2)).toContain("broken");
		expect(notices.map(notice => notice.level)).toEqual(["info", "warning", "info", "info"]);
		expect(notices.at(-1)?.message).toBe("passed");
	});

	it("stops with a notice after verify.maxAttempts automatic fix rounds", async () => {
		const { mock, notices } = await run(
			[writeCall("one"), { content: ["done"] }, writeCall("two"), { content: ["done again"] }],
			{ "verify.command": "cat target.txt; exit 1", "verify.maxAttempts": 1 },
		);
		expect(mock.calls).toHaveLength(4);
		expect(notices.at(-1)?.level).toBe("error");
		expect(notices.at(-1)?.message).toContain("stopping");
	});

	it("does not run when the turn changed no files", async () => {
		const ran = path.join(tempDir.path(), "ran.txt");
		const { mock } = await run([{ content: ["just talking"] }], { "verify.command": `touch ${ran}; exit 1` });
		expect(mock.calls).toHaveLength(1);
		expect(fs.existsSync(ran)).toBe(false);
	});

	it("is off by default", async () => {
		const { mock, notices } = await run([writeCall("broken"), { content: ["done"] }], {});
		expect(mock.calls).toHaveLength(2);
		expect(notices).toHaveLength(0);
	});

	it("skips sessions whose tools exclude bash", async () => {
		const ran = path.join(tempDir.path(), "ran.txt");
		const { mock } = await run(
			[writeCall("broken"), { content: ["done"] }],
			{ "verify.command": `touch ${ran}; exit 1` },
			{ bash: false },
		);
		expect(mock.calls).toHaveLength(2);
		expect(fs.existsSync(ran)).toBe(false);
	});

	it("checks after each editing turn, mid-run, when verify.when is after-edit", async () => {
		const { mock, contextOf } = await run([writeCall("broken"), writeCall("fixed"), { content: ["done"] }], {
			"verify.command": failsUntilFixed,
			"verify.when": "after-edit",
		});
		expect(mock.calls).toHaveLength(3);
		expect(contextOf(1)).toContain("verification step");
		expect(contextOf(1)).toContain("broken");
		expect(contextOf(2)).toContain("verification step");
	});
});
