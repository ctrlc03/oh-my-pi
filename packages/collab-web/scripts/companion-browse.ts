/**
 * Folder browsing for the companion: the `browse-folders` request, which lets a device pick any folder on the computer to
 * start a session in, and the check a `start` makes of its folder before tmux runs.
 *
 * Browsing lists directory names only: never file names or contents. A paired device can already start a session, which
 * runs code, in any folder, so seeing which folders exist gives it no new power.
 */

import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowsedFolder, FolderListing } from "../src/lib/companion";

/** Folders in one listing; more is `truncated`. */
export const MAX_BROWSED_FOLDERS = 500;
/** How long one listing may take before it stops and answers with what it has (or, before the first read finishes, fails). */
const BROWSE_BUDGET_MS = 5_000;
/** Entries inspected at once: enough to overlap the disk, few enough not to starve the thread pool. */
const BATCH = 32;

/** What a typed path means: `~` is the home folder and a path that is not absolute is read from it. */
export function expandFolder(input: string, home: string): string {
	const typed = input.trim();
	if (typed.includes("\0")) throw new Error("invalid path");
	if (typed === "~") return path.resolve(home);
	if (typed.startsWith("~/") || typed.startsWith("~\\")) return path.resolve(home, typed.slice(2));
	return path.resolve(home, typed);
}

/** Say what is wrong with a folder, from the error of looking at it. */
function folderProblem(err: unknown, dir: string): string {
	switch ((err as NodeJS.ErrnoException | undefined)?.code) {
		case "ENOENT":
			return `${dir} does not exist`;
		case "ENOTDIR":
			return `${dir} is not a folder`;
		case "EACCES":
		case "EPERM":
			return `${dir} cannot be read: permission denied`;
		default:
			return `${dir} cannot be read: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * The folder a new session may start in: `cwd` with `~` expanded, as an absolute path that exists and is a folder.
 * @throws Error with a message for the person who typed the path.
 */
export async function checkStartFolder(cwd: string, home: string): Promise<string> {
	if (cwd.trim() === "") throw new Error("Choose a folder to start in");
	const dir = expandFolder(cwd, home);
	let info: Stats;
	try {
		info = await fs.stat(dir);
	} catch (err) {
		throw new Error(folderProblem(err, dir));
	}
	if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
	return dir;
}

const LATE = Symbol("late");

/** `work`, or {@link LATE} once `ms` have passed (the work itself cannot be cancelled). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
	let timer: Timer | undefined;
	const late = new Promise<typeof LATE>(resolve => {
		timer = setTimeout(() => resolve(LATE), Math.max(ms, 0));
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** A directory entry as a folder to list, or null when it is no folder or this process cannot enter it. */
async function inspect(parent: string, entry: Dirent): Promise<BrowsedFolder | null> {
	const full = path.join(parent, entry.name);
	try {
		// A symlink (or an entry whose type the file system does not tell) is a folder when what it points at is one.
		if (!entry.isDirectory() && !(await fs.stat(full)).isDirectory()) return null;
		await fs.access(full, constants.R_OK | constants.X_OK);
	} catch {
		return null;
	}
	const git = await fs.stat(path.join(full, ".git")).then(
		() => true,
		() => false,
	);
	return { name: entry.name, path: full, git };
}

function byName(a: Dirent, b: Dirent): number {
	const x = a.name.toLowerCase();
	const y = b.name.toLowerCase();
	if (x !== y) return x < y ? -1 : 1;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface BrowseOptions {
	/** What an absent `path` and `~` mean. */
	home: string;
	/** Folders at most in the answer (default {@link MAX_BROWSED_FOLDERS}). */
	max?: number;
	/** Time the listing may take (default 5 s). */
	budgetMs?: number;
}

/**
 * The `browse-folders` request: the folders directly inside `path` (the home folder when absent), sorted without regard to case,
 * hidden ones (a leading dot) only with `hidden`. Symlinks to folders are listed as entries under their own name; entries that
 * cannot be inspected, and folders this process cannot enter, are left out. A slow disk ends the listing early with `truncated`.
 * @throws Error when the path does not exist, is not a folder or cannot be read.
 */
export async function browseFolders(
	request: { path?: unknown; hidden?: unknown },
	options: BrowseOptions,
): Promise<FolderListing> {
	if (
		(request.path !== undefined && typeof request.path !== "string") ||
		(request.hidden !== undefined && typeof request.hidden !== "boolean")
	) {
		throw new Error("invalid request");
	}
	const max = options.max ?? MAX_BROWSED_FOLDERS;
	const deadline = Date.now() + (options.budgetMs ?? BROWSE_BUDGET_MS);
	const dir =
		request.path === undefined || request.path.trim() === ""
			? path.resolve(options.home)
			: expandFolder(request.path, options.home);
	const tooSlow = new Error(`${dir} took too long to read`);

	const info = await within(
		fs.stat(dir).catch(err => {
			throw new Error(folderProblem(err, dir));
		}),
		deadline - Date.now(),
	);
	if (info === LATE) throw tooSlow;
	if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
	const entries = await within(
		fs.readdir(dir, { withFileTypes: true }).catch(err => {
			throw new Error(folderProblem(err, dir));
		}),
		deadline - Date.now(),
	);
	if (entries === LATE) throw tooSlow;

	const candidates = entries
		.filter(entry => !entry.isFile() && (request.hidden === true || !entry.name.startsWith(".")))
		.sort(byName);
	const folders: BrowsedFolder[] = [];
	let truncated = false;
	for (let at = 0; at < candidates.length; at += BATCH) {
		const found = await within(
			Promise.all(candidates.slice(at, at + BATCH).map(entry => inspect(dir, entry))),
			deadline - Date.now(),
		);
		if (found === LATE) {
			truncated = true;
			break;
		}
		for (const folder of found) if (folder !== null) folders.push(folder);
		if (folders.length > max) break;
	}
	if (folders.length > max) {
		truncated = true;
		folders.length = max;
	}
	const parent = path.dirname(dir);
	return { path: dir, parent: parent === dir ? null : parent, folders, truncated };
}
