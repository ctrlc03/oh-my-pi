/**
 * Read-only git and file access for the companion's `git`, `git-diff` and
 * `file` requests. Every command runs in the session's cwd with
 * `--no-optional-locks` (never touch the index of a repo omp is working in), a
 * timeout, and an output cap. Paths from the device are confined to the
 * repository root (the cwd outside a repository) after symlink resolution.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileContent, GitCommit, GitFileChange, GitSnapshot } from "../src/lib/companion";

const GIT_TIMEOUT_MS = 15_000;
/** Largest git output read for status, numstat and log. */
const GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DIFF_BYTES = 256 * 1024;
const FILE_BYTES = 512 * 1024;
/** A NUL within this prefix marks a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Untracked files above this size are not line-counted (reported as binary). */
const COUNT_LINES_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_COMMITS = 15;
const MAX_PATH_CHARS = 4096;

interface GitResult {
	out: Uint8Array;
	code: number;
	err: string;
	/** Output reached the cap and git was stopped. */
	truncated: boolean;
}

const decoder = new TextDecoder();

/** Run git read-only in `cwd`; resolves on any exit code, rejects only when git cannot run. */
async function git(cwd: string, args: string[], maxBytes = GIT_OUTPUT_BYTES): Promise<GitResult> {
	const proc = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotepath=off", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
		timeout: GIT_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const errText = new Response(proc.stderr).text();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of proc.stdout) {
		const room = maxBytes - total;
		if (chunk.byteLength > room) {
			chunks.push(chunk.subarray(0, room));
			total = maxBytes;
			truncated = true;
			proc.kill();
			break;
		}
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const code = await proc.exited;
	return { out: Buffer.concat(chunks), code, err: (await errText).trim(), truncated };
}

function gitFailure(result: GitResult, what: string): Error {
	if (result.err.includes("not a git repository")) return new Error("not a git repository");
	return new Error(result.err.split("\n")[0] || `${what} failed`);
}

async function requireDirectory(cwd: string): Promise<void> {
	let ok = false;
	try {
		ok = (await fs.stat(cwd)).isDirectory();
	} catch {
		// reported below
	}
	if (!ok) throw new Error("session directory not found");
}

/** Repository root containing `cwd` (symlinks resolved), or null outside a repository. */
async function repoRoot(cwd: string): Promise<string | null> {
	await requireDirectory(cwd);
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code === 0) return fs.realpath(decoder.decode(result.out).trim());
	if (result.err.includes("not a git repository")) return null;
	throw gitFailure(result, "git rev-parse");
}

/** True when `target` is `base` or lies beneath it; both must already be symlink-resolved. */
export function isInside(base: string, target: string): boolean {
	const rel = path.relative(base, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function checkPathText(value: string): void {
	if (!value || value.length > MAX_PATH_CHARS || value.includes("\0")) throw new Error("invalid path");
}

function hasNul(bytes: Uint8Array): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Decode UTF-8 that may end mid-character because the bytes were cut. */
function decodeCut(bytes: Uint8Array, cut: boolean): string {
	const text = decoder.decode(bytes);
	return cut ? text.replace(/\uFFFD$/, "") : text;
}

/** Lines in a text file; null for binary, non-regular or oversized files. */
async function countLines(file: string): Promise<number | null> {
	try {
		const stat = await fs.lstat(file);
		// git diffs a symlink as one added line holding its target.
		if (stat.isSymbolicLink()) return 1;
		if (!stat.isFile() || stat.size > COUNT_LINES_MAX_BYTES) return null;
		const bytes = await Bun.file(file).bytes();
		if (hasNul(bytes)) return null;
		let lines = 0;
		for (const byte of bytes) if (byte === 10) lines++;
		return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
	} catch {
		return null;
	}
}

/** `## main...origin/main [ahead 1, behind 2]` and its variants. */
function parseBranchLine(line: string): Pick<GitSnapshot, "branch" | "upstream" | "ahead" | "behind"> {
	let rest = line.slice(3);
	let ahead = 0;
	let behind = 0;
	const counts = /\s\[([^\]]*)\]$/.exec(rest);
	if (counts) {
		rest = rest.slice(0, counts.index);
		ahead = Number(/ahead (\d+)/.exec(counts[1]!)?.[1] ?? 0);
		behind = Number(/behind (\d+)/.exec(counts[1]!)?.[1] ?? 0);
	}
	const noCommits = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(rest);
	if (noCommits) return { branch: noCommits[1]!, upstream: null, ahead, behind };
	if (rest.startsWith("HEAD (no branch)")) return { branch: null, upstream: null, ahead, behind };
	const split = rest.indexOf("...");
	if (split < 0) return { branch: rest, upstream: null, ahead, behind };
	return { branch: rest.slice(0, split), upstream: rest.slice(split + 3), ahead, behind };
}

/** Tree to diff the working tree against: HEAD, or the empty tree in a repository without commits. */
async function diffBase(root: string): Promise<string> {
	const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
	if (head.code === 0) return "HEAD";
	const empty = await git(root, ["hash-object", "-t", "tree", "/dev/null"]);
	return decoder.decode(empty.out).trim();
}

/** Line counts per path from `git diff --numstat -z`; null counts mark binary files. */
function parseNumstat(out: Uint8Array): Record<string, { added: number | null; removed: number | null }> {
	const counts: Record<string, { added: number | null; removed: number | null }> = {};
	const records = decoder.decode(out).split("\0");
	for (let i = 0; i < records.length; i++) {
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[i]!);
		if (!match) continue;
		let file = match[3]!;
		// A rename lists `added\tremoved\t` then the old and new paths as separate records.
		if (file === "") {
			file = records[i + 2] ?? "";
			i += 2;
		}
		counts[file] = {
			added: match[1] === "-" ? null : Number(match[1]),
			removed: match[2] === "-" ? null : Number(match[2]),
		};
	}
	return counts;
}

async function recentCommits(root: string): Promise<GitCommit[]> {
	const log = await git(root, ["log", "-n", String(MAX_COMMITS), "-z", "--format=%H%x1f%an%x1f%ct%x1f%s"]);
	// A repository without commits fails here; that is an empty history, not an error.
	if (log.code !== 0) return [];
	const commits: GitCommit[] = [];
	for (const record of decoder.decode(log.out).split("\0")) {
		const [hash, author, time, ...subject] = record.split("\x1f");
		if (hash && /^[0-9a-f]{40,64}$/.test(hash.trim())) {
			commits.push({
				hash: hash.trim(),
				author: author ?? "",
				time: Number(time) * 1000 || 0,
				subject: subject.join("\x1f"),
			});
		}
	}
	return commits;
}

/** Working-tree state of the repository containing `cwd`. */
export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
	const root = await repoRoot(cwd);
	if (root === null) throw new Error("not a git repository");
	const status = await git(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
	if (status.code !== 0) throw gitFailure(status, "git status");
	const records = decoder.decode(status.out).split("\0");
	const branch = records[0]?.startsWith("## ")
		? parseBranchLine(records[0])
		: { branch: null, upstream: null, ahead: 0, behind: 0 };

	const entries: { path: string; status: string }[] = [];
	for (let i = 1; i < records.length && entries.length < MAX_FILES; i++) {
		const record = records[i]!;
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		// Renames and copies are followed by a record holding the original path.
		if (code.includes("R") || code.includes("C")) i++;
		if (code === "!!") continue;
		entries.push({ path: record.slice(3), status: code });
	}

	const [numstat, commits] = await Promise.all([
		git(root, ["diff", "--numstat", "-z", "--no-ext-diff", await diffBase(root), "--"]),
		recentCommits(root),
	]);
	const counts = numstat.code === 0 ? parseNumstat(numstat.out) : {};
	const files: GitFileChange[] = await Promise.all(
		entries.map(async ({ path: file, status: code }) => {
			if (code === "??") {
				const added = await countLines(path.join(root, file));
				return { path: file, status: code, added, removed: added === null ? null : 0 };
			}
			const count = counts[file] ?? { added: 0, removed: 0 };
			return { path: file, status: code, added: count.added, removed: count.removed };
		}),
	);
	return { root, ...branch, files, commits };
}

/** Unified diff of one repo-relative path against HEAD (an untracked file diffs as wholly added). */
export async function gitDiff(cwd: string, file: string): Promise<{ diff: string; truncated: boolean }> {
	checkPathText(file);
	const root = await repoRoot(cwd);
	if (root === null) throw new Error("not a git repository");
	const rel = path.posix.normalize(file);
	if (rel.startsWith("/") || rel === ".." || rel.startsWith("../") || rel === ".") {
		throw new Error("path must be inside the repository");
	}

	const tracked = await git(
		root,
		["diff", "--no-ext-diff", "--no-textconv", "--no-color", await diffBase(root), "--", rel],
		DIFF_BYTES,
	);
	let result = tracked;
	if (tracked.code !== 0 && !tracked.truncated) throw gitFailure(tracked, "git diff");
	if (tracked.out.length === 0) {
		const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", rel]);
		if (untracked.out.length > 0) {
			// git reads the file itself, so a parent directory symlinked out of the repo must not be followed.
			const parent = await fs.realpath(path.dirname(path.join(root, rel)));
			if (!isInside(root, parent)) throw new Error("path is outside the repository");
			result = await git(
				root,
				["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", rel],
				DIFF_BYTES,
			);
			// --no-index exits 1 when the files differ.
			if (result.code > 1 && !result.truncated) throw gitFailure(result, "git diff");
		}
	}
	if (!result.truncated) return { diff: decoder.decode(result.out), truncated: false };
	// Cut at a line boundary so the last hunk line is whole.
	const end = result.out.lastIndexOf(10);
	return { diff: decodeCut(result.out.subarray(0, end < 0 ? result.out.length : end + 1), true), truncated: true };
}

/** A file inside the session's repository (or cwd outside one); symlinks may not lead out of it. */
export async function readRepoFile(cwd: string, input: string): Promise<FileContent> {
	checkPathText(input);
	const root = await repoRoot(cwd);
	const base = root ?? (await fs.realpath(cwd));
	let real: string;
	try {
		real = await fs.realpath(path.resolve(cwd, input));
	} catch {
		throw new Error("file not found");
	}
	if (!isInside(base, real))
		throw new Error(root ? "path is outside the repository" : "path is outside the session directory");
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new Error("not a regular file");
	const truncated = stat.size > FILE_BYTES;
	const bytes = await Bun.file(real).slice(0, FILE_BYTES).bytes();
	return {
		path: path.relative(base, real) || path.basename(real),
		size: stat.size,
		text: hasNul(bytes) ? null : decodeCut(bytes, truncated),
		truncated: truncated && !hasNul(bytes),
	};
}
