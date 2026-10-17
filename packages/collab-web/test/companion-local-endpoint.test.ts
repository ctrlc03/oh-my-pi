import { describe, expect, it } from "bun:test";
import { type LocalEndpoint, waitForRunningEndpoint } from "../scripts/companion-local-endpoint";

const ENDPOINT: LocalEndpoint = { pid: 1, port: 7467, app: true };

describe("waiting for a companion that is starting to publish its address", () => {
	it("returns it as soon as it appears", async () => {
		let calls = 0;
		const found = await waitForRunningEndpoint("file", {
			pollMs: 1,
			timeoutMs: 5_000,
			find: async () => (++calls < 4 ? null : ENDPOINT),
		});
		expect(found).toEqual(ENDPOINT);
		expect(calls).toBe(4);
	});

	it("gives up after the timeout, having looked at least once", async () => {
		let calls = 0;
		const found = await waitForRunningEndpoint("file", {
			pollMs: 1,
			// Real time passes here: the deadline is the wall clock's.
			timeoutMs: 20,
			find: async () => {
				calls++;
				return null;
			},
		});
		expect(found).toBeNull();
		expect(calls).toBeGreaterThan(0);
		expect(await waitForRunningEndpoint("file", { timeoutMs: 0, find: async () => ENDPOINT })).toEqual(ENDPOINT);
	});
});
