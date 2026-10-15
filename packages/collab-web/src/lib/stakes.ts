/**
 * What the app decides about high-stakes sessions, with no React: whether a computer or a session shows the mode at
 * all (a companion that predates `canHighStakes` shows nothing of it), and what the push, pull request and merge
 * buttons say while the session's changes are not covered. The wire contract is `@oh-my-pi/pi-wire/stakes`.
 */

import type { AgentRef } from "@oh-my-pi/pi-wire";
import type { StakesStatus } from "@oh-my-pi/pi-wire/stakes";
import type { CompanionSnapshot } from "./companion";

/** What the buttons it gates are, and the line shown beside them while they are disabled. */
export type StakesGate = "push" | "pr" | "merge";

const GATE_LINE: Record<StakesGate, string> = {
	push: "Pass the quiz to push",
	pr: "Pass the quiz to open a pull request",
	merge: "Pass the quiz to merge",
};

/** The line beside a disabled button of `gate`. */
export function stakesGateLine(gate: StakesGate): string {
	return GATE_LINE[gate];
}

/** Pushing, pull requests and merges wait for a quiz: the mode is on and the session's changes are not covered. */
export function stakesBlocked(status: StakesStatus | undefined): status is StakesStatus {
	return status !== undefined && status.on && !status.covered;
}

/** The label of the action that opens the quiz the push needs: the new changes only after an earlier pass. */
export function takeQuizLabel(status: StakesStatus): string {
	return status.needs === "delta" ? "Take the quiz on the new changes" : "Take the quiz";
}

/** The companion's own detail beside the gate lines, when it adds something they do not already say. */
export function stakesDetail(status: StakesStatus): string | null {
	const lines = Object.values(GATE_LINE);
	const message = status.message.trim();
	return message === "" || lines.includes(message) ? null : message;
}

/** The session is high stakes, as far as this computer reports it (never from a companion without the capability). */
export function stakesOn(snap: Pick<CompanionSnapshot, "canHighStakes">, row: { highStakes?: boolean }): boolean {
	return snap.canHighStakes && row.highStakes === true;
}

/** A session can be toggled: the computer supports the mode and the session is omp (vendor agents are not gated). */
export function stakesToggleShown(
	snap: Pick<CompanionSnapshot, "canHighStakes">,
	agent: AgentRef | null | undefined,
): boolean {
	return snap.canHighStakes && (agent === null || agent === undefined);
}
