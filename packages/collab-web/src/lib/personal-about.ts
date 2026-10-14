/** The About you screen's pure parts: the live size of the draft, and the history's wording and diffs. */

import {
	MAX_ABOUT_BYTES,
	PERSONAL_DEFAULTS,
	type PersonalAboutVersion,
	type PersonalDiffLine,
} from "@oh-my-pi/pi-wire/personal";
import { lineDiff } from "./personal-diff";

export interface AboutSize {
	/** Rough token count, 4 characters to a token, as the companion counts. */
	tokens: number;
	/** Past the share About you is meant to stay under: loaded into every session. */
	over: boolean;
	/** Too big to save at all. */
	tooLong: boolean;
}

const encoder = new TextEncoder();

export function aboutSize(text: string): AboutSize {
	const tokens = Math.ceil(text.length / 4);
	return {
		tokens,
		over: tokens > PERSONAL_DEFAULTS.aboutMaxTokens,
		tooLong: encoder.encode(text).length > MAX_ABOUT_BYTES,
	};
}

const BY_LABELS: Record<PersonalAboutVersion["by"], string> = {
	setup: "Set up",
	owner: "You",
	proposal: "Proposal accepted",
};

/** Who made a version: "Set up", "You", "Proposal accepted · a1b2c3d4". */
export function aboutVersionBy(version: Pick<PersonalAboutVersion, "by" | "proposalId">): string {
	const by = BY_LABELS[version.by];
	return version.proposalId === undefined ? by : `${by} · ${version.proposalId.slice(0, 8)}`;
}

/**
 * What `versions[index]` changed: the diff from the version after it (versions are newest first); the first ever from
 * nothing. Null when its predecessor is older than what was loaded.
 */
export function aboutVersionDiff(versions: readonly PersonalAboutVersion[], index: number): PersonalDiffLine[] | null {
	const before = versions[index + 1];
	if (before === undefined && versions[index].rev > 1) return null;
	return lineDiff(before?.text ?? "", versions[index].text);
}
