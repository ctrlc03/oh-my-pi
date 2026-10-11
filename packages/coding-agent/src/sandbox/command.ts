/**
 * `/sandbox` command logic: view the shell sandbox, change its mode or network for the session.
 * Changes are runtime overrides of `sandbox.mode` / `sandbox.network`; they are never written to
 * the settings files.
 */
import type { Settings } from "../config/settings";
import { describePolicy } from "./policy";
import { detectSandboxBackend, sandboxUnavailableReason } from "./run";
import {
	cfgSandboxMode,
	cfgSandboxNetwork,
	effectiveSandboxAutoEscalate,
	effectiveSandboxFailOpen,
	effectiveSandboxMode,
	effectiveSandboxNetwork,
	SANDBOX_MODES,
	type SandboxMode,
} from "./settings";

export type SandboxCommand =
	| { action: "show" }
	| { action: "mode"; mode: SandboxMode }
	| { action: "network"; network: boolean }
	| { action: "error"; message: string };

export const SANDBOX_USAGE = "Usage: /sandbox [off|read-only|workspace-write] | /sandbox network [on|off]";

/** Parse the text after `/sandbox`. */
export function parseSandboxArgs(args: string): SandboxCommand {
	const [verb, value, ...extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (verb === undefined) return { action: "show" };
	if (verb === "network") {
		if (extra.length > 0 || (value !== "on" && value !== "off")) return { action: "error", message: SANDBOX_USAGE };
		return { action: "network", network: value === "on" };
	}
	if (value !== undefined || !SANDBOX_MODES.includes(verb as SandboxMode)) {
		return { action: "error", message: SANDBOX_USAGE };
	}
	return { action: "mode", mode: verb as SandboxMode };
}

/** Multi-line status: policy, backend, escape hatches. */
export function formatSandboxStatus(settings: Settings): string {
	const mode = effectiveSandboxMode(settings);
	const network = effectiveSandboxNetwork(settings) === "on";
	const lines = [`Sandbox: ${describePolicy(mode, network)}`];
	if (mode !== "off") {
		const backend = detectSandboxBackend();
		lines.push(
			backend
				? `Backend: ${backend.kind === "seatbelt" ? "Seatbelt" : "bubblewrap"} (${backend.executable})`
				: `Backend unavailable: ${sandboxUnavailableReason()}; ${effectiveSandboxFailOpen(settings) ? "commands run unsandboxed (sandbox.failOpen)" : "commands are refused"}`,
		);
		lines.push(
			`Escalation: ${effectiveSandboxAutoEscalate(settings) ? "runs without a prompt (sandbox.autoEscalate)" : "needs your approval"}`,
		);
	}
	return lines.join("\n");
}

/** Apply a parsed command to the session's settings and report the result. */
export function runSandboxCommand(settings: Settings, command: SandboxCommand): string {
	switch (command.action) {
		case "error":
			return command.message;
		case "mode":
			cfgSandboxMode.override(settings, command.mode);
			return `Sandbox mode set to ${command.mode} for this session.\n${formatSandboxStatus(settings)}`;
		case "network":
			cfgSandboxNetwork.override(settings, command.network ? "on" : "off");
			return `Sandbox network ${command.network ? "on" : "off"} for this session.\n${formatSandboxStatus(settings)}`;
		case "show":
			return formatSandboxStatus(settings);
	}
}
