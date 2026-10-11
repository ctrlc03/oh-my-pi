/**
 * Keeping the computer reachable: a sleep assertion held for the companion's
 * lifetime, and the power state the app shows and the companion pushes about.
 *
 * macOS: `caffeinate -i -s -w <pid>` stops idle sleep (on battery too) and
 * system sleep on mains power until the companion exits; closing the lid still
 * sleeps the Mac unless it runs in clamshell mode or with `pmset disablesleep`.
 * Linux: `systemd-inhibit --what=sleep:idle` holds a block inhibitor for as long as its child (which waits for
 * the companion's pid) runs, falling back to `--what=idle` where polkit refuses sleep inhibitors to a process
 * outside a login session; the power state comes from `/sys/class/power_supply`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { type CompanionPower, LOW_BATTERY_PCT } from "../src/lib/companion";

const POWER_SUPPLY_DIR = "/sys/class/power_supply";

/** A notification the power state calls for, or null. */
export interface PowerNotice {
	title: string;
	body: string;
}

/** `pmset -g batt`: what the Mac draws from and the internal battery's charge (null on a Mac without one). */
export function parsePmsetBatt(text: string): Pick<CompanionPower, "source" | "battery"> {
	const from = /drawing from '([^']+)'/.exec(text)?.[1];
	const charge = /InternalBattery[^\n]*?(\d{1,3})%/.exec(text)?.[1];
	return {
		// UPS Power is stored energy too: the mains are out.
		source: from === undefined ? null : from === "AC Power" ? "ac" : "battery",
		battery: charge === undefined ? null : Math.min(100, Number(charge)),
	};
}

/** `caffeinate` held until `pid` exits. */
export function caffeinateCommand(pid: number): string[] {
	return ["caffeinate", "-i", "-s", "-w", String(pid)];
}

/**
 * A systemd inhibitor held until `pid` exits (the wrapped `tail` ends with it). `what` is what it blocks: `sleep`
 * needs polkit's authorisation for a login session, so it is refused to a user service without one (a lingering
 * user manager); `idle` is allowed to anyone.
 */
export function inhibitCommand(pid: number, what: string = "sleep:idle"): string[] {
	return [
		"systemd-inhibit",
		`--what=${what}`,
		"--who=omp collab companion",
		"--why=Keeps omp sessions reachable from the app",
		"--mode=block",
		"tail",
		`--pid=${pid}`,
		"-f",
		"/dev/null",
	];
}

/** What each platform runs to stay awake, strongest first; the next one is tried when one is refused at once. */
export function awakeCommands(pid: number, platform: NodeJS.Platform = process.platform): string[][] {
	if (platform === "darwin") return [caffeinateCommand(pid)];
	if (platform === "linux") return [inhibitCommand(pid, "sleep:idle"), inhibitCommand(pid, "idle")];
	return [];
}

/** The tool that keeps this platform awake, or null where there is none. */
export function awakeTool(platform: NodeJS.Platform = process.platform): string | null {
	if (platform === "darwin") return "caffeinate";
	if (platform === "linux") return "systemd-inhibit";
	return null;
}

/** An awake tool that exits this soon was refused, not ended by the companion. */
const REFUSED_WITHIN_MS = 5_000;

/**
 * Holds the computer awake until the companion exits; `held` turns false if the tool is missing or dies, and
 * `onLost` hears why.
 */
export function holdAwake(onLost?: (reason: string) => void): { readonly held: boolean; release(): void } {
	const commands = awakeCommands(process.pid);
	let held = commands.length > 0;
	let released = false;
	let child: Subprocess | null = null;
	const lose = (reason: string) => {
		held = false;
		onLost?.(reason);
	};
	const start = (index: number) => {
		const startedAt = Date.now();
		try {
			const proc = Bun.spawn(commands[index]!, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
			child = proc;
			void proc.exited.then(async code => {
				if (released) return;
				const text = (await new Response(proc.stderr).text()).trim();
				if (index + 1 < commands.length && Date.now() - startedAt < REFUSED_WITHIN_MS) start(index + 1);
				else lose(text || `exit ${code}`);
			});
		} catch (err) {
			lose(err instanceof Error ? err.message : String(err));
		}
	};
	if (held) start(0);
	return {
		get held() {
			return held;
		},
		release() {
			released = true;
			child?.kill();
		},
	};
}

/** One entry of `/sys/class/power_supply`: the files the power state reads, null when absent. */
export interface PowerSupply {
	type: string | null;
	/** `Device` for a peripheral's battery (mouse, headset); absent or `System` otherwise. */
	scope: string | null;
	capacity: number | null;
	status: string | null;
	online: boolean | null;
}

/**
 * What the machine draws from and its battery's charge, from sysfs power supplies. Null without a system battery
 * (a desktop, a VM, a container). On mains, any `Mains`/`USB` supply online counts; with no such supply, the
 * battery's own status decides.
 */
export function parsePowerSupplies(supplies: PowerSupply[]): Pick<CompanionPower, "source" | "battery"> | null {
	const batteries = supplies.filter(s => s.type === "Battery" && s.scope !== "Device");
	if (batteries.length === 0) return null;
	const charges = batteries.map(b => b.capacity).filter((c): c is number => c !== null);
	const battery =
		charges.length === 0 ? null : Math.min(100, Math.round(charges.reduce((a, b) => a + b, 0) / charges.length));
	const adapters = supplies.filter(s => s.type !== null && s.type !== "Battery" && s.online !== null);
	const source =
		adapters.length > 0
			? adapters.some(a => a.online === true)
				? "ac"
				: "battery"
			: batteries.some(b => b.status === "Discharging")
				? "battery"
				: "ac";
	return { source, battery };
}

async function readSysfs(dir: string, file: string): Promise<string | null> {
	try {
		return (await fs.readFile(path.join(dir, file), "utf8")).trim();
	} catch {
		return null;
	}
}

/** Read every power supply under `root` (default `/sys/class/power_supply`). */
export async function readPowerSupplies(root: string = POWER_SUPPLY_DIR): Promise<PowerSupply[]> {
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch {
		return [];
	}
	return await Promise.all(
		names.map(async name => {
			const dir = path.join(root, name);
			const [type, scope, capacity, status, online] = await Promise.all(
				["type", "scope", "capacity", "status", "online"].map(file => readSysfs(dir, file)),
			);
			const charge = capacity === null || capacity === "" ? Number.NaN : Number(capacity);
			return {
				type,
				scope,
				capacity: Number.isFinite(charge) ? charge : null,
				status,
				online: online === null ? null : online === "1",
			};
		}),
	);
}

/** Current power state, or null where there is nothing to read (not macOS or Linux, or Linux without a battery). */
export async function readPower(awake: boolean, supplyRoot?: string): Promise<CompanionPower | null> {
	if (process.platform === "linux") {
		const parsed = parsePowerSupplies(await readPowerSupplies(supplyRoot));
		return parsed === null ? null : { ...parsed, awake };
	}
	if (process.platform !== "darwin") return null;
	try {
		const proc = Bun.spawn(["pmset", "-g", "batt"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return null;
		return { ...parsePmsetBatt(text), awake };
	} catch {
		return null;
	}
}

/**
 * What to tell devices about a change from `prev` to `next`: unplugged, low
 * battery (once per discharge: `lowWarned` says it was sent), back on power.
 */
export function powerNotice(
	machine: string,
	prev: CompanionPower,
	next: CompanionPower,
	lowWarned: boolean,
): PowerNotice | null {
	const charge = next.battery === null ? "" : ` (${next.battery}%)`;
	if (next.source === "battery" && prev.source === "ac") {
		return {
			title: `${machine} is on battery${charge}`,
			body: "It sleeps when the battery runs out and your sessions go offline. Plug it in to keep them reachable.",
		};
	}
	if (next.source === "battery" && !lowWarned && next.battery !== null && next.battery <= LOW_BATTERY_PCT) {
		return {
			title: `${machine} battery low${charge}`,
			body: "Your sessions go offline when it sleeps. Plug it in soon.",
		};
	}
	if (next.source === "ac" && prev.source === "battery") {
		return { title: `${machine} is plugged in again${charge}`, body: "Your sessions stay reachable." };
	}
	return null;
}
