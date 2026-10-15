/**
 * An implementation entry's code as a patch (docs/collab.md, *Design bake-off*): `git diff --binary` of the base against
 * the commit the entry's worktree was snapshotted into when its facts were measured. That commit is held under a
 * private ref for as long as the bake-off exists, so the patch outlives the worktree: taking another entry and removing
 * the others' worktrees does not take it away. It is the entry as it was judged, not what the worktree holds now.
 *
 * The device names an entry by its label; the commits come from the stored bake-off and never from the request.
 */

import { BAKEOFF_MAX_PATCH_BYTES, type BakeoffEntry } from "@oh-my-pi/pi-wire/bakeoff";
import { git } from "./companion-git";
import type { BakeoffDoc } from "./companion-bakeoff-store";
import { resolveCommit } from "./companion-blueprint-git";

const PATCH_TIMEOUT_MS = 60_000;
/** `a/` and `b/` whatever the person's git config says, so `git apply` finds its default `-p1`. */
const DIFF_ARGS = [
	"diff",
	"--binary",
	"--full-index",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--find-renames",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

export type PatchState = NonNullable<BakeoffEntry["patch"]>;

const NO_BASE = "This bake-off has no base to take a patch against.";
const GONE = "The code of this entry is no longer kept on this computer, so there is nothing to export.";
const NO_CODE = "This entry made no code to export.";

/** The commit an entry's code is kept under, or why there is none. */
function entryCommit(doc: BakeoffDoc, label: string): { commit: string } | { reason: string } {
	if (doc.bakeoff.mode !== "implementation") return { reason: "Only an implementation has code to export." };
	if (doc.commits.base === undefined) return { reason: NO_BASE };
	const commit = doc.commits.entries[label];
	return commit === undefined ? { reason: NO_CODE } : { commit };
}

async function kept(root: string, commit: string): Promise<boolean> {
	return (await resolveCommit(root, commit).catch(() => null)) !== null;
}

/**
 * For each entry of an implementation bake-off whose entries were measured, whether its code can still be exported.
 * Empty before that (nothing is kept yet) and for a design.
 */
export async function patchStates(doc: BakeoffDoc): Promise<Map<string, PatchState>> {
	const states = new Map<string, PatchState>();
	if (doc.bakeoff.mode !== "implementation") return states;
	const measured = Object.keys(doc.commits.entries).length > 0;
	if (!measured && doc.bakeoff.result === undefined) return states;
	const root = doc.bakeoff.repo.root;
	const baseKept = doc.commits.base === undefined ? false : await kept(root, doc.commits.base);
	await Promise.all(
		doc.bakeoff.entries.map(async entry => {
			const found = entryCommit(doc, entry.label);
			if ("reason" in found) return void states.set(entry.label, { ok: false, reason: found.reason });
			states.set(
				entry.label,
				baseKept && (await kept(root, found.commit)) ? { ok: true } : { ok: false, reason: GONE },
			);
		}),
	);
	return states;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The patch of the entry `label` of `doc` against its base.
 * @throws Error in plain words when the entry is not one of the bake-off's, made no code, has lost its commit, changes
 * nothing, or the patch is larger than {@link BAKEOFF_MAX_PATCH_BYTES} or not text.
 */
export async function entryPatch(doc: BakeoffDoc, label: string): Promise<string> {
	const entry = doc.bakeoff.entries.find(candidate => candidate.label === label);
	if (!entry) throw new Error("There is no such entry.");
	const found = entryCommit(doc, entry.label);
	if ("reason" in found) throw new Error(found.reason);
	const root = doc.bakeoff.repo.root;
	const base = doc.commits.base!;
	if (!(await kept(root, base)) || !(await kept(root, found.commit))) throw new Error(GONE);
	const result = await git(root, [...DIFF_ARGS, base, found.commit, "--"], {
		maxBytes: BAKEOFF_MAX_PATCH_BYTES + 1,
		timeoutMs: PATCH_TIMEOUT_MS,
	});
	if (result.truncated || result.out.byteLength > BAKEOFF_MAX_PATCH_BYTES)
		throw new Error(
			`The patch is larger than ${BAKEOFF_MAX_PATCH_BYTES / (1024 * 1024)} MB, so it is not offered. Take this entry and read its worktree instead.`,
		);
	if (result.code !== 0) throw new Error(result.err.split("\n")[0] || "git could not make the patch.");
	if (result.out.byteLength === 0) throw new Error("This entry changes nothing against the base.");
	try {
		return utf8.decode(result.out);
	} catch {
		throw new Error(
			"This entry changes a file that is neither UTF-8 text nor binary to git, so its patch cannot be sent as text. Take this entry and read its worktree instead.",
		);
	}
}
