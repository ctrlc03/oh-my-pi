/**
 * The compaction calls as provider requests (the spec's §3.3, §4): a side request whose system prompt and tools are
 * the turns' (the host builds the context from them), whose one user message is the view, in cache blocks, followed by
 * the task, and whose later turns are the model's replies and the "Too long" follow-ups. It never calls a tool.
 */
import type { AssistantMessage, Context, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import type { CompactionCall, CompactionHooks, CompactionTransport } from "./compactor";

export interface SideRequestHost {
	/** The system prompt and tools of a turn, around `messages`. */
	buildContext(messages: Message[]): Promise<Context>;
	/** Sends the request on the compaction model; resolves to the text of the reply. `onStart` is called when the response has its first content (not at the provider's `start`, which precedes the request). */
	send(context: Context, signal: AbortSignal | undefined, onStart: () => void): Promise<string>;
	/** The model the compactions run on, for the assistant messages that replay earlier replies. */
	model(): Model;
}

/** The user message of a call: view blocks, the last whole one marked for the cache, the rest of the view, the task. */
function firstUserMessage(call: CompactionCall): Message {
	const content: TextContent[] = call.view.blocks.map(text => ({ type: "text", text }));
	const last = content.at(-1);
	if (last) last.cacheBoundary = true;
	content.push({ type: "text", text: call.view.tail });
	content.push({ type: "text", text: call.turns[0] as string });
	return { role: "user", content, attribution: "agent", timestamp: Date.now() };
}

/** The request of a call: the first message, then each reply and the follow-up that answered it. */
export function compactionMessages(call: CompactionCall, model: Model): Message[] {
	const messages: Message[] = [firstUserMessage(call)];
	for (let k = 0; k < call.replies.length; k++) {
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: call.replies[k] as string }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		messages.push(reply, {
			role: "user",
			content: [{ type: "text", text: call.turns[k + 1] as string }],
			attribution: "agent",
			timestamp: Date.now(),
		});
	}
	return messages;
}

export function createCompactionTransport(host: SideRequestHost): CompactionTransport {
	return async (call: CompactionCall, hooks: CompactionHooks) => {
		const context = await host.buildContext(compactionMessages(call, host.model()));
		return await host.send(context, hooks.signal, hooks.onResponseStart);
	};
}
