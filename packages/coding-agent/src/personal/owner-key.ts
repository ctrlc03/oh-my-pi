/**
 * The owner key: the secret the companion signs owner-trust events with (`PersonalEvent.mac`), kept in
 * `<agentDir>/collab-companion-personal-owner.key`. The `collab-companion` prefix keeps the file out of reach of
 * the shell sandbox (`sandbox/policy.ts`), so nothing the agent runs can read it and forge an owner event.
 *
 * The HMAC key is the file's text, trimmed, as UTF-8 (the companion writes 32 random bytes as base64url and
 * does not decode them again). `mac` = hex of HMAC-SHA256 over `personalEventCanonical(event)`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { PERSONAL_OWNER_KEY_FILE, type PersonalEvent, personalEventCanonical } from "@oh-my-pi/pi-wire/personal-ipc";

export function ownerKeyFile(agentDir: string): string {
	return path.join(agentDir, PERSONAL_OWNER_KEY_FILE);
}

/** The owner key, or undefined when there is none (no companion has set the profile up). */
export async function readOwnerKey(agentDir: string): Promise<string | undefined> {
	try {
		const key = (await Bun.file(ownerKeyFile(agentDir)).text()).trim();
		return key === "" ? undefined : key;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Hex HMAC-SHA256 of the event's canonical form: what the companion puts in `mac`. */
export function signPersonalEvent(key: string, event: PersonalEvent): string {
	return createHmac("sha256", key).update(personalEventCanonical(event)).digest("hex");
}

/** Whether `event.mac` is the right signature under `key` (constant-time; a missing or malformed mac is false). */
export function verifyPersonalEvent(key: string, event: PersonalEvent): boolean {
	if (typeof event.mac !== "string" || !/^[0-9a-f]{64}$/.test(event.mac)) return false;
	const expected = Buffer.from(signPersonalEvent(key, event), "hex");
	const given = Buffer.from(event.mac, "hex");
	return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The trust the session gives an event: `owner` only for an owner-trust event with a valid mac. A bad or
 * missing mac, or no key to check it with, downgrades to `external`; nothing upgrades.
 */
export function effectiveTrust(event: PersonalEvent, key: string | undefined): "owner" | "external" {
	if (event.trust !== "owner") return "external";
	return key !== undefined && verifyPersonalEvent(key, event) ? "owner" : "external";
}
