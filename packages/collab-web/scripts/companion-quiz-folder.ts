/**
 * The folder of a session a topic quiz draws on (see ./companion-quiz): what is in it, whether it holds code, and the
 * files its citations name. A folder inside a git repository with a commit is read as the working tree snapshotted into
 * a commit (./companion-blueprint-git), like a quiz on `@worktree`; any other folder (a "No project" scratch folder, a
 * folder of notes) is read from disk at quiz time, and the files its questions cite are stored with the quiz
 * (./companion-quiz-store) so they do not change under it later.
 *
 * A device names the folder and the agent names the files, so both are checked: a cited path stays inside the folder
 * (no `..`, no symlink out of it), is not a dotfile or in a dot folder (`.env`, `.ssh/`), is text and is not large.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scratchLabel } from "../src/lib/scratch";
import { BLOB_BYTES, repoInfo, resolveCommit } from "./companion-blueprint-git";
import { normalizeRepoPath, pool } from "./companion-citations";
import { splitLines } from "./companion-excerpt";
import { git, hasNul, isInside } from "./companion-git";

/** Files listed for a folder, at most: a folder with more is read as far as this. */
export const MAX_FOLDER_FILES = 3_000;
/** Directories deep a folder that is not a repository is walked. */
const MAX_WALK_DEPTH = 6;
/** Characters of the decoded cited files a quiz stores, over all of them. */
export const MAX_STORED_CHARS = 1_500_000;
const LIST_TIMEOUT_MS = 30_000;

const SKIPPED_DIRS = new Set([
	"node_modules",
	"target",
	"dist",
	"build",
	"out",
	"__pycache__",
	"venv",
	"vendor",
	"coverage",
]);
const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"ico",
	"pdf",
	"zip",
	"gz",
	"tar",
	"tgz",
	"woff",
	"woff2",
	"ttf",
	"mp3",
	"mp4",
	"mov",
	"wasm",
	"bin",
	"so",
	"dylib",
	"lock",
	"sqlite",
	"db",
]);
/** Extensions of source code: the *Implementation* focus needs at least one file with them. Notes, data and config do not count. */
const CODE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"rs",
	"sol",
	"nr",
	"py",
	"go",
	"java",
	"kt",
	"swift",
	"rb",
	"php",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"sh",
	"sql",
	"lua",
	"zig",
	"ex",
	"exs",
	"hs",
	"ml",
	"scala",
	"r",
	"jl",
	"dart",
	"vue",
	"svelte",
	"circom",
	"cairo",
	"move",
	"ipynb",
]);

export interface FolderInfo {
	/** Short name for titles: the repository's, a scratch folder's label, or the folder's last path part. */
	name: string;
	/** The repository's primary checkout, or the folder itself when it is not one. */
	root: string;
	/** The top of the working tree the session runs in (the folder itself when it is not a repository). */
	checkout: string;
	/** True when the folder is inside a git repository that has a commit: it is read as a snapshot of the working tree. */
	git: boolean;
	github?: string;
}

/**
 * Describe the folder `cwd`, a git working tree or not.
 * @throws Error "invalid folder" when `cwd` is not a folder that exists.
 */
export async function folderInfo(cwd: string): Promise<FolderInfo> {
	const real = await fs.realpath(cwd).catch(() => null);
	if (real === null || !(await fs.stat(real)).isDirectory()) throw new Error("invalid folder");
	const repo = await repoInfo(real).catch(() => null);
	if (repo !== null && (await resolveCommit(repo.checkout, "HEAD")) !== null)
		return { name: repo.name, root: repo.root, checkout: repo.checkout, git: true, github: repo.github };
	return { name: scratchLabel(real) ?? path.basename(real), root: real, checkout: real, git: false };
}

/** True when a path is a dotfile or lies in a dot folder. */
function hidden(file: string): boolean {
	return file.split("/").some(part => part.startsWith("."));
}

function listable(file: string): boolean {
	const ext = path.posix.extname(file).slice(1).toLowerCase();
	return !hidden(file) && !BINARY_EXTENSIONS.has(ext);
}

async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
	if (depth > MAX_WALK_DEPTH || out.length >= MAX_FOLDER_FILES) return;
	const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (out.length >= MAX_FOLDER_FILES) return;
		if (entry.name.startsWith(".")) continue;
		const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) await walk(root, rel, depth + 1, out);
		} else if (entry.isFile() && listable(rel)) out.push(rel);
	}
}

/** The files a topic quiz can read in the folder, relative to it, at most {@link MAX_FOLDER_FILES}: tracked and untracked but not ignored for a repository, a bounded walk otherwise. */
export async function listFolderFiles(info: FolderInfo): Promise<string[]> {
	if (!info.git) {
		const out: string[] = [];
		await walk(info.checkout, "", 0, out);
		return out;
	}
	const result = await git(info.checkout, ["ls-files", "-co", "--exclude-standard", "-z"], {
		timeoutMs: LIST_TIMEOUT_MS,
	});
	if (result.code !== 0) return [];
	return new TextDecoder()
		.decode(result.out)
		.split("\0")
		.filter(file => file !== "" && listable(file))
		.slice(0, MAX_FOLDER_FILES);
}

/** True when any of `files` is source code. */
export function hasCode(files: readonly string[]): boolean {
	return files.some(file => CODE_EXTENSIONS.has(path.posix.extname(file).slice(1).toLowerCase()));
}

/**
 * The lines of the file `rel` in the folder `root` that is not a repository, or null when the path is not one a citation
 * may name (outside the folder, by `..` or a symlink; a dotfile or in a dot folder), the file is missing, binary or
 * larger than {@link BLOB_BYTES}.
 */
export async function readFolderFile(root: string, rel: string): Promise<string[] | null> {
	const file = normalizeRepoPath(rel);
	if (file === undefined || hidden(file)) return null;
	const rootReal = await fs.realpath(root).catch(() => null);
	const real = rootReal === null ? null : await fs.realpath(path.join(rootReal, file)).catch(() => null);
	if (rootReal === null || real === null || real === rootReal || !isInside(rootReal, real)) return null;
	const stat = await fs.stat(real).catch(() => null);
	if (stat === null || !stat.isFile() || stat.size > BLOB_BYTES) return null;
	const bytes = await fs.readFile(real).catch(() => null);
	if (bytes === null || hasNul(bytes)) return null;
	return splitLines(new TextDecoder().decode(bytes));
}

/** Bytes of a folder copied for the agent, at most: past this the rest of the files are left out. */
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const COPY_CONCURRENCY = 8;

/**
 * Copy `files` (relative paths from {@link listFolderFiles}) of the folder `from` to `to`, so the agent reads a fixed,
 * read-only copy: the folder may change while the questions are written, and the citations are checked against the very
 * files the agent saw. A file larger than {@link BLOB_BYTES} is skipped, and so are those past {@link MAX_COPY_BYTES}.
 * Resolves with the paths copied.
 */
export async function copyFolderFiles(from: string, files: readonly string[], to: string): Promise<string[]> {
	await fs.mkdir(to, { recursive: true });
	const copied: string[] = [];
	let bytes = 0;
	await pool(files, COPY_CONCURRENCY, async file => {
		const source = path.join(from, file);
		const stat = await fs.lstat(source).catch(() => null);
		if (stat === null || !stat.isFile() || stat.size > BLOB_BYTES || bytes + stat.size > MAX_COPY_BYTES) return;
		bytes += stat.size;
		const target = path.join(to, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(source, target);
		copied.push(file);
	});
	return copied.sort();
}
