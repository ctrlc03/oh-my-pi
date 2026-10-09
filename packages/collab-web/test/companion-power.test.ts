import { describe, expect, it } from "bun:test";
import { parsePmsetBatt, powerNotice } from "../scripts/companion-power";
import type { CompanionPower } from "../src/lib/companion";

const LAPTOP_AC =
	"Now drawing from 'AC Power'\n -InternalBattery-0 (id=22675555)\t14%; charging; 5:55 remaining present: true\n";
const LAPTOP_BATTERY =
	"Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22675555)\t100%; discharging; 9:12 remaining present: true\n";
const DESKTOP = "Now drawing from 'AC Power'\n";
const DESKTOP_UPS = "Now drawing from 'UPS Power'\n -Back-UPS ES 700 (id=1234)\t87%; discharging; (no estimate)\n";

const power = (source: CompanionPower["source"], battery: number | null): CompanionPower => ({
	source,
	battery,
	awake: true,
});

describe("parsePmsetBatt", () => {
	it("reads the source and the internal battery's charge", () => {
		expect(parsePmsetBatt(LAPTOP_AC)).toEqual({ source: "ac", battery: 14 });
		expect(parsePmsetBatt(LAPTOP_BATTERY)).toEqual({ source: "battery", battery: 100 });
	});

	it("has no charge without an internal battery, and treats a UPS as stored energy", () => {
		expect(parsePmsetBatt(DESKTOP)).toEqual({ source: "ac", battery: null });
		expect(parsePmsetBatt(DESKTOP_UPS)).toEqual({ source: "battery", battery: null });
	});
});

describe("powerNotice", () => {
	it("warns when unplugged and when plugged in again", () => {
		expect(powerNotice("mac", power("ac", 80), power("battery", 79), false)?.title).toBe("mac is on battery (79%)");
		expect(powerNotice("mac", power("battery", 50), power("ac", 50), false)?.title).toBe(
			"mac is plugged in again (50%)",
		);
	});

	it("warns of a low battery once per discharge", () => {
		expect(powerNotice("mac", power("battery", 21), power("battery", 20), false)?.title).toBe(
			"mac battery low (20%)",
		);
		expect(powerNotice("mac", power("battery", 20), power("battery", 19), true)).toBeNull();
		expect(powerNotice("mac", power("battery", 60), power("battery", 59), false)).toBeNull();
	});

	it("stays quiet while nothing changed on mains power", () => {
		expect(powerNotice("mac", power("ac", 40), power("ac", 41), false)).toBeNull();
	});
});
