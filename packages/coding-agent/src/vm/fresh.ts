/**
 * Rules for fresh VMs (docs/vm-sessions.md, "Fresh VMs"): when a template may be cloned and when the supervisor
 * deletes a fresh VM. Pure, so the CLI and the supervisor share them and tests need no VM.
 */
import type { VmDriverState } from "./driver";
import { VM_MAX_FRESH, VM_NAME_PATTERN, type VmRecord } from "./types";

/** A failed fresh VM nobody is working on is deleted after this long. */
export const FAILED_FRESH_GRACE_MS = 10 * 60_000;

export interface CloneRequest {
	template: VmRecord;
	/** The template's driver state. */
	templateState: VmDriverState;
	/** The name asked for. */
	name: string;
	/** Every VM that exists now. */
	existing: readonly VmRecord[];
}

/** Why `request` cannot be cloned, or undefined when it can. */
export function cloneRefusal({ template, templateState, name, existing }: CloneRequest): string | undefined {
	if (!template.template) return `${template.name} is not a template (omp vm create ${template.name} --template …)`;
	if (template.phase !== "ready") return `template ${template.name} is ${template.phase}; reset or delete it`;
	if (templateState === "running")
		return `template ${template.name} is running; stop it first (omp vm stop ${template.name})`;
	if (templateState === "absent") return `template ${template.name} has no VM on this computer; reset or delete it`;
	if (!VM_NAME_PATTERN.test(name)) {
		return `invalid VM name "${name}": use a lower-case letter, then up to 30 lower-case letters, digits or dashes`;
	}
	if (existing.some(record => record.name === name)) return `a VM named ${name} already exists`;
	const fresh = existing.filter(record => record.fresh).length;
	if (fresh >= VM_MAX_FRESH) {
		return `${fresh} fresh VMs exist already (at most ${VM_MAX_FRESH}); delete one first`;
	}
	return undefined;
}

export type FreshSweep = "expired" | "failed";

/**
 * Whether the supervisor deletes `record` now: a fresh VM past `fresh.expiresAt` (a clone takes minutes, so a VM
 * still `creating` that long ago lost its CLI job), or a `failed` one whose record was last written (`recordWrittenAt`,
 * when it failed) {@link FAILED_FRESH_GRACE_MS} ago. A VM still `creating` within its lifetime is never swept: a CLI job
 * owns it. Anything not fresh is never swept.
 */
export function freshSweep(record: VmRecord, now: number, recordWrittenAt: number): FreshSweep | undefined {
	if (!record.fresh) return undefined;
	if (now >= record.fresh.expiresAt) return "expired";
	if (record.phase === "failed" && now - recordWrittenAt >= FAILED_FRESH_GRACE_MS) return "failed";
	return undefined;
}
