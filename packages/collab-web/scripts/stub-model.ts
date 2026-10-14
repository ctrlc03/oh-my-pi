/**
 * A scripted OpenAI-compatible model server, so the real companion and the real `omp` can be exercised end to end
 * without credentials or network: omp is pointed at it through a `models.yml` custom provider (see ./e2e-home).
 *
 * It speaks the streaming Chat Completions API (`POST /v1/chat/completions`, SSE) plus `GET /v1/models`; configure the
 * model as `api: openai-completions`. A {@link Responder} decides what each model call answers: text, tool calls, a
 * usage figure, a delay or an HTTP error. Every request body is kept in {@link StubServer.requests} (and optionally
 * appended to a JSONL file) so a test can assert what the prompt carried.
 *
 * ```ts
 * const stub = startStubModel({ responder: writeFileThenDone("/tmp/out.json", '{"ok":true}') });
 * // … run omp against stub.url …
 * stub.requests[0]!.lastUser; // the first message omp sent
 * await stub.stop();
 * ```
 *
 * Standalone: `bun scripts/stub-model.ts [--port N] [--log requests.jsonl] [--reply TEXT]` answers every call with TEXT.
 */

import * as fs from "node:fs";
import { isRecord } from "../src/tool-render/util";

/** Model id the stub serves, and the price omp is told it costs (see `modelsYml` in ./e2e-home). */
export const STUB_MODEL_ID = "stub-model";

/** USD per million tokens the harness configures for {@link STUB_MODEL_ID}; {@link StubUsage.costUsd} is converted with these. */
export const STUB_PRICING = { inputPerMTok: 3, outputPerMTok: 15 } as const;

export interface StubToolCall {
	/** Call id: taken from the request for an assistant message in the history; generated for a reply. */
	id: string;
	name: string;
	arguments: unknown;
}

export interface StubToolResult {
	/** The id of the call this answers. */
	id: string;
	text: string;
}

/** One message of the conversation the model was handed, flattened from the Chat Completions shape. */
export interface StubMessage {
	role: string;
	/** Text content; parts are joined, non-text parts dropped. */
	text: string;
	/** What an assistant message asked for. */
	toolCalls: StubToolCall[];
	/** What a `tool` message returns (one entry). */
	toolResults: StubToolResult[];
}

export interface StubRequest {
	/** 0-based count of model calls so far (chat completions only). */
	index: number;
	model: string;
	/** All system and developer messages, joined by a blank line. */
	system: string;
	messages: StubMessage[];
	/** Names of the tools the request offers. */
	tools: string[];
	/** Text of the last `user` message, "" when there is none. */
	lastUser: string;
	/** The parsed request body, untouched. */
	raw: Record<string, unknown>;
}

export interface StubUsage {
	input: number;
	output: number;
	/**
	 * What the call should cost omp, USD. omp prices a custom provider's tokens itself (from `models.yml`), so this is
	 * met by raising the reported input tokens (given {@link STUB_PRICING}); `input` is then ignored. Wins over `input`.
	 */
	costUsd?: number;
}

export interface StubReply {
	text?: string;
	toolCalls?: { name: string; arguments: object }[];
	/** Default: estimated from the sizes of the request and the reply. */
	usage?: StubUsage;
	/** Wait this long before answering. */
	delayMs?: number;
	/** An HTTP status of 400 or more answers an error instead of a completion (`text` becomes the message). */
	status?: number;
}

export type Responder = (request: StubRequest) => StubReply | Promise<StubReply>;

/** What was logged for one HTTP request. */
export interface StubLogEntry {
	at: string;
	method: string;
	path: string;
	status: number;
	/** The model call, for a chat completion. */
	request?: StubRequest;
	reply?: StubReply;
}

// ── normalising the request ──────────────────────────────────────────────────

/** Text of a message `content`: a string, or an array of parts of which the text ones are joined. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
		.filter(text => text !== "")
		.join("\n");
}

function parseArguments(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function normaliseMessage(message: Record<string, unknown>): StubMessage {
	const role = typeof message.role === "string" ? message.role : "";
	const text = contentText(message.content);
	const toolCalls: StubToolCall[] = [];
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!isRecord(call) || !isRecord(call.function)) continue;
			toolCalls.push({
				id: typeof call.id === "string" ? call.id : "",
				name: typeof call.function.name === "string" ? call.function.name : "",
				arguments: parseArguments(call.function.arguments),
			});
		}
	}
	const toolResults: StubToolResult[] =
		role === "tool" ? [{ id: typeof message.tool_call_id === "string" ? message.tool_call_id : "", text }] : [];
	return { role, text, toolCalls, toolResults };
}

/** The request a Chat Completions body makes, in the shape a {@link Responder} reads. */
export function normaliseRequest(body: unknown, index: number): StubRequest {
	const raw = isRecord(body) ? body : {};
	const messages = (Array.isArray(raw.messages) ? raw.messages : []).filter(isRecord).map(normaliseMessage);
	const tools = (Array.isArray(raw.tools) ? raw.tools : []).flatMap(tool =>
		isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : [],
	);
	const lastUser = messages.findLast(message => message.role === "user")?.text ?? "";
	const system = messages
		.filter(message => message.role === "system" || message.role === "developer")
		.map(message => message.text)
		.join("\n\n");
	return { index, model: typeof raw.model === "string" ? raw.model : "", system, messages, tools, lastUser, raw };
}

// ── encoding the reply ───────────────────────────────────────────────────────

/** Characters per streamed text or argument delta. */
const CHUNK_CHARS = 64;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Token counts omp is told about: the given ones, or estimates from the request and the reply. */
export function replyUsage(
	reply: StubReply,
	request: StubRequest,
	pricing = STUB_PRICING,
): { promptTokens: number; completionTokens: number } {
	const replyChars = (reply.text ?? "") + (reply.toolCalls ? JSON.stringify(reply.toolCalls) : "");
	const completionTokens = reply.usage?.output ?? estimateTokens(replyChars);
	const costUsd = reply.usage?.costUsd;
	if (costUsd !== undefined) {
		const outputCost = (completionTokens * pricing.outputPerMTok) / 1e6;
		const promptTokens = Math.max(0, Math.round(((costUsd - outputCost) * 1e6) / pricing.inputPerMTok));
		return { promptTokens, completionTokens };
	}
	return {
		promptTokens: reply.usage?.input ?? estimateTokens(JSON.stringify(request.raw)),
		completionTokens,
	};
}

function chunks(text: string): string[] {
	const out: string[] = [];
	for (let at = 0; at < text.length; at += CHUNK_CHARS) out.push(text.slice(at, at + CHUNK_CHARS));
	return out;
}

/** The stop reason a reply ends with. */
export function finishReason(reply: StubReply): "stop" | "tool_calls" {
	return (reply.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop";
}

/** A tool call as Chat Completions carries it: `index` and partial `arguments` in a streamed delta. */
export interface StubWireToolCall {
	index?: number;
	id?: string;
	type?: "function";
	function: { name?: string; arguments?: string };
}

export interface StubWireUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

/** One `data:` event of a streamed Chat Completions answer. */
export interface StubChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: {
		index: number;
		delta: { role?: "assistant"; content?: string; tool_calls?: StubWireToolCall[] };
		finish_reason: "stop" | "tool_calls" | null;
	}[];
	/** Only on the last event, which has no choices. */
	usage?: StubWireUsage;
}

/** Chat Completions streaming chunks (the JSON of each `data:` line) for `reply`, ending with the usage chunk. */
export function replyChunks(reply: StubReply, request: StubRequest, model: string): StubChunk[] {
	const id = `chatcmpl-stub-${request.index}`;
	const created = 1_700_000_000;
	const chunk = (
		delta: StubChunk["choices"][number]["delta"],
		finish: StubChunk["choices"][number]["finish_reason"],
	): StubChunk => ({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	const out = [chunk({ role: "assistant", content: "" }, null)];
	for (const piece of chunks(reply.text ?? "")) out.push(chunk({ content: piece }, null));
	(reply.toolCalls ?? []).forEach((call, index) => {
		out.push(
			chunk(
				{
					tool_calls: [
						{
							index,
							id: `call_stub_${request.index}_${index}`,
							type: "function",
							function: { name: call.name, arguments: "" },
						},
					],
				},
				null,
			),
		);
		for (const piece of chunks(JSON.stringify(call.arguments)))
			out.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }, null));
	});
	out.push(chunk({}, finishReason(reply)));
	const { promptTokens, completionTokens } = replyUsage(reply, request);
	out.push({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	});
	return out;
}

/** The body a streaming call answers: one `data:` event per chunk, then `data: [DONE]`. */
export function encodeSse(events: readonly unknown[]): string {
	return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A non-streaming Chat Completions body. */
export interface StubCompletion {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: {
		index: number;
		message: { role: "assistant"; content: string | null; tool_calls?: StubWireToolCall[] };
		finish_reason: "stop" | "tool_calls";
	}[];
	usage: StubWireUsage;
}

/** The body a non-streaming call answers. */
export function replyCompletion(reply: StubReply, request: StubRequest, model: string): StubCompletion {
	const { promptTokens, completionTokens } = replyUsage(reply, request);
	const toolCalls: StubWireToolCall[] = (reply.toolCalls ?? []).map((call, index) => ({
		id: `call_stub_${request.index}_${index}`,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	}));
	return {
		id: `chatcmpl-stub-${request.index}`,
		object: "chat.completion",
		created: 1_700_000_000,
		model,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: reply.text ?? null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: finishReason(reply),
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

// ── responders ───────────────────────────────────────────────────────────────

/** One step of a script: a fixed reply, or a function of the request. */
export type StubStep = StubReply | Responder;

/**
 * Reply `i` answers model call `i`. Past the end of the script the call fails with HTTP 500 and a message naming the
 * call, so a run that makes more calls than the test planned is visible instead of looping.
 */
export function scriptedResponder(steps: readonly StubStep[]): Responder {
	return request => {
		const step = steps[request.index];
		if (step === undefined)
			return { status: 500, text: `stub script exhausted: call ${request.index} but only ${steps.length} step(s)` };
		return typeof step === "function" ? step(request) : step;
	};
}

/** Every call answers `text`. */
export function textResponder(text: string): Responder {
	return () => ({ text });
}

/**
 * The restricted agent's happy path: while the conversation has no tool result yet, call `write` with
 * `{ path, content }`; once it has one, answer `done`. Stateless (it reads the history), so a retried call behaves the same.
 */
export function writeFileThenDone(path: string, content: string, done = "Done."): Responder {
	return request => {
		const wrote = request.messages.some(message => message.toolResults.length > 0);
		return wrote ? { text: done } : { toolCalls: [{ name: "write", arguments: { path, content } }] };
	};
}

// ── server ───────────────────────────────────────────────────────────────────

export interface StubModelOptions {
	responder: Responder;
	/** Listen on this port; default: any free one. */
	port?: number;
	/** Append one JSON line per request ({@link StubLogEntry}) to this file. */
	logFile?: string;
	/** The id `GET /v1/models` lists. Default {@link STUB_MODEL_ID}. */
	modelId?: string;
}

export interface StubServer {
	/** `http://127.0.0.1:<port>/v1`: the provider's `baseUrl`. */
	url: string;
	port: number;
	/** Every model call so far, in order. */
	requests: StubRequest[];
	/** Everything the server saw, including requests that were not model calls. */
	log: StubLogEntry[];
	/** Resolves once `count` model calls have arrived; rejects after `timeoutMs`. */
	waitForRequests(count: number, timeoutMs?: number): Promise<void>;
	stop(): Promise<void>;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, message: string): Response {
	return jsonResponse(status, {
		error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code: null },
	});
}

/** Start the server on 127.0.0.1. */
export function startStubModel(options: StubModelOptions): StubServer {
	const modelId = options.modelId ?? STUB_MODEL_ID;
	const requests: StubRequest[] = [];
	const log: StubLogEntry[] = [];
	const waiters: { count: number; resolve: () => void }[] = [];
	const record = (entry: StubLogEntry): void => {
		log.push(entry);
		if (options.logFile) fs.appendFileSync(options.logFile, `${JSON.stringify(entry)}\n`);
	};

	const handleChat = async (req: Request, path: string): Promise<Response> => {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			record({ at: new Date().toISOString(), method: req.method, path, status: 400 });
			return errorResponse(400, "request body is not JSON");
		}
		const request = normaliseRequest(body, requests.length);
		requests.push(request);
		for (const waiter of waiters.filter(w => requests.length >= w.count)) waiter.resolve();
		let reply: StubReply;
		try {
			reply = await options.responder(request);
		} catch (err) {
			reply = { status: 500, text: `stub responder threw: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (reply.delayMs) await Bun.sleep(reply.delayMs);
		const status = reply.status !== undefined && reply.status >= 400 ? reply.status : 200;
		record({ at: new Date().toISOString(), method: req.method, path, status, request, reply });
		if (status !== 200) return errorResponse(status, reply.text ?? `stub error ${status}`);
		if (request.raw.stream === false)
			return jsonResponse(200, replyCompletion(reply, request, request.model || modelId));
		return new Response(encodeSse(replyChunks(reply, request, request.model || modelId)), {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		idleTimeout: 120,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (req.method === "POST" && path.endsWith("/chat/completions")) return handleChat(req, path);
			if (req.method === "GET" && path.endsWith("/models")) {
				record({ at: new Date().toISOString(), method: req.method, path, status: 200 });
				return jsonResponse(200, {
					object: "list",
					data: [{ id: modelId, object: "model", created: 0, owned_by: "stub" }],
				});
			}
			record({ at: new Date().toISOString(), method: req.method, path, status: 404 });
			return errorResponse(404, `stub: no route for ${req.method} ${path}`);
		},
	});
	const port = server.port ?? 0;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		port,
		requests,
		log,
		waitForRequests(count, timeoutMs = 60_000) {
			if (requests.length >= count) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(new Error(`stub model: ${requests.length} of ${count} requests after ${timeoutMs}ms`));
				}, timeoutMs);
				const waiter = {
					count,
					resolve: () => {
						clearTimeout(timer);
						waiters.splice(waiters.indexOf(waiter), 1);
						resolve();
					},
				};
				waiters.push(waiter);
			});
		},
		async stop() {
			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const at = argv.indexOf(name);
		return at >= 0 ? argv[at + 1] : undefined;
	};
	const stub = startStubModel({
		responder: textResponder(flag("--reply") ?? "Done."),
		port: flag("--port") !== undefined ? Number(flag("--port")) : undefined,
		logFile: flag("--log"),
	});
	console.log(`stub model listening on ${stub.url}`);
}
