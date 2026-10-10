import type { RewindFilesPlan } from "@oh-my-pi/pi-wire";

/** "3 files (2 reverted, 1 removed)": how many files a restore touches. */
export function describeFilePlan(plan: RewindFilesPlan): string {
	const total = plan.revert + plan.remove + plan.recreate;
	const parts = [
		plan.revert > 0 ? `${plan.revert} reverted` : undefined,
		plan.remove > 0 ? `${plan.remove} removed` : undefined,
		plan.recreate > 0 ? `${plan.recreate} recreated` : undefined,
	].filter(part => part !== undefined);
	return `${total} ${total === 1 ? "file" : "files"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}
