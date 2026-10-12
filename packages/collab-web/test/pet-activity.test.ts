import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	derivePetState,
	homePetState,
	PET_PULSE_MS,
	type PetPulse,
	type PetSignals,
	petBubbleText,
	stepPulse,
	steadyPetState,
	tallyFailures,
} from "../src/lib/pet-activity";

const NOW = 1_000_000;
const base: PetSignals = {
	live: true,
	blocked: false,
	working: false,
	tools: [],
	thinking: false,
	failures: 0,
	planDone: false,
};
const signals = (patch: Partial<PetSignals>): PetSignals => ({ ...base, ...patch });

describe("steadyPetState", () => {
	it("is idle while nothing happens or the session is not live", () => {
		expect(steadyPetState(base)).toBe("idle");
		expect(steadyPetState(signals({ live: false, working: true, blocked: true }))).toBe("idle");
	});

	it("waits on the user over everything else, an ask tool included", () => {
		expect(steadyPetState(signals({ working: true, blocked: true, tools: ["bash"] }))).toBe("waiting");
		expect(steadyPetState(signals({ working: true, tools: ["ask"] }))).toBe("waiting");
	});

	it("runs for a tool that changes things and for a turn in flight", () => {
		expect(steadyPetState(signals({ working: true, tools: ["bash"] }))).toBe("running");
		expect(steadyPetState(signals({ working: true, tools: ["read", "edit"] }))).toBe("running");
		expect(steadyPetState(signals({ working: true }))).toBe("running");
	});

	it("reviews while the model thinks or only reading tools run", () => {
		expect(steadyPetState(signals({ working: true, thinking: true }))).toBe("review");
		expect(steadyPetState(signals({ working: true, tools: ["grep", "read"] }))).toBe("review");
	});
});

describe("derivePetState", () => {
	it("lets a playing transient win over the steady state, and drops it once expired", () => {
		const working = signals({ working: true, tools: ["bash"] });
		const pulse: PetPulse = { kind: "failed", until: NOW + 100 };
		expect(derivePetState(working, pulse, NOW)).toBe("failed");
		expect(derivePetState(working, pulse, NOW + 100)).toBe("running");
	});
});

describe("stepPulse", () => {
	const turn = signals({ working: true });

	it("plays nothing for the first snapshot or when either side is not live", () => {
		expect(stepPulse(null, signals({ failures: 3 }), NOW, null)).toBeNull();
		expect(stepPulse(signals({ live: false }), signals({ failures: 3 }), NOW, null)).toBeNull();
		expect(stepPulse(turn, signals({ live: false }), NOW, null)).toBeNull();
	});

	it("waves when a turn ends, jumps when the plan completes, fails when a failure is counted", () => {
		expect(stepPulse(turn, base, NOW, null)).toEqual({ kind: "waving", until: NOW + PET_PULSE_MS.waving });
		expect(stepPulse(base, signals({ planDone: true }), NOW, null)?.kind).toBe("jumping");
		expect(stepPulse(turn, signals({ working: true, failures: 1 }), NOW, null)?.kind).toBe("failed");
	});

	it("ranks failed over jumping over waving when they land together", () => {
		const ending = stepPulse(turn, signals({ planDone: true, failures: 1 }), NOW, null);
		expect(ending?.kind).toBe("failed");
		expect(stepPulse(turn, signals({ planDone: true }), NOW, null)?.kind).toBe("jumping");
	});

	it("keeps a stronger transient while a weaker one arrives, and retires a wave when a turn starts", () => {
		const failed: PetPulse = { kind: "failed", until: NOW + 1000 };
		expect(stepPulse(turn, base, NOW, failed)).toBe(failed);
		const waving: PetPulse = { kind: "waving", until: NOW + 1000 };
		expect(stepPulse(base, turn, NOW, waving)).toBeNull();
	});

	it("does not replay on a reconnect: a failure count that jumps while not live is baseline", () => {
		const reconnecting = signals({ live: false, failures: 5 });
		expect(stepPulse(reconnecting, signals({ failures: 5 }), NOW, null)).toBeNull();
	});
});

function toolResult(isError: boolean): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: "c",
			toolName: "bash",
			content: [{ type: "text", text: "x" }],
			isError,
			timestamp: 1,
		},
	};
}

describe("tallyFailures", () => {
	it("counts failed tool results and continues from the previous list when it only grew", () => {
		const first = [toolResult(false), toolResult(true)];
		const a = tallyFailures(first, null);
		expect(a.count).toBe(1);
		const grown = [...first, toolResult(true)];
		const b = tallyFailures(grown, a);
		expect(b.count).toBe(2);
	});

	it("recounts when the list was replaced rather than grown", () => {
		const a = tallyFailures([toolResult(true), toolResult(true)], null);
		const replaced = [toolResult(false), toolResult(true), toolResult(false)];
		expect(tallyFailures(replaced, a).count).toBe(1);
	});
});

describe("homePetState", () => {
	const idle = { busy: false, inputRequired: false };

	it("waits if any session needs you, else runs if any works, else idles", () => {
		expect(homePetState([idle, { busy: true, inputRequired: false }], true)).toBe("running");
		expect(
			homePetState(
				[
					{ busy: true, inputRequired: false },
					{ busy: false, inputRequired: true },
				],
				true,
			),
		).toBe("waiting");
		expect(homePetState([idle, { busy: null, inputRequired: false }], true)).toBe("idle");
		expect(homePetState([{ busy: true, inputRequired: true }], false)).toBe("idle");
	});
});

describe("petBubbleText", () => {
	it("uses the words of the pop-out's bubble", () => {
		expect(petBubbleText("running")).toBe("working…");
		expect(petBubbleText("review")).toBe("thinking…");
		expect(petBubbleText("waiting")).toBe("your turn");
		expect(petBubbleText("waving")).toBe("done");
		expect(petBubbleText("failed")).toBe("failed");
	});
});
