/**
 * Which screen of Settings → Personal agent to open on, so a notification tap, a deep link (`#personal/memory`) and the
 * sidebar entry can land on a tab. Read once when the screen mounts: Settings re-mounts its content on every open request.
 */

import type { PersonalRoute } from "./personal";
import { openSettings } from "./settings-ui";

export type PersonalTab = "agent" | "memory" | "about" | "activity" | "settings";

export const PERSONAL_TABS: Record<PersonalTab, string> = {
	agent: "Agent",
	memory: "Memory",
	about: "About you",
	activity: "Activity",
	settings: "Settings",
};

/** The tabs, in the order they are listed. */
export const PERSONAL_TAB_ORDER = Object.keys(PERSONAL_TABS) as readonly PersonalTab[];

/** Where each route that is not the thread or the inbox opens. */
export const ROUTE_TABS: Partial<Record<PersonalRoute, PersonalTab>> = {
	memory: "memory",
	about: "about",
	settings: "settings",
};

let requested: PersonalTab | null = null;

/** Open Settings on Personal agent, on `tab`. */
export function openPersonalSettings(tab: PersonalTab = "agent"): void {
	requested = tab;
	openSettings("personal");
}

/** The tab asked for by the last {@link openPersonalSettings}, once; null when Settings was opened another way. */
export function takeRequestedTab(): PersonalTab | null {
	const tab = requested;
	requested = null;
	return tab;
}
