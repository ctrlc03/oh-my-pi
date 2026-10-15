import type {
	Blueprint,
	BlueprintCreate,
	BlueprintExcerpt,
	BlueprintExcerptRef,
	BlueprintRefsAnswer,
	BlueprintSummary,
} from "@oh-my-pi/pi-wire/blueprint";
import type { CompanionClient } from "../../lib/companion";

/** Listing and reading maps reads stored JSON; a map of a large repository is several MB. */
const MAP_TIMEOUT_MS = 60_000;
/** Branches and pull requests of a repository: git and, for pull requests, `gh`. */
const REFS_TIMEOUT_MS = 45_000;
/** Code around cited lines: a git read per cited file. */
const EXCERPT_TIMEOUT_MS = 90_000;

/** Citations asked for in one `blueprint-excerpt` request, so no single request holds the connection for long. */
export const EXCERPT_BATCH = 200;

/** Architecture maps of the repository holding `cwd` (all repositories when omitted), newest first. */
export async function listBlueprints(client: CompanionClient, cwd?: string): Promise<BlueprintSummary[]> {
	return (await client.requestBlueprint({ t: "blueprint-list", cwd }, MAP_TIMEOUT_MS)).maps;
}

/** Start building a map; resolves with its id as soon as it is listed as `running`. */
export async function createBlueprint(client: CompanionClient, request: BlueprintCreate): Promise<string> {
	return (await client.requestBlueprint({ t: "blueprint-create", ...request }, MAP_TIMEOUT_MS)).id;
}

export async function getBlueprint(client: CompanionClient, id: string): Promise<Blueprint> {
	return (await client.requestBlueprint({ t: "blueprint-get", id }, MAP_TIMEOUT_MS)).map;
}

/** Code around each ref at the map's commit, in the order of `refs` (at most {@link EXCERPT_BATCH}); null for a ref the commit does not have. */
export async function getExcerpts(
	client: CompanionClient,
	id: string,
	refs: BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	return (await client.requestBlueprint({ t: "blueprint-excerpt", id, refs }, EXCERPT_TIMEOUT_MS)).excerpts;
}

/** Delete a map; a running one is stopped first. */
export async function deleteBlueprint(client: CompanionClient, id: string): Promise<void> {
	await client.requestBlueprint({ t: "blueprint-delete", id }, MAP_TIMEOUT_MS);
}

/** Branches and open pull requests of the repository holding `cwd` that can be mapped; `q` filters both. */
export async function getBlueprintRefs(client: CompanionClient, cwd: string, q?: string): Promise<BlueprintRefsAnswer> {
	const { branches, current, prs } = await client.requestBlueprint({ t: "blueprint-refs", cwd, q }, REFS_TIMEOUT_MS);
	return { branches, current, prs };
}
