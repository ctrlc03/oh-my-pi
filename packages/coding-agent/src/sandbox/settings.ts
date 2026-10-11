/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import type { Settings } from "../config/settings";
import { type AnySetting, register } from "../config/registry";

export const SANDBOX_MODES = ["off", "read-only", "workspace-write"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const SANDBOX_NETWORK_VALUES = ["on", "off"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORK_VALUES)[number];

/** YAML 1.1 readers turn a bare `on`/`off` into a boolean; accept that spelling too. */
function normalizeOnOff(value: unknown): unknown {
	if (value === true) return "on";
	if (value === false) return "off";
	return value;
}

export const cfgSandboxMode = register({
	id: "sandbox.mode",
	type: "enum",
	values: SANDBOX_MODES,
	default: "off",
	normalize: normalizeOnOff,
	ui: {
		tab: "interaction",
		group: "Sandbox",
		label: "Shell Sandbox",
		description:
			"OS-level sandbox for shell commands (bash, services, ! commands, verify). macOS uses Seatbelt, Linux uses bubblewrap. Change per session with /sandbox.",
		options: [
			{ value: "off", label: "Off", description: "No sandbox (default)." },
			{
				value: "read-only",
				label: "Read-only",
				description: "Commands read the filesystem (secrets excluded) but write only to temp directories.",
			},
			{
				value: "workspace-write",
				label: "Workspace write",
				description:
					"Commands also write the project, extra workspace roots, and common tool caches; nothing else.",
			},
		],
	},
});

export const cfgSandboxNetwork = register({
	id: "sandbox.network",
	type: "enum",
	values: SANDBOX_NETWORK_VALUES,
	default: "off",
	normalize: normalizeOnOff,
	ui: {
		tab: "interaction",
		group: "Sandbox",
		label: "Sandbox Network",
		description:
			"Whether sandboxed commands may use the network (loopback included). Applies when sandbox.mode is on.",
		options: [
			{ value: "off", label: "Off", description: "Block all network access from sandboxed commands (default)." },
			{ value: "on", label: "On", description: "Allow network access." },
		],
	},
});

export const cfgSandboxFailOpen = register({
	id: "sandbox.failOpen",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Sandbox",
		label: "Sandbox Fail Open",
		description:
			"Run commands unsandboxed, with a notice, when the sandbox cannot start (no sandbox-exec or bwrap). Off refuses the command instead.",
	},
});

export const cfgSandboxAutoEscalate = register({
	id: "sandbox.autoEscalate",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Sandbox",
		label: "Sandbox Auto-Escalate",
		description:
			"Let the model's escalation requests (bash `escalate`) run without the approval prompt. Off prompts for every escalation, even in yolo mode.",
	},
});

/** Strictness of a sandbox mode: the less a command may write, the higher. */
export const SANDBOX_MODE_RANK: Record<SandboxMode, number> = { off: 0, "workspace-write": 1, "read-only": 2 };

function globalValue(settings: Settings, setting: AnySetting): unknown {
	let node: unknown = settings.getGlobalSettings();
	for (const segment of setting.segments) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return normalizeOnOff(node);
}

/**
 * Sandbox settings are read through these, not `.get`: a repository's project config can only make
 * the sandbox stricter. A project-sourced value that is looser than the user-level one (or the
 * default) is ignored, so a cloned repo cannot ship `sandbox: { mode: off }`.
 */
export function effectiveSandboxMode(settings: Settings): SandboxMode {
	const value = cfgSandboxMode.get(settings);
	if (settings.getProvenance(cfgSandboxMode) !== "project") return value;
	const user = globalValue(settings, cfgSandboxMode);
	const base = SANDBOX_MODES.find(mode => mode === user) ?? cfgSandboxMode.default;
	return SANDBOX_MODE_RANK[value] > SANDBOX_MODE_RANK[base] ? value : base;
}

export function effectiveSandboxNetwork(settings: Settings): SandboxNetwork {
	const value = cfgSandboxNetwork.get(settings);
	if (value === "off" || settings.getProvenance(cfgSandboxNetwork) !== "project") return value;
	return globalValue(settings, cfgSandboxNetwork) === "on" ? "on" : "off";
}

export function effectiveSandboxFailOpen(settings: Settings): boolean {
	const value = cfgSandboxFailOpen.get(settings);
	if (!value || settings.getProvenance(cfgSandboxFailOpen) !== "project") return value;
	return globalValue(settings, cfgSandboxFailOpen) === true;
}

export function effectiveSandboxAutoEscalate(settings: Settings): boolean {
	const value = cfgSandboxAutoEscalate.get(settings);
	if (!value || settings.getProvenance(cfgSandboxAutoEscalate) !== "project") return value;
	return globalValue(settings, cfgSandboxAutoEscalate) === true;
}
