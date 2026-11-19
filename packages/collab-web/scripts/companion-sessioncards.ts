/**
 * The status and note the user gave a session ("In review", "waiting on the API key"), kept on the computer so every
 * paired device shows the same ones (see ../src/lib/session-card). One card per session id, written by whichever
 * device set it last. It is the user's own bookkeeping: nothing here reaches a session or changes what the agent
 * does. Persisted to a file private to the user (mode 0600).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanNote, isCardStatus, parseCardUpdate, type SessionCard } from "../src/lib/session-card";
import { SAFE_ID_RE } from "./companion-sessions";

/** Cards kept; once past it the longest untouched ones go, so sessions deleted long ago do not pile up. */
export const MAX_CARDS = 1000;

interface StoredCard extends SessionCard {
	/** When the card was last set (ms). */
	at: number;
}

export interface CardsFile {
	/** Counts changes; devices list their sessions again when the number moves. */
	rev: number;
	cards: Record<string, StoredCard>;
}

/** A cards file from untrusted JSON: damaged cards are dropped, never thrown. */
export function parseCardsFile(raw: unknown): CardsFile {
	const fieldsOf = (value: unknown): Map<string, unknown> =>
		new Map(typeof value === "object" && value !== null ? Object.entries(value) : []);
	const file = fieldsOf(raw);
	const stored = file.get("rev");
	const rev = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : 0;
	const cards: Record<string, StoredCard> = {};
	for (const [sessionId, value] of fieldsOf(file.get("cards"))) {
		if (!SAFE_ID_RE.test(sessionId)) continue;
		const fields = fieldsOf(value);
		const status = fields.get("status");
		const at = fields.get("at");
		if (!(status === null || isCardStatus(status))) continue;
		if (typeof at !== "number" || !Number.isFinite(at)) continue;
		const card: SessionCard = { status, note: cleanNote(fields.get("note")) };
		if (card.status === null && card.note === "") continue;
		cards[sessionId] = { ...card, at };
	}
	return { rev, cards };
}

/** The cards with `sessionId` set to `card`, or removed when it says nothing; the newest {@link MAX_CARDS} are kept. */
export function withCard(
	cards: Readonly<Record<string, StoredCard>>,
	sessionId: string,
	card: SessionCard,
	at: number,
): Record<string, StoredCard> {
	const { [sessionId]: _old, ...rest } = cards;
	if (card.status === null && card.note === "") return rest;
	const next = { ...rest, [sessionId]: { ...card, at } };
	const ids = Object.keys(next);
	if (ids.length <= MAX_CARDS) return next;
	const keep = new Set(ids.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, MAX_CARDS));
	return Object.fromEntries(Object.entries(next).filter(([id]) => keep.has(id)));
}

export async function loadCardsFile(file: string): Promise<CardsFile> {
	try {
		return parseCardsFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { rev: 0, cards: {} };
	}
}

export async function saveCardsFile(file: string, contents: CardsFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

export interface SessionCardsOptions {
	now(): number;
	initial: CardsFile;
	save(file: CardsFile): Promise<void>;
	/** A device changed a card: tell the other devices (the rows and the revision moved). */
	onChange(): void;
}

export interface SessionCards {
	file(): CardsFile;
	/**
	 * Set (or, with no status and no note, clear) the card of a session. Refuses an unknown status or an id that is
	 * not a session id; persisted, and the devices are told. Resolves once the file is written.
	 */
	set(sessionId: unknown, status: unknown, note: unknown): Promise<void>;
	/** `rows` with the card of each session that has one. */
	markRows<T extends { sessionId: string }>(rows: readonly T[]): (T & { card?: SessionCard })[];
}

export function createSessionCards(options: SessionCardsOptions): SessionCards {
	let file = options.initial;
	let saving: Promise<void> = Promise.resolve();
	return {
		file: () => file,
		async set(sessionId, status, note) {
			if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) throw new Error("invalid session id");
			const card = parseCardUpdate(status, note);
			const before = Object.hasOwn(file.cards, sessionId) ? file.cards[sessionId] : undefined;
			if (before?.status === card.status && before.note === card.note) return;
			if (before === undefined && card.status === null && card.note === "") return;
			file = { rev: file.rev + 1, cards: withCard(file.cards, sessionId, card, options.now()) };
			const snapshot = file;
			saving = saving.catch(() => {}).then(() => options.save(snapshot));
			await saving;
			options.onChange();
		},
		markRows(rows) {
			return rows.map(row => {
				if (!Object.hasOwn(file.cards, row.sessionId)) return row;
				const { status, note } = file.cards[row.sessionId]!;
				return { ...row, card: { status, note } };
			});
		},
	};
}
