/**
 * The harness's side of PR watching that talks to GitHub through the sanctioned `gh` runner: the
 * conditional REST calls, who the signed-in user is, which pull request a checkout is on, and
 * the log tails of what failed.
 */
import {
	ghApiArgs,
	type PrApi,
	PrApiError,
	type PrCheck,
	type PrRef,
	type PrSnapshot,
	parseGhApiResponse,
	parsePrRef,
} from "@oh-my-pi/pi-wire/pr-watch";
import { github } from "../utils/github";
import type { GhRunSnapshot } from "@oh-my-pi/pi-tui/tools/github";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { tryResolveCurrentRepo } from "../tools/gh-common";
import { fetchFailedJobLogs, fetchRunsForCommit, isFailedJob } from "../tools/gh-run-watch";

/** Lines of each failed job's log the agent is shown. */
const LOG_TAIL_LINES = 120;
/** Failed jobs whose logs are fetched. */
const MAX_LOGGED_JOBS = 4;
/** Characters of log across a wake. */
const MAX_LOG_CHARS = 24_000;

/** {@link PrApi} over `gh api`, run in `cwd`. */
export function ghPrApi(cwd: string, signal?: AbortSignal): PrApi {
	return async (endpoint, etag) => {
		const result = await github.run(cwd, ghApiArgs(endpoint, etag), signal, { repoProvided: true });
		const response = parseGhApiResponse(result.stdout);
		if (response) return response;
		throw new PrApiError(result.stderr || `gh api ${endpoint} failed`, 0);
	};
}

/** Login of the signed-in `gh` user; undefined when it cannot be read. */
export async function ghUserLogin(cwd: string): Promise<string | undefined> {
	const result = await github.run(cwd, ["api", "user", "--jq", ".login"], undefined, { repoProvided: true });
	const login = result.stdout.trim();
	return result.exitCode === 0 && login !== "" ? login : undefined;
}

/** The pull request of the checkout's current branch. */
async function branchPullRequest(cwd: string): Promise<PrRef> {
	const view = await github.json<{ url?: string }>(cwd, ["pr", "view", "--json", "url"]).catch((error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ToolError(`No pull request found for the current branch: ${reason}`);
	});
	const ref = typeof view.url === "string" ? parsePrRef(view.url) : undefined;
	if (!ref) throw new ToolError("gh did not report a pull request URL for the current branch.");
	return ref;
}

/**
 * The pull request `arg` names: a URL, `owner/repo#N`, `#N` or `N` (in the checkout's repository), or,
 * when empty, the pull request of the checkout's current branch.
 * @throws ToolError when it names none.
 */
export async function resolvePrRef(cwd: string, arg: string | undefined): Promise<PrRef> {
	const text = (arg ?? "").trim();
	if (text === "") return branchPullRequest(cwd);
	const ref = parsePrRef(text);
	if (ref) return ref;
	const bare = /^#?(\d+)$/.exec(text);
	if (!bare) throw new ToolError(`"${text}" is not a pull request: use a URL, owner/repo#N, or a number.`);
	const repo = await tryResolveCurrentRepo(cwd, undefined);
	if (!repo)
		throw new ToolError(`Cannot tell which repository #${bare[1]} is in: run inside a GitHub checkout or use a URL.`);
	return { repo, number: Number(bare[1]) };
}

/** What of a log tail fits in the remaining character `budget` (the end of the log is kept), and what budget is left. */
export function fitLogBudget(tail: string, budget: number): { shown: string; left: number } {
	if (budget <= 0) return { shown: "(log omitted: size budget used up)", left: 0 };
	const shown = tail.length > budget ? tail.slice(-budget) : tail;
	return { shown, left: budget - shown.length };
}

/**
 * Tail of the log of each failed job behind `failed`, for the first few failures. Checks that are
 * not GitHub Actions jobs (or whose log cannot be read) contribute only their name and URL.
 */
export async function collectFailureLogs(
	cwd: string,
	snapshot: PrSnapshot,
	failed: readonly PrCheck[],
): Promise<string> {
	const lines: string[] = [];
	let jobs: GhRunSnapshot[] = [];
	try {
		jobs = await fetchRunsForCommit(cwd, snapshot.repo, snapshot.headSha);
	} catch {
		jobs = [];
	}
	const names = new Set(failed.map(check => check.name));
	const matched = jobs
		.flatMap(run =>
			run.jobs
				.filter(job => isFailedJob(job) && (names.has(job.name) || names.has(`${run.workflowName} / ${job.name}`)))
				.map(job => ({ run, job })),
		)
		.slice(0, MAX_LOGGED_JOBS);
	const logs =
		matched.length > 0 ? await fetchFailedJobLogs(cwd, snapshot.repo, matched, LOG_TAIL_LINES).catch(() => []) : [];
	let budget = MAX_LOG_CHARS;
	const logged = new Set<string>();
	for (const entry of logs) {
		logged.add(entry.job.name);
		const tail = entry.tail ?? "(log unavailable)";
		const { shown, left } = fitLogBudget(tail, budget);
		budget = left;
		lines.push(
			`--- ${entry.run.workflowName ?? "workflow"} / ${entry.job.name} (${entry.job.url ?? entry.run.url ?? ""}) ---`,
			shown,
		);
	}
	for (const check of failed) {
		if (!logged.has(check.name))
			lines.push(`--- ${check.name}${check.url ? ` (${check.url})` : ""} --- no log collected`);
	}
	return lines.join("\n");
}
