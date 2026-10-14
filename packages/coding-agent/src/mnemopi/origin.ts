/**
 * Who a memory write is for, under `mnemopi.provenance`.
 *
 * A turn's origin is read from the session entries alone: the last entry that starts a turn (`personalEntryOrigin`:
 * a user message or a stamped `collab-prompt` / `personal-event`) says who the turn is for, until the next such
 * entry. Rows the agent writes during the turn (`retain`, `learn`, `memory_edit`) carry that origin, so text that
 * came from outside the session never becomes a row the agent seems to have written on its own.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	PERSONAL_AUTHOR_ID,
	PERSONAL_EVENT_MESSAGE_TYPE,
	PERSONAL_TRUST_TIER,
	type PersonalOrigin,
	type PersonalTurnOrigin,
	personalEntryOrigin,
} from "@oh-my-pi/pi-wire/personal-ipc";
import type { SessionEntry } from "../session/session-entries";

/** `source` labels are one short token; anything longer or multi-line is cut so it cannot bloat an author id. */
const MAX_SOURCE_CHARS = 80;

export interface TurnOrigin {
	origin: PersonalTurnOrigin;
	/** The producer of a `personal-event` (`github`, `script:x` …); absent for terminal and collab prompts. */
	source?: string;
}

/** The author columns of one memory row. */
export interface RowAuthor {
	authorId: string;
	authorType: PersonalOrigin;
	trustTier: string;
}

/** The origin of the turn `entry` starts, or undefined when it starts none. */
export function entryTurnOrigin(entry: SessionEntry): TurnOrigin | undefined {
	const origin = personalEntryOrigin(entry);
	if (origin === undefined) return undefined;
	if (entry.type === "custom_message" && entry.customType === PERSONAL_EVENT_MESSAGE_TYPE) {
		const source = isRecord(entry.details) ? entry.details.source : undefined;
		if (typeof source === "string" && source !== "") return { origin, source };
	}
	return { origin };
}

/** The origin of the turn in progress: the last turn-starting entry of the current branch; the owner when there is none. */
export function currentTurnOrigin(sessionManager: { getBranch(): SessionEntry[] }): TurnOrigin {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const origin = entryTurnOrigin(branch[index]);
		if (origin) return origin;
	}
	return { origin: "owner" };
}

/** The author columns for `origin`; an external row's id carries its `source` (`external:github`). */
export function rowAuthor(origin: PersonalOrigin, source?: string): RowAuthor {
	const label = source?.replace(/\s+/g, " ").trim().slice(0, MAX_SOURCE_CHARS);
	const base = PERSONAL_AUTHOR_ID[origin];
	return {
		authorId: origin === "external" && label ? `${base}:${label}` : base,
		authorType: origin,
		trustTier: PERSONAL_TRUST_TIER[origin],
	};
}

/**
 * The author of a row the agent writes itself in `turn`: `agent` in an owner turn, `external` in a turn an
 * outside event started, nothing for a guest turn (a guest never writes memory).
 */
export function agentWriteAuthor(turn: TurnOrigin): RowAuthor | undefined {
	if (turn.origin === "guest") return undefined;
	return turn.origin === "external" ? rowAuthor("external", turn.source) : rowAuthor("agent");
}
