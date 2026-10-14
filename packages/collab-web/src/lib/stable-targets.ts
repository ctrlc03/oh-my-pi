import { useRef } from "react";
import type { CompanionClient } from "./companion";
import { type ComputerHandle, type Feature, unavailableReason } from "./computers";

/** A computer whose stored things (maps, quizzes) are listed. */
export interface ClientTarget {
	id: string;
	name: string;
	client: CompanionClient;
}

/** The computers that can do `feature` right now, each with its connection. */
export function featureTargets(computers: readonly ComputerHandle[], feature: Feature): ClientTarget[] {
	return computers.flatMap(computer =>
		computer.client !== null && unavailableReason(computer, feature) === null
			? [{ id: computer.id, name: computer.name, client: computer.client }]
			: [],
	);
}

/** `targets`, the same array while the same computers stay connected (a snapshot change on another field is not a new list). */
export function useStableTargets(next: ClientTarget[]): ClientTarget[] {
	const kept = useRef(next);
	const same =
		kept.current.length === next.length &&
		next.every((target, at) => target.id === kept.current[at]!.id && target.client === kept.current[at]!.client);
	if (!same) kept.current = next;
	return kept.current;
}
