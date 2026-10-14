/**
 * A scripted OpenAI-compatible chat-completions server for the Personal agent's end-to-end runs: a real omp
 * session talks to it instead of a model. The test queues replies (text, or tool calls such as `notify_owner`,
 * `retain`, `bash`), and every request the session makes is recorded for assertions (system prompt, messages,
 * the tools offered). No credentials, no network beyond loopback.
 *
 * A request that offers no tools is not the agent loop (a title, a summary): it gets a plain text reply and
 * never consumes the queue. Everything else takes the first queued reply whose `when` accepts it, or `idle`.
 */

/** One tool call of a scripted reply. */
export interface StubToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** What the stub answers. `tools` wins over `text`; `usage` overrides the default token counts (they set the turn's cost). */
export interface StubReply {
	text?: string;
	tools?: StubToolCall[];
	usage?: { promptTokens: number; completionTokens: number };
	/** Wait this long before answering: holds a turn open so a test can act while the agent is busy. */
	delayMs?: number;
}

/** A message of a recorded request, content flattened to text. */
export interface StubMessage {
	role: string;
	text: string;
	toolCalls: StubToolCall[];
}

/** A chat-completions request the session made. */
export interface StubRequest {
	/** Order of arrival, from 1. */
	n: number;
	at: number;
	model: string;
	/** The system (or developer) messages, joined. */
	system: string;
	messages: StubMessage[];
	/** Names of the tools offered. */
	toolNames: string[];
	/** The description of each tool offered, by name. */
	toolDescriptions: Record<string, string>;
	/** Text of the last user message. */
	lastUser: string;
	/** Everything the model was shown, as one string: for `toContain` checks. */
	transcript: string;
}

/** Tool results the model was shown after the last message that contains `marker`: those of the turn that marker started. */
export function toolResultsSince(request: StubRequest, marker: string): string[] {
	const from = request.messages.findLastIndex(message => message.role !== "tool" && message.text.includes(marker));
	return request.messages
		.slice(from + 1)
		.filter(message => message.role === "tool")
		.map(message => message.text);
}

export interface StubModel {
	/** `http://127.0.0.1:<port>/v1` */
	baseUrl: string;
	port: number;
	/** Every request so far, oldest first. */
	requests: StubRequest[];
	/** Queue a reply for the next agent-loop request `when` accepts (any, when omitted). */
	enqueue(reply: StubReply, when?: (request: StubRequest) => boolean): void;
	/** The reply for an agent-loop request that finds the queue empty; text "Noted." by default. */
	setIdle(reply: StubReply): void;
	/** Drop queued replies and recorded requests. */
	reset(): void;
	/** The requests of the agent loop (those that offer tools), oldest first; titles, summaries and memory extraction are left out. */
	agentRequests(): StubRequest[];
	/**
	 * Resolves with the first agent-loop request (already recorded or to come) after request number `after` that `match`
	 * accepts; `any` also considers requests that offer no tools.
	 */
	waitForRequest(
		match: (request: StubRequest) => boolean,
		options?: { after?: number; timeoutMs?: number; any?: boolean },
	): Promise<StubRequest>;
	stop(): void;
}

/** The `models.yml` that points a profile at this stub, with a model priced at `usdPerMillionTokens` (input and output). */
export function stubModelsYml(stub: StubModel, usdPerMillionTokens = 0): string {
	return [
		"providers:",
		"  stub:",
		`    baseUrl: ${stub.baseUrl}`,
		"    auth: none",
		"    api: openai-completions",
		"    models:",
		"      - id: stub-model",
		"        name: Stub model",
		"        reasoning: false",
		"        contextWindow: 200000",
		"        maxTokens: 4096",
		`        cost: { input: ${usdPerMillionTokens}, output: ${usdPerMillionTokens}, cacheRead: 0, cacheWrite: 0 }`,
		"",
	].join("\n");
}

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

interface RawMessage {
	role?: unknown;
	content?: unknown;
	tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
}

function parseCalls(raw: RawMessage): StubToolCall[] {
	return (raw.tool_calls ?? []).map(call => {
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(String(call.function?.arguments ?? "{}")) as Record<string, unknown>;
		} catch {
			// a malformed argument string is recorded as no arguments
		}
		return { name: String(call.function?.name ?? ""), args };
	});
}

function record(n: number, body: Record<string, unknown>): StubRequest {
	const raw = (Array.isArray(body.messages) ? body.messages : []) as RawMessage[];
	const messages: StubMessage[] = raw.map(message => ({
		role: String(message.role ?? ""),
		text: flatten(message.content),
		toolCalls: parseCalls(message),
	}));
	const tools = (Array.isArray(body.tools) ? body.tools : []) as Array<{
		function?: { name?: unknown; description?: unknown };
	}>;
	const system = messages
		.filter(message => message.role === "system" || message.role === "developer")
		.map(message => message.text)
		.join("\n");
	const lastUser = messages.findLast(message => message.role === "user")?.text ?? "";
	return {
		n,
		at: Date.now(),
		model: String(body.model ?? ""),
		system,
		messages,
		toolNames: tools.map(tool => String(tool.function?.name ?? "")),
		toolDescriptions: Object.fromEntries(
			tools.map(tool => [String(tool.function?.name ?? ""), String(tool.function?.description ?? "")]),
		),
		lastUser,
		transcript: messages.map(message => `${message.role}: ${message.text}`).join("\n"),
	};
}

const DEFAULT_USAGE = { promptTokens: 10, completionTokens: 5 };

function chunks(reply: StubReply, callIds: string): object[] {
	const usage = reply.usage ?? DEFAULT_USAGE;
	const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: "stub-model" };
	const delta = reply.tools?.length
		? {
				role: "assistant",
				tool_calls: reply.tools.map((tool, index) => ({
					index,
					id: `call_${callIds}_${index}`,
					type: "function",
					function: { name: tool.name, arguments: JSON.stringify(tool.args) },
				})),
			}
		: { role: "assistant", content: reply.text ?? "" };
	return [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] },
		{
			...base,
			choices: [],
			usage: {
				prompt_tokens: usage.promptTokens,
				completion_tokens: usage.completionTokens,
				total_tokens: usage.promptTokens + usage.completionTokens,
			},
		},
	];
}

/** Start the stub on a port the operating system picks. */
export function startStubModel(): StubModel {
	const requests: StubRequest[] = [];
	const queue: Array<{ reply: StubReply; when?: (request: StubRequest) => boolean }> = [];
	const waiters: Array<{
		match: (request: StubRequest) => boolean;
		after: number;
		resolve: (request: StubRequest) => void;
	}> = [];
	let idle: StubReply = { text: "Noted." };
	let calls = 0;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "stub-model", object: "model", owned_by: "stub" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as Record<string, unknown>;
			const entry = record(requests.length + 1, body);
			requests.push(entry);
			for (const waiter of waiters.splice(0)) {
				if (entry.n > waiter.after && waiter.match(entry)) waiter.resolve(entry);
				else waiters.push(waiter);
			}
			let reply: StubReply = { text: "ok" };
			if (entry.toolNames.length > 0) {
				const at = queue.findIndex(item => (item.when ? item.when(entry) : true));
				reply = at >= 0 ? queue.splice(at, 1)[0]!.reply : idle;
			}
			if (reply.delayMs) await Bun.sleep(reply.delayMs);
			if (body.stream !== true) {
				const usage = reply.usage ?? DEFAULT_USAGE;
				return Response.json({
					id: "chatcmpl-stub",
					object: "chat.completion",
					created: 0,
					model: "stub-model",
					choices: [
						{
							index: 0,
							finish_reason: reply.tools?.length ? "tool_calls" : "stop",
							message: {
								role: "assistant",
								content: reply.tools?.length ? null : (reply.text ?? ""),
								tool_calls: reply.tools?.map((tool, index) => ({
									id: `call_${calls}_${index}`,
									type: "function",
									function: { name: tool.name, arguments: JSON.stringify(tool.args) },
								})),
							},
						},
					],
					usage: {
						prompt_tokens: usage.promptTokens,
						completion_tokens: usage.completionTokens,
						total_tokens: usage.promptTokens + usage.completionTokens,
					},
				});
			}
			const events = chunks(reply, String(++calls)).map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
			return new Response(`${events.join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		port: server.port ?? 0,
		requests,
		enqueue(reply, when) {
			queue.push({ reply, when });
		},
		setIdle(reply) {
			idle = reply;
		},
		reset() {
			queue.length = 0;
			requests.length = 0;
			idle = { text: "Noted." };
		},
		agentRequests() {
			return requests.filter(entry => entry.toolNames.length > 0);
		},
		waitForRequest(accept, options = {}) {
			const after = options.after ?? 0;
			const match = (entry: StubRequest): boolean => (options.any || entry.toolNames.length > 0) && accept(entry);
			const seen = requests.find(entry => entry.n > after && match(entry));
			if (seen) return Promise.resolve(seen);
			const { promise, resolve, reject } = Promise.withResolvers<StubRequest>();
			const timer = setTimeout(() => {
				const at = waiters.findIndex(waiter => waiter.resolve === done);
				if (at >= 0) waiters.splice(at, 1);
				reject(
					new Error(
						`the stub saw no matching request within ${options.timeoutMs ?? 60_000} ms (${requests.length} seen)`,
					),
				);
			}, options.timeoutMs ?? 60_000);
			const done = (entry: StubRequest): void => {
				clearTimeout(timer);
				resolve(entry);
			};
			waiters.push({ match, after, resolve: done });
			return promise;
		},
		stop() {
			server.stop(true);
		},
	};
}
