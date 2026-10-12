/** The petdex row names; our mascot implements the same set. */
export type PetState =
	| "idle"
	| "running-right"
	| "running-left"
	| "waving"
	| "jumping"
	| "failed"
	| "waiting"
	| "running"
	| "review";
export const PET_STATES: readonly PetState[] = [
	"idle",
	"running-right",
	"running-left",
	"waving",
	"jumping",
	"failed",
	"waiting",
	"running",
	"review",
];
