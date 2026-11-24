/**
 * Mid-turn replies: the agent answers the user without ending its turn by writing Markdown to `out://`
 * (the host's only `reply`-scoped scheme; see coding-agent `internal-urls/out-protocol.ts`). The host's
 * terminal draws them as assistant prose, and so must the web transcript: folded into a tool run, the
 * answer to a question asked mid-task never reaches a guest.
 * - A `write` call to `out://…` carries the reply in its `content` argument.
 * - Text a tool's commands redirect there (`printf … > out://` in bash, a bridged eval call) arrives in
 *   that tool's result as `details.replies`.
 */
import { isRecord } from "../tool-render/util";

const REPLY_SCHEME = "out://";

/** The reply a `write` call to `out://` sends, or undefined for any other call (or one whose path has not streamed in yet). */
export function replyWriteText(toolName: string, args: unknown): string | undefined {
	if (toolName !== "write" || !isRecord(args)) return undefined;
	const target = typeof args.path === "string" ? args.path : args.file_path;
	if (typeof target !== "string" || !target.trim().toLowerCase().startsWith(REPLY_SCHEME)) return undefined;
	return typeof args.content === "string" ? args.content : "";
}

/** Replies a tool result carries in `details.replies`, oldest first. */
export function toolResultReplies(details: unknown): readonly string[] {
	if (!isRecord(details) || !Array.isArray(details.replies)) return [];
	return details.replies.filter((reply): reply is string => typeof reply === "string" && reply.trim() !== "");
}
