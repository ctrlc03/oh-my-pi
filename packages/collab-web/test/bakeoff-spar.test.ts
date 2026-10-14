import { describe, expect, it } from "bun:test";
import { BAKEOFF_MAX_INSTRUCTIONS_CHARS } from "@oh-my-pi/pi-wire/bakeoff";
import { scoreSpar, type Spar, type SparPoint, type SparRecord, type SparRun } from "@oh-my-pi/pi-wire/spar";
import { bakeoffFromSpar } from "../src/components/bakeoff/bakeoff-spar";

function point(id: string, challenge: string): SparPoint {
	return { id, part: 0, kind: "failure", title: `Point ${id}`, challenge, severity: 2, refs: [] };
}

function spar(points: SparPoint[], over: Partial<Spar> = {}): Spar {
	return {
		v: 1,
		id: "sp-1",
		title: "demo @ feature vs main",
		repo: { root: "/work/repo", name: "repo" },
		createdAt: 1,
		parts: [{ index: 0, title: "What changed", head: { commit: "c" }, base: { commit: "b" } }],
		points,
		warnings: [],
		...over,
	};
}

function run(points: string[], records: Record<string, SparRecord>): SparRun {
	return { id: "r1", startedAt: 10, points, records, result: scoreSpar({ points, records }) };
}

const HELD: SparRecord = { turns: [], outcome: { kind: "held", by: "partner" } };
const LOST: SparRecord = {
	turns: [],
	outcome: { kind: "lost", by: "you" },
	reveal: { strongestDefence: "x", suggestion: "Do y." },
};
const OPEN: SparRecord = { turns: [], outcome: { kind: "open", by: "limit" } };

describe("bakeoffFromSpar", () => {
	const points = [
		point("p1", "Lead.\n\nThe lock is held across the await."),
		point("p2", "Lead.\n\nThe retry never gives up."),
		point("p3", "Lead.\n\nThe cache is never emptied."),
	];

	it("takes the objections that were not held as instructions, in the spar's own repository", () => {
		const start = bakeoffFromSpar(
			"pi",
			spar(points, { sessionId: "s-1" }),
			run(["p1", "p2", "p3"], { p1: HELD, p2: LOST, p3: OPEN }),
		);
		expect(start.view).toBe("new");
		expect(start.subject).toEqual({ kind: "changes" });
		expect(start.at).toEqual({ computerId: "pi", cwd: "/work/repo", sessionId: "s-1" });
		expect(start.instructions).toBe(
			"Sparring left these objections standing; a good answer settles them:\n- The cache is never emptied.\n- The retry never gives up.",
		);
	});

	it("states no instructions when every point held", () => {
		const start = bakeoffFromSpar("pi", spar(points), run(["p1", "p2"], { p1: HELD, p2: HELD }));
		expect(start.instructions).toBeUndefined();
		expect(start.at?.sessionId).toBeNull();
	});

	it("keeps the instructions within what the companion accepts", () => {
		const long = Array.from({ length: 30 }, (_, i) => point(`q${i}`, `Lead.\n\n${"w".repeat(390)} ${i}`));
		const records: Record<string, SparRecord> = Object.fromEntries(long.map(item => [item.id, OPEN]));
		const start = bakeoffFromSpar(
			"pi",
			spar(long),
			run(
				long.map(item => item.id),
				records,
			),
		);
		expect(start.instructions!.length).toBeLessThanOrEqual(BAKEOFF_MAX_INSTRUCTIONS_CHARS);
		expect(start.instructions!.split("\n").length).toBeGreaterThan(2);
	});

	it("offers the pull request of a spar about one", () => {
		const withPr = spar(points, {
			parts: [
				{
					index: 0,
					title: "Fix it",
					head: { commit: "c" },
					base: { commit: "b" },
					pr: { number: 12 },
				} as Spar["parts"][number],
			],
		});
		expect(bakeoffFromSpar("pi", withPr, run(["p1"], { p1: HELD })).subject).toEqual({
			kind: "pr",
			number: 12,
			title: "Fix it",
		});
	});

	it("offers a design for a spar about a document", () => {
		const design = spar(points, { parts: [{ index: 0, title: "Design", head: { commit: "c" } }] });
		expect(bakeoffFromSpar("pi", design, run(["p1"], { p1: HELD })).subject).toEqual({ kind: "doc" });
	});
});
