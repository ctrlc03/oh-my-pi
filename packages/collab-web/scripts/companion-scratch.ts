/**
 * Folders for sessions that have no project: the `start` request's `scratch` option makes a fresh folder
 * `<omp config dir>/scratch/<YYYY-MM-DD>-<first words of the prompt>-<id>` (names: ../src/lib/scratch) and
 * starts omp there. The companion never deletes one, not even when its session ends; only a folder whose
 * start failed and is still empty is removed again.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SCRATCH_DIR, SCRATCH_ID_CHARS, scratchFolderName } from "../src/lib/scratch";

/** Fresh names tried before giving up on a collision (one in 16 million per try, so only a broken `id` ever gets near it). */
const ATTEMPTS = 5;

/** `p` with symlinks resolved, as far as it exists. */
async function realpathExisting(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		const parent = path.dirname(p);
		if (parent === p) return p;
		return path.join(await realpathExisting(parent), path.basename(p));
	}
}

/** The nearest folder at or above `dir` that holds a `.git` (a repository or a linked worktree), or null. */
export async function gitCheckoutAbove(dir: string): Promise<string | null> {
	for (let at = dir; ; at = path.dirname(at)) {
		if (
			await fs.lstat(path.join(at, ".git")).then(
				() => true,
				() => false,
			)
		)
			return at;
		if (path.dirname(at) === at) return null;
	}
}

export interface ScratchOptions {
	/** The omp config dir; the folder goes under `scratch/` in it. */
	configDir: string;
	/** The first prompt, for the folder's name; none gives `session`. */
	hint?: string;
	now?: Date;
	/** Short id of the name; random unless a test pins it. */
	id?: () => string;
}

/**
 * Make the folder and resolve with its realpath.
 *
 * @throws Error when the config dir lies inside a git checkout: omp would take the scratch folder for part of that
 * repository, which is the opposite of a session without a project.
 */
export async function createScratchFolder(options: ScratchOptions): Promise<string> {
	const root = path.join(await realpathExisting(path.resolve(options.configDir)), SCRATCH_DIR);
	const checkout = await gitCheckoutAbove(root);
	if (checkout !== null)
		throw new Error(
			`a session without a project needs a folder outside git checkouts, and omp's config folder lies inside ${checkout}`,
		);
	await fs.mkdir(root, { recursive: true });
	const newId = options.id ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, SCRATCH_ID_CHARS));
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const folder = path.join(root, scratchFolderName(options.now ?? new Date(), options.hint, newId()));
		try {
			await fs.mkdir(folder);
			return folder;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new Error("could not find a free scratch folder name");
}
