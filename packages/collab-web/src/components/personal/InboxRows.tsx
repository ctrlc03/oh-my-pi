import type { ReactNode } from "react";
import type { InboxItem } from "../../lib/companion";
import type { MergedInboxItem } from "../../lib/personal";
import { PersonalInboxRow, usePersonalInboxData } from "./InboxItems";

export interface PersonalInboxRowsProps {
	/** The merged inbox, in its order. */
	items: readonly MergedInboxItem<InboxItem>[];
	/** A session row, keyed. */
	renderSession(entry: Extract<MergedInboxItem<InboxItem>, { source: "session" }>): ReactNode;
	onReload(): void;
}

/**
 * The inbox's rows when it holds Personal items: the sheet's own session rows and the Personal rows, interleaved as
 * merged. A module of its own, loaded only when a Personal item exists, so the proposal and digest views stay out of
 * the app's entry chunk.
 */
export default function PersonalInboxRows({ items, renderSession, onReload }: PersonalInboxRowsProps): ReactNode {
	const data = usePersonalInboxData(items.flatMap(entry => (entry.source === "personal" ? [entry.item] : [])));
	return items.map(entry =>
		entry.source === "personal" ? (
			<PersonalInboxRow key={`personal:${entry.item.id}`} item={entry.item} data={data} onReload={onReload} />
		) : (
			renderSession(entry)
		),
	);
}
