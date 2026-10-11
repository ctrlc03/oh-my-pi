/**
 * A scripted Agent Client Protocol agent on stdio, for the foreign host's tests. What a prompt makes it
 * do depends on keywords in its text:
 *
 *   tool    run `echo hi` (execute), asking permission first; says "done" or "denied"
 *   edit    change a file (a diff), asking permission first
 *   plan    send a plan, then answer
 *   slow    stream chunks until cancelled (ends `cancelled`)
 *   crash   exit in the middle of the turn
 *   costly  report $1.50 of cumulative cost
 *   ask     ask a form question (elicitation) and echo the answer
 *   echo    answer with the whole prompt text it received
 *   anything else: "Hello from the fake agent."
 *
 * `FAKE_ACP_DIR` holds `sessions.json` (session ids it can reload) and `log.jsonl`, one line per thing the
 * host did to it: new / load / prompt / permission / config / mode / cancel.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.env.FAKE_ACP_DIR ?? process.cwd();
const sessionsFile = path.join(dir, "sessions.json");
const logFile = path.join(dir, "log.jsonl");

function log(entry: Record<string, unknown>): void {
	fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function knownSessions(): string[] {
	try {
		return JSON.parse(fs.readFileSync(sessionsFile, "utf8")) as string[];
	} catch {
		return [];
	}
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const pending = new Map<number, (message: Record<string, unknown>) => void>();
let nextId = 1000;

function ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = nextId++;
	return new Promise(resolve => {
		pending.set(id, resolve);
		send({ id, method, params });
	});
}

function update(sessionId: string, body: Record<string, unknown>): void {
	send({ method: "session/update", params: { sessionId, update: body } });
}

const MODEL_OPTION = {
	id: "model",
	name: "Model",
	category: "model",
	type: "select",
	currentValue: "fast",
	options: [
		{ value: "fast", name: "Fast" },
		{ value: "smart", name: "Smart" },
	],
};
const THOUGHT_OPTION = {
	id: "effort",
	name: "Effort",
	category: "thought_level",
	type: "select",
	currentValue: "low",
	options: [
		{ value: "low", name: "Low" },
		{ value: "high", name: "High" },
	],
};
let currentModel = "fast";
let currentEffort = "low";
let currentMode = "default";
const MODES = {
	currentModeId: "default",
	availableModes: [
		{ id: "default", name: "Default" },
		{ id: "bypassPermissions", name: "Bypass" },
	],
};

function configOptions(): Record<string, unknown>[] {
	return [
		{ ...MODEL_OPTION, currentValue: currentModel },
		{ ...THOUGHT_OPTION, currentValue: currentEffort },
	];
}

let cancelled = false;
let cost = 0;
let sessionCounter = 0;
let sessionCwd = process.cwd();

function setup(sessionId: string): Record<string, unknown> {
	return { sessionId, configOptions: configOptions(), modes: { ...MODES, currentModeId: currentMode } };
}

function afterSetup(sessionId: string): void {
	queueMicrotask(() => {
		update(sessionId, {
			sessionUpdate: "available_commands_update",
			availableCommands: [{ name: "review", description: "Review code", input: { hint: "path" } }],
		});
	});
}

function promptText(params: Record<string, unknown>): string {
	const blocks = Array.isArray(params.prompt) ? params.prompt : [];
	return blocks
		.map(block => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.join("\n");
}

async function chunks(sessionId: string, pieces: string[]): Promise<void> {
	for (const piece of pieces) {
		update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
		await Bun.sleep(5);
	}
}

function reportCost(sessionId: string, amount: number): void {
	cost += amount;
	update(sessionId, {
		sessionUpdate: "usage_update",
		size: 200_000,
		used: 1_234,
		cost: { amount: cost, currency: "USD" },
	});
}

async function runPrompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
	cancelled = false;
	log({ event: "prompt", text });
	if (text.includes("touch")) fs.writeFileSync(path.join(sessionCwd, "touched.txt"), "touched");
	const usage = { totalTokens: 30, inputTokens: 10, outputTokens: 20 };
	if (text.includes("crash")) {
		await chunks(sessionId, ["about to ", "crash"]);
		process.exit(1);
	}
	if (text.includes("cursorq")) {
		const response = await ask("cursor/ask_question", {
			toolCallId: "q-1",
			title: "Need input",
			questions: [
				{
					id: "q1",
					prompt: "Which mode?",
					options: [
						{ id: "agent", label: "Agent" },
						{ id: "plan", label: "Plan" },
					],
					allowMultiple: false,
				},
				{
					id: "q2",
					prompt: "Which checks?",
					options: [
						{ id: "lint", label: "Lint" },
						{ id: "test", label: "Test" },
					],
					allowMultiple: true,
				},
			],
		});
		log({ event: "cursor-answer", response });
		await chunks(sessionId, [`answer: ${JSON.stringify(response.result)}`]);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("cursorp")) {
		send({
			method: "cursor/update_todos",
			params: { toolCallId: "t-1", todos: [{ id: "1", content: "Draft", status: "in_progress" }], merge: false },
		});
		const response = await ask("cursor/create_plan", {
			toolCallId: "p-1",
			name: "Ship it",
			overview: "A short plan.",
			plan: "1. Draft\n2. Review",
			todos: [
				{ id: "1", content: "Draft", status: "completed" },
				{ id: "2", content: "Review", status: "pending" },
				{ id: "3", content: "Dropped", status: "cancelled" },
			],
		});
		log({ event: "cursor-plan", response });
		await chunks(sessionId, [`plan: ${JSON.stringify(response.result)}`]);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("cursoro")) {
		const response = await ask("cursor/frobnicate", { toolCallId: "x-1" });
		await chunks(sessionId, [`odd: ${JSON.stringify(response.error)}`]);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("slow")) {
		for (let i = 0; i < 400 && !cancelled; i++) {
			update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tick ${i} ` } });
			await Bun.sleep(25);
		}
		return { stopReason: cancelled ? "cancelled" : "end_turn" };
	}
	if (text.includes("plan")) {
		update(sessionId, {
			sessionUpdate: "plan",
			entries: [
				{ content: "Look around", priority: "high", status: "completed" },
				{ content: "Fix it", priority: "high", status: "in_progress" },
			],
		});
		await chunks(sessionId, ["Plan ", "made."]);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("ask")) {
		const answer = await ask("elicitation/create", {
			sessionId,
			mode: "form",
			message: "Which database?",
			requestedSchema: {
				type: "object",
				properties: { db: { type: "string", title: "Database", enum: ["sqlite", "postgres"] } },
				required: ["db"],
			},
		});
		log({ event: "elicitation", answer });
		const result = answer.result;
		const content =
			typeof result === "object" && result !== null && "content" in result ? JSON.stringify(result.content) : "none";
		await chunks(sessionId, [`You chose ${content}.`]);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("tool") || text.includes("edit")) {
		const editing = text.includes("edit");
		const file = text.includes("inside") ? path.join(sessionCwd, "src", "app.ts") : "/work/src/app.ts";
		const call = editing
			? {
					toolCallId: "call-1",
					title: "Edit src/app.ts",
					kind: "edit",
					status: "pending",
					locations: [{ path: file }],
					content: [
						{
							type: "diff",
							path: file,
							oldText: "const a = 1;\nconst b = 2;",
							newText: "const a = 1;\nconst b = 3;",
						},
					],
				}
			: {
					toolCallId: "call-1",
					title: "echo hi",
					kind: "execute",
					status: "pending",
					rawInput: {
						command: text.includes("compound") ? "echo hi && echo there" : "echo hi",
						...(text.includes("escalate") ? { sandbox_permissions: "require_escalated" } : {}),
					},
				};
		update(sessionId, { sessionUpdate: "tool_call", ...call });
		const response = await ask("session/request_permission", {
			sessionId,
			toolCall: { toolCallId: "call-1" },
			options: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "always", name: "Always allow", kind: "allow_always" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		});
		const result = response.result;
		const outcome = typeof result === "object" && result !== null && "outcome" in result ? result.outcome : null;
		log({ event: "permission", outcome });
		const optionId =
			typeof outcome === "object" && outcome !== null && "optionId" in outcome ? outcome.optionId : null;
		if (optionId === "allow") {
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" });
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				content: editing ? undefined : [{ type: "content", content: { type: "text", text: "hi" } }],
				rawOutput: editing ? undefined : { output: "hi", exit_code: 0 },
			});
			await chunks(sessionId, ["done"]);
		} else {
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
			await chunks(sessionId, ["denied"]);
		}
		reportCost(sessionId, 0.01);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("costly")) {
		await chunks(sessionId, ["spending"]);
		reportCost(sessionId, 1.5);
		return { stopReason: "end_turn", usage };
	}
	if (text.includes("echo")) {
		await chunks(sessionId, [`echo: ${text}`]);
		return { stopReason: "end_turn", usage };
	}
	await chunks(sessionId, ["Hello ", "from the fake agent."]);
	reportCost(sessionId, 0.01);
	return { stopReason: "end_turn", usage };
}

async function handle(message: Record<string, unknown>): Promise<void> {
	const { id, method } = message;
	const params =
		typeof message.params === "object" && message.params !== null ? (message.params as Record<string, unknown>) : {};
	const reply = (result: Record<string, unknown>): void => send({ id, result });
	switch (method) {
		case "initialize":
			reply({
				protocolVersion: 1,
				agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
				agentInfo: { name: "fake-agent", version: "9.9.9" },
				authMethods: [],
			});
			return;
		case "session/new": {
			const sessionId = `fake-${process.pid}-${++sessionCounter}`;
			fs.writeFileSync(sessionsFile, JSON.stringify([...knownSessions(), sessionId]));
			log({ event: "new", cwd: params.cwd });
			sessionCwd = String(params.cwd);
			reply(setup(sessionId));
			afterSetup(sessionId);
			return;
		}
		case "session/load": {
			const sessionId = String(params.sessionId);
			log({ event: "load", sessionId });
			sessionCwd = String(params.cwd);
			if (!knownSessions().includes(sessionId)) {
				send({ id, error: { code: -32602, message: "unknown session" } });
				return;
			}
			update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed prompt" } });
			update(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "replayed answer" },
			});
			reply(setup(sessionId));
			afterSetup(sessionId);
			return;
		}
		case "session/prompt": {
			const sessionId = String(params.sessionId);
			const result = await runPrompt(sessionId, promptText(params));
			reply(result);
			return;
		}
		case "session/set_config_option": {
			log({ event: "config", configId: params.configId, value: params.value });
			if (params.configId === "model") currentModel = String(params.value);
			if (params.configId === "effort") currentEffort = String(params.value);
			reply({ configOptions: configOptions() });
			return;
		}
		case "session/set_mode":
			log({ event: "mode", modeId: params.modeId });
			if (process.env.FAKE_ACP_FAIL_MODE === "1") {
				send({ id, error: { code: -32603, message: "mode switch refused" } });
				return;
			}
			currentMode = String(params.modeId);
			reply({});
			return;
		case "session/cancel":
			log({ event: "cancel" });
			cancelled = true;
			return;
		default:
			if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${String(method)}` } });
	}
}

currentMode = process.env.FAKE_ACP_MODE ?? "default";

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffered += chunk;
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\n");
		if (line.trim() === "") continue;
		const message = JSON.parse(line) as Record<string, unknown>;
		if ("method" in message) void handle(message);
		else if (typeof message.id === "number") pending.get(message.id)?.(message);
	}
});
process.stdin.on("end", () => process.exit(0));
