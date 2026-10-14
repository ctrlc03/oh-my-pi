/**
 * Glue between the inbox / start sheets and the session they open. Opening a
 * session goes through `openHost`, which only knows an instance id; what to do
 * once it is joined (send a prompt, answer its pending ask) is recorded here
 * beforehand and picked up when the link resolves.
 */

import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import type { InboxItem } from "./companion";
import { deliverDraft } from "./draft-bus";
import { enqueuePrompt, roomIdOf } from "./rooms";
import { readJson, writeJson } from "./storage";

export interface OpenIntent {
	/** Sent as a prompt once the session is live (through the room's prompt queue). */
	prompt?: string;
	/** Put into the room's message box once it opens, for the user to edit and send; nothing is sent. */
	draft?: string;
	/** Answers the session's pending select ask with `option`, but only while it still asks `question`. */
	answer?: { question: string; option: string };
}

/** An intent whose session was never opened (the open failed) must not fire at some later open. */
const INTENT_TTL_MS = 10 * 60 * 1000;
/** A pending answer older than this is stale: the question it was meant for is long gone. */
const ANSWER_TTL_MS = 2 * 60 * 1000;
/** Characters of the question compared against the ask's title. */
const QUESTION_PROBE_CHARS = 80;
const DISMISSED_KEY = "omp.collab.inbox.dismissed";
const MAX_DISMISSED = 100;

const intents = new Map<string, OpenIntent & { at: number }>();
/** Answers waiting for their ask to arrive, by room. */
const pendingAnswers = new Map<string, { question: string; option: string; at: number }>();

/** A process of one computer: instance ids are only unique per computer, so everything keyed by one carries the computer. */
export function hostKey(computerId: string, instanceId: string): string {
	return `${computerId}|${instanceId}`;
}

/** Record what to do when `instanceId` of the computer `computerId` is next opened. */
export function setOpenIntent(computerId: string, instanceId: string, intent: OpenIntent, now = Date.now()): void {
	intents.set(hostKey(computerId, instanceId), { ...intent, at: now });
}

/**
 * A link for `instanceId` of `computerId` resolved: carry out its recorded intent. The prompt joins the room's
 * queue (which the client for that room sends once live); the answer waits for the ask.
 */
export function applyOpenIntent(computerId: string, instanceId: string, link: string, now = Date.now()): void {
	const key = hostKey(computerId, instanceId);
	const intent = intents.get(key);
	if (!intent) return;
	intents.delete(key);
	const roomId = roomIdOf(link);
	if (roomId === null || now - intent.at > INTENT_TTL_MS) return;
	if (intent.prompt) enqueuePrompt(roomId, intent.prompt);
	if (intent.draft) deliverDraft(roomId, intent.draft);
	if (intent.answer) pendingAnswers.set(roomId, { ...intent.answer, at: now });
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Whether an ask titled `title` is the question the inbox showed as `question` (possibly truncated). */
export function sameQuestion(title: string, question: string): boolean {
	const probe = normalize(question.replace(/ \(\+\d+ more\)$/, "").replace(/…$/, "")).slice(0, QUESTION_PROBE_CHARS);
	return probe.length > 0 && normalize(title).includes(probe);
}

/**
 * The answer to give `request` in `roomId`, or null. A pending answer is spent by the first ask
 * that arrives: given when it is the question it was meant for and offers the option, else dropped.
 */
export function claimPendingAnswer(roomId: string, request: CollabUiRequest, now = Date.now()): string | null {
	const pending = pendingAnswers.get(roomId);
	if (!pending) return null;
	pendingAnswers.delete(roomId);
	if (now - pending.at > ANSWER_TTL_MS || request.kind !== "select" || !sameQuestion(request.title, pending.question))
		return null;
	// The ask tool marks its recommended option; the session file's label lacks the suffix.
	const wanted = normalize(pending.option);
	for (const item of request.options) {
		const label = typeof item === "string" ? item : item.label;
		if (normalize(label) === wanted || normalize(label.replace(/ \(recommended\)$/i, "")) === wanted) return label;
	}
	return null;
}

/** Stable identity of an inbox item of one computer: a new question or reply in the same session is a new item. */
export function inboxKey(computerId: string, item: InboxItem): string {
	return `${hostKey(computerId, item.instanceId)}:${item.kind}:${item.at}`;
}

/** Keys of items the user dismissed, oldest first. */
export function loadDismissed(): string[] {
	const raw = readJson(DISMISSED_KEY);
	return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
}

export function saveDismissed(keys: readonly string[]): void {
	writeJson(DISMISSED_KEY, keys.slice(-MAX_DISMISSED));
}

/** Items dismissed while one computer was paired were its own: their keys gain its id. */
export function claimLegacyDismissed(computerId: string): void {
	saveDismissed(loadDismissed().map(key => (key.includes("|") ? key : `${computerId}|${key}`)));
}
