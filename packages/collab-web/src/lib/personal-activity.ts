/**
 * Words and ordering for the Personal agent's Activity screens (proposals, digests, events) and its inbox rows: what a
 * proposal does in plain language, how a status reads, how pages of a newest-first list merge. Pure: the components only render.
 */

import type {
	PersonalDigest,
	PersonalEventRecord,
	PersonalEventStatus,
	PersonalInboxItem,
	PersonalInboxKind,
	PersonalProposal,
	PersonalProposalStatus,
} from "@oh-my-pi/pi-wire/personal";
import type { PersonalEventKind, PersonalEventTrust } from "@oh-my-pi/pi-wire/personal-ipc";
import { type DiffRow, diffRows } from "./personal";

export type Tone = "ok" | "warn" | "bad" | "idle";

// ── proposals ────────────────────────────────────────────────────────────────

/** What a proposal does to About you, in words: "Add to How I like to work". */
export function proposalTitle(proposal: Pick<PersonalProposal, "op" | "section">): string {
	const section = proposal.section?.trim() || "About you";
	if (proposal.op === "add") return `Add to ${section}`;
	if (proposal.op === "replace") return `Replace a line in ${section}`;
	return `Remove a line from ${section}`;
}

export const PROPOSAL_STATUS: Record<PersonalProposalStatus, { label: string; tone: Tone }> = {
	pending: { label: "Waiting for you", tone: "warn" },
	accepted: { label: "Accepted", tone: "ok" },
	rejected: { label: "Rejected", tone: "idle" },
	superseded: { label: "Superseded", tone: "idle" },
};

/** The decided statuses, newest decision first in the merged list. */
export const DECIDED_STATUSES: readonly PersonalProposalStatus[] = ["accepted", "rejected", "superseded"];

/** "based on 3 memories", or null when the agent named none. */
export function evidenceLabel(count: number): string | null {
	if (count <= 0) return null;
	return `based on ${count} ${count === 1 ? "memory" : "memories"}`;
}

/**
 * The rows of a proposal's diff. A proposal whose diff the companion could not place (a decided one, or one whose line is
 * gone) still shows what it said: the removed line and the added one.
 */
export function proposalRows(proposal: Pick<PersonalProposal, "op" | "target" | "text" | "diff">): DiffRow[] {
	if (proposal.diff.length > 0) return diffRows(proposal.diff);
	const lines: PersonalProposal["diff"] = [];
	if (proposal.op !== "add" && proposal.target) lines.push({ op: "del", text: proposal.target });
	if (proposal.op !== "remove" && proposal.text) lines.push({ op: "add", text: proposal.text });
	return diffRows(lines);
}

/** When a proposal last changed state: the decision, else the proposal itself. */
export function proposalWhen(proposal: Pick<PersonalProposal, "at" | "decidedAt">): number {
	return proposal.decidedAt ?? proposal.at;
}

// ── ordering ─────────────────────────────────────────────────────────────────

/** Lists merged into one, newest first by `when`. An id in more than one list keeps its first appearance (pass the freshest list first). */
export function mergeNewest<T extends { id: string }>(
	when: (item: T) => number,
	...lists: readonly (readonly T[])[]
): T[] {
	const seen = new Set<string>();
	const merged: T[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			merged.push(item);
		}
	}
	return merged.sort((a, b) => when(b) - when(a));
}

// ── digests ──────────────────────────────────────────────────────────────────

/** "2027-01-31 · $0.12 · learned 3 · proposed 2": what a digest covers and cost. */
export function digestMeta(digest: Pick<PersonalDigest, "day" | "costUsd" | "learned" | "proposals">): string {
	const cost = digest.costUsd > 0 && digest.costUsd < 0.01 ? "<$0.01" : `$${digest.costUsd.toFixed(2)}`;
	return `${digest.day} · ${cost} · learned ${digest.learned.length} · proposed ${digest.proposals.length}`;
}

// ── events ───────────────────────────────────────────────────────────────────

export const EVENT_STATUS: Record<PersonalEventStatus, { label: string; tone: Tone }> = {
	queued: { label: "Queued", tone: "idle" },
	delivered: { label: "Delivered", tone: "ok" },
	"rate-limited": { label: "Held back: too many", tone: "warn" },
	refused: { label: "Refused", tone: "bad" },
	expired: { label: "Expired", tone: "idle" },
	failed: { label: "Failed", tone: "bad" },
	capped: { label: "Held: spend limit", tone: "warn" },
};

export const EVENT_KIND: Record<PersonalEventKind, string> = {
	event: "Event",
	answer: "Your answer",
	"about-updated": "About you changed",
	schedule: "Schedule",
	poll: "Source check",
	rollover: "Daily rollover",
	control: "Control",
};

export const EVENT_TRUST: Record<PersonalEventTrust, { label: string; tone: Tone }> = {
	owner: { label: "Owner", tone: "ok" },
	external: { label: "External", tone: "warn" },
};

/** A status or kind this app does not know (a newer companion) reads as itself, not as a blank. */
export function eventStatus(event: Pick<PersonalEventRecord, "status">): { label: string; tone: Tone } {
	return Object.hasOwn(EVENT_STATUS, event.status)
		? EVENT_STATUS[event.status]
		: { label: event.status, tone: "idle" };
}

export function eventKind(event: Pick<PersonalEventRecord, "kind">): string {
	return Object.hasOwn(EVENT_KIND, event.kind) ? EVENT_KIND[event.kind] : event.kind;
}

// ── inbox rows ───────────────────────────────────────────────────────────────

/** The small tag on every Personal inbox row. */
export const INBOX_KIND_LABEL: Record<PersonalInboxKind, string> = {
	question: "Question",
	proposal: "Proposal",
	digest: "Digest",
	alert: "Alert",
	info: "Note",
};

/** An alert about a limit reached or something broken is red; a heads-up (80% of a limit) is amber. */
export function alertTone(title: string): "warn" | "bad" {
	return /\b(reached|failed|failing|lost|missing|expired|stopped)\b/i.test(title) ? "bad" : "warn";
}

/** "You answered: Yes, go ahead": what the owner said, from the item. */
export function answerText(item: Pick<PersonalInboxItem, "answer">): string {
	const { answer } = item;
	if (answer === undefined) return "Answered";
	const given = [answer.option, answer.text].filter(part => part !== undefined && part !== "").join(": ");
	return given === "" ? "Answered" : `You answered: ${given}`;
}

/** How a proposal item that is done reads: the decision the companion recorded on it. */
export function decisionText(item: Pick<PersonalInboxItem, "answer">): string {
	const option = item.answer?.option;
	return option === undefined || option === "" ? "Decided" : option;
}

/** Read items fade, except the ones that still wait on an answer: a question or proposal seen on another device is not done. */
export function inboxDimmed(item: Pick<PersonalInboxItem, "kind" | "state" | "readAt">): boolean {
	if (item.readAt === undefined) return false;
	return !(item.state === "open" && (item.kind === "question" || item.kind === "proposal"));
}

/** Whether the list needs the pending proposals / the digests loaded to render its rows. */
export function inboxNeeds(items: readonly PersonalInboxItem[]): { proposals: boolean; digests: boolean } {
	return {
		proposals: items.some(item => item.kind === "proposal" && item.state === "open" && item.proposalId !== undefined),
		digests: items.some(item => item.kind === "digest" && item.digestId !== undefined),
	};
}

/** An event's link when it is a web address; anything else (an event's text is not ours: `javascript:`) is not made a link. */
export function webUrl(url: string | undefined): string | null {
	if (url === undefined) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}
