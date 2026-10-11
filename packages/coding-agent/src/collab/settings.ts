/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_RELAY_URL } from "./protocol";

// Collab
export const cfgCollabRelayUrl = register({
	id: "collab.relayUrl",
	type: "string",
	default: DEFAULT_RELAY_URL,
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Relay URL",
		description: "Relay used by /collab (wss://host[:port])",
	},
});

export const cfgCollabLocalRelayUrl = register({
	id: "collab.localRelayUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Local Relay URL",
		description:
			"Also serve each /collab room on a relay on this computer (ws://127.0.0.1:<port>) so the web app here connects over loopback; guests elsewhere keep using collab.relayUrl. Empty = off",
	},
});

export const cfgCollabWebUrl = register({
	id: "collab.webUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Web UI URL",
		description:
			"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
	},
});

export const cfgCollabDisplayName = register({
	id: "collab.displayName",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Display Name",
		description: "Name shown to other collab participants (default: OS username)",
	},
});

export const cfgCollabAutoStart = register({
	id: "collab.autoStart",
	type: "enum",
	values: ["off", "view", "control"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Auto Start",
		description:
			"Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch",
		options: [
			{ value: "off", label: "Off", description: "Share only when /collab is run" },
			{
				value: "view",
				label: "View",
				description: "Auto-host; the registry hands out view-only links (omp collab link --view)",
			},
			{
				value: "control",
				label: "Control",
				description: "Auto-host; the registry hands out control links that can prompt the session",
			},
		],
	},
});

export const cfgCollabGuestsCanSaveApprovals = register({
	id: "collab.guestsCanSaveApprovals",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Guests Can Save Approvals",
		description:
			"Let collab guests with control access pick 'Always allow (this project)' or 'Deny always' on a tool approval prompt, which saves a project rule in the user's agent directory. Off: a guest's project choice approves or denies that one call and saves nothing. Session-scoped choices are always honored",
	},
});
