import { describe, expect, it } from "bun:test";
import { defaultPetSettings, MASCOT, parsePetSettings, parsePetSpot } from "../src/lib/pet-settings";

const SHEET = "https://assets.petdex.dev/pets/boba-1/sprite.webp";
const pick = { slug: "boba", name: "Boba", kind: "creature", by: "Ana", sheet: SHEET, version: 1 };

describe("parsePetSettings", () => {
	it("defaults to on and 64 px with a mouse, off and 44 px on a touch screen, never roaming", () => {
		expect(parsePetSettings(null, false)).toEqual({
			enabled: true,
			choice: MASCOT,
			pick: null,
			size: 64,
			roam: false,
			popout: false,
		});
		expect(defaultPetSettings(true)).toMatchObject({ enabled: false, size: 44, roam: false });
	});

	it("takes each stored field that is valid and defaults the others", () => {
		const settings = parsePetSettings({ enabled: false, size: 500, roam: "yes", choice: "boba", pick }, false);
		expect(settings).toMatchObject({ enabled: false, size: 160, roam: false, choice: "boba", pick });
		expect(parsePetSettings({ size: 1 }, false).size).toBe(32);
	});

	it("falls back to the mascot when a petdex choice has no usable saved pet", () => {
		expect(parsePetSettings({ choice: "boba" }, false)).toMatchObject({ choice: MASCOT, pick: null });
		expect(parsePetSettings({ choice: "other", pick }, false)).toMatchObject({ choice: MASCOT, pick: null });
		const unsafe = { ...pick, sheet: "https://evil.example/s.webp" };
		expect(parsePetSettings({ choice: "boba", pick: unsafe }, false)).toMatchObject({ choice: MASCOT, pick: null });
	});
});

describe("parsePetSpot", () => {
	it("clamps fractions into the viewport and rejects junk", () => {
		expect(parsePetSpot({ x: 2, y: -1 })).toEqual({ x: 1, y: 0 });
		expect(parsePetSpot({ x: "1", y: 0 })).toBeNull();
		expect(parsePetSpot(null)).toBeNull();
	});
});
