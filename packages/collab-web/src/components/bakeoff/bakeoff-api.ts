import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import type {
	Bakeoff,
	BakeoffCreate,
	BakeoffJudgeInfo,
	BakeoffSummary,
	BakeoffTakeResult,
} from "@oh-my-pi/pi-wire/bakeoff";
import type { CompanionClient } from "../../lib/companion";

/** Listing and reading bake-offs reads stored JSON. */
const BAKEOFF_TIMEOUT_MS = 60_000;
/** Starting a bake-off answers as soon as it is listed as running. */
const CREATE_TIMEOUT_MS = 60_000;
/** The judge probe asks a model one question. */
const JUDGE_TIMEOUT_MS = 60_000;
/** Code around cited lines: a git read per cited file. */
const EXCERPT_TIMEOUT_MS = 90_000;
/** Stopping ends model runs and their processes. */
const STOP_TIMEOUT_MS = 60_000;
/** Taking an implementation merges a worktree and may remove the others. */
const TAKE_TIMEOUT_MS = 180_000;

/** Citations asked for in one `bakeoff-excerpt` request, so no single request holds the connection for long. */
export const BAKEOFF_EXCERPT_BATCH = 200;

/** Bake-offs of the repository holding `cwd` (all repositories when omitted), newest first. */
export async function listBakeoffs(client: CompanionClient, cwd?: string): Promise<BakeoffSummary[]> {
	return (await client.requestBakeoff({ t: "bakeoff-list", cwd }, BAKEOFF_TIMEOUT_MS)).bakeoffs;
}

/** What the second opinion would use for the repository holding `cwd`, and whether it answered a probe. */
export async function getBakeoffJudge(client: CompanionClient, cwd?: string): Promise<BakeoffJudgeInfo> {
	return (await client.requestBakeoff({ t: "bakeoff-judge", cwd }, JUDGE_TIMEOUT_MS)).judge;
}

/** Start a bake-off; resolves with its id as soon as it is listed as `running`. */
export async function createBakeoff(client: CompanionClient, request: BakeoffCreate): Promise<string> {
	return (await client.requestBakeoff({ t: "bakeoff-create", ...request }, CREATE_TIMEOUT_MS)).id;
}

/** The bake-off with its entries and, once there is one, the verdict. */
export async function getBakeoff(client: CompanionClient, id: string): Promise<Bakeoff> {
	return (await client.requestBakeoff({ t: "bakeoff-get", id }, BAKEOFF_TIMEOUT_MS)).bakeoff;
}

/** Code around each ref in an entry (its worktree, or its write-up), in the order of `refs`; null for a ref it does not have. */
export async function getBakeoffExcerpts(
	client: CompanionClient,
	id: string,
	entry: string,
	refs: BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	const out: (BlueprintExcerpt | null)[] = [];
	for (let at = 0; at < refs.length; at += BAKEOFF_EXCERPT_BATCH) {
		const reply = await client.requestBakeoff(
			{ t: "bakeoff-excerpt", id, entry, refs: refs.slice(at, at + BAKEOFF_EXCERPT_BATCH) },
			EXCERPT_TIMEOUT_MS,
		);
		out.push(...reply.excerpts);
	}
	return out;
}

/** Stop one entry, or the whole bake-off when `entry` is omitted. */
export async function stopBakeoff(client: CompanionClient, id: string, entry?: string): Promise<void> {
	await client.requestBakeoff({ t: "bakeoff-stop", id, entry }, STOP_TIMEOUT_MS);
}

/** Keep one entry. Implementations answer what the keep did to the other worktrees. */
export async function takeBakeoff(
	client: CompanionClient,
	id: string,
	entry: string,
	options: { removeOthers?: boolean; discardDirty?: boolean } = {},
): Promise<BakeoffTakeResult | undefined> {
	const { removeOthers, discardDirty } = options;
	return (await client.requestBakeoff({ t: "bakeoff-take", id, entry, removeOthers, discardDirty }, TAKE_TIMEOUT_MS))
		.result;
}

/** Run the review and the judge again on a bake-off whose review or judge pass failed. */
export async function reviewBakeoffAgain(client: CompanionClient, id: string): Promise<void> {
	await client.requestBakeoff({ t: "bakeoff-review", id }, BAKEOFF_TIMEOUT_MS);
}

/** Delete a bake-off; a running one is stopped first. */
export async function deleteBakeoff(client: CompanionClient, id: string): Promise<void> {
	await client.requestBakeoff({ t: "bakeoff-delete", id }, BAKEOFF_TIMEOUT_MS);
}
