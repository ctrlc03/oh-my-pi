/**
 * Citations of the session's conversation in a quiz (see ./companion-quiz-verify): a question may point at a message of
 * the session it was written from, as `{ entry, quote }`. The entry id is the one the digest marks each message with
 * (./companion-quiz-digest) and the quote is a passage of that message. A citation holds when the entry is a real
 * message of the session file and the quote is in its text, whitespace aside; anything else is dropped, so a stored quiz
 * never shows a message that was not said. Pure over the messages, so the rules are testable without a session file.
 */

import type { QuizSessionRef } from "@oh-my-pi/pi-wire/quiz";
import { isRecord } from "../src/tool-render/util";
import { Warnings } from "./companion-citations";
import type { DigestEntry } from "./companion-quiz-digest";

/** A quote is cut to this many characters; the cut part of a real passage is still a real passage. */
export const MAX_QUOTE_CHARS = 300;
/** Shorter quotes prove nothing: a few words occur in any message. */
export const MIN_QUOTE_CHARS = 12;
const MAX_SESSION_REFS = 3;

/** An entry as the agent wrote it, before it is checked. */
export interface SessionCite {
	entry: string;
	quote: string;
}

/** `text` with every run of whitespace as one space and the ends trimmed. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A quote as it is compared and stored: whitespace collapsed, quotation marks and ellipses at its ends removed. */
export function normalizeQuote(text: string): string {
	let quote = collapse(text);
	let previous: string;
	do {
		previous = quote;
		quote = quote
			.replace(/^(?:\[?(?:…|\.{3})\]?|["'“”‘’`])\s*/, "")
			.replace(/\s*(?:\[?(?:…|\.{3})\]?|["'“”‘’`])$/, "");
	} while (quote !== previous);
	return quote;
}

/** `#a1b2c3d4`, `[#a1b2c3d4]` or `a1b2c3d4` as the id. */
function entryId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value
		.trim()
		.replace(/^\[?#?/, "")
		.replace(/\]$/, "");
	return id === "" || id.length > 64 ? undefined : id;
}

/** The conversation citations in a list the agent wrote: objects with `entry` (or `id`) and `quote`; others are ignored. */
export function parseSessionCites(value: unknown): SessionCite[] {
	if (!Array.isArray(value)) return [];
	const cites: SessionCite[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) continue;
		const entry = entryId(raw.entry ?? raw.id);
		const quote = typeof raw.quote === "string" ? normalizeQuote(raw.quote).slice(0, MAX_QUOTE_CHARS).trim() : "";
		if (entry === undefined || quote === "") continue;
		cites.push({ entry, quote });
		if (cites.length >= MAX_SESSION_REFS * 2) break;
	}
	return cites;
}

/**
 * The citations that hold against `entries` (the messages of the session by entry id), as the wire shape with the role
 * of the message, repeated ones removed. Each drop is counted in `stats.dropped` and described in `warnings`
 * (`where` says what the citation belonged to). With no `entries` (the conversation could not be read) none holds.
 */
export function checkSessionCites(
	cites: readonly SessionCite[],
	entries: ReadonlyMap<string, DigestEntry> | undefined,
	where: string,
	stats: { verified: number; dropped: number },
	warnings: Warnings,
): QuizSessionRef[] {
	const kept: QuizSessionRef[] = [];
	const seen = new Set<string>();
	for (const cite of cites) {
		const dropped = (why: string): void => {
			stats.dropped++;
			warnings.add(
				"session",
				`Dropped the conversation citation of message ${cite.entry} (${where}): ${why}.`,
				n => `${n} more conversation citations were dropped.`,
			);
		};
		const message = entries?.get(cite.entry);
		if (message === undefined) {
			dropped(entries === undefined ? "the conversation was not available" : "there is no such message");
			continue;
		}
		if (cite.quote.length < MIN_QUOTE_CHARS) {
			dropped("the quote is too short to show it was said");
			continue;
		}
		if (!collapse(message.text).includes(cite.quote)) {
			dropped("the quote is not in that message");
			continue;
		}
		const key = `${cite.entry}\0${cite.quote}`;
		if (seen.has(key)) continue;
		seen.add(key);
		stats.verified++;
		kept.push({ entry: cite.entry, role: message.role, quote: cite.quote });
		if (kept.length >= MAX_SESSION_REFS) break;
	}
	return kept;
}
