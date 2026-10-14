/**
 * Where the companion keeps sparring sessions: `<dir>/index.json` (one summary per spar, including spars still being
 * written or failed) and `<dir>/<id>.json` (a finished spar with the case files and the runs). Private to the user, under
 * the omp config folder and never in a repository; see ./companion-doc-store for the storage rules.
 */

import { type Spar, type SparRun, type SparSummary, SPAR_VERSION } from "@oh-my-pi/pi-wire/spar";
import { createDocStore, type DocStore } from "./companion-doc-store";
import type { SparCase } from "./companion-spar-verify";

/** A stored spar: what devices see, what only the companion sees, and the runs so far. */
export interface SparDoc {
	v: typeof SPAR_VERSION;
	id: string;
	spar: Spar;
	/** The case file of each point by point id; never sent to a device. */
	cases: Record<string, SparCase>;
	runs: SparRun[];
	/** The design document, when there is one. Leaves the computer only through `spar-excerpt`. */
	doc?: { name: string; text: string };
	/** The model of the replies: a role or a `provider/id`. */
	replyModel: string;
	/** The limit this spar was made with, USD. */
	maxCostUsd: number;
	/** What writing the points cost, USD, when known. */
	generationCostUsd: number;
	/** What the replies have cost so far, USD. */
	replyCostUsd: number;
}

export type SparStore = DocStore<SparSummary, SparDoc>;

export function createSparStore(dir: string): SparStore {
	return createDocStore<SparSummary, SparDoc>({
		dir,
		indexKey: "spars",
		idPrefix: "sp",
		noun: "spar",
		version: SPAR_VERSION,
		isSummary: value => typeof value.subject === "string",
	});
}
