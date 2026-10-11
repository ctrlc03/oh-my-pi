import { useMemo } from "react";
import type { GuestSnapshot } from "../../lib/client";
import type { CompanionClient } from "../../lib/companion";
import type { MentionSources } from "./MentionMenu";

/** Sessions offered by `@`: the most recent of the paired computer. */
const SESSION_LIST_LIMIT = 40;

export interface ComposerExtras {
	followUpIds: readonly string[];
	queueEdit: boolean;
	mentions: MentionSources | null;
}

/**
 * What the composer needs to edit the host's queued follow-ups and to mention pull requests and sessions: the host's
 * `queue-edit` and `mentions` features (writers only), and the paired computer, which lists the session's open pull
 * requests (`hostId` is this session's host there; `canGithub`) and the other sessions.
 */
export function useComposerExtras(
	snap: GuestSnapshot,
	companion: CompanionClient | null,
	hostId: string | null,
	canGithub: boolean,
): ComposerExtras {
	const mentionsOn = Object.hasOwn(snap.features, "mentions") && !snap.readOnly;
	const queueEdit = Object.hasOwn(snap.features, "queue-edit") && !snap.readOnly;
	const currentSessionId = snap.header?.id ?? null;
	const mentions = useMemo<MentionSources | null>(() => {
		if (!mentionsOn) return null;
		return {
			prs:
				companion !== null && hostId !== null && canGithub
					? async () => (await companion.requestGithub(hostId, "pr", "open")).items
					: null,
			sessions:
				companion === null
					? null
					: async () =>
							(await companion.requestSessions({ limit: SESSION_LIST_LIMIT })).map(session => ({
								id: session.sessionId,
								title: session.title ?? session.sessionId.slice(0, 8),
								folder: session.folder,
							})),
			currentSessionId,
		};
	}, [mentionsOn, companion, hostId, canGithub, currentSessionId]);
	return { followUpIds: snap.followUpIds, queueEdit, mentions };
}
