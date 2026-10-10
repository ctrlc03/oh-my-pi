/** The prompt the Fix-it flow puts in a session's message box: what failed, the log tails, and what to do. */

import type { CiLogFailure, CiLogPr } from "./companion";

export interface FixPromptInput {
	number: number;
	pr: CiLogPr;
	failures: readonly CiLogFailure[];
	/** Failing checks the report left out. */
	moreFailures: number;
	/** Branch the chosen session is on; null when detached or when no session exists yet. */
	sessionBranch: string | null;
}

/** `text` in a code fence that its own backticks cannot close. */
function fence(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}\n${text}\n${ticks}`;
}

export function fixPrompt({ number, pr, failures, moreFailures, sessionBranch }: FixPromptInput): string {
	const head = [`Checks failed on pull request #${number}: ${pr.title}`, pr.url, `Branch: ${pr.branch}`].filter(
		Boolean,
	);
	const parts = [head.join("\n"), failures.length === 1 ? "Failing check:" : "Failing checks:"];
	for (const failure of failures) {
		const title = failure.url ? `${failure.check} (${failure.url})` : failure.check;
		parts.push(failure.log ? `${title}\n${fence(failure.log)}` : `${title}\n(no log available; see the link)`);
	}
	if (moreFailures > 0)
		parts.push(`${moreFailures} more failing ${moreFailures === 1 ? "check is" : "checks are"} not shown.`);
	if (pr.branch && sessionBranch !== pr.branch)
		parts.push(
			`Check out ${pr.branch} first${sessionBranch ? ` (this session is on ${sessionBranch})` : ""}, for example with \`gh pr checkout ${number}\`.`,
		);
	parts.push(
		`Fix the failing checks on ${pr.branch || `pull request #${number}`}; run the failing tests locally before pushing.`,
	);
	return parts.join("\n\n");
}
