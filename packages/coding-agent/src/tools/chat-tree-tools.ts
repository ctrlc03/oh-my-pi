import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter, sessionResolveContext } from "../internal-urls";
import { chatTreeActive } from "../personal/chat-tree/mode";
import type { ChatTreeSession } from "../personal/chat-tree/session";
import { ZoomError } from "../personal/chat-tree/zoom";
import { ZOOM_PAGE_CHARS } from "../personal/chat-tree/constants";
import dateDescription from "../prompts/tools/date.md" with { type: "text" };
import zoomDescription from "../prompts/tools/zoom.md" with { type: "text" };
import type { ToolSession } from ".";

const zoomSchema = type({
	id: type("number | string").describe("a message id (a multiple of n), or an agent's name"),
	"n?": type("number").describe("how many messages the line covers: a power of 2; 1 gives the message whole"),
	"page?": type("number").describe("page of a long message or transcript, from 1"),
});

const dateSchema = type({
	id: type("number").describe("the message id"),
});

function chatOf(session: ToolSession): ChatTreeSession {
	const chat = session.getChatTree?.();
	if (!chat) throw new ToolError("This session has no chat.");
	return chat;
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** The page `page` (from 1) of `text`, with the header that says how to read on. */
function pageOfTranscript(name: string, text: string, page: number): string {
	const pages = Math.max(1, Math.ceil(text.length / ZOOM_PAGE_CHARS));
	const shown = Math.min(Math.max(Math.trunc(page), 1), pages);
	const body = text.slice((shown - 1) * ZOOM_PAGE_CHARS, shown * ZOOM_PAGE_CHARS);
	if (pages === 1) return body;
	const more = shown < pages ? ` Next: zoom("${name}", page=${shown + 1}).` : "";
	return `${name}, page ${shown} of ${pages}.${more}\n${body}`;
}

/** `zoom` of the chat-tree memory mode (docs/personal-chat-tree.md). */
export class ZoomTool implements AgentTool<typeof zoomSchema, undefined> {
	readonly name = "zoom";
	readonly label = "Zoom";
	readonly summary = "Open a line of the chat view, or read a message whole";
	readonly description = prompt.render(zoomDescription);
	readonly parameters = zoomSchema;
	readonly strict = true;
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ZoomTool | null {
		return chatTreeActive(session.settings) && (session.taskDepth ?? 0) === 0 && session.getChatTree
			? new ZoomTool(session)
			: null;
	}

	async execute(
		_toolCallId: string,
		params: typeof zoomSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<undefined>> {
		const chat = chatOf(this.session);
		try {
			if (typeof params.id === "string") {
				const name = params.id.trim();
				if (name === "") throw new ToolError("zoom needs a message id or an agent's name.");
				const resource = await InternalUrlRouter.instance().resolve(
					`history://${name}`,
					sessionResolveContext(this.session, { signal }),
				);
				return textResult(pageOfTranscript(name, resource.content, params.page ?? 1));
			}
			return textResult(await chat.zoom(params.id, params.n ?? 1, params.page));
		} catch (error) {
			if (error instanceof ZoomError) throw new ToolError(error.message);
			throw error;
		}
	}
}

/** `date` of the chat-tree memory mode. */
export class DateTool implements AgentTool<typeof dateSchema, undefined> {
	readonly name = "date";
	readonly label = "Date";
	readonly summary = "The date and time of a message";
	readonly description = prompt.render(dateDescription);
	readonly parameters = dateSchema;
	readonly strict = true;
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): DateTool | null {
		return chatTreeActive(session.settings) && (session.taskDepth ?? 0) === 0 && session.getChatTree
			? new DateTool(session)
			: null;
	}

	async execute(_toolCallId: string, params: typeof dateSchema.infer): Promise<AgentToolResult<undefined>> {
		try {
			return textResult(await chatOf(this.session).date(params.id));
		} catch (error) {
			if (error instanceof ZoomError) throw new ToolError(error.message);
			throw error;
		}
	}
}
