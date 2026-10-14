/**
 * Where the session organisation documents (pin / snooze / settle) are kept on this device. Each computer keeps
 * its own document and syncs it with its own companion, so there is one per computer; sessions with no computer
 * (a room joined from a link no paired computer lists) share the device's own.
 */

import { type OrgDoc, parseOrg } from "./session-org";
import { readJson, writeJson } from "./storage";

const ORG_KEY = "omp.collab.session-org";

/** The owner of rooms no computer lists. */
export const DEVICE_ORG = "device";

/** `owner` is a computer id or {@link DEVICE_ORG}. */
function orgKey(owner: string): string {
	return owner === DEVICE_ORG ? ORG_KEY : `${ORG_KEY}.${owner}`;
}

export function loadOrg(owner: string): OrgDoc {
	return parseOrg(readJson(orgKey(owner)));
}

export function saveOrg(owner: string, doc: OrgDoc): void {
	writeJson(orgKey(owner), doc);
}

/** The document kept before there were several computers was the one computer's. */
export function claimLegacyOrg(computerId: string): void {
	const legacy = readJson(ORG_KEY);
	if (legacy === null) return;
	if (readJson(orgKey(computerId)) === null) writeJson(orgKey(computerId), legacy);
	writeJson(ORG_KEY, null);
}

/** A removed computer's document goes with it. */
export function dropOrg(computerId: string): void {
	writeJson(orgKey(computerId), null);
}
