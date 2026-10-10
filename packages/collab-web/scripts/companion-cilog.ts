/**
 * The Fix-it flow's companion side: what failed on a pull request (the
 * failing checks with the tail of their GitHub Actions logs) and which
 * sessions and folders on this computer belong to the repository, so the app
 * can open one with a ready-made prompt. Read-only: logs come from the
 * signed-in `gh`, repositories from `git config`.
 */

import * as os from "node:os";
import type { CiLogFailure, CiLogFolder, CiLogPr, CiLogSession } from "../src/lib/companion";
import { type RawCheck, toCheck } from "./companion-github";
import { gh, ghBin } from "./companion-gitflow";
import { git } from "./companion-git";

const GH_TIMEOUT_MS = 25_000;
/** Lines kept per check: the failure is almost always in the tail. */
export const MAX_LOG_LINES = 200;
/** Bytes kept per check. */
export const MAX_LOG_BYTES = 16 * 1024;
/** Bytes of log across all checks of one answer, so a pull request with many failing jobs stays one frame. */
export const MAX_TOTAL_BYTES = 48 * 1024;
/** Failing checks answered with; the rest are counted. */
export const MAX_FAILURES = 8;
/** A budget below this carries no useful log. */
const MIN_LOG_BYTES = 512;
/** Room for the truncation marker line. */
const MARKER_BYTES = 64;
/** Bytes of a log's end kept in memory while it streams in; the shown tail is cut from this. */
const LOG_TAIL_BYTES = 256 * 1024;
/** gh is killed once it has printed this much: a runaway log must not cost unbounded time. */
const LOG_HARD_CAP_BYTES = 64 * 1024 * 1024;
/** `gh run view` processes running at once. */
const LOG_FETCHES = 2;
/** Sessions and folders whose repository is read per request. */
const MAX_CANDIDATES = 40;
const MAX_FOLDERS = 5;
const MAX_ERROR_CHARS = 800;

const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const RUN_URL_RE = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** `gh run view --log` prefixes each line with `job<TAB>step<TAB>`, then an ISO timestamp. */
const TIMESTAMP_RE = /^([^\t]*\t[^\t]*\t)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** @throws Error when `value` is not `owner/name`. */
export function checkRepo(value: unknown): string {
	if (typeof value !== "string" || !REPO_RE.test(value)) throw new Error("invalid repository");
	return value;
}

/** @throws Error when `value` is not a pull request number. */
export function checkNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalid number");
	return value;
}

/** `owner/name` of a git remote URL (https, ssh://, scp-like), or null when it names no repository. */
export function repoFromRemote(url: string): string | null {
	const match =
		/^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?[^/]+\/|[^/@\s]+@[^:/\s]+:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	return match?.[1] ?? null;
}

/** The Actions run (and job, when the check is one job) a check's details URL points to. */
export function actionsRef(url: string): { runId: string; jobId: string | null } | null {
	const match = RUN_URL_RE.exec(url);
	return match ? { runId: match[1]!, jobId: match[2] ?? null } : null;
}

const byteLength = (text: string): number => Buffer.byteLength(text);

/**
 * The tail of a CI log: colour codes and per-line timestamps dropped, at most `maxLines` lines and
 * `maxBytes` bytes (marker included), with a first line saying how much came before when anything was cut.
 * `cutBefore`: `raw` is itself the end of a longer log, so its first (partial) line is dropped.
 */
export function trimLog(raw: string, maxLines = MAX_LOG_LINES, maxBytes = MAX_LOG_BYTES, cutBefore = false): string {
	const lines = raw
		.replace(ANSI_RE, "")
		.split(/\r?\n/)
		.map(line => line.replace(TIMESTAMP_RE, "$1").trimEnd());
	// The first line of a window cut out of a longer log is a fragment.
	if (cutBefore) lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	while (lines.length > 0 && lines[0] === "") lines.shift();
	if (lines.length === 0) return "";
	const budget = Math.max(0, maxBytes - MARKER_BYTES);
	let kept = lines.slice(-maxLines);
	let size = byteLength(kept.join("\n"));
	while (size > budget && kept.length > 1) {
		kept = kept.slice(1);
		size = byteLength(kept.join("\n"));
	}
	let body = kept.join("\n");
	let cutInLine = false;
	if (size > budget) {
		// One line alone is over budget: keep its end.
		body = Buffer.from(body)
			.subarray(-budget)
			.toString()
			.replace(/^\uFFFD+/, "");
		cutInLine = true;
	}
	const omitted = lines.length - kept.length;
	if (omitted === 0 && !cutInLine && !cutBefore) return body;
	if (cutBefore) return `… earlier output omitted\n${body}`;
	return `… ${omitted > 0 ? `${omitted} earlier line${omitted === 1 ? "" : "s"} omitted` : "start of the last line omitted"}\n${body}`;
}

/** A `gh` read that must succeed; the failure carries what gh printed. */
async function ghOut(args: string[]): Promise<string> {
	const result = await gh(os.homedir(), args, GH_TIMEOUT_MS);
	if (result.code !== 0) {
		const lines = (result.err || result.out).split("\n").filter(line => line.trim());
		throw new Error(lines.slice(0, 4).join("\n").slice(0, MAX_ERROR_CHARS) || `gh ${args[0]} failed`);
	}
	return result.out;
}

interface RawPr {
	title?: string;
	url?: string;
	headRefName?: string;
	statusCheckRollup?: RawCheck[];
}

/** One failing check: its name and details URL, whether it is an Actions job or run. */
interface FailingCheck {
	check: string;
	url: string;
}

/** The pull request and its failing checks, in the order GitHub lists them, de-duplicated by name and URL. */
export async function readFailingChecks(
	repo: string,
	number: number,
): Promise<{ pr: CiLogPr; failing: FailingCheck[] }> {
	const raw = JSON.parse(
		await ghOut(["pr", "view", String(number), "--repo", repo, "--json", "title,url,headRefName,statusCheckRollup"]),
	) as RawPr;
	const seen: Record<string, true> = {};
	const failing: FailingCheck[] = [];
	for (const check of (raw.statusCheckRollup ?? []).map(toCheck)) {
		const key = `${check.name}\n${check.url}`;
		if (check.state !== "fail" || Object.hasOwn(seen, key)) continue;
		seen[key] = true;
		failing.push({ check: check.name, url: check.url });
	}
	return { pr: { title: raw.title ?? "", url: raw.url ?? "", branch: raw.headRefName ?? "" }, failing };
}

/** A log read from `gh`: the end of its output, and whether earlier output was dropped. */
export interface LogTail {
	text: string;
	/** The output began before `text` (it exceeded the tail window, or gh was stopped at the hard cap). */
	cutBefore: boolean;
}

/**
 * Read `stream` keeping only its last `tailBytes` bytes. Reading stops (`stopped`) once more than
 * `hardCapBytes` have been read, so a runaway log costs bounded memory and time.
 */
export async function readTail(
	stream: ReadableStream<Uint8Array>,
	tailBytes: number,
	hardCapBytes: number,
): Promise<LogTail & { stopped: boolean }> {
	const reader = stream.getReader();
	let chunks: Uint8Array[] = [];
	let held = 0;
	let total = 0;
	let stopped = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		held += value.length;
		total += value.length;
		// Whole chunks before the window are dropped; the window is cut exactly below.
		while (chunks.length > 1 && held - chunks[0]!.length >= tailBytes) held -= chunks.shift()!.length;
		if (total > hardCapBytes) {
			stopped = true;
			break;
		}
	}
	await reader.cancel().catch(() => {});
	const all = Buffer.concat(chunks);
	chunks = [];
	const window = all.subarray(Math.max(0, all.length - tailBytes));
	return { text: window.toString(), cutBefore: total > window.length, stopped };
}

/**
 * `gh run view --log-failed` for the check's job (or its run), at most the last {@link LOG_TAIL_BYTES} bytes
 * of it; empty when GitHub has no log yet or gh refuses. gh is killed after {@link LOG_HARD_CAP_BYTES}.
 */
async function readActionsLog(repo: string, ref: { runId: string; jobId: string | null }): Promise<LogTail> {
	const none: LogTail = { text: "", cutBefore: false };
	const bin = ghBin();
	if (!bin) return none;
	const args = ref.jobId === null ? ["run", "view", ref.runId] : ["run", "view", "--job", ref.jobId];
	try {
		const proc = Bun.spawn([bin, ...args, "--repo", repo, "--log-failed"], {
			cwd: os.homedir(),
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
			timeout: GH_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		const tail = await readTail(proc.stdout, LOG_TAIL_BYTES, LOG_HARD_CAP_BYTES);
		if (tail.stopped) proc.kill("SIGKILL");
		const code = await proc.exited;
		return code === 0 || tail.stopped ? { text: tail.text, cutBefore: tail.cutBefore } : none;
	} catch {
		return none;
	}
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await work(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The failing checks of a pull request with log tails, within {@link MAX_TOTAL_BYTES} overall. */
export async function ciFailures(
	repo: string,
	number: number,
): Promise<{ pr: CiLogPr; failures: CiLogFailure[]; moreFailures: number }> {
	const { pr, failing } = await readFailingChecks(repo, number);
	const shown = failing.slice(0, MAX_FAILURES);
	// Checks that point at the same job share one log read; reads run a couple at a time.
	const refs: Record<string, { runId: string; jobId: string | null }> = {};
	for (const { url } of shown) {
		const ref = actionsRef(url);
		if (ref) refs[`${ref.runId}/${ref.jobId ?? ""}`] = ref;
	}
	const logs: Record<string, LogTail> = {};
	await pool(Object.keys(refs), LOG_FETCHES, async key => {
		logs[key] = await readActionsLog(repo, refs[key]!);
	});
	let remaining = MAX_TOTAL_BYTES;
	const failures: CiLogFailure[] = [];
	for (const { check, url } of shown) {
		const ref = actionsRef(url);
		let log = "";
		if (ref && remaining >= MIN_LOG_BYTES) {
			const tail = logs[`${ref.runId}/${ref.jobId ?? ""}`]!;
			log = trimLog(tail.text, MAX_LOG_LINES, Math.min(MAX_LOG_BYTES, remaining), tail.cutBefore);
			remaining -= byteLength(log);
		}
		failures.push({ check, url, log });
	}
	return { pr, failures, moreFailures: failing.length - shown.length };
}

// ── sessions and folders of the repository ───────────────────────────────────

/** What the lookup needs of a listed session. */
export interface SessionLike {
	instanceId: string;
	sessionName: string | null;
	cwd: string;
	busy: boolean | null;
	sandboxed?: boolean;
}

/** The repositories a working directory's remotes name, and its branch. */
export interface RepoFacts {
	repos: string[];
	branch: string | null;
}

/** Remotes and branch of the repository at `cwd` through git; null outside a repository or when `cwd` is gone. */
export async function readRepoFacts(cwd: string): Promise<RepoFacts | null> {
	try {
		const [remotes, head] = await Promise.all([
			git(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"]),
			git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
		]);
		if (remotes.code !== 0) return null;
		const repos = new TextDecoder()
			.decode(remotes.out)
			.split("\n")
			.map(line => repoFromRemote(line.slice(line.indexOf(" ") + 1)))
			.filter((repo): repo is string => repo !== null);
		return { repos, branch: head.code === 0 ? new TextDecoder().decode(head.out).trim() || null : null };
	} catch {
		return null;
	}
}

/**
 * Sessions whose repository is `repo` (any remote counts, so a fork's checkout matches the upstream
 * pull request), best first: on the pull request's branch, then not sandboxed (the prompt asks to run
 * tests), then hosting before idle.
 */
export async function repoSessions(
	repo: string,
	branch: string,
	hosts: readonly SessionLike[],
	idle: readonly SessionLike[],
	facts: (cwd: string) => Promise<RepoFacts | null> = readRepoFacts,
): Promise<CiLogSession[]> {
	const want = repo.toLowerCase();
	const candidates = [
		...hosts.map(session => ({ session, host: true })),
		...idle.map(session => ({ session, host: false })),
	].slice(0, MAX_CANDIDATES);
	const found = await Promise.all(
		candidates.map(async ({ session, host }): Promise<(CiLogSession & { order: number }) | null> => {
			const info = await facts(session.cwd);
			if (!info?.repos.some(r => r.toLowerCase() === want)) return null;
			const onBranch = branch !== "" && info.branch === branch;
			const sandboxed = session.sandboxed === true;
			return {
				instanceId: session.instanceId,
				title: session.sessionName ?? (session.cwd.split("/").filter(Boolean).pop() || session.cwd),
				cwd: session.cwd,
				branch: info.branch,
				host,
				busy: session.busy === true,
				sandboxed,
				order: (onBranch ? 0 : 4) + (sandboxed ? 2 : 0) + (host ? 0 : 1),
			};
		}),
	);
	return found
		.filter((session): session is CiLogSession & { order: number } => session !== null)
		.map((session, index) => ({ session, index }))
		.sort((a, b) => a.session.order - b.session.order || a.index - b.index)
		.map(({ session: { order: _order, ...session } }) => session);
}

/** Recent folders (newest first) of `repo` where no listed session runs, to start a new session in. */
export async function repoFolders(
	repo: string,
	recent: readonly { cwd: string }[],
	taken: readonly string[],
	facts: (cwd: string) => Promise<RepoFacts | null> = readRepoFacts,
): Promise<CiLogFolder[]> {
	const want = repo.toLowerCase();
	const busy: Record<string, true> = {};
	for (const cwd of taken) busy[cwd] = true;
	const candidates = recent.filter(folder => !Object.hasOwn(busy, folder.cwd)).slice(0, MAX_CANDIDATES);
	const found = await Promise.all(
		candidates.map(async ({ cwd }): Promise<CiLogFolder | null> => {
			const info = await facts(cwd);
			return info?.repos.some(r => r.toLowerCase() === want) ? { cwd, branch: info.branch } : null;
		}),
	);
	return found.filter((folder): folder is CiLogFolder => folder !== null).slice(0, MAX_FOLDERS);
}
