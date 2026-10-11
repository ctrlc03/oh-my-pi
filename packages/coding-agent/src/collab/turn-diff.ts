/**
 * Guest-driven per-turn diffs and receipts for the collab host: `session-cmd` `turn-diff`,
 * `session-diff` (feature `turn-diff`) and `receipts` (feature `receipts`). The diffing lives in
 * `session/turn-diff*.ts` and the extraction in `session/receipts.ts`; this only shapes their
 * results into the targeted `turn-diff` / `receipts` frames.
 */
import type { AgentSession } from "../session/agent-session";
import { buildReceipts } from "../session/receipts";
import { runSessionDiff, runTurnDiff } from "../session/turn-diff-run";
import type { CollabFrame } from "./protocol";

type DiffSession = Parameters<typeof runTurnDiff>[0];

/** Answer `turn-diff` (`entryId` a prompt on the active path) or, with no `entryId`, `session-diff`. */
export async function replyTurnDiff(
	session: DiffSession,
	entryId: string | undefined,
	reply: (frame: CollabFrame) => void,
): Promise<void> {
	const scope = entryId === undefined ? "session" : "turn";
	const outcome = entryId === undefined ? await runSessionDiff(session) : await runTurnDiff(session, entryId);
	if ("reason" in outcome) {
		reply({ t: "turn-diff", scope, entryId: entryId ?? null, files: null, reason: outcome.reason });
		return;
	}
	reply({
		t: "turn-diff",
		scope,
		entryId: entryId ?? null,
		files: outcome.diff.files,
		spansTurns: outcome.diff.spansTurns,
		...(outcome.diff.omitted > 0 ? { omitted: outcome.diff.omitted } : {}),
	});
}

/** Answer `receipts` with what the active path did. */
export function replyReceipts(
	session: Pick<AgentSession, "sessionManager">,
	reply: (frame: CollabFrame) => void,
): void {
	reply({ t: "receipts", receipts: buildReceipts(session.sessionManager.getBranch()) });
}
