import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PushSubscriptionJson } from "../src/lib/companion";
import {
	cleanDeviceName,
	consumeInvite,
	DeviceRegistry,
	INVITE_TTL_MS,
	issueInvite,
	parseDevices,
} from "../scripts/companion-devices";

const T0 = 1_700_000_000_000;

describe("invites", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-invites-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("is single use", async () => {
		const { invite } = await issueInvite(dir, T0);
		expect(await consumeInvite(dir, invite, T0 + 1_000)).toBe(true);
		expect(await consumeInvite(dir, invite, T0 + 2_000)).toBe(false);
	});

	// Two devices racing for one code must not both pair.
	it("is spent by exactly one of concurrent claims", async () => {
		const { invite } = await issueInvite(dir, T0);
		const results = await Promise.all([1, 2, 3, 4].map(() => consumeInvite(dir, invite, T0)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it("expires after ten minutes, to the millisecond", async () => {
		const first = await issueInvite(dir, T0);
		expect(first.expiresAt).toBe(T0 + INVITE_TTL_MS);
		expect(INVITE_TTL_MS).toBe(10 * 60_000);
		expect(await consumeInvite(dir, first.invite, T0 + INVITE_TTL_MS)).toBe(false);
		const second = await issueInvite(dir, T0);
		expect(await consumeInvite(dir, second.invite, T0 + INVITE_TTL_MS - 1)).toBe(true);
	});

	it("rejects codes that were never issued or are malformed", async () => {
		await issueInvite(dir, T0);
		expect(await consumeInvite(dir, "A".repeat(22), T0)).toBe(false);
		expect(await consumeInvite(dir, "../../etc/passwd", T0)).toBe(false);
		expect(await consumeInvite(dir, "", T0)).toBe(false);
		expect(await consumeInvite(dir, undefined, T0)).toBe(false);
	});

	// The files are readable by anything running as the user, e.g. a sandboxed omp.
	it("stores only a hash of the invite", async () => {
		const { invite } = await issueInvite(dir, T0);
		for (const name of await fs.readdir(dir)) {
			expect(name).not.toContain(invite);
			expect(await Bun.file(path.join(dir, name)).text()).not.toContain(invite);
		}
	});

	it("drops expired invites when issuing a new one", async () => {
		const old = await issueInvite(dir, T0);
		const fresh = await issueInvite(dir, T0 + INVITE_TTL_MS + 1);
		expect(await fs.readdir(dir)).toHaveLength(1);
		expect(await consumeInvite(dir, old.invite, T0)).toBe(false);
		expect(await consumeInvite(dir, fresh.invite, T0 + INVITE_TTL_MS + 2)).toBe(true);
	});

	it("keeps several outstanding invites apart", async () => {
		const a = await issueInvite(dir, T0);
		const b = await issueInvite(dir, T0);
		expect(a.invite).not.toBe(b.invite);
		expect(await consumeInvite(dir, b.invite, T0)).toBe(true);
		expect(await consumeInvite(dir, a.invite, T0)).toBe(true);
	});
});

describe("device registry", () => {
	let now = T0;
	let saves = 0;
	let registry: DeviceRegistry;
	const sub = (endpoint: string): PushSubscriptionJson => ({ endpoint, keys: { p256dh: "k", auth: "a" } });
	beforeEach(() => {
		now = T0;
		saves = 0;
		registry = new DeviceRegistry([], {
			now: () => now,
			save: async () => {
				saves++;
			},
		});
	});

	it("authenticates the credentials it issued, and nothing else", async () => {
		const { device, token } = await registry.enroll("iPhone Safari");
		expect(registry.authenticate({ id: device.id, token })?.id).toBe(device.id);
		expect(registry.authenticate({ id: device.id, token: `${token}x` })).toBeNull();
		expect(registry.authenticate({ id: "nobody", token })).toBeNull();
		expect(registry.authenticate({ id: device.id })).toBeNull();
		expect(registry.authenticate(undefined)).toBeNull();
		// One device's token never opens another device.
		const other = await registry.enroll("Mac Chrome");
		expect(registry.authenticate({ id: other.device.id, token })).toBeNull();
	});

	it("never keeps the token itself", async () => {
		const { device, token } = await registry.enroll("iPad");
		expect(JSON.stringify(registry.records)).not.toContain(token);
		expect(device.tokenHash).not.toBe(token);
		expect(saves).toBe(1);
	});

	it("stops authenticating a device the moment it is revoked, and drops its subscription", async () => {
		const keep = await registry.enroll("Mac");
		const gone = await registry.enroll("Phone");
		await registry.setSubscription(gone.device.id, sub("https://push/gone"), true);
		await registry.setSubscription(keep.device.id, sub("https://push/keep"), true);

		const removed = await registry.revoke(gone.device.id);
		expect(removed?.id).toBe(gone.device.id);
		expect(registry.authenticate({ id: gone.device.id, token: gone.token })).toBeNull();
		expect(registry.authenticate({ id: keep.device.id, token: keep.token })).not.toBeNull();
		expect(registry.subscriptions().map(s => s.endpoint)).toEqual(["https://push/keep"]);
		expect(await registry.revoke(gone.device.id)).toBeNull();
	});

	it("moves a browser's push endpoint to the device that registered it last", async () => {
		const first = await registry.enroll("Phone");
		const second = await registry.enroll("Phone again");
		expect(await registry.setSubscription(first.device.id, sub("https://push/x"), true)).toBe(true);
		// Same device registering again at launch is not news.
		expect(await registry.setSubscription(first.device.id, sub("https://push/x"), true)).toBe(false);
		// Re-paired browser: the old record must not keep notifying it.
		expect(await registry.setSubscription(second.device.id, sub("https://push/x"), true)).toBe(false);
		expect(registry.subscriptions()).toHaveLength(1);
		expect(registry.records.find(d => d.id === first.device.id)?.subscription).toBeUndefined();
		await registry.setSubscription(second.device.id, sub("https://push/x"), false);
		expect(registry.subscriptions()).toHaveLength(0);
	});

	it("forgets an endpoint the push service reported gone, wherever it is", async () => {
		const { device } = await registry.enroll("Phone");
		await registry.setSubscription(device.id, sub("https://push/y"), true);
		await registry.dropEndpoint("https://push/y");
		expect(registry.subscriptions()).toHaveLength(0);
	});

	it("tracks last seen with the injected clock", async () => {
		const { device } = await registry.enroll("Phone");
		now = T0 + 5_000;
		registry.touch(device.id);
		expect(device.lastSeen).toBe(T0 + 5_000);
		expect(device.pairedAt).toBe(T0);
		registry.touch("unknown");
	});

	it("renames, and refuses an unknown device", async () => {
		const { device } = await registry.enroll("Phone");
		await registry.rename(device.id, "  Work phone \u0007 ");
		expect(device.name).toBe("Work phone");
		await expect(registry.rename("nope", "x")).rejects.toThrow("no such device");
	});
});

describe("device records", () => {
	it("cleans names: printable, bounded, never empty", () => {
		expect(cleanDeviceName("  iPhone\u0000 Safari\n")).toBe("iPhone Safari");
		expect(cleanDeviceName("x".repeat(100))).toHaveLength(40);
		expect(cleanDeviceName("")).toBe("Device");
		expect(cleanDeviceName(42)).toBe("Device");
	});

	it("keeps well-formed stored rows and drops the rest", () => {
		const good = { id: "a", name: "Mac", tokenHash: "h", pairedAt: 1, lastSeen: 2 };
		expect(
			parseDevices([good, { ...good, id: 7 }, null, "x", { ...good, subscription: { endpoint: "nope" } }]),
		).toEqual([good, good]);
		expect(parseDevices(undefined)).toEqual([]);
	});
});
