import { describe, expect, it } from "bun:test";
import { clampPoint, defaultLeft, homePoint, PET_MARGIN, petHeight, roamY, spotAt } from "../src/lib/pet-layout";
import { hopLift, nextRoamStep, walkSpeed } from "../src/lib/pet-roam";

const view = { width: 1000, height: 800 };

describe("homePoint", () => {
	it("sits at the bottom right above the message box by default", () => {
		const size = 64;
		const home = homePoint(null, view, size, 700);
		expect(home.x).toBe(defaultLeft(view, size));
		expect(home.x).toBe(1000 - size - PET_MARGIN);
		expect(home.y + petHeight(size)).toBe(700 - PET_MARGIN);
	});

	it("uses the viewport's bottom when no session is open, and stays inside it", () => {
		const home = homePoint(null, view, 64, null);
		expect(home.y + petHeight(64)).toBeLessThanOrEqual(800);
		expect(homePoint(null, { width: 40, height: 40 }, 64, 10)).toEqual({ x: 0, y: 0 });
	});

	it("keeps a saved spot proportional across a resize", () => {
		const spot = spotAt({ x: 468, y: 348 }, view, 64);
		const bigger = homePoint(spot, { width: 2000, height: 1000 }, 64, null);
		expect(bigger.x).toBeCloseTo((468 / (1000 - 64)) * (2000 - 64));
		expect(clampPoint({ x: -50, y: 5000 }, view, 64)).toEqual({ x: 0, y: 800 - petHeight(64) });
	});
});

describe("roamY", () => {
	it("lifts the walk above the message box instead of crossing it", () => {
		expect(roamY({ x: 0, y: 600 }, 64, 500)).toBe(500 - petHeight(64) - 4);
		expect(roamY({ x: 0, y: 300 }, 64, 500)).toBe(300);
		expect(roamY({ x: 0, y: 600 }, 64, null)).toBe(600);
	});
});

describe("nextRoamStep", () => {
	const sequence = (values: number[]) => {
		let i = 0;
		return () => values[i++ % values.length];
	};

	it("walks toward the side with room, inside the band, naming the direction", () => {
		const step = nextRoamStep(sequence([0.9, 0.1, 0.5]), 100, 12, 900, 64, null);
		if (step.kind !== "walk") throw new Error(`expected a walk, got ${step.kind}`);
		expect(step.state).toBe("running-right");
		expect(step.to).toBeGreaterThan(100);
		expect(step.to).toBeLessThanOrEqual(900);
		expect(step.ms).toBeCloseTo(((step.to - 100) / walkSpeed(64)) * 1000);
		const left = nextRoamStep(sequence([0.9, 0.9, 0.5]), 800, 12, 900, 64, null);
		expect(left.kind === "walk" && left.state).toBe("running-left");
	});

	it("never leaves the band and pauses after every walk and hop", () => {
		for (let seed = 0; seed < 200; seed++) {
			const random = sequence([(seed * 0.37) % 1, (seed * 0.61) % 1, (seed * 0.13) % 1, (seed * 0.91) % 1]);
			const step = nextRoamStep(random, 450, 12, 900, 64, null);
			if (step.kind === "walk") {
				expect(step.to).toBeGreaterThanOrEqual(12);
				expect(step.to).toBeLessThanOrEqual(900);
			}
			expect(nextRoamStep(random, 450, 12, 900, 64, "walk").kind).toBe("pause");
			expect(nextRoamStep(random, 450, 12, 900, 64, "hop").kind).toBe("pause");
		}
	});

	it("only pauses or hops when the band is too narrow to walk", () => {
		const step = nextRoamStep(sequence([0.9]), 20, 12, 40, 64, null);
		expect(step.kind).toBe("pause");
	});
});

describe("hopLift", () => {
	it("peaks mid-hop and is on the floor at both ends", () => {
		expect(hopLift(0, 30)).toBe(0);
		expect(hopLift(0.5, 30)).toBe(30);
		expect(hopLift(1, 30)).toBe(0);
	});
});
