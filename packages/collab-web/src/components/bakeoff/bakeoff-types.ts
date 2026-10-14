import type { Bakeoff, BakeoffEntry, BakeoffMode } from "@oh-my-pi/pi-wire/bakeoff";
import type { QuizSubject } from "../quiz/quiz-flow";

/** What a bake-off is about: a change as in the quiz form, or a design document alone. */
export type BakeoffSubject = QuizSubject | { kind: "doc" };

/** The design document of the form: pasted text, or a file of the repository. */
export type BakeoffDocInput = { source: "paste"; name: string; text: string } | { source: "file"; path: string };

/** What the bake-off sheet opens on. */
export type BakeoffStart =
	| { view: "home" }
	| {
			view: "new";
			subject: BakeoffSubject;
			/** A design to start with: a file of the repository, or a spar's design text. */
			doc?: BakeoffDocInput;
			mode?: BakeoffMode;
			/** The problem to solve, when it is not stated by the change or the document. */
			goal?: string;
			/** Extra instructions to start with: what a spar left standing. */
			instructions?: string;
			/** The repository the subject is in, when it is not the session on screen's (a spar of another repository). */
			at?: { computerId: string; cwd: string; sessionId: string | null };
	  }
	| { view: "bakeoff"; computerId: string; id: string };

/** What the new-bake-off form starts on, and where it runs. */
export interface BakeoffTarget {
	/** The computer that holds the repository (and the session, for a bake-off about its changes). */
	computerId: string;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose changes, conversation and run targets may be offered; null when none is at hand. */
	sessionId: string | null;
	/** The session's host on `computerId`, which lists the repository's run targets (`run-targets`); null when none. */
	instanceId: string | null;
	subject: BakeoffSubject;
	doc?: BakeoffDocInput;
	mode?: BakeoffMode;
	goal?: string;
	instructions?: string;
}

/**
 * What an entry of a finished bake-off can lead to. The app supplies each (it owns the other sheets); the screen shows
 * a button only for the ones given.
 */
export interface BakeoffJoins {
	/** *Map this entry*: an architecture map of that entry's worktree against the base (implementation entries). */
	mapEntry?(computerId: string, bakeoff: Bakeoff, entry: BakeoffEntry): void;
	/** *Spar with this entry*: a sparring session on that entry's change (implementation) or write-up (design). */
	sparEntry?(computerId: string, bakeoff: Bakeoff, entry: BakeoffEntry): void;
	/** *Start a session from this design*: a new session whose first message is that design. */
	startFromDesign?(computerId: string, bakeoff: Bakeoff, entry: BakeoffEntry): void;
}
