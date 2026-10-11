/**
 * What a turn changed, read from the per-prompt working-tree snapshots (`file-snapshots.ts`).
 *
 * The snapshot taken before prompt N holds the files as they were when N was sent. Diffing it
 * against the snapshot before prompt N+1 (or, for the latest turn, the working tree right now)
 * gives exactly the edits of turn N, whether the agent made them through its edit tools or through
 * shell commands. Diffing the session's first snapshot against the working tree gives everything
 * since the session started. Neither needs the repository's own history: the snapshots live in a
 * private git store, so uncommitted work is covered.
 *
 * This module is the pure half: turning `git diff-tree` output into {@link TurnDiffFile} rows. The git
 * calls live in `file-snapshots.ts`; `turn-diff-run.ts` picks which prompts bound a turn.
 */
import type { TurnDiffFile } from "@oh-my-pi/pi-wire";

/** Files listed per diff; the rest are counted in {@link TurnDiff.omitted}. */
export const TURN_DIFF_MAX_FILES = 2000;
/** One file's diff text is cut at this size. */
export const TURN_DIFF_MAX_FILE_CHARS = 64 * 1024;
/** Diff text across all files; files past it are listed without their diff. */
export const TURN_DIFF_MAX_TOTAL_CHARS = 1024 * 1024;

/** The result of a snapshot diff: changed files, with how many turns it spans. */
export interface TurnDiff {
	files: TurnDiffFile[];
	/** Changed files past {@link TURN_DIFF_MAX_FILES}, not listed. */
	omitted: number;
	/** Turns the diff covers (more than 1 when prompts after the asked one have no snapshot). */
	spansTurns: number;
}

/** A path's status in `git diff-tree --name-status`. */
export interface RawChange {
	status: "A" | "D" | "M" | "T";
	path: string;
}

const STATUS_NAME: Record<RawChange["status"], TurnDiffFile["status"]> = {
	A: "added",
	D: "deleted",
	M: "modified",
	T: "typechange",
};

/** `git diff-tree --numstat -z` (no renames): path -> `[added, removed]`, `null` counts for a binary file. */
export function parseNumstat(output: string): Map<string, [number | null, number | null]> {
	const counts = new Map<string, [number | null, number | null]>();
	for (const record of output.split("\0")) {
		const first = record.indexOf("\t");
		const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
		if (second < 0) continue;
		const added = record.slice(0, first);
		const removed = record.slice(first + 1, second);
		counts.set(record.slice(second + 1), [
			added === "-" ? null : Number(added),
			removed === "-" ? null : Number(removed),
		]);
	}
	return counts;
}

/**
 * The per-file sections of `git diff-tree -p`, each cut down to its hunks (the `diff --git`, `index`,
 * `---` and `+++` preamble dropped: the path is the row header). A binary or mode-only change has no
 * hunk and yields "". Sections come in the same path order as `--name-status`.
 */
export function splitPatch(output: string): string[] {
	const sections = output.split(/^diff --git /m);
	sections.shift();
	return sections.map(section => {
		const hunk = section.startsWith("@@ ") ? 0 : section.indexOf("\n@@ ");
		return hunk < 0 ? "" : section.slice(hunk === 0 ? 0 : hunk + 1);
	});
}

function cutAtLine(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = text.lastIndexOf("\n", limit);
	return end < 0 ? "" : text.slice(0, end + 1);
}

/** Rows for a tree diff from its name-status, numstat and patch output. Throws when the three disagree. */
export function buildTurnDiff(
	changes: readonly RawChange[],
	numstat: ReadonlyMap<string, [number | null, number | null]>,
	patch: readonly string[],
	spansTurns: number,
): TurnDiff {
	if (patch.length !== changes.length) {
		throw new Error("the diff did not line up with its file list");
	}
	const files: TurnDiffFile[] = [];
	let budget = TURN_DIFF_MAX_TOTAL_CHARS;
	for (const [index, change] of changes.slice(0, TURN_DIFF_MAX_FILES).entries()) {
		const counts = numstat.get(change.path);
		const full = patch[index] ?? "";
		const diff = cutAtLine(full, Math.min(TURN_DIFF_MAX_FILE_CHARS, budget));
		budget -= diff.length;
		files.push({
			path: change.path,
			status: STATUS_NAME[change.status],
			added: counts ? counts[0] : null,
			removed: counts ? counts[1] : null,
			diff,
			...(diff.length < full.length ? { truncated: true as const } : {}),
		});
	}
	return { files, omitted: Math.max(0, changes.length - files.length), spansTurns };
}
