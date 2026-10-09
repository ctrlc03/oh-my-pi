import { describe, expect, it } from "bun:test";
import { collectDiag, recordRelayEvent, recordRequestError } from "../scripts/companion-diag";
import { restartCompanion, updateOmp } from "../scripts/companion-maintain";
import { getEvents, mergeEvents, recordEvent } from "../src/lib/diag-log";

describe("app event log", () => {
	it("keeps the newest 50 events", () => {
		for (let i = 0; i < 60; i++) recordEvent("session", "closed", `n${i}`);
		const events = getEvents();
		expect(events).toHaveLength(50);
		expect(events[0]?.detail).toBe("n10");
		expect(events[49]?.detail).toBe("n59");
	});

	it("merges the computer's events onto this device's clock, newest first", () => {
		const app = [
			{ at: 1_000, source: "companion" as const, kind: "connected" as const },
			{ at: 5_000, source: "session" as const, kind: "closed" as const, detail: "x" },
		];
		// The computer's clock runs 10s behind this device's.
		const merged = mergeEvents(app, [{ at: -8_000, kind: "close", detail: "boom" }], 10_000);
		expect(merged.map(e => [e.source, e.at])).toEqual([
			["session", 5_000],
			["computer", 2_000],
			["companion", 1_000],
		]);
		expect(merged[1]).toMatchObject({ kind: "closed", detail: "boom" });
	});
});

describe("companion diagnostics", () => {
	it("keeps the last 20 relay events and the last 10 request errors, with bounded messages", async () => {
		for (let i = 0; i < 25; i++) recordRelayEvent("open", `e${i}`);
		for (let i = 0; i < 12; i++) recordRequestError("git", `${i}:${"x".repeat(500)}`);
		const diag = await collectDiag({
			ompBin: "/nonexistent/omp",
			devices: 2,
			keepAwake: true,
			power: null,
			listing: { method: "cli", lastMs: 12 },
		});
		expect(diag.events.map(e => e.detail)).toEqual(Array.from({ length: 20 }, (_, i) => `e${i + 5}`));
		expect(diag.errors).toHaveLength(10);
		expect(diag.errors[0]?.message.startsWith("2:")).toBe(true);
		expect(diag.errors[0]?.message.length).toBe(200);
		expect(diag.omp).toBeNull();
		expect(diag.devices).toBe(2);
	});
});

describe("maintenance", () => {
	it("refuses to update omp while a session works", async () => {
		await expect(updateOmp("/nonexistent/omp", [{ busy: false }, { busy: true }, { busy: null }])).rejects.toThrow(
			"1 session is working",
		);
	});

	it("refuses to restart a companion launchd does not run", () => {
		expect(() => restartCompanion()).toThrow("started by hand");
	});
});
