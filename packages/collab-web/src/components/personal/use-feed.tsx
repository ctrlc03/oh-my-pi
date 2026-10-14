import type { PersonalChangeKind } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { mergeNewest } from "../../lib/personal-activity";
import type { PersonalControl, PersonalQuery } from "../../lib/use-personal";
import { usePersonalQuery } from "../../lib/use-personal";
import { type Action, useAction } from "./shared";

export interface Feed<T> {
	/** The newest page, refetched when the companion pushes a change of `what`. */
	query: PersonalQuery<T[]>;
	/** The newest page and every older page asked for, newest first. */
	items: T[];
	/** Another page may exist. */
	hasMore: boolean;
	older: Action;
	showOlder(): void;
}

/**
 * A newest-first list the companion serves in pages: the first page stays current by itself, "Show older" appends the
 * page before the oldest row shown (`before` = its `at`).
 */
export function useFeed<T extends { id: string; at: number }>(
	personal: PersonalControl,
	what: readonly PersonalChangeKind[],
	pageSize: number,
	fetchPage: (call: PersonalControl["call"], before: number | undefined) => Promise<T[]>,
): Feed<T> {
	const query = usePersonalQuery(personal, what, call => fetchPage(call, undefined));
	const [older, setOlder] = useState<T[]>([]);
	const [exhausted, setExhausted] = useState(false);
	const action = useAction();
	const head = query.state.status === "ready" ? query.state.value : [];
	const items = mergeNewest(item => item.at, head, older);

	const showOlder = (): void => {
		const oldest = items.at(-1)?.at;
		if (oldest === undefined) return;
		void action.run(async () => {
			const page = await fetchPage(personal.call, oldest);
			setOlder(prev => mergeNewest(item => item.at, prev, page));
			setExhausted(page.length < pageSize);
		});
	};

	return { query, items, hasMore: !exhausted && items.length >= pageSize, older: action, showOlder };
}

/** The "Show older" button under a feed, with the failure of the last try. */
export function ShowOlder({ feed }: { feed: Feed<unknown> }): ReactNode {
	if (!feed.hasMore) return null;
	return (
		<div className="pa-older">
			<button type="button" className="sh-btn" disabled={feed.older.busy} onClick={feed.showOlder}>
				{feed.older.busy && <LoaderCircle size={14} className="sh-spin" />} Show older
			</button>
			{feed.older.error !== null && <div className="sh-connect-error">{feed.older.error}</div>}
		</div>
	);
}
