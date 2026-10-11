/**
 * Guest-driven "what fills the context" for the collab host: `session-cmd` `context-items` and
 * `context-prune` (feature `context-items`). The ranking and the pruning live in
 * `session/context-items.ts` and `SessionMaintenance`; this only shapes the ranking into the
 * targeted `context-items` frame and turns a refusal into the guest's `error`.
 */
import type { ContextItemRow } from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../session/agent-session";
import type { ContextItem } from "../session/context-items";
import type { CollabFrame } from "./protocol";

/** Rows a `context-items` frame carries; the tail is too small to be worth pruning one by one. */
export const COLLAB_CONTEXT_ITEM_ROWS = 30;

/** The host's own context meter, so guests see the numbers its status line shows. */
export interface ContextMeter {
	usedTokens: number;
	contextWindow: number;
}

function toRow(item: ContextItem): ContextItemRow {
	return {
		id: item.id,
		kind: item.kind,
		label: item.label,
		tokens: item.tokens,
		share: item.share,
		prunable: item.targets.length > 0,
	};
}

/** Answer `session-cmd` `context-items` (and, with `pruned`, `context-prune`). */
export function replyContextItems(
	session: Pick<AgentSession, "getContextItems">,
	meter: ContextMeter,
	reply: (frame: CollabFrame) => void,
	pruned?: { entries: number; tokensFreed: number },
): void {
	reply({
		t: "context-items",
		items: session.getContextItems().slice(0, COLLAB_CONTEXT_ITEM_ROWS).map(toRow),
		usedTokens: meter.usedTokens,
		contextWindow: meter.contextWindow,
		...(pruned ? { pruned } : {}),
	});
}

/**
 * Prune the item a guest picked from its last `context-items` frame. `refreshMeter` runs once the
 * context has changed and returns the host's updated meter. Resolves the notice text for the room,
 * or undefined after reporting a refusal through `fail`.
 */
export async function runGuestContextPrune(
	session: Pick<AgentSession, "getContextItems" | "pruneContextItems">,
	itemId: string | undefined,
	refreshMeter: () => ContextMeter,
	reply: (frame: CollabFrame) => void,
	fail: (message: string) => void,
): Promise<string | undefined> {
	const item = session.getContextItems().find(candidate => candidate.id === itemId);
	if (!item) {
		fail("that item is no longer in the context");
		return undefined;
	}
	if (item.targets.length === 0) {
		fail(`${item.label} cannot be pruned`);
		return undefined;
	}
	const result = await session.pruneContextItems([item]);
	replyContextItems(session, refreshMeter(), reply, {
		entries: result.entriesRewritten,
		tokensFreed: result.tokensFreed,
	});
	return `pruned ${item.label} from the context (~${result.tokensFreed} tokens)`;
}
