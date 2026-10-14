/**
 * Where the companion keeps bake-offs: `<dir>/index.json` (one summary per bake-off, including ones still running or
 * failed) and `<dir>/<id>.json` (a finished one with what only the companion needs). Private to the user, under the
 * omp config folder and never in a repository; see ./companion-doc-store for the storage rules.
 */

import { type Bakeoff, BAKEOFF_VERSION, type BakeoffCreate, type BakeoffSummary } from "@oh-my-pi/pi-wire/bakeoff";
import { createDocStore, type DocStore } from "./companion-doc-store";

/** The commits an entry's citations are read at, and what the review pack is rebuilt from. */
export interface BakeoffCommits {
	/** The original's merge base: what every entry's diff is measured against. */
	base?: string;
	/** The original's head. In design mode every entry's citations read here. */
	original: string;
	/** Snapshot commit of each entry's code (implementation mode), by label. */
	entries: Record<string, string>;
}

/** A stored bake-off: what devices see, and what only the companion sees. */
export interface BakeoffDoc {
	v: typeof BAKEOFF_VERSION;
	id: string;
	bakeoff: Bakeoff;
	commits: BakeoffCommits;
	/** The problem statement every session read: the document, the description, the conversation. */
	problem: string;
	/** What the person asked for; a review run again reads the settings from here. */
	request: Pick<
		BakeoffCreate,
		"reviewerPasses" | "judge" | "judgeAdvisory" | "test" | "bench" | "start" | "sandboxed" | "goal"
	>;
	/** What the bake-off is about, as the list shows it: `feature/x vs main`, `PR #12`, `a design`. */
	subject: string;
	/** The limit this bake-off was made with, USD. */
	maxCostUsd: number;
	/** What commits are held under (`holdCommit`'s map ids), to release when the bake-off is deleted. */
	held: string[];
	/** The design document the entries answer, when there is one. */
	document?: { name?: string; text: string };
}

export type BakeoffStore = DocStore<BakeoffSummary, BakeoffDoc>;

export function createBakeoffStore(dir: string): BakeoffStore {
	return createDocStore<BakeoffSummary, BakeoffDoc>({
		dir,
		indexKey: "bakeoffs",
		idPrefix: "bk",
		noun: "bake-off",
		version: BAKEOFF_VERSION,
		isSummary: value => typeof value.subject === "string",
	});
}
