/**
 * What the diagnostics screen shows about the companion: its version, how
 * long it has run, and rings of recent relay events and request errors.
 */

import * as path from "node:path";
import type { CompanionDiag, CompanionPower, CompanionRelayEvent, CompanionRequestError } from "../src/lib/companion";
import { git } from "./companion-git";
import { isLaunchManaged } from "./companion-launchd";
import { ompVersion } from "./companion-maintain";

const MAX_EVENTS = 20;
const MAX_ERRORS = 10;
const MAX_MESSAGE_CHARS = 200;

const startedAt = Date.now();
const relayEvents: CompanionRelayEvent[] = [];
const requestErrors: CompanionRequestError[] = [];

/** Append to a ring: the oldest entry goes once `max` are held. */
function push<T>(ring: T[], entry: T, max: number): void {
	ring.push(entry);
	if (ring.length > max) ring.shift();
}

/** The companion's relay connection opened or closed. */
export function recordRelayEvent(kind: CompanionRelayEvent["kind"], detail: string): void {
	push(relayEvents, { at: Date.now(), kind, detail }, MAX_EVENTS);
}

/** A request failed: its type and the error text the app received. */
export function recordRequestError(type: string, message: string): void {
	push(requestErrors, { at: Date.now(), type, message: message.slice(0, MAX_MESSAGE_CHARS) }, MAX_ERRORS);
}

/** The checkout this script runs from, read once at startup: that is the code the process loaded. */
const checkout: Promise<{ version: string | null; dirty: boolean }> = (async () => {
	const cwd = path.dirname(import.meta.dir);
	try {
		const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
		if (head.code !== 0) return { version: null, dirty: false };
		const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no", "--", "."]);
		return { version: new TextDecoder().decode(head.out).trim(), dirty: status.code === 0 && status.out.length > 0 };
	} catch {
		return { version: null, dirty: false };
	}
})();

export interface DiagInput {
	ompBin: string;
	/** Devices connected to the room. */
	devices: number;
	keepAwake: boolean;
	power: CompanionPower | null;
	listing: CompanionDiag["listing"];
}

export async function collectDiag(input: DiagInput): Promise<CompanionDiag> {
	const [{ version, dirty }, omp] = await Promise.all([checkout, ompVersion(input.ompBin)]);
	const now = Date.now();
	return {
		now,
		version,
		dirty,
		omp,
		startedAt,
		uptimeMs: now - startedAt,
		listing: input.listing,
		keepAwake: input.keepAwake,
		power: input.power,
		managed: isLaunchManaged() ? "launchd" : "manual",
		devices: input.devices,
		events: [...relayEvents],
		errors: [...requestErrors],
	};
}
