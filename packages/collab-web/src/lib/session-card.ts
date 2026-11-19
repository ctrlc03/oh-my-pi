/**
 * What a session's card in the sessions list says about it, beyond its title: the agent's own todo progress (read from
 * the host's registry row) and the status and note the user gave it. Shared by the companion, which keeps the user's
 * part, and the app, which shows and edits it. Kept apart from the components so the decisions can be tested.
 */

/** Where the user says a session stands, whatever the agent is doing. Not the pin / snooze / settle organisation. */
export const CARD_STATUSES = ["todo", "in-progress", "in-review", "blocked", "done"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_LABEL: Record<CardStatus, string> = {
	todo: "To do",
	"in-progress": "In progress",
	"in-review": "In review",
	blocked: "Blocked",
	done: "Done",
};

/** Longest note a card carries: it is one line on a row, not a place for prose. */
export const MAX_NOTE_CHARS = 140;

/** The user's part of a card, as the companion sends it with a session row. */
export interface SessionCard {
	/** Null when only a note was written. */
	status: CardStatus | null;
	/** Empty when only a status was set. */
	note: string;
}

/** The agent's todo list progress, as the host's registry row reports it. */
export interface TodoProgress {
	/** Completed tasks. */
	done: number;
	/** Every task that is not abandoned. */
	total: number;
	/** The task in progress (else the first pending one); null when nothing is open. */
	current: string | null;
	/** The last task completed; null when none is. */
	lastDone: string | null;
}

export function isCardStatus(value: unknown): value is CardStatus {
	return typeof value === "string" && (CARD_STATUSES as readonly string[]).includes(value);
}

/** A note as stored: one line, trimmed, at most {@link MAX_NOTE_CHARS} characters. */
export function cleanNote(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const line = raw.replace(/\s+/g, " ").trim();
	return line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : line;
}

/**
 * A card from an untrusted request. A status other than the five (or null, for none) is refused rather than dropped:
 * the device asked for something this computer cannot show.
 */
export function parseCardUpdate(status: unknown, note: unknown): SessionCard {
	if (!(status === null || isCardStatus(status))) throw new Error("unknown card status");
	if (note !== undefined && typeof note !== "string") throw new Error("invalid note");
	return { status, note: cleanNote(note) };
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The todo progress of an untrusted registry row; undefined when absent or malformed (an omp that predates it). */
export function parseTodoProgress(raw: unknown): TodoProgress | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const fields = new Map(Object.entries(raw));
	const done = fields.get("done");
	const total = fields.get("total");
	if (!isCount(done) || !isCount(total) || total === 0 || done > total) return undefined;
	const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
	return { done, total, current: text(fields.get("current")), lastDone: text(fields.get("lastDone")) };
}

/** What a card shows of the todo list: `3/7`, and the task in progress, else the last one finished. */
export interface TodoLine {
	progress: string;
	/** Null when no task has been worked on yet. */
	text: string | null;
	/** `text` is the task being worked on; otherwise it is the last one completed. */
	active: boolean;
}

export function todoLine(todo: TodoProgress | undefined): TodoLine | null {
	if (todo === undefined || todo.total === 0) return null;
	const progress = `${todo.done}/${todo.total}`;
	if (todo.current !== null) return { progress, text: todo.current, active: true };
	return { progress, text: todo.lastDone, active: false };
}

/** The statuses some row carries, in the order a menu lists them: the choices of the card filter. */
export function cardFilterOptions(items: readonly { card?: SessionCard }[]): CardStatus[] {
	const present = new Set<CardStatus>();
	for (const item of items) if (item.card?.status) present.add(item.card.status);
	return CARD_STATUSES.filter(status => present.has(status));
}

/** `items` whose card has status `filter`; every item for `null` (All). */
export function filterByCard<T extends { card?: SessionCard }>(items: readonly T[], filter: CardStatus | null): T[] {
	return filter === null ? [...items] : items.filter(item => item.card?.status === filter);
}
