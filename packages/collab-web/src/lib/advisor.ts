/**
 * `advisor` custom messages carry an advisor's notes to the agent it watches. Their content is the
 * agent-facing form (`<advisory severity="…" guidance="…">` elements, sometimes headed by guidance
 * prose for the agent), which reads as noise to a person. The structured notes travel in `details`,
 * so the transcript draws those instead, as a message labelled as the advisor's, like the terminal
 * UI's advisor card.
 */

import { isRecord } from "../tool-render/util";

export const ADVISOR_TYPE = "advisor";

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
	note: string;
	severity: AdvisorSeverity | null;
	/** The configured advisor that wrote it; null for the unnamed default advisor. */
	advisor: string | null;
	/** Agent turns between the note being written and it being delivered; null when it was delivered at once. */
	turnsAgo: number | null;
}

/** Worst first: a card wears the worst severity among its notes. */
const SEVERITY_ORDER: readonly AdvisorSeverity[] = ["blocker", "concern", "nit"];

const SEVERITY_LABEL: Record<AdvisorSeverity, string> = { blocker: "Blocker", concern: "Concern", nit: "Nit" };

function severityOf(value: unknown): AdvisorSeverity | null {
	return SEVERITY_ORDER.find(severity => severity === value) ?? null;
}

function toNote(value: unknown): AdvisorNote | null {
	if (!isRecord(value) || typeof value.note !== "string" || !/\S/.test(value.note)) return null;
	const advisor = typeof value.advisor === "string" && value.advisor !== "" ? value.advisor : null;
	const turnsAgo = value.turnsAgo;
	return {
		note: value.note.trim(),
		severity: severityOf(value.severity),
		// The implicit single advisor is named "default" on some paths; it has no name worth showing.
		advisor: advisor === "default" ? null : advisor,
		turnsAgo: typeof turnsAgo === "number" && Number.isInteger(turnsAgo) && turnsAgo > 0 ? turnsAgo : null,
	};
}

/** The notes of an `advisor` message, or null when its details carry none (an older or foreign host). */
export function advisorNotes(details: unknown): AdvisorNote[] | null {
	if (!isRecord(details) || !Array.isArray(details.notes)) return null;
	const notes = details.notes.map(toNote).filter(note => note !== null);
	return notes.length > 0 ? notes : null;
}

/** The worst severity among `notes`; null when none has one. */
export function worstSeverity(notes: readonly AdvisorNote[]): AdvisorSeverity | null {
	return SEVERITY_ORDER.find(severity => notes.some(note => note.severity === severity)) ?? null;
}

export function severityLabel(severity: AdvisorSeverity): string {
	return SEVERITY_LABEL[severity];
}

/** The advisor every note comes from, when they all name the same one; null for the default or a mix. */
export function sharedAdvisor(notes: readonly AdvisorNote[]): string | null {
	const first = notes[0]?.advisor ?? null;
	return first !== null && notes.every(note => note.advisor === first) ? first : null;
}

/** Who a card is from: the advisor's name when the notes share one, else "Advisor". */
export function advisorAuthor(notes: readonly AdvisorNote[]): string {
	return sharedAdvisor(notes) ?? "Advisor";
}

/** "2 turns ago" for a note held back while the agent kept working. */
export function turnsAgoLabel(turnsAgo: number): string {
	return `${turnsAgo} turn${turnsAgo === 1 ? "" : "s"} ago`;
}

/**
 * The notes as Markdown, for copying and quoting. A single note is its text; several each start with
 * their severity, and their advisor when the notes come from more than one.
 */
export function advisorMarkdown(notes: readonly AdvisorNote[]): string {
	if (notes.length === 1) return notes[0]!.note;
	const named = sharedAdvisor(notes) === null && notes.some(note => note.advisor !== null);
	return notes
		.map(note => {
			const head = [note.severity === null ? null : severityLabel(note.severity), named ? note.advisor : null]
				.filter(part => part !== null)
				.join(" · ");
			return head === "" ? note.note : `**${head}:** ${note.note}`;
		})
		.join("\n\n");
}
