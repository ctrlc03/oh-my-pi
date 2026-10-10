/**
 * GitHub alerts: the user's own open pull requests in the repositories of
 * known sessions, polled through `gh`, and a push when their checks finish or
 * someone reviews or comments. Pure over an injected clock and reader (like
 * the spend monitor) so transitions are testable without GitHub. The first
 * sighting of a pull request only records it: nothing already there is news.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GithubItem, PrAlertSettings } from "../src/lib/companion";
import { fixRoute } from "../src/lib/fix-route";
import { gh } from "./companion-gitflow";
import { type RawCheck, rollup, toCheck } from "./companion-github";

/** Interval between checks while some watched pull request still has pending checks. */
export const PR_PENDING_CHECK_MS = 2 * 60 * 1000;
/** Interval otherwise. */
export const PR_IDLE_CHECK_MS = 5 * 60 * 1000;
const GH_TIMEOUT_MS = 30_000;
const PR_LIMIT = 30;
/** Repositories polled per round: every session cwd of a long-lived companion would otherwise cost one `gh` each. */
const MAX_REPOS = 20;
/** Alerts per pull request per round; a burst of reviews should not bury the lock screen. */
const MAX_ALERTS_PER_PR = 3;
const MAX_TITLE_CHARS = 80;
const MAX_LINE_CHARS = 120;
/** `Topic` header limit (RFC 8030): at most 32 characters of the URL-safe base64 alphabet. */
const TOPIC_HASH_CHARS = 24;

const PR_FIELDS = "number,title,url,author,statusCheckRollup,reviewDecision,latestReviews,comments";

export type PrChecks = GithubItem["checks"];

/** A pull request as one poll sees it. */
export interface PrSnapshot {
	/** `owner/repo`. */
	repo: string;
	number: number;
	title: string;
	url: string;
	/** Login of the pull request author, whose own reviews and comments are not news. */
	author: string;
	checks: PrChecks;
	/** Name of the first failing check, when `checks` is `fail`. */
	failing: string | null;
	reviews: { author: string; state: string; at: number }[];
	comments: { author: string; body: string; at: number }[];
}

/** What was already seen of one pull request. */
export interface PrSeen {
	checks: PrChecks;
	/** Newest review time (Unix ms) already reported. */
	reviewAt: number;
	/** Newest comment time (Unix ms) already reported. */
	commentAt: number;
}

/** Key: `owner/repo#number`. */
export type PrWatchState = Record<string, PrSeen>;

export interface PrAlert {
	title: string;
	body: string;
	/** The pull request page, opened by tapping the notification. */
	url: string;
	/** App route opened on tap instead of {@link url} (`fix:` for failed checks). */
	open?: string;
	/** Notifications with the same tag replace each other on the device. */
	tag: string;
	/** Web Push `Topic`: a newer undelivered alert of the same tag replaces an older one. */
	topic: string;
}

export const DEFAULT_PR_ALERTS: PrAlertSettings = { checks: true, reviews: true };

/** @throws Error when `raw` is not `{ checks, reviews }` of booleans. */
export function parsePrAlertSettings(raw: unknown): PrAlertSettings {
	const value = raw as Partial<Record<keyof PrAlertSettings, unknown>> | null;
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.checks !== "boolean" ||
		typeof value.reviews !== "boolean"
	)
		throw new Error("invalid pull request alert settings");
	return { checks: value.checks, reviews: value.reviews };
}

const prKey = (pr: { repo: string; number: number }): string => `${pr.repo}#${pr.number}`;

function parseSeen(raw: unknown): PrSeen | undefined {
	const seen = raw as Partial<Record<keyof PrSeen, unknown>> | null;
	if (typeof seen !== "object" || seen === null) return undefined;
	const checks = seen.checks === "pending" || seen.checks === "pass" || seen.checks === "fail" ? seen.checks : null;
	const time = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return { checks, reviewAt: time(seen.reviewAt), commentAt: time(seen.commentAt) };
}

/** The persisted file: settings and what was seen. Anything missing or damaged falls back to defaults / nothing seen. */
export function parsePrWatchFile(raw: unknown): { settings: PrAlertSettings; prs: PrWatchState } {
	const file = raw as { settings?: unknown; prs?: unknown } | null;
	let settings = DEFAULT_PR_ALERTS;
	try {
		settings = parsePrAlertSettings(file?.settings);
	} catch {
		// absent or damaged: both on
	}
	const prs: PrWatchState = {};
	const stored = file?.prs;
	if (typeof stored === "object" && stored !== null)
		for (const [key, value] of Object.entries(stored)) {
			const seen = parseSeen(value);
			if (seen) prs[key] = seen;
		}
	return { settings, prs };
}

export async function loadPrWatchFile(file: string): Promise<{ settings: PrAlertSettings; prs: PrWatchState }> {
	try {
		return parsePrWatchFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { settings: DEFAULT_PR_ALERTS, prs: {} };
	}
}

export async function savePrWatchFile(
	file: string,
	contents: { settings: PrAlertSettings; prs: PrWatchState },
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

/** What `gh pr list --json` prints for {@link PR_FIELDS}; every field optional to tolerate older `gh`. */
interface RawPr {
	number?: number;
	title?: string;
	url?: string;
	author?: { login?: string } | null;
	statusCheckRollup?: RawCheck[];
	latestReviews?: { author?: { login?: string } | null; state?: string; submittedAt?: string }[];
	comments?: { author?: { login?: string } | null; body?: string; createdAt?: string }[];
}

const PR_URL_RE = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/;

function time(iso: string | undefined): number {
	const ms = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(ms) ? 0 : ms;
}

const login = (author: { login?: string } | null | undefined): string => author?.login || "ghost";

/** Pull requests from `gh pr list --json` output; entries without a number or a recognisable URL are dropped. */
export function parsePrs(raw: unknown): PrSnapshot[] {
	if (!Array.isArray(raw)) return [];
	const prs: PrSnapshot[] = [];
	for (const item of raw as RawPr[]) {
		const repo = typeof item.url === "string" ? PR_URL_RE.exec(item.url)?.[1] : undefined;
		if (!repo || typeof item.number !== "number") continue;
		const checks = item.statusCheckRollup ?? [];
		prs.push({
			repo,
			number: item.number,
			title: item.title ?? "",
			url: item.url as string,
			author: login(item.author),
			checks: rollup(checks),
			failing: checks.map(toCheck).find(check => check.state === "fail")?.name ?? null,
			reviews: (item.latestReviews ?? []).map(review => ({
				author: login(review.author),
				state: review.state ?? "",
				at: time(review.submittedAt),
			})),
			comments: (item.comments ?? []).map(comment => ({
				author: login(comment.author),
				body: comment.body ?? "",
				at: time(comment.createdAt),
			})),
		});
	}
	return prs;
}

/** The user's open pull requests in the repository at `root`, through the signed-in `gh`. */
export async function ghReadPrs(root: string): Promise<PrSnapshot[]> {
	const result = await gh(
		root,
		["pr", "list", "--author", "@me", "--state", "open", "--limit", String(PR_LIMIT), "--json", PR_FIELDS],
		GH_TIMEOUT_MS,
	);
	if (result.code !== 0) throw new Error((result.err || result.out).split("\n")[0] || "gh pr list failed");
	return parsePrs(JSON.parse(result.out));
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(body: string): string {
	const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
	return clip(
		text
			.split("\n")
			.find(line => line.trim())
			?.trim() ?? "",
		MAX_LINE_CHARS,
	);
}

/** Web Push topic for `tag`: a fixed-length hash, as owner and repository names can exceed the 32-character limit. */
export function pushTopic(tag: string): string {
	return `pr-${new Bun.CryptoHasher("sha256").update(tag).digest("base64url").slice(0, TOPIC_HASH_CHARS)}`;
}

function alertFor(pr: SnapshotLike, kind: "checks" | "review" | "comment", body: string, open?: string): PrAlert {
	const tag = `pr:${prKey(pr)}:${kind}`;
	return {
		title: clip(`${prKey(pr)} ${pr.title}`, MAX_TITLE_CHARS),
		body,
		url: pr.url,
		...(open === undefined ? {} : { open }),
		tag,
		topic: pushTopic(tag),
	};
}

type SnapshotLike = Pick<PrSnapshot, "repo" | "number" | "title" | "url">;

const REVIEW_VERB: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes" };

/**
 * What a poll of `pr` makes of the previous sighting: the state to remember
 * and the alerts due. The state advances whatever the settings, so turning an
 * alert on later does not replay what happened while it was off.
 */
export function detectPrEvents(
	prev: PrSeen | undefined,
	pr: PrSnapshot,
	settings: PrAlertSettings,
): { seen: PrSeen; alerts: PrAlert[] } {
	const reviews = pr.reviews.filter(
		review => review.author !== pr.author && review.state !== "PENDING" && review.state !== "DISMISSED",
	);
	const comments = pr.comments.filter(comment => comment.author !== pr.author);
	const newest = (items: { at: number }[]): number => items.reduce((max, item) => Math.max(max, item.at), 0);
	const seen: PrSeen = {
		checks: pr.checks,
		reviewAt: Math.max(prev?.reviewAt ?? 0, newest(reviews)),
		commentAt: Math.max(prev?.commentAt ?? 0, newest(comments)),
	};
	if (!prev) return { seen, alerts: [] };
	const alerts: PrAlert[] = [];
	if (settings.checks && prev.checks === "pending" && (pr.checks === "pass" || pr.checks === "fail"))
		alerts.push(
			pr.checks === "pass"
				? alertFor(pr, "checks", "Checks passed")
				: alertFor(pr, "checks", `Checks failed: ${pr.failing ?? "a check"}`, fixRoute(pr.repo, pr.number)),
		);
	if (settings.reviews) {
		const fresh = <T extends { at: number }>(items: T[], after: number): T[] =>
			items
				.filter(item => item.at > after)
				.sort((a, b) => a.at - b.at)
				.slice(-MAX_ALERTS_PER_PR);
		for (const review of fresh(reviews, prev.reviewAt))
			alerts.push(alertFor(pr, "review", `${review.author} ${REVIEW_VERB[review.state] ?? "reviewed"}`));
		for (const comment of fresh(comments, prev.commentAt))
			alerts.push(alertFor(pr, "comment", `${comment.author} commented: ${firstLine(comment.body)}`));
	}
	return { seen, alerts };
}

export interface PrWatchOptions {
	now(): number;
	/** What was seen of each pull request. */
	state(): PrWatchState;
	settings(): PrAlertSettings;
	/** Persist the state after a round recorded something. */
	save(state: PrWatchState): Promise<void>;
	/** Someone can receive the alert and `gh` can read: without that the round (and its `gh` calls) is skipped. */
	wanted(): boolean | Promise<boolean>;
	/** Repository roots to list pull requests of. */
	listRepos(): Promise<string[]>;
	readPrs(root: string): Promise<PrSnapshot[]>;
	alert(alert: PrAlert): void;
	onError(err: unknown): void;
}

/** Polls at most every {@link PR_PENDING_CHECK_MS} (some check pending) or {@link PR_IDLE_CHECK_MS}, one round at a time. */
export function createPrWatch(options: PrWatchOptions): { tick(force?: boolean): Promise<void> } {
	let lastRun = Number.NEGATIVE_INFINITY;
	let interval = PR_IDLE_CHECK_MS;
	let running = false;
	return {
		async tick(force = false) {
			const now = options.now();
			if (running || (!force && now - lastRun < interval)) return;
			const settings = options.settings();
			if (!settings.checks && !settings.reviews) return;
			running = true;
			try {
				if (!(await options.wanted())) return;
				lastRun = now;
				const roots = (await options.listRepos()).slice(0, MAX_REPOS);
				const found: Record<string, PrSnapshot> = {};
				let failed = false;
				for (const root of roots) {
					try {
						for (const pr of await options.readPrs(root)) found[prKey(pr)] = pr;
					} catch (err) {
						failed = true;
						options.onError(err);
					}
				}
				const prev = options.state();
				const next: PrWatchState = {};
				const alerts: PrAlert[] = [];
				for (const [key, pr] of Object.entries(found)) {
					const { seen, alerts: due } = detectPrEvents(
						Object.hasOwn(prev, key) ? prev[key] : undefined,
						pr,
						settings,
					);
					next[key] = seen;
					alerts.push(...due);
				}
				// A repository that could not be read may still have open pull requests: keep what was known of them.
				if (failed || roots.length === 0)
					for (const [key, seen] of Object.entries(prev)) if (!Object.hasOwn(next, key)) next[key] = seen;
				interval = Object.values(next).some(seen => seen.checks === "pending")
					? PR_PENDING_CHECK_MS
					: PR_IDLE_CHECK_MS;
				if (JSON.stringify(next) !== JSON.stringify(prev)) {
					// Record before pushing: an alert must not repeat after a failed save and restart.
					await options.save(next);
				}
				for (const alert of alerts) options.alert(alert);
			} catch (err) {
				options.onError(err);
			} finally {
				running = false;
			}
		},
	};
}
