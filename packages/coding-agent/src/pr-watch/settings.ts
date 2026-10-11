/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgPrWatchEnabled = register({
	id: "prWatch.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "PR Watch",
		description:
			"Offer the watch_pr tool and /watch-pr: watch a pull request and wake the session when its required checks fail, someone reviews or comments, or a conflict appears. Nothing is watched until asked",
	},
});

export const cfgPrWatchMaxWakesPerHour = register({
	id: "prWatch.maxWakesPerHour",
	type: "number",
	default: 3,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "PR Watch Wakes per Hour",
		description:
			"Most times one watched pull request may start an agent turn in an hour; events past it wait for the hour to pass (0 never wakes: you are only notified)",
		options: [
			{ value: "0", label: "Never wake", description: "Notify only" },
			{ value: "1", label: "1 per hour" },
			{ value: "3", label: "3 per hour", description: "Default" },
			{ value: "6", label: "6 per hour" },
			{ value: "12", label: "12 per hour" },
		],
	},
});

export const cfgPrWatchPollSeconds = register({
	id: "prWatch.pollSeconds",
	type: "number",
	default: 120,
	ui: {
		tab: "tools",
		group: "GitHub",
		label: "PR Watch Poll Interval",
		description:
			"Seconds between checks of a watched pull request while its checks run; twice that once they have settled. The collab companion polls instead while it runs",
		options: [
			{ value: "30", label: "30 seconds" },
			{ value: "60", label: "1 minute" },
			{ value: "120", label: "2 minutes", description: "Default" },
			{ value: "300", label: "5 minutes" },
		],
	},
});
