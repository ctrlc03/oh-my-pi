/**
 * Guest-driven trajectory inspector for the collab host: `session-cmd` `inspect` and
 * `preview-request` (feature `inspect`). The rows and the preview are built by the session
 * (`getInspectRows`, `previewNextRequest`); this shapes them into the targeted frames with every
 * excerpt redacted through the session's secret obfuscator, since the guest is another machine.
 */
import type { AgentSession } from "../session/agent-session";
import type { CollabFrame } from "./protocol";

/** Newest requests an `inspect` frame carries; older ones stay in the host's `/inspect`. */
export const COLLAB_INSPECT_ROWS = 200;

/** Size cap of a `request-preview` frame's JSON text. */
export const COLLAB_PREVIEW_MAX_CHARS = 120_000;

/** Answer `session-cmd` `inspect`. */
export function replyInspect(session: Pick<AgentSession, "getInspectRows">, reply: (frame: CollabFrame) => void): void {
	const { rows, total } = session.getInspectRows({ redact: true, limit: COLLAB_INSPECT_ROWS });
	reply({ t: "inspect", rows, total });
}

/** Answer `session-cmd` `preview-request`; a refusal reaches the guest as its `error` frame. */
export async function replyRequestPreview(
	session: Pick<AgentSession, "previewNextRequest">,
	reply: (frame: CollabFrame) => void,
	fail: (message: string) => void,
): Promise<void> {
	try {
		const preview = await session.previewNextRequest({ redact: true, maxChars: COLLAB_PREVIEW_MAX_CHARS });
		reply({ t: "request-preview", preview });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
