import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	awakeCommands,
	awakeTool,
	caffeinateCommand,
	inhibitCommand,
	parsePmsetBatt,
	parsePowerSupplies,
	powerNotice,
	readPowerSupplies,
} from "../scripts/companion-power";
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

describe("keep awake commands", () => {
	it("holds a systemd sleep and idle inhibitor until the companion's pid exits", () => {
		expect(inhibitCommand(4242)).toEqual([
			"systemd-inhibit",
			"--what=sleep:idle",
			"--who=omp collab companion",
			"--why=Keeps omp sessions reachable from the app",
			"--mode=block",
			"tail",
			"--pid=4242",
			"-f",
			"/dev/null",
		]);
	});

	it("keeps the macOS caffeinate command", () => {
		expect(caffeinateCommand(4242)).toEqual(["caffeinate", "-i", "-s", "-w", "4242"]);
	});

	it("tries a sleep and idle inhibitor first and an idle-only one after it is refused", () => {
		const linux = awakeCommands(7, "linux");
		expect(linux.map(command => command[1])).toEqual(["--what=sleep:idle", "--what=idle"]);
		expect(linux[1]).toEqual(inhibitCommand(7, "idle"));
		expect(awakeCommands(7, "darwin")).toEqual([caffeinateCommand(7)]);
		expect(awakeCommands(7, "win32")).toEqual([]);
	});

	it("names the tool per platform", () => {
		expect(awakeTool("darwin")).toBe("caffeinate");
		expect(awakeTool("linux")).toBe("systemd-inhibit");
		expect(awakeTool("win32")).toBeNull();
	});
});

describe("Linux power supplies", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-power-supply-"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function supply(name: string, files: Record<string, string>): Promise<void> {
		await fs.mkdir(path.join(root, name));
		for (const [file, content] of Object.entries(files))
			await fs.writeFile(path.join(root, name, file), `${content}\n`);
	}

	it("reads a laptop on mains: the charge, and AC from the adapter", async () => {
		await supply("BAT0", { type: "Battery", capacity: "87", status: "Charging" });
		await supply("AC", { type: "Mains", online: "1" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "ac", battery: 87 });
	});

	it("reads a laptop on battery", async () => {
		await supply("BAT0", { type: "Battery", capacity: "42", status: "Discharging" });
		await supply("AC", { type: "Mains", online: "0" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "battery", battery: 42 });
	});

	it("falls back on the battery's status when there is no adapter entry", async () => {
		await supply("BAT0", { type: "Battery", capacity: "55", status: "Discharging" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "battery", battery: 55 });
		await fs.writeFile(path.join(root, "BAT0", "status"), "Full\n");
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "ac", battery: 55 });
	});

	it("averages several batteries and ignores a peripheral's battery", async () => {
		await supply("BAT0", { type: "Battery", capacity: "80", status: "Discharging" });
		await supply("BAT1", { type: "Battery", capacity: "41", status: "Discharging" });
		await supply("hidpp_battery_0", { type: "Battery", scope: "Device", capacity: "5", status: "Discharging" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "battery", battery: 61 });
	});

	it("has no power state without a system battery", async () => {
		await supply("AC", { type: "Mains", online: "1" });
		await supply("hidpp_battery_0", { type: "Battery", scope: "Device", capacity: "5", status: "Discharging" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toBeNull();
		expect(parsePowerSupplies(await readPowerSupplies(path.join(root, "missing")))).toBeNull();
	});

	it("tolerates a battery without a readable charge", async () => {
		await supply("BAT0", { type: "Battery", status: "Unknown", capacity: "" });
		expect(parsePowerSupplies(await readPowerSupplies(root))).toEqual({ source: "ac", battery: null });
	});
});
