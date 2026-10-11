/**
 * Stable ids for queued messages, so a remote editor can name one chip across edits and moves even
 * when two chips carry the same text. The id lives on the message object (a side map, never in the
 * transcript) and is handed to a replacement object with {@link carryQueuedId}.
 */

const ids = new WeakMap<object, string>();
let next = 0;

/** The id of `message`, minted on first use; ids are never reused within the process. */
export function queuedId(message: object): string {
	let id = ids.get(message);
	if (id === undefined) {
		id = `q${(++next).toString(36)}`;
		ids.set(message, id);
	}
	return id;
}

/** Gives `to` the id `from` has (minting it first), so an edited copy keeps its chip. */
export function carryQueuedId(from: object, to: object): void {
	ids.set(to, queuedId(from));
}
