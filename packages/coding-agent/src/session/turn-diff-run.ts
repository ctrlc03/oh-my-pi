/**
 * Which prompts bound a turn, and the never-throwing entry points the TUI `/diff` and the collab
 * host's `turn-diff` / `session-diff` commands share. The diffing itself is
 * {@link FileSnapshotStore.turnDiff} / {@link FileSnapshotStore.sessionDiff}.
 */
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { AgentSession } from "./agent-session";
import { isTranscriptEntry } from "./session-context";
import type { SessionEntry } from "./session-entries";
import type { TurnDiff } from "./turn-diff";

/** Prompts of the active path, oldest first. */
export function promptIdsOf(branch: readonly SessionEntry[]): string[] {
	return branch.filter(entry => isTranscriptEntry(entry) && isUserRequestEntry(entry)).map(entry => entry.id);
}

type DiffSession = Pick<AgentSession, "sessionManager" | "canRestoreFiles" | "diffFilesSince" | "diffFilesSinceStart">;

/** The diff, or why there is none. */
export type TurnDiffOutcome = { diff: TurnDiff } | { reason: string };

const NO_SNAPSHOTS = "file snapshots are off or this session is not in a git repository";

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What prompt `entryId` changed: the files from before it to before the next prompt with a snapshot,
 * or to the working tree when none follows. Never throws; a refusal carries its reason.
 */
export async function runTurnDiff(session: DiffSession, entryId: string): Promise<TurnDiffOutcome> {
	if (!session.canRestoreFiles) return { reason: NO_SNAPSHOTS };
	const prompts = promptIdsOf(session.sessionManager.getBranch());
	const at = prompts.indexOf(entryId);
	if (at < 0) return { reason: "not a prompt on the active conversation" };
	try {
		const diff = await session.diffFilesSince(entryId, prompts.slice(at + 1));
		return diff ? { diff } : { reason: "no file snapshot was recorded before that prompt" };
	} catch (error) {
		return { reason: reasonOf(error) };
	}
}

/** Everything changed since the session's first snapshot on the active path. Never throws. */
export async function runSessionDiff(session: DiffSession): Promise<TurnDiffOutcome> {
	if (!session.canRestoreFiles) return { reason: NO_SNAPSHOTS };
	try {
		const diff = await session.diffFilesSinceStart(promptIdsOf(session.sessionManager.getBranch()));
		return diff ? { diff } : { reason: "no file snapshot was recorded in this session" };
	} catch (error) {
		return { reason: reasonOf(error) };
	}
}
