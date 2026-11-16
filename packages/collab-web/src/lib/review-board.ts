/**
 * The review board: a four-column view of a change set — old code, new code, the agent's
 * reasoning per hunk, and the reviewer's comments — over a GitHub PR (one part of a stack),
 * a branch against its base, or a session's or one turn's changes.
 *
 * Types shared by the app (`components/review-board/*`) and the companion
 * (`scripts/companion-review-notes.ts`, `scripts/companion-pr-stack.ts`).
 */

/** What the board shows. */
export type ReviewSubject =
	/** One PR of a stack: its own changes against the PR below it (or its base when it is the bottom). */
	| { kind: "pr"; number: number }
	/** The session's branch against its merge-base, working tree included. */
	| { kind: "branch" }
	/** The session's changes: all of them, or one prompt turn's (`entryId` = the prompt entry id). */
	| { kind: "session"; entryId?: string };

/** A stable key for a subject within one session (localStorage, caches). */
export function subjectKey(subject: ReviewSubject): string {
	switch (subject.kind) {
		case "pr":
			return `pr:${subject.number}`;
		case "branch":
			return "branch";
		case "session":
			return subject.entryId ? `turn:${subject.entryId}` : "session";
	}
}

/** One PR in a stack, bottom first. */
export interface StackPr {
	number: number;
	title: string;
	/** Head branch name. */
	head: string;
	/** Base branch name (the head of the PR below, or the trunk). */
	base: string;
	url: string;
	state: "open" | "closed" | "merged";
}

/** One changed file of a subject, as a unified diff (`diff --git` header optional). */
export interface BoardFile {
	path: string;
	oldPath?: string;
	status: "added" | "modified" | "deleted" | "renamed";
	diff: string;
	added: number;
	removed: number;
	/** The diff was cut to fit; the board says so instead of pretending it is whole. */
	truncated?: boolean;
}

/** A PR's own changes (against the PR below it in its stack, or its base). */
export interface PrOwnDiff {
	number: number;
	/** Head commit the diff was taken at; notes and comments are cached against it. */
	head: string;
	/** What the diff is against: the head of the PR below, or the base branch. */
	against: { ref: string; sha: string };
	files: BoardFile[];
}

/**
 * The agent's reasoning for one hunk. `hunk` is the hunk header exactly as it appears in
 * the subject's diff (`@@ -a,b +c,d @@`), the anchor the board aligns the note to.
 */
export interface HunkNote {
	path: string;
	hunk: string;
	text: string;
	/** `session`: quoted from the session that made the change; `generated`: written by a model after the fact. */
	source: "session" | "generated";
	/**
	 * The session the note came from: the quote (`source: "session"`), or for a `generated` note the session whose
	 * weak quote it rewrote (then `sessionId`/`sessionTitle`/`turn`/`intent` are that quote's).
	 */
	sessionId?: string;
	sessionTitle?: string;
	/** 1-based prompt turn in that session. */
	turn?: number;
	/** The edit's short intent label, when it had one. */
	intent?: string;
	/** Epoch ms of the edit (session) or of generation. */
	at?: number;
	/**
	 * A session quote that says little about the change: only the edit's intent, under about 12 words, or sharing no
	 * word with the hunk's path and code. It counts in `unexplained`, and `generate` rewrites it.
	 */
	weak?: true;
}

/** A request for notes: the subject's files as the board shows them. */
export interface ReviewNotesQuery {
	subject: ReviewSubject;
	/** Cache identity: the PR head sha, or a hash of the diffs for branch/session subjects. */
	version: string;
	files: { path: string; diff: string }[];
	/** Also write notes for hunks no session explains, and rewrite the `weak` session notes (costs model calls). */
	generate: boolean;
}

export interface ReviewNotesReply {
	notes: HunkNote[];
	/** Hunks with no note, or only a `weak` one, after this reply (after a `generate`: those the model could not write). */
	unexplained: number;
	/** Whether a model is available to `generate`. */
	canGenerate: boolean;
}
