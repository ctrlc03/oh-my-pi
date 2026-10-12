import { describe, expect, it } from "bun:test";
import { isPetdexAssetUrl, parseManifest, PETDEX_ROWS, searchPets, spriteGeometry } from "../src/lib/petdex";
import { PET_STATES } from "../src/lib/pet-state";

const SHEET = "https://assets.petdex.dev/pets/boba-1/sprite.webp";
const entry = (patch: Record<string, unknown>) => ({
	slug: "boba",
	displayName: "Boba",
	kind: "creature",
	submittedBy: "Ana",
	spritesheetUrl: SHEET,
	spriteVersionNumber: 1,
	...patch,
});

describe("parseManifest", () => {
	it("keeps pets whose sheet is an https assets.petdex.dev URL and drops the rest", () => {
		const pets = parseManifest({
			pets: [
				entry({}),
				entry({ slug: "http", spritesheetUrl: "http://assets.petdex.dev/a.webp" }),
				entry({ slug: "other", spritesheetUrl: "https://evil.example/a.webp" }),
				entry({ slug: "lookalike", spritesheetUrl: "https://assets.petdex.dev.evil.example/a.webp" }),
				entry({ slug: "creds", spritesheetUrl: "https://user:pw@assets.petdex.dev/a.webp" }),
				entry({ slug: "../escape" }),
				entry({ slug: "v2", spriteVersionNumber: 2 }),
				entry({ slug: "boba" }),
				null,
				"nope",
			],
		});
		expect(pets.map(p => p.slug)).toEqual(["boba", "v2"]);
		expect(pets[0]).toEqual({ slug: "boba", name: "Boba", kind: "creature", by: "Ana", sheet: SHEET, version: 1 });
		expect(pets[1].version).toBe(2);
	});

	it("rejects a manifest that is not a list of pets", () => {
		expect(() => parseManifest({ pets: "x" })).toThrow();
		expect(() => parseManifest(null)).toThrow();
	});
});

describe("isPetdexAssetUrl", () => {
	it("accepts only https on the asset host", () => {
		expect(isPetdexAssetUrl(SHEET)).toBe(true);
		expect(isPetdexAssetUrl("https://petdex.dev/x.webp")).toBe(false);
		expect(isPetdexAssetUrl(42)).toBe(false);
	});
});

describe("spriteGeometry", () => {
	it("puts each state on its petdex row, scaled by the cell width", () => {
		const idle = spriteGeometry(96, "idle");
		expect(idle).toMatchObject({ width: 96, height: 104, sheetWidth: 768, offsetY: -0, frames: 6, travelX: -576 });
		const failed = spriteGeometry(96, "failed");
		expect(failed.offsetY).toBe(-5 * 104);
		expect(failed.frames).toBe(8);
	});

	it("covers every state with a distinct row inside the nine petdex rows", () => {
		const rows = PET_STATES.map(state => PETDEX_ROWS[state].row);
		expect(new Set(rows).size).toBe(PET_STATES.length);
		expect(Math.max(...rows)).toBe(8);
	});
});

describe("searchPets", () => {
	const pets = parseManifest({
		pets: [entry({ slug: "boba" }), entry({ slug: "mochi", displayName: "Mochi Cat", submittedBy: "Bo" })],
	});

	it("needs every word to match the name, slug, kind or submitter", () => {
		expect(searchPets(pets, "").length).toBe(2);
		expect(searchPets(pets, "cat bo").map(p => p.slug)).toEqual(["mochi"]);
		expect(searchPets(pets, "creature ana").map(p => p.slug)).toEqual(["boba", "mochi"].slice(0, 1));
	});
});
