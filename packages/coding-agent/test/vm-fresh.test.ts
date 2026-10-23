import { describe, expect, test } from "bun:test";
import { cloneRefusal, FAILED_FRESH_GRACE_MS, freshSweep } from "@oh-my-pi/pi-coding-agent/vm/fresh";
import { VM_MAX_FRESH, type VmRecord } from "@oh-my-pi/pi-coding-agent/vm/types";

function record(name: string, extra: Partial<VmRecord> = {}): VmRecord {
	return {
		version: 1,
		name,
		repos: ["acme/api"],
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 20,
		network: "open",
		driver: "lima",
		phase: "ready",
		createdAt: 0,
		...extra,
	};
}

const template = record("base", { template: true });

function fresh(name: string, extra: Partial<VmRecord> = {}): VmRecord {
	return record(name, { fresh: { from: "base", expiresAt: 10_000_000 }, ...extra });
}

describe("clone refusal", () => {
	const ok = { template, templateState: "stopped" as const, name: "base-1", existing: [template] };

	test("a stopped, ready template with a free name can be cloned", () => {
		expect(cloneRefusal(ok)).toBeUndefined();
	});

	test("refuses what is not a template", () => {
		expect(cloneRefusal({ ...ok, template: record("base") })).toMatch(/not a template/);
	});

	test("refuses a template that is not ready", () => {
		expect(cloneRefusal({ ...ok, template: { ...template, phase: "creating" } })).toMatch(/is creating/);
		expect(cloneRefusal({ ...ok, template: { ...template, phase: "failed" } })).toMatch(/is failed/);
	});

	test("refuses a running template and one with no instance", () => {
		expect(cloneRefusal({ ...ok, templateState: "running" })).toMatch(/running; stop it first/);
		expect(cloneRefusal({ ...ok, templateState: "absent" })).toMatch(/no VM on this computer/);
	});

	test("refuses an invalid or taken name", () => {
		expect(cloneRefusal({ ...ok, name: "Base_1" })).toMatch(/invalid VM name/);
		expect(cloneRefusal({ ...ok, name: "base" })).toMatch(/already exists/);
		expect(cloneRefusal({ ...ok, existing: [template, record("base-1")] })).toMatch(/already exists/);
	});

	test(`refuses a ${VM_MAX_FRESH + 1}th fresh VM, counting failed ones, but not shared VMs`, () => {
		const shared = Array.from({ length: 5 }, (_, i) => record(`shared-${i}`));
		const some = Array.from({ length: VM_MAX_FRESH - 1 }, (_, i) => fresh(`f-${i}`));
		expect(cloneRefusal({ ...ok, existing: [template, ...shared, ...some] })).toBeUndefined();
		const full = [...some, fresh("f-last", { phase: "failed" })];
		expect(cloneRefusal({ ...ok, existing: [template, ...full] })).toMatch(
			new RegExp(`${VM_MAX_FRESH} fresh VMs exist already`),
		);
	});
});

describe("fresh VM sweep", () => {
	const now = 5_000_000;

	test("a VM that is not fresh is never swept, whatever its state or age", () => {
		expect(freshSweep(record("a"), now, 0)).toBeUndefined();
		expect(freshSweep(record("a", { phase: "failed" }), now, 0)).toBeUndefined();
		expect(freshSweep(template, now, 0)).toBeUndefined();
	});

	test("a fresh VM is swept once its time is up", () => {
		expect(freshSweep(fresh("a"), now, now)).toBeUndefined();
		const record = fresh("a", { fresh: { from: "base", expiresAt: now } });
		expect(freshSweep(record, now - 1, now)).toBeUndefined();
		expect(freshSweep(record, now, now)).toBe("expired");
	});

	test("a failed fresh VM is swept only after the grace period", () => {
		const failed = fresh("a", { phase: "failed" });
		expect(freshSweep(failed, now, now - FAILED_FRESH_GRACE_MS + 1)).toBeUndefined();
		expect(freshSweep(failed, now, now - FAILED_FRESH_GRACE_MS)).toBe("failed");
	});

	test("a fresh VM being created is left to its job until its time is up", () => {
		const creating = fresh("a", { phase: "creating" });
		expect(freshSweep(creating, now, 0)).toBeUndefined();
		expect(freshSweep({ ...creating, fresh: { from: "base", expiresAt: now - 1 } }, now, 0)).toBe("expired");
	});

	test("a ready fresh VM is not swept for age before its time is up", () => {
		expect(freshSweep(fresh("a"), now, 0)).toBeUndefined();
	});
});
