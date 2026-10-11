/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgScheduleEnabled = register({
	id: "schedule.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Schedule",
		description:
			"Let the agent create, list, and delete scheduled runs through the collab companion on this computer (every creation asks first). Needs the companion running",
	},
});
