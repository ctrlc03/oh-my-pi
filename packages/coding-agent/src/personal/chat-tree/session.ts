/**
 * The chat-tree mode as one session sees it (docs/personal-chat-tree.md): what is logged from the agent's events, and
 * how every owner message becomes a fresh model call made of [tools][system prompt][view][state][message].
 *
 * Nothing of the omp session's own history reaches the provider: `transformContext` replaces everything before the
 * turn's first message with one user message that carries the view and the state. Within a turn the calls go on
 * from that message (the model's tool calls and their results, messages the owner sends meanwhile). The next owner
 * message starts again from the chat.
 */
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { PERSONAL_EVENT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire/personal-ipc";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../../collab/protocol";
import type { Settings } from "../../config/settings";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../../session/async-job-delivery";
import { PR_WATCH_MESSAGE_TYPE } from "../../pr-watch/manager";
import { cfgPersonalChatTreeConcurrency } from "../settings";
import { CacheGate, type CompactionTransport, type RenderedView } from "./compactor";
import { ChatTree, type ChatTreeOptions } from "./chat-tree";
import { ChatLockedError } from "./log";
import type { ChatKind } from "./types";
import { dateOf, zoom } from "./zoom";

export interface ChatTreeSessionHost {
	settings: Settings;
	/** The profile's agent dir; the chat lives in `<agentDir>/personal-chat`. */
	agentDir: string;
	cwd(): string;
	convertToLlm(messages: AgentMessage[]): Message[];
	/** The model of the compactions and the transport that calls it, resolved when the chat opens. */
	compaction(): Promise<{ modelKey: string; transport: CompactionTransport }>;
	/** The model key of the turns, to know whether a turn shares the compactions' cache. */
	turnModelKey(): string | undefined;
	now?: () => Date;
	/** Overrides for tests: wait times, status interval. */
	chatOptions?: Partial<Pick<ChatTreeOptions, "turnWaitMs" | "waitForLockMs" | "statusIntervalMs" | "concurrency">>;
}

interface Turn {
	/** The messages that opened the turn, as they sit in the agent's list. */
	group: AgentMessage[];
	/** The one message every call of the turn starts from. */
	message: Message;
	open: boolean;
}

/** Custom messages that are something the chat should hold: an owner's prompt or an event. The rest are harness notices. */
const LOGGED_CUSTOM_TYPES: readonly string[] = [
	PERSONAL_EVENT_MESSAGE_TYPE,
	COLLAB_PROMPT_MESSAGE_TYPE,
	ASYNC_RESULT_MESSAGE_TYPE,
	PR_WATCH_MESSAGE_TYPE,
];

const RELEASE_TIMEOUT_MS = 30_000;

function isRun(message: AgentMessage): boolean {
	return message.role !== "assistant" && message.role !== "toolResult";
}

function flatten(messages: readonly Message[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") {
			out.push({ type: "text", text: message.content });
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text" || block.type === "image") out.push(block);
		}
	}
	return out;
}

/** The text of content blocks as the chat holds it: images are named, not stored. */
function contentText(content: string | readonly { type: string; text?: string; mimeType?: string }[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push(`[image: ${block.mimeType ?? "unknown type"}]`);
	}
	return parts.join("\n");
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

/** The names of the jobs an `async-result` message reports, and whether they are all subagent tasks. */
function jobLabels(details: unknown): { names: string; task: boolean } {
	const jobs = isRecord(details) && Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [];
	const names = jobs
		.map(job => stringField(job, "label") ?? stringField(job, "agentId") ?? stringField(job, "jobId") ?? "task")
		.join(", ");
	return { names: names || "task", task: jobs.length > 0 && jobs.every(job => job.type === "task") };
}

/** The text the model saw for `message`, through the same conversion the provider request uses. */
function convertedText(message: AgentMessage, convert: (messages: AgentMessage[]) => Message[]): string {
	return convert([message])
		.map(converted => contentText(converted.content))
		.join("\n");
}

/** What the chat holds for a message that opens a turn or arrives within one; undefined for harness notices. */
export function describeInput(
	message: AgentMessage,
	convert: (messages: AgentMessage[]) => Message[],
): { kind: ChatKind; text: string } | undefined {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "pythonExecution": {
			const text = convertedText(message, convert);
			return text.trim() === "" ? undefined : { kind: "user", text };
		}
		case "fileMention": {
			const text = convertedText(message, convert);
			return text.trim() === "" ? undefined : { kind: "echo", text };
		}
		case "custom": {
			if (!LOGGED_CUSTOM_TYPES.includes(message.customType)) return undefined;
			const text = contentText(message.content);
			if (text.trim() === "") return undefined;
			if (message.customType === ASYNC_RESULT_MESSAGE_TYPE) {
				const { names, task } = jobLabels(message.details);
				return task ? { kind: "work", text: `[${names}] report\n${text}` } : { kind: "echo", text };
			}
			// Only the owner's own words are `user`: what an outside party sent (an event not signed by the owner, a
			// PR comment) is `echo`, so a summary never presents it as the owner's instruction.
			if (message.customType === PERSONAL_EVENT_MESSAGE_TYPE) {
				return { kind: isRecord(message.details) && message.details.trust === "owner" ? "user" : "echo", text };
			}
			if (message.customType === PR_WATCH_MESSAGE_TYPE) return { kind: "echo", text };
			return { kind: "user", text };
		}
		default:
			return undefined;
	}
}

/** `work` rows for a finished `task` tool call: one per subagent that reported. */
function workOf(toolName: string, details: unknown): { kind: ChatKind; text: string }[] | undefined {
	if (toolName !== "task" || !isRecord(details) || !Array.isArray(details.results)) return undefined;
	if (isRecord(details.async) && details.async.state === "running") return undefined;
	const rows: { kind: ChatKind; text: string }[] = [];
	for (const result of details.results.filter(isRecord)) {
		const output = stringField(result, "output")?.trim();
		if (output) rows.push({ kind: "work", text: `[${stringField(result, "id") ?? "task"}] report\n${output}` });
	}
	return rows.length > 0 ? rows : undefined;
}

function localState(now: Date, cwd: string): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(offsetMinutes);
	const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()];
	return `<state>\nNow: ${day} ${time} ${weekday}, UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}\nWorkspace: ${cwd}\n</state>`;
}

export class ChatTreeSession {
	readonly #host: ChatTreeSessionHost;
	/** The open chat, or the attempt that is opening it; undefined until the first use and again after an attempt failed. */
	#opened: Promise<ChatTree> | undefined;
	/** How long an attempt waits for a lock a live process holds: once that has refused the chat, the next attempts only look. */
	#lockWaitMs: number;
	readonly gate = new CacheGate();
	#turn: Turn | undefined;
	/** Messages of the chat already logged by a turn start: their own message events must not log them again. */
	#logged = new WeakSet<object>();
	/** Whether a turn start of this process has looked at the log's tail for a group a crashed process logged. */
	#tailChecked = false;
	#release: (() => void) | undefined;
	#disposed = false;

	constructor(host: ChatTreeSessionHost) {
		this.#host = host;
		this.#lockWaitMs = host.chatOptions?.waitForLockMs ?? 20_000;
		// Opening starts at once (a restarted chat resumes its summaries); a failure surfaces on the first turn or
		// tool call that needs the chat, which then tries again.
		this.#chat().catch(() => {});
	}

	async #open(): Promise<ChatTree> {
		const { modelKey, transport } = await this.#host.compaction();
		return await ChatTree.open({
			dir: `${this.#host.agentDir}/personal-chat`,
			concurrency: this.#host.chatOptions?.concurrency ?? cfgPersonalChatTreeConcurrency.get(this.#host.settings),
			transport,
			modelKey,
			gate: this.gate,
			now: this.#host.now,
			waitForLockMs: this.#lockWaitMs,
			turnWaitMs: this.#host.chatOptions?.turnWaitMs,
			statusIntervalMs: this.#host.chatOptions?.statusIntervalMs,
		});
	}

	/** The open chat; a failed attempt is not remembered, so the next use opens it again (the lock's holder may have left, the model may have appeared). */
	#chat(): Promise<ChatTree> {
		if (this.#opened) return this.#opened;
		if (this.#disposed) return Promise.reject(new Error("The chat is closed"));
		const opening = this.#open();
		this.#opened = opening;
		opening.catch(error => {
			if (this.#opened === opening) this.#opened = undefined;
			if (error instanceof ChatLockedError) this.#lockWaitMs = 0;
			logger.error("chat-tree could not open", { error: String(error) });
		});
		return opening;
	}

	/** Resolves with the open chat; rejects when it cannot be opened now (another live process owns it), and opens it again on the next use. */
	get ready(): Promise<ChatTree> {
		return this.#chat();
	}

	/** Logs a note (memories from before the chat); starts no turn. */
	async logNote(text: string): Promise<void> {
		await (await this.#chat()).logMessage("note", text);
	}

	async zoom(id: number, n: number, page?: number): Promise<string> {
		return await zoom(await this.#chat(), id, n, page);
	}

	async date(id: number): Promise<string> {
		return dateOf(await this.#chat(), id);
	}

	#log(kind: ChatKind, text: string): void {
		void this.#chat()
			.then(chat => chat.logMessage(kind, text))
			.catch(error => logger.warn("chat-tree could not log a message", { kind, error: String(error) }));
	}

	/** Called with every agent event, before anything awaits. */
	onAgentEvent(event: AgentEvent): void {
		if (event.type === "agent_end") {
			this.#endTurn();
			return;
		}
		// The provider's `start` comes before it has read the request (the first byte of the response is what makes the
		// cache entry available), so only a message's first content releases the gate.
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.contentIndex !== undefined) this.#release?.();
			return;
		}
		if (event.type !== "message_end") return;
		const message = event.message;
		const turn = this.#turn;
		if (message.role === "assistant") {
			let hasToolCall = false;
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim() !== "") this.#log("unii", block.text);
				else if (block.type === "toolCall") {
					hasToolCall = true;
					this.#log("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			if (!hasToolCall) this.#endTurn();
			return;
		}
		if (message.role === "toolResult") {
			const work = workOf(message.toolName, message.details);
			if (work) {
				for (const row of work) this.#log(row.kind, row.text);
				return;
			}
			const text = contentText(message.content);
			this.#log("echo", message.isError ? `error: ${text}` : text);
			return;
		}
		// A message the owner sends within a turn reaches the model between its tool calls: it is part of the chat too.
		if (!turn?.open || this.#logged.has(message)) return;
		const input = describeInput(message, m => this.#host.convertToLlm(m));
		if (input) this.#log(input.kind, input.text);
		this.#logged.add(message);
	}

	#endTurn(): void {
		if (this.#turn) this.#turn.open = false;
		this.#release?.();
	}

	/**
	 * The `transformContext` of the session in this mode: the first call of a turn builds the turn's message from the
	 * view; every call of the turn sends that message, then what the turn has added to the list.
	 */
	async transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const current = this.#turn;
		if (current?.open) {
			return this.#assemble(current, messages) ?? messages;
		}
		let run: AgentMessage[] = [];
		for (let i = messages.length - 1; i >= 0 && isRun(messages[i] as AgentMessage); i--)
			run.unshift(messages[i] as AgentMessage);
		let turn: Turn | undefined;
		if (run.length > 0 && current && current.group[0] === run[0]) turn = current;
		else if (run.length === 0 && current && messages.includes(current.group[0] as AgentMessage)) turn = current;
		if (!turn) {
			if (run.length === 0) run = this.#lastRun(messages);
			if (run.length === 0) return messages;
			turn = await this.#beginTurn(run, !run.every(m => this.#logged.has(m)), signal);
		}
		turn.open = true;
		this.#turn = turn;
		return this.#assemble(turn, messages) ?? messages;
	}

	/** The newest run of owner-side messages in a list that does not end with one: the start of a turn a restart cut off. */
	#lastRun(messages: AgentMessage[]): AgentMessage[] {
		let end = messages.length - 1;
		while (end >= 0 && !isRun(messages[end] as AgentMessage)) end--;
		if (end < 0) return [];
		let start = end;
		while (start > 0 && isRun(messages[start - 1] as AgentMessage)) start--;
		return messages.slice(start, end + 1);
	}

	async #beginTurn(group: AgentMessage[], log: boolean, signal: AbortSignal | undefined): Promise<Turn> {
		const chat = await this.#chat();
		const convert = (messages: AgentMessage[]) => this.#host.convertToLlm(messages);
		let rows: { kind: ChatKind; text: string; at?: number }[] = [];
		if (log) {
			for (const member of group) {
				const row = describeInput(member, convert);
				if (row) rows.push({ ...row, at: typeof member.timestamp === "number" ? member.timestamp : undefined });
			}
			// `#logged` is memory: a process that starts on the history of a crashed one has no record of the turn start
			// that one logged before it died, and that start is the head of this group when the prompt that follows it
			// joins it. Only the first turn of a process can meet such a message, so only then is the log's tail read.
			if (!this.#tailChecked) rows = rows.slice(await chat.loggedTail(rows));
		}
		this.#tailChecked = true;
		const view: RenderedView = await chat.beginTurn(rows, signal);
		for (const member of group) this.#logged.add(member);
		const content: (TextContent | ImageContent)[] = view.blocks.map(text => ({ type: "text", text }));
		const last = content.at(-1);
		if (last && last.type === "text") last.cacheBoundary = true;
		content.push({ type: "text", text: view.tail });
		content.push({ type: "text", text: localState(this.#host.now?.() ?? new Date(), this.#host.cwd()) });
		content.push(...flatten(convert(group)));
		const authored = group.some(member => member.role === "user");
		const message: Message = {
			role: "user",
			content,
			attribution: authored ? "user" : "agent",
			timestamp: Date.now(),
		};
		return { group, message, open: true };
	}

	#assemble(turn: Turn, messages: AgentMessage[]): AgentMessage[] | undefined {
		const first = messages.indexOf(turn.group[0] as AgentMessage);
		if (first < 0) return undefined;
		let end = first;
		for (const member of turn.group) {
			const at = messages.indexOf(member, end);
			if (at >= 0) end = at;
		}
		return [turn.message as AgentMessage, ...messages.slice(end + 1)];
	}

	/**
	 * Before each model call of a turn: when the turn runs on the model the compactions use, a compaction that is
	 * writing the cache entry of the tools and system prompt goes first (§3.3), and this call becomes the writer.
	 * Aborting `signal` ends the wait and gives the gate back.
	 */
	async beforeModelCall(signal?: AbortSignal): Promise<void> {
		const turnModel = this.#host.turnModelKey();
		if (!turnModel || this.#disposed) return;
		const { modelKey } = await this.#host.compaction();
		if (turnModel !== modelKey) return;
		signal?.throwIfAborted();
		this.#release?.();
		const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
		const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
		const timer = setTimeout(finish, RELEASE_TIMEOUT_MS);
		this.#release = () => {
			clearTimeout(timer);
			finish();
			if (this.#release === release) this.#release = undefined;
		};
		const release = this.#release;
		void this.gate
			.run([`head:${modelKey}`], async () => {
				enter();
				await finished;
			})
			.catch(error => logger.debug("chat-tree turn gate failed", { error: String(error) }));
		const { promise: aborted, resolve: stop } = Promise.withResolvers<void>();
		const onAbort = () => stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([entered, aborted]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (signal?.aborted) {
			release();
			signal.throwIfAborted();
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#release?.();
		const opening = this.#opened;
		try {
			if (opening) await (await opening).close();
		} catch {
			// Never opened: nothing to release.
		}
	}
}
