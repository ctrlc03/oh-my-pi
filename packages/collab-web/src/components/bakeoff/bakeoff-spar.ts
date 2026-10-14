import { BAKEOFF_MAX_INSTRUCTIONS_CHARS } from "@oh-my-pi/pi-wire/bakeoff";
import type { Spar, SparRun } from "@oh-my-pi/pi-wire/spar";
import { objectionOf, subjectOf, summaryOf } from "../spar/spar-flow";
import type { BakeoffStart } from "./bakeoff-types";

/**
 * What *Bake off this* opens the new-bake-off form on: the spar's own subject (its pull request, its changes or its
 * design) in its own repository, and as extra instructions the objections the partner left standing. No instructions
 * when every point held.
 */
export function bakeoffFromSpar(computerId: string, spar: Spar, run: SparRun): Extract<BakeoffStart, { view: "new" }> {
	const model = summaryOf(spar, run);
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const item of [...model.open, ...model.suggested]) {
		if (seen.has(item.point.id)) continue;
		seen.add(item.point.id);
		lines.push(`- ${objectionOf(item.point)}`);
	}
	const head = "Sparring left these objections standing; a good answer settles them:";
	let instructions = head;
	for (const line of lines) {
		if (instructions.length + line.length + 1 > BAKEOFF_MAX_INSTRUCTIONS_CHARS) break;
		instructions += `\n${line}`;
	}
	return {
		view: "new",
		subject: subjectOf(spar),
		instructions: instructions === head ? undefined : instructions,
		at: { computerId, cwd: spar.repo.root, sessionId: spar.sessionId ?? null },
	};
}
