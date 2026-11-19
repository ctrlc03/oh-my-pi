import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { hostKey } from "../../lib/inbox";
import { unreadLabel } from "../../lib/unread";
import { useUnread } from "./UnreadHost";
import "./inbox.css";

export interface UnreadBadgeProps {
	computerId: string;
	instanceId: string;
}

/**
 * The Inbox icon with the number of updates the session has waiting, on its row; nothing when there are none or when the
 * session is on screen. A question the session waits on is in the warning colour, finished turns are neutral.
 */
export function UnreadBadge({ computerId, instanceId }: UnreadBadgeProps): ReactNode {
	const { sessions, viewing } = useUnread();
	const key = hostKey(computerId, instanceId);
	const entry = sessions.get(key);
	if (entry === undefined || viewing.has(key)) return null;
	return (
		<span
			className="sh-unread"
			data-needs-input={entry.needsInput || undefined}
			role="img"
			aria-label={unreadLabel(entry)}
		>
			<Inbox size={11} aria-hidden />
			{entry.count}
		</span>
	);
}
