/**
 * The in-app editor's side of the companion: the file tree of a session's
 * repository, saving an existing file, and the versions that detect edits made
 * behind an open editor. Paths follow the same rules as the read-only `file`
 * request (./companion-git): confined to the repository root (the cwd outside
 * a repository) after symlink resolution. Saving never creates files, never
 * touches anything inside `.git`, and is refused for sandboxed sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileTree } from "../src/lib/companion";
import { FileChangedError } from "../src/lib/companion";
import {
	checkPathText,
	FILE_BYTES,
	fileVersion,
	git,
	gitFailure,
	hasNul,
	isGitInternal,
	repoScope,
	resolveInScope,
} from "./companion-git";

/** Files listed at most; a repository larger than this shows a truncated tree. */
const MAX_TREE_FILES = 20_000;
/** Largest text a save may carry. */
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
/** Paths `file-versions` answers for at once. */
const MAX_VERSION_PATHS = 20;
/** Directories the walk outside a repository does not enter: repository internals and installed packages. */
const SKIPPED_DIRS = [".git", "node_modules"];

const decoder = new TextDecoder();

/** NUL-separated paths from `git ls-files -z`. */
function splitPaths(out: Uint8Array): string[] {
	const parts = decoder.decode(out).split("\0");
	// The output ends with a NUL, so the last part is empty; if git was cut off it is a partial path instead.
	parts.pop();
	return parts;
}

async function listGitFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
	const [present, deleted] = await Promise.all([
		git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
		git(root, ["ls-files", "-z", "--deleted"]),
	]);
	if (present.code !== 0 && !present.truncated) throw gitFailure(present, "git ls-files");
	// No prototype: a file named `constructor` must not look deleted.
	const gone: Record<string, true> = Object.create(null);
	for (const file of splitPaths(deleted.out)) gone[file] = true;
	const seen: Record<string, true> = Object.create(null);
	const files: string[] = [];
	for (const file of splitPaths(present.out)) {
		// An untracked nested repository is listed as its directory.
		if (file.endsWith("/") || gone[file] || seen[file]) continue;
		seen[file] = true;
		files.push(file);
	}
	return { files, truncated: present.truncated };
}

/** True when the symlink at `link` leads to a file; a symlinked directory is not entered, a broken link is not a file. */
async function isFileLink(link: string): Promise<boolean> {
	try {
		return (await fs.stat(link)).isFile();
	} catch {
		return false;
	}
}

/** Files and symlinks to files under `base`, not entering `.git`, `node_modules` or symlinked directories. */
async function walkFiles(base: string): Promise<{ files: string[]; truncated: boolean }> {
	const files: string[] = [];
	const pending = [""];
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir ? `${base}/${dir}` : base, { withFileTypes: true });
		} catch {
			// Unreadable or removed meanwhile: list what can be read.
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.includes(entry.name)) pending.push(rel);
			} else if (entry.isFile() || (entry.isSymbolicLink() && (await isFileLink(`${base}/${rel}`)))) {
				if (files.length === MAX_TREE_FILES) return { files, truncated: true };
				files.push(rel);
			}
		}
	}
	return { files, truncated: false };
}

/**
 * Files of the session's repository: tracked and untracked ones git does not ignore, minus those
 * deleted from the working tree. Outside a repository, the files under the cwd.
 */
export async function listTree(cwd: string): Promise<FileTree> {
	const { root, base } = await repoScope(cwd);
	const listed = root ? await listGitFiles(root) : await walkFiles(base);
	listed.files.sort();
	const truncated = listed.truncated || listed.files.length > MAX_TREE_FILES;
	return { root: base, files: truncated ? listed.files.slice(0, MAX_TREE_FILES) : listed.files, truncated };
}

/**
 * Replace the text of an existing file with `text`, in place so its inode and mode stay.
 * `base` is the version the edit started from; resolves the version of what was written.
 * @throws {FileChangedError} the file no longer has version `base` (null version: it was deleted).
 */
export async function writeRepoFile(
	cwd: string,
	input: string,
	text: string,
	base: string,
	sandboxed: boolean,
): Promise<string> {
	if (sandboxed) throw new Error("files of a sandboxed session are read-only");
	checkPathText(input);
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > MAX_WRITE_BYTES) throw new Error("text is too large to save");
	const scope = await repoScope(cwd);
	const real = await resolveInScope(cwd, scope, input);
	if (real === null) throw new FileChangedError(null);
	if (isGitInternal(scope.base, real)) throw new Error("files inside .git are read-only");
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new Error("not a regular file");
	if (stat.size > FILE_BYTES) throw new Error("file is too large to edit");
	const current = await Bun.file(real).slice(0, FILE_BYTES).bytes();
	if (hasNul(current)) throw new Error("binary files cannot be edited");
	const version = fileVersion(stat, current);
	if (version !== base) throw new FileChangedError(version);
	// No O_CREAT: a file deleted since the check is an error, never recreated.
	const handle = await fs.open(real, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
	try {
		await handle.writeFile(bytes);
		// Stat the handle: a path lookup could see a replacement made after the write.
		return fileVersion(await handle.stat(), bytes);
	} finally {
		await handle.close();
	}
}

/**
 * Current versions of `paths`, in order; null for one that is missing, unreadable or not a regular
 * file, or that leads outside the session's repository.
 */
export async function fileVersions(cwd: string, paths: unknown): Promise<(string | null)[]> {
	if (!Array.isArray(paths) || paths.length > MAX_VERSION_PATHS) throw new Error("invalid paths");
	for (const input of paths) {
		if (typeof input !== "string") throw new Error("invalid paths");
		checkPathText(input);
	}
	const scope = await repoScope(cwd);
	return Promise.all(
		(paths as string[]).map(async input => {
			try {
				const real = await resolveInScope(cwd, scope, input);
				if (real === null) return null;
				const stat = await fs.stat(real);
				if (!stat.isFile()) return null;
				return fileVersion(stat, await Bun.file(real).slice(0, FILE_BYTES).bytes());
			} catch {
				return null;
			}
		}),
	);
}
