import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configYml, modelsYml, STUB_SELECTOR, tmuxWrapper } from "../scripts/e2e-home";
import {
	encodeSse,
	finishReason,
	normaliseRequest,
	replyChunks,
	replyCompletion,
	replyUsage,
	scriptedResponder,
	STUB_MODEL_ID,
	STUB_PRICING,
	type StubChunk,
	type StubCompletion,
	type StubLogEntry,
	type StubRequest,
	type StubServer,
	startStubModel,
	textResponder,
	writeFileThenDone,
} from "../scripts/stub-model";

const BODY = {
	model: STUB_MODEL_ID,
	stream: true,
	tools: [
		{ type: "function", function: { name: "read", parameters: {} } },
		{ type: "function", function: { name: "write", parameters: {} } },
	],
	messages: [
		{ role: "system", content: "You are strict." },
		{ role: "developer", content: [{ type: "text", text: "Dev note." }] },
		{
			role: "user",
			content: [
				{ type: "text", text: "first" },
				{ type: "image_url", image_url: { url: "x" } },
			],
		},
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_1", type: "function", function: { name: "write", arguments: '{"path":"/a","content":"b"}' } },
			],
		},
		{ role: "tool", tool_call_id: "call_1", content: "Successfully wrote" },
		{ role: "user", content: "second" },
	],
};

function request(index = 0, messages: unknown[] = BODY.messages): StubRequest {
	return normaliseRequest({ ...BODY, messages }, index);
}

describe("normaliseRequest", () => {
	it("flattens system text, messages, tools and the last user message", () => {
		const req = request(3);
		expect(req.index).toBe(3);
		expect(req.model).toBe(STUB_MODEL_ID);
		expect(req.system).toBe("You are strict.\n\nDev note.");
		expect(req.tools).toEqual(["read", "write"]);
		expect(req.lastUser).toBe("second");
		expect(req.messages.map(message => message.role)).toEqual([
			"system",
			"developer",
			"user",
			"assistant",
			"tool",
			"user",
		]);
		expect(req.messages[2]!.text).toBe("first");
		expect(req.raw.stream).toBe(true);
	});

	it("parses tool call arguments and pairs tool results with their call", () => {
		const req = request();
		expect(req.messages[3]!.toolCalls).toEqual([
			{ id: "call_1", name: "write", arguments: { path: "/a", content: "b" } },
		]);
		expect(req.messages[4]!.toolResults).toEqual([{ id: "call_1", text: "Successfully wrote" }]);
		expect(req.messages[0]!.toolResults).toEqual([]);
	});

	it("keeps unparseable arguments as text and tolerates a body of another shape", () => {
		const bad = normaliseRequest(
			{ messages: [{ role: "assistant", tool_calls: [{ id: "x", function: { name: "n", arguments: "{oops" } }] }] },
			0,
		);
		expect(bad.messages[0]!.toolCalls[0]!.arguments).toBe("{oops");
		const empty = normaliseRequest("nope", 1);
		expect(empty).toMatchObject({ index: 1, model: "", system: "", messages: [], tools: [], lastUser: "" });
	});
});

describe("reply encoding", () => {
	const req = request(2);

	it("streams text in deltas, then a stop chunk and a usage chunk", () => {
		const text = "x".repeat(150);
		const chunks = replyChunks({ text, usage: { input: 100, output: 40 } }, req, STUB_MODEL_ID);
		const deltas = chunks.flatMap(chunk => {
			const content = chunk.choices[0]?.delta.content;
			return content ? [content] : [];
		});
		expect(deltas.join("")).toBe(text);
		expect(deltas.length).toBeGreaterThan(1);
		const finish = chunks.flatMap(chunk => chunk.choices.map(choice => choice.finish_reason)).filter(Boolean);
		expect(finish).toEqual(["stop"]);
		const last = chunks.at(-1)!;
		expect(last.choices).toEqual([]);
		expect(last.usage).toEqual({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 });
	});

	it("streams a tool call as an id and name first, then argument fragments, and stops with tool_calls", () => {
		const args = { path: "/tmp/out.json", content: "y".repeat(200) };
		const chunks = replyChunks({ toolCalls: [{ name: "write", arguments: args }] }, req, STUB_MODEL_ID);
		const calls = chunks.flatMap(chunk => chunk.choices[0]?.delta.tool_calls ?? []);
		expect(calls[0]).toMatchObject({ index: 0, id: "call_stub_2_0", function: { name: "write", arguments: "" } });
		expect(calls.length).toBeGreaterThan(2);
		expect(JSON.parse(calls.map(call => call.function.arguments ?? "").join(""))).toEqual(args);
		expect(chunks.some(chunk => chunk.choices[0]?.finish_reason === "tool_calls")).toBe(true);
		expect(finishReason({ toolCalls: [{ name: "write", arguments: {} }] })).toBe("tool_calls");
		expect(finishReason({ text: "x" })).toBe("stop");
	});

	it("encodes server-sent events ending with [DONE]", () => {
		const body = encodeSse([{ a: 1 }, { b: 2 }]);
		expect(body).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
	});

	it("builds a non-streaming completion with the same content", () => {
		const completion = replyCompletion(
			{ text: "hi", toolCalls: [{ name: "read", arguments: { path: "a" } }] },
			req,
			STUB_MODEL_ID,
		);
		const choice = completion.choices[0]!;
		expect(choice.message.content).toBe("hi");
		expect(choice.finish_reason).toBe("tool_calls");
		expect(JSON.parse(choice.message.tool_calls![0]!.function.arguments ?? "")).toEqual({ path: "a" });
	});
});

describe("usage and cost", () => {
	it("estimates tokens from the request and the reply when none are given", () => {
		const usage = replyUsage({ text: "x".repeat(400) }, request());
		expect(usage.completionTokens).toBe(100);
		expect(usage.promptTokens).toBeGreaterThan(0);
	});

	it("meets a requested cost through the configured prices", () => {
		const { promptTokens, completionTokens } = replyUsage(
			{ text: "x", usage: { input: 1, output: 1000, costUsd: 0.1 } },
			request(),
		);
		const cost = (promptTokens * STUB_PRICING.inputPerMTok + completionTokens * STUB_PRICING.outputPerMTok) / 1e6;
		expect(cost).toBeCloseTo(0.1, 5);
	});

	it("never reports negative input tokens when the output alone costs more", () => {
		expect(replyUsage({ usage: { input: 0, output: 1_000_000, costUsd: 0.01 } }, request()).promptTokens).toBe(0);
	});
});

describe("responders", () => {
	it("scriptedResponder answers reply i to call i, calls function steps, and fails past the end", async () => {
		const responder = scriptedResponder([{ text: "one" }, req => ({ text: `saw ${req.lastUser}` })]);
		expect(await responder(request(0))).toEqual({ text: "one" });
		expect(await responder(request(1))).toEqual({ text: "saw second" });
		const over = await responder(request(2));
		expect(over.status).toBe(500);
		expect(over.text).toContain("call 2");
	});

	it("writeFileThenDone calls write first and says Done once a tool result exists", async () => {
		const responder = writeFileThenDone("/tmp/out.json", '{"ok":true}');
		const first = await responder(request(0, [{ role: "user", content: "go" }]));
		expect(first.toolCalls).toEqual([
			{ name: "write", arguments: { path: "/tmp/out.json", content: '{"ok":true}' } },
		]);
		expect(await responder(request(1))).toEqual({ text: "Done." });
	});

	it("textResponder repeats its text", async () => {
		expect(await textResponder("hello")(request())).toEqual({ text: "hello" });
	});
});

describe("the server", () => {
	let stub: StubServer | undefined;
	let dir: string | undefined;
	afterEach(async () => {
		await stub?.stop();
		stub = undefined;
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function post(body: unknown): Promise<Response> {
		return fetch(`${stub!.url}/chat/completions`, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		});
	}

	it("streams a scripted reply, logs the request body and appends it to the JSONL file", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "stub-model-test-"));
		const logFile = path.join(dir, "log.jsonl");
		stub = startStubModel({ responder: scriptedResponder([{ text: "hello there" }]), logFile });
		const res = await post(BODY);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const events: StubChunk[] = (await res.text())
			.split("\n\n")
			.filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
			.map(line => JSON.parse(line.slice(6)));
		expect(events.map(event => event.choices[0]?.delta.content ?? "").join("")).toBe("hello there");
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.lastUser).toBe("second");
		const lines = (await Bun.file(logFile).text()).trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry: StubLogEntry = JSON.parse(lines[0]!);
		expect(entry.status).toBe(200);
		expect(entry.request?.raw.messages).toEqual(BODY.messages);
	});

	it("answers a scripted error status as an OpenAI error body", async () => {
		stub = startStubModel({ responder: () => ({ status: 400, text: "nope" }) });
		const res = await post(BODY);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { message: "nope", type: "invalid_request_error" } });
	});

	it("turns a throwing responder into a 500 and an unknown route into a 404", async () => {
		stub = startStubModel({
			responder: () => {
				throw new Error("boom");
			},
		});
		const res = await post(BODY);
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).toContain("boom");
		expect((await fetch(`${stub.url}/nothing`)).status).toBe(404);
	});

	it("lists its model, answers without streaming when asked, and lets a test wait for calls", async () => {
		stub = startStubModel({ responder: textResponder("plain") });
		const models: { data: { id: string }[] } = await (await fetch(`${stub.url}/models`)).json();
		expect(models.data.map(model => model.id)).toEqual([STUB_MODEL_ID]);
		const waiting = stub.waitForRequests(1, 5_000);
		const res = await post({ ...BODY, stream: false });
		await waiting;
		const completion: StubCompletion = await res.json();
		expect(completion.choices[0]!.message.content).toBe("plain");
		await expect(stub.waitForRequests(5, 50)).rejects.toThrow("1 of 5");
	});
});

describe("the harness files", () => {
	it("models.yml prices the stub model and points at the stub", () => {
		const yaml = modelsYml("http://127.0.0.1:1234/v1");
		expect(yaml).toContain('baseUrl: "http://127.0.0.1:1234/v1"');
		expect(yaml).toContain("api: openai-completions");
		expect(yaml).toContain(`id: ${STUB_MODEL_ID}`);
		expect(yaml).toContain(`input: ${STUB_PRICING.inputPerMTok}`);
		expect(yaml).toContain(`output: ${STUB_PRICING.outputPerMTok}`);
	});

	it("config.yml puts the roles on the stub, skips update checks and keeps the local relay off port 7467", () => {
		const yaml = configYml({ localRelayPort: 45678, relayUrl: "ws://127.0.0.1:9" });
		expect(yaml).toContain(`default: ${STUB_SELECTOR}`);
		expect(yaml).toContain(`smol: ${STUB_SELECTOR}`);
		expect(yaml).toContain("checkUpdate: false");
		expect(yaml).toContain('localRelayUrl: "ws://127.0.0.1:45678"');
		expect(yaml).toContain('relayUrl: "ws://127.0.0.1:9"');
		expect(yaml).not.toContain("7467");
	});

	it("the tmux wrapper always uses the private socket and quotes its paths", () => {
		const script = tmuxWrapper("/opt/it's/tmux", "omp-e2e-1");
		expect(script).toContain("unset TMUX");
		expect(script).toContain(`exec '/opt/it'\\''s/tmux' -L 'omp-e2e-1' "$@"`);
	});
});
