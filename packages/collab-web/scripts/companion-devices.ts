/**
 * Paired devices of the companion. The room link (and its key) only gets a
 * device into the room; to be served it must also authenticate, either with the
 * credentials it was issued when it paired or with a one-time invite.
 *
 * Invites are random, single use, expire after {@link INVITE_TTL_MS}, and are
 * stored hashed, one file per invite in a directory: `--pair` runs as a separate
 * process while the companion serves, so they must not share a rewritten file,
 * and renaming the file away is the atomic claim that makes an invite single use.
 * Device tokens are random and stored as sha256 hashes in the companion state.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PushSubscriptionJson } from "../src/lib/companion";
import { encodeBase64Url } from "../src/lib/link";
import { isPushSubscription } from "./web-push";

export const INVITE_TTL_MS = 10 * 60_000;
const INVITE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_NAME_LENGTH = 40;
const MAX_TOKEN_LENGTH = 128;

/** A paired device as stored in the companion state; `tokenHash` is sha256 of its token, base64url. */
export interface DeviceRecord {
	id: string;
	name: string;
	tokenHash: string;
	pairedAt: number;
	lastSeen: number;
	/** Web Push subscription of this device; dropped with the device on revoke. */
	subscription?: PushSubscriptionJson;
}

function hashSecret(secret: string): string {
	return encodeBase64Url(createHash("sha256").update(secret).digest());
}

function newSecret(bytes: number): string {
	return encodeBase64Url(randomBytes(bytes));
}

/** A device-chosen name, made safe to list: printable characters only, bounded, never empty. */
export function cleanDeviceName(name: unknown): string {
	if (typeof name !== "string") return "Device";
	const printable = [...name].filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("");
	return printable.trim().slice(0, MAX_NAME_LENGTH) || "Device";
}

/** Device records out of the state file, dropping rows that are malformed. */
export function parseDevices(raw: unknown): DeviceRecord[] {
	if (!Array.isArray(raw)) return [];
	const devices: DeviceRecord[] = [];
	for (const row of raw as Partial<DeviceRecord>[]) {
		if (
			typeof row?.id !== "string" ||
			typeof row.name !== "string" ||
			typeof row.tokenHash !== "string" ||
			typeof row.pairedAt !== "number" ||
			typeof row.lastSeen !== "number"
		)
			continue;
		const device: DeviceRecord = {
			id: row.id,
			name: row.name,
			tokenHash: row.tokenHash,
			pairedAt: row.pairedAt,
			lastSeen: row.lastSeen,
		};
		if (isPushSubscription(row.subscription)) device.subscription = row.subscription;
		devices.push(device);
	}
	return devices;
}

async function readExpiry(file: string): Promise<number | null> {
	try {
		const parsed = JSON.parse(await Bun.file(file).text()) as { expiresAt?: unknown };
		return typeof parsed.expiresAt === "number" ? parsed.expiresAt : null;
	} catch {
		return null;
	}
}

/** Create an invite (its hash is all that is stored) and drop expired ones. */
export async function issueInvite(dir: string, now: number): Promise<{ invite: string; expiresAt: number }> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	for (const name of await fs.readdir(dir)) {
		const file = path.join(dir, name);
		const expiresAt = name.endsWith(".json") ? await readExpiry(file) : null;
		if (expiresAt === null || expiresAt <= now) await fs.rm(file, { force: true });
	}
	const invite = newSecret(16);
	const expiresAt = now + INVITE_TTL_MS;
	await fs.writeFile(path.join(dir, `${hashSecret(invite)}.json`), JSON.stringify({ expiresAt }), { mode: 0o600 });
	return { invite, expiresAt };
}

/** Whether `invite` was issued, has not expired, and was not used before; a valid one is spent by this call. */
export async function consumeInvite(dir: string, invite: unknown, now: number): Promise<boolean> {
	if (typeof invite !== "string" || !INVITE_RE.test(invite)) return false;
	const file = path.join(dir, `${hashSecret(invite)}.json`);
	const expiresAt = await readExpiry(file);
	if (expiresAt === null) return false;
	const claimed = `${file}.${newSecret(6)}.claimed`;
	try {
		// Of concurrent claims exactly one rename succeeds (concurrent unlinks do not reliably fail under Bun).
		await fs.rename(file, claimed);
	} catch {
		return false;
	}
	await fs.rm(claimed, { force: true });
	return expiresAt > now;
}

export interface DeviceRegistryOptions {
	now(): number;
	/** Persist the companion state, which holds {@link DeviceRegistry.records}. */
	save(): Promise<void>;
}

/** The paired devices; `records` is the array the companion state persists, mutated in place. */
export class DeviceRegistry {
	readonly records: DeviceRecord[];
	readonly #opts: DeviceRegistryOptions;

	constructor(records: DeviceRecord[], opts: DeviceRegistryOptions) {
		this.records = records;
		this.#opts = opts;
	}

	/** Add a device and issue its token, which is not stored anywhere but the device. */
	async enroll(name: unknown): Promise<{ device: DeviceRecord; token: string }> {
		const token = newSecret(32);
		const now = this.#opts.now();
		const device: DeviceRecord = {
			id: newSecret(9),
			name: cleanDeviceName(name),
			tokenHash: hashSecret(token),
			pairedAt: now,
			lastSeen: now,
		};
		this.records.push(device);
		await this.#opts.save();
		return { device, token };
	}

	/** The device the credentials belong to, or null. */
	authenticate(creds: unknown): DeviceRecord | null {
		const { id, token } = (creds ?? {}) as { id?: unknown; token?: unknown };
		if (typeof id !== "string" || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
		const device = this.records.find(d => d.id === id);
		if (!device) return null;
		const given = Buffer.from(hashSecret(token));
		const stored = Buffer.from(device.tokenHash);
		return given.length === stored.length && timingSafeEqual(given, stored) ? device : null;
	}

	/** Note activity in memory; persisted with the next save. */
	touch(id: string): void {
		const device = this.records.find(d => d.id === id);
		if (device) device.lastSeen = this.#opts.now();
	}

	async rename(id: string, name: unknown): Promise<void> {
		const device = this.records.find(d => d.id === id);
		if (!device) throw new Error("no such device");
		device.name = cleanDeviceName(name);
		await this.#opts.save();
	}

	/** Remove a device with its push subscription; null when there is no such device. */
	async revoke(id: string): Promise<DeviceRecord | null> {
		const at = this.records.findIndex(d => d.id === id);
		if (at < 0) return null;
		const [removed] = this.records.splice(at, 1);
		await this.#opts.save();
		return removed ?? null;
	}

	/** Every push subscription of every device. */
	subscriptions(): PushSubscriptionJson[] {
		return this.records.flatMap(d => (d.subscription ? [d.subscription] : []));
	}

	/**
	 * Set (or with null clear) a device's subscription. One browser endpoint belongs to one device:
	 * re-pairing a browser must not leave the old record notifying it.
	 * Resolves true when the endpoint was not registered before.
	 */
	async setSubscription(id: string, subscription: PushSubscriptionJson, on: boolean): Promise<boolean> {
		const device = this.records.find(d => d.id === id);
		if (!device) throw new Error("no such device");
		const known = this.records.some(d => d.subscription?.endpoint === subscription.endpoint);
		for (const other of this.records) {
			if (other.subscription?.endpoint === subscription.endpoint) delete other.subscription;
		}
		if (on) device.subscription = subscription;
		await this.#opts.save();
		return on && !known;
	}

	/** Forget a subscription the push service reported gone, wherever it is registered. */
	async dropEndpoint(endpoint: string): Promise<void> {
		let changed = false;
		for (const device of this.records) {
			if (device.subscription?.endpoint !== endpoint) continue;
			delete device.subscription;
			changed = true;
		}
		if (changed) await this.#opts.save();
	}
}
