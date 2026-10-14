import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ComputerHandle } from "../../src/lib/computers";
import { chooseHome, hostableComputers, setupBlockedReason } from "../../src/lib/personal";
import { PersonalHarness } from "../../scripts/e2e-personal-harness";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

/**
 * Scenario 12: two computers, two real companions in separate homes. The app owns the rule (the companions do not know of each
 * other): it picks the computer that is set up as home and refuses to set Personal up on another. The first computer's memory is
 * never touched by anything the second one does.
 */
describeE2e("two computers", () => {
	let a: PersonalHarness;
	let b: PersonalHarness;

	beforeAll(async () => {
		a = await PersonalHarness.start();
		b = await PersonalHarness.start();
		await a.setUp("Sam, a baker.");
		await a.waitIdle();
		const guest = await a.openSession();
		await a.turn(guest, "Please remember that my oven runs hot.");
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await Promise.all([a?.stop(), b?.stop()]);
	});

	/** The app's view of a computer: its real client and what that client last heard. */
	const handle = (id: string, harness: PersonalHarness): ComputerHandle => ({
		id,
		name: id,
		client: harness.client,
		snap: harness.client.getSnapshot(),
		error: null,
	});

	const memoryOf = (harness: PersonalHarness): Array<Record<string, unknown>> =>
		harness.memoryRows("SELECT id, content, author_type, trust_tier FROM working_memory ORDER BY id");

	/** Every row of `before` is still there, unchanged (the session itself may add rows when it exits or consolidates). */
	const expectKept = (before: Array<Record<string, unknown>>): void => {
		const now = new Map(memoryOf(a).map(row => [row.id, row]));
		for (const row of before) expect(now.get(row.id)).toEqual(row);
	};

	it(
		"picks the set-up computer as home and refuses to set Personal up on the other",
		async () => {
			const rows = memoryOf(a);
			expect(rows.length).toBeGreaterThan(0);

			const computers = [handle("first", a), handle("second", b)];
			expect(hostableComputers(computers).map(c => c.id)).toEqual(["first", "second"]);
			const statuses = { first: await a.status(), second: await b.status() };
			expect(statuses.first).toMatchObject({ setUp: true, enabled: true });
			expect(statuses.second).toMatchObject({ setUp: false, enabled: false, run: "off" });

			const home = chooseHome(computers, statuses, null);
			expect(home.computer?.id).toBe("first");
			expect(home.duplicates).toEqual([]);
			expect(setupBlockedReason(home, computers[0]!)).toBeNull();
			expect(setupBlockedReason(home, computers[1]!)).toMatch(/Personal already lives on first/);

			// Because the app refuses, the second computer is left alone and the first one does not notice.
			await expect(fs.stat(path.join(b.configDir, "profiles", "personal"))).rejects.toThrow();
			expect(b.personalHost()).toBeUndefined();
			await a.waitIdle();
			expectKept(rows);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"keeps refusing after the first computer is turned off, and its memory is kept",
		async () => {
			const rows = memoryOf(a);
			await a.call({ t: "personal-disable" });
			const computers = [handle("first", a), handle("second", b)];
			const statuses = { first: await a.status(), second: await b.status() };
			expect(statuses.first).toMatchObject({ setUp: true, enabled: false });
			const home = chooseHome(computers, statuses, null);
			expect(home.computer?.id).toBe("first");
			expect(setupBlockedReason(home, computers[1]!)).toMatch(/Turn it off there and keep its memory/);
			expectKept(rows);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"warns, and still uses the first, when a stale app set up both",
		async () => {
			await a.call({ t: "personal-enable" });
			await a.waitIdle();
			const rows = memoryOf(a);
			// Nothing in the companion stops this; the app's rule is what normally prevents it.
			await b.setUp("Not Sam.");
			await b.waitIdle();
			const computers = [handle("first", a), handle("second", b)];
			const statuses = { first: await a.status(), second: await b.status() };
			const home = chooseHome(computers, statuses, null);
			expect(home.computer?.id).toBe("first");
			expect(home.duplicates.map(c => c.id)).toEqual(["second"]);
			// Separate homes: the second one's agent has its own memory and the first one's did not change.
			expectKept(rows);
			expect((await b.call({ t: "personal-about-get" })).about.text).toContain("Not Sam.");
			expect((await a.call({ t: "personal-about-get" })).about.text).toContain("Sam, a baker.");
		},
		SCENARIO_TIMEOUT_MS,
	);
});
