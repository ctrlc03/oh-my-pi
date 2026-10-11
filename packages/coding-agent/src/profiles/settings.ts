/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Agent profiles. Definitions live in `profiles.<name>`; each entry is parsed by `profiles/definition.ts`.
export const cfgProfiles = register({
	id: "profiles",
	type: "record",
	default: {},
});

export const cfgProfileDefault = register({
	id: "profile.default",
	type: "string",
	default: undefined,
	ui: {
		tab: "interaction",
		group: "Profiles",
		label: "Default Profile",
		description:
			"Agent profile a session starts in when it has not switched yet (/profile). Empty starts in the built-in build profile, which changes nothing.",
	},
});
