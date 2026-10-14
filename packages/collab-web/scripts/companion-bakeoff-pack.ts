/**
 * The review pack of a bake-off (docs/design-review.md, *Blind protocol*): which label each entry gets, in what order
 * a reviewer reads them, and each entry's code exported without history. Labels and order are drawn from the bake-off's
 * id with the quiz's repeatable generator, so the same id always gives the same pack and a second reviewer pass can
 * read the same entries under other labels in the reverse order.
 */

import * as fs from "node:fs/promises";
import { BAKEOFF_LABELS } from "@oh-my-pi/pi-wire/bakeoff";
import { seeded } from "./companion-seed";

/** Fisher–Yates over a copy of `items`. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/** The labels of `count` entries, in the order the entries were made (the original first): a shuffle of `A`.. seeded by the bake-off id. */
export function drawLabels(seed: string, count: number): string[] {
	if (count < 1 || count > BAKEOFF_LABELS.length) throw new Error("invalid entry count");
	return shuffled(BAKEOFF_LABELS.slice(0, count).split(""), seeded(`${seed}:labels`));
}

/** How one reviewer pass sees the entries. Keys are the stored (entry) labels. */
export interface Presentation {
	/** The label the reviewer reads for each entry. */
	packLabel: Record<string, string>;
	/** Entry labels in the order the reviewer reads them. A second thing the seed controls, apart from the labels. */
	order: string[];
}

/**
 * Pass 0 reads the entries under their own labels in a shuffled order. Pass 1 reads them in the reverse order under
 * freshly drawn labels (no entry keeps its label when there is more than one), so neither "first" nor a letter is a hint.
 */
export function presentation(seed: string, pass: 0 | 1, labels: readonly string[]): Presentation {
	const order = shuffled(labels, seeded(`${seed}:order`));
	if (pass === 0) return { packLabel: Object.fromEntries(labels.map(label => [label, label])), order };
	let drawn = [...labels];
	for (let attempt = 0; attempt < 32; attempt++) {
		drawn = shuffled(labels, seeded(`${seed}:labels:1:${attempt}`));
		if (labels.length < 2 || drawn.every((label, i) => label !== labels[i])) break;
	}
	// A shuffle that kept a label after every attempt (rare) is rotated by one instead.
	if (labels.length > 1 && drawn.some((label, i) => label === labels[i])) drawn = [...labels.slice(1), labels[0]!];
	return { packLabel: Object.fromEntries(labels.map((label, i) => [label, drawn[i]!])), order: [...order].reverse() };
}

/**
 * `git archive <commit>` extracted into `dest`: the code as of the commit, no `.git`, no branch names. `dest` is
 * created. @throws Error with git's first line when the commit cannot be archived.
 */
export async function exportCommit(root: string, commit: string, dest: string): Promise<void> {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid commit");
	await fs.mkdir(dest, { recursive: true });
	const archive = Bun.spawn(["git", "-C", root, "archive", "--format=tar", commit], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const extract = Bun.spawn(["tar", "-xf", "-", "-C", dest], {
		stdin: archive.stdout,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [archiveErr, extractErr, archiveCode, extractCode] = await Promise.all([
		new Response(archive.stderr).text(),
		new Response(extract.stderr).text(),
		archive.exited,
		extract.exited,
	]);
	if (archiveCode !== 0) throw new Error(archiveErr.trim().split("\n")[0] || "git archive failed");
	if (extractCode !== 0) throw new Error(extractErr.trim().split("\n")[0] || "could not unpack the code");
}
