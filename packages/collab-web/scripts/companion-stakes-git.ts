/**
 * Git side of high-stakes sessions (./companion-stakes): the tree and the diff id a pass is tied to, and the base a quiz
 * starts from. Reads only; nothing here touches the user's checkout, index or branches.
 */

import { defaultBranch, resolveCommit } from "./companion-blueprint-git";
import { git } from "./companion-git";

const TREE_RE = /^[0-9a-f]{40,64}$/;
const DIFF_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder();

/** The tree object of `rev` (a commit, tag or tree), or null when it does not resolve. */
export async function treeOf(checkout: string, rev: string): Promise<string | null> {
	if (rev.startsWith("-")) return null;
	const result = await git(checkout, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
	const out = decoder.decode(result.out).trim();
	return result.code === 0 && TREE_RE.test(out) ? out : null;
}

/** True when `commit` names a commit object in the repository. */
export async function hasCommit(checkout: string, commit: string): Promise<boolean> {
	return (await resolveCommit(checkout, commit).catch(() => null)) !== null;
}

/** Where a session's changes start: the merge base of its commit with the default branch. */
export interface DiffBase {
	commit: string;
	/** The default branch's name (`main`). */
	ref: string;
	tree: string;
}

/**
 * The merge base of `commit` with the repository's default branch, or an error text when there is none (no `main`,
 * `master` or `origin/HEAD`; unrelated history). `root` is the primary checkout.
 */
export async function diffBaseOf(root: string, commit: string): Promise<{ base: DiffBase } | { error: string }> {
	let branch: { name: string; rev: string };
	try {
		branch = await defaultBranch(root);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	const common = await git(root, ["merge-base", commit, branch.rev]);
	const mergeBase = decoder.decode(common.out).trim();
	if (common.code !== 0 || !TREE_RE.test(mergeBase))
		return { error: `The changes share no history with ${branch.name}, so there is nothing to compare them with.` };
	const tree = await treeOf(root, mergeBase);
	if (tree === null) return { error: "The default branch could not be read." };
	return { base: { commit: mergeBase, ref: branch.name, tree } };
}

/**
 * The id of the patch that takes `base` to `head` (`git patch-id --verbatim` of their diff): the same changes on
 * another base, as after a rebase, have the same id. Null when they do not differ or the id cannot be computed.
 */
export async function patchId(root: string, base: string, head: string): Promise<string | null> {
	const diff = await git(root, ["diff", "--no-ext-diff", "--binary", "--no-color", "--no-renames", base, head], {
		maxBytes: DIFF_BYTES,
	});
	if (diff.code !== 0 || diff.truncated || diff.out.length === 0) return null;
	const proc = Bun.spawn(["git", "patch-id", "--verbatim"], {
		cwd: root,
		stdin: diff.out,
		stdout: "pipe",
		stderr: "ignore",
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return null;
	const id = out.trim().split(/\s+/)[0];
	return id && TREE_RE.test(id) ? id : null;
}
