/**
 * Keeping the computer reachable: a sleep assertion held for the companion's
 * lifetime, and the power state the app shows and the companion pushes about.
 *
 * macOS only. `caffeinate -i -s -w <pid>` stops idle sleep (on battery too) and
 * system sleep on mains power until the companion exits; closing the lid still
 * sleeps the Mac unless it runs in clamshell mode or with `pmset disablesleep`.
 */

import { type CompanionPower, LOW_BATTERY_PCT } from "../src/lib/companion";

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

/** Holds the Mac awake until the companion exits; `held` turns false if `caffeinate` is missing or dies. */
export function holdAwake(): { readonly held: boolean; release(): void } {
	if (process.platform !== "darwin") return { held: false, release() {} };
	let held = true;
	let child: ReturnType<typeof Bun.spawn> | null = null;
	try {
		child = Bun.spawn(["caffeinate", "-i", "-s", "-w", String(process.pid)], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		void child.exited.then(() => {
			held = false;
		});
	} catch {
		held = false;
	}
	return {
		get held() {
			return held;
		},
		release() {
			child?.kill();
		},
	};
}

/** Current power state, or null where `pmset` is unavailable (not macOS). */
export async function readPower(awake: boolean): Promise<CompanionPower | null> {
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
