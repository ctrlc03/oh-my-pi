import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import type { SparCreate, SparGetAnswer, SparRecord, SparRun, SparSummary, SparTurn } from "@oh-my-pi/pi-wire/spar";
import type { CompanionClient } from "../../lib/companion";

/** Listing and reading spars reads stored JSON. */
const SPAR_TIMEOUT_MS = 60_000;
/** Starting a spar answers as soon as it is listed as running. */
const CREATE_TIMEOUT_MS = 60_000;
/** A model answers a defence: the reply waits for it. */
const REPLY_TIMEOUT_MS = 150_000;
/** Code around cited lines: a git read per cited file. */
const EXCERPT_TIMEOUT_MS = 90_000;

/** Citations asked for in one `spar-excerpt` request, so no single request holds the connection for long. */
export const SPAR_EXCERPT_BATCH = 200;

/** Spars of the repository holding `cwd` (all repositories when omitted), newest first. */
export async function listSpars(client: CompanionClient, cwd?: string): Promise<SparSummary[]> {
	return (await client.requestSpar({ t: "spar-list", cwd }, SPAR_TIMEOUT_MS)).spars;
}

/** Start preparing a spar; resolves with its id as soon as it is listed as `running`. */
export async function createSpar(client: CompanionClient, request: SparCreate): Promise<string> {
	return (await client.requestSpar({ t: "spar-create", ...request }, CREATE_TIMEOUT_MS)).id;
}

/** The spar without its case files, and every run made through it. */
export async function getSpar(client: CompanionClient, id: string): Promise<SparGetAnswer> {
	const { spar, runs } = await client.requestSpar({ t: "spar-get", id }, SPAR_TIMEOUT_MS);
	return { spar, runs };
}

/** Defend a point; resolves with the partner's turn, the point's record and the run with its result updated. */
export async function replySpar(
	client: CompanionClient,
	id: string,
	run: string,
	point: string,
	text: string,
): Promise<{ turn: SparTurn; record: SparRecord; run: SparRun }> {
	const {
		turn,
		record,
		run: updated,
	} = await client.requestSpar({ t: "spar-reply", id, run, point, text }, REPLY_TIMEOUT_MS);
	return { turn, record, run: updated };
}

/** Close a point without a model call: concede it (`lost`) or accept the risk, which also skips it (`open`). */
export async function closeSpar(
	client: CompanionClient,
	id: string,
	run: string,
	point: string,
	as: "lost" | "open",
	note?: string,
): Promise<{ record: SparRecord; run: SparRun }> {
	const { record, run: updated } = await client.requestSpar(
		{ t: "spar-close", id, run, point, as, ...(note === undefined || note.trim() === "" ? {} : { note }) },
		SPAR_TIMEOUT_MS,
	);
	return { record, run: updated };
}

/** A new run asking every point, or only the ones `from` (default: the latest run) did not hold. */
export async function againSpar(
	client: CompanionClient,
	id: string,
	only: "all" | "unsettled",
	from?: string,
): Promise<SparRun> {
	return (await client.requestSpar({ t: "spar-again", id, only, from }, SPAR_TIMEOUT_MS)).run;
}

/** Code around each ref at a part's commit (or in the design), in the order of `refs`; null for a ref the commit does not have. */
export async function getSparExcerpts(
	client: CompanionClient,
	id: string,
	part: number,
	refs: BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	const out: (BlueprintExcerpt | null)[] = [];
	for (let at = 0; at < refs.length; at += SPAR_EXCERPT_BATCH) {
		const reply = await client.requestSpar(
			{ t: "spar-excerpt", id, part, refs: refs.slice(at, at + SPAR_EXCERPT_BATCH) },
			EXCERPT_TIMEOUT_MS,
		);
		out.push(...reply.excerpts);
	}
	return out;
}

/** Delete a spar; a running one is stopped first. */
export async function deleteSpar(client: CompanionClient, id: string): Promise<void> {
	await client.requestSpar({ t: "spar-delete", id }, SPAR_TIMEOUT_MS);
}
