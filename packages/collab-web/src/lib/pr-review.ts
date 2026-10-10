/**
 * Line comments on a pull request's files: kept per pull request on the device, then either handed to the
 * agent as one prompt or posted to GitHub as one review.
 */
import type { PrReviewComment } from "./companion";
import { buildReviewPrompt, parseStoredComments, type ReviewComment } from "./review-comments";
import { readJson, writeJson } from "./storage";

const KEY_PREFIX = "omp.collab.pr-review.";

/**
 * A diff comment as GitHub wants it. Rows of removed lines carry old-file numbers (side `LEFT`), everything
 * else new-file numbers (side `RIGHT`); a selection over several lines becomes a range ending at `line`.
 */
export function toReviewComment(c: ReviewComment): PrReviewComment {
	const comment: PrReviewComment = {
		path: c.path,
		line: c.end,
		side: c.removed ? "LEFT" : "RIGHT",
		body: c.text.trim(),
	};
	if (c.start < c.end) comment.startLine = c.start;
	return comment;
}

/** Every comment in file and line order, as the review would post them. */
export function toReviewComments(comments: Readonly<Record<string, ReviewComment>>): PrReviewComment[] {
	return Object.values(comments)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start || a.end - b.end))
		.map(toReviewComment);
}

/** The prompt that hands the review to the agent: each comment with its file lines and the quoted diff. */
export function prReviewPrompt(number: number, comments: Readonly<Record<string, ReviewComment>>): string {
	return buildReviewPrompt(Object.values(comments), `Address these review comments on PR #${number}:`);
}

/** Unsent comments of one pull request, by id; `url` (the pull request's page) is what tells two apart across repositories. */
export function loadPrComments(url: string): Record<string, ReviewComment> {
	return parseStoredComments(readJson(KEY_PREFIX + url));
}

export function savePrComments(url: string, comments: Readonly<Record<string, ReviewComment>>): void {
	const all = Object.values(comments);
	writeJson(KEY_PREFIX + url, all.length > 0 ? all : null);
}

/** How many comments each file has. */
export function countByPath(comments: Readonly<Record<string, ReviewComment>>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const c of Object.values(comments)) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
	return counts;
}
