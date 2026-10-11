/**
 * Sandboxed shell runs. Every shell-executing backend (embedded shell, PTY,
 * client terminal, services) takes a shell command line; the sandbox wraps
 * that line in `sandbox-exec` (macOS) or `bwrap` (Linux) so the whole process
 * tree the command spawns runs under the policy. The shell that interprets the
 * command is the configured one, started inside the sandbox, so shell state
 * (cwd changes, exports) does not carry over between sandboxed commands.
 */
import * as fs from "node:fs";
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { isPosixShell } from "@oh-my-pi/pi-utils/procmgr";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Settings } from "../config/settings";
import { quotePosixArgv } from "../utils/shell-quote";
import { bwrapCleanupScript, planBwrap } from "./bubblewrap";
import { describePolicy, resolveSandboxPolicy } from "./policy";
import { buildSeatbeltProfile } from "./seatbelt";
import {
	effectiveSandboxAutoEscalate,
	effectiveSandboxFailOpen,
	effectiveSandboxMode,
	effectiveSandboxNetwork,
	type SandboxMode,
} from "./settings";

/** `network`: run sandboxed with the network on. `full`: run without the sandbox. */
export type SandboxEscalation = "network" | "full";

/** The sandbox is on but cannot start here; a ToolError so the model sees the message as is. */
export class SandboxUnavailableError extends ToolError {}

export interface SandboxBackend {
	kind: "seatbelt" | "bubblewrap";
	executable: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

let backendOverride: SandboxBackend | null | undefined;

/** Test seam: `null` simulates a host without a backend, `undefined` restores detection. */
export function __setSandboxBackendForTests(backend: SandboxBackend | null | undefined): void {
	backendOverride = backend;
}

export function detectSandboxBackend(): SandboxBackend | undefined {
	if (backendOverride !== undefined) return backendOverride ?? undefined;
	if (process.platform === "darwin") {
		return fs.existsSync(SANDBOX_EXEC) ? { kind: "seatbelt", executable: SANDBOX_EXEC } : undefined;
	}
	if (process.platform === "linux") {
		const executable = Bun.which("bwrap");
		return executable ? { kind: "bubblewrap", executable } : undefined;
	}
	return undefined;
}

/** Why no sandbox backend exists on this host. */
export function sandboxUnavailableReason(): string {
	if (process.platform === "darwin") return `${SANDBOX_EXEC} is missing`;
	if (process.platform === "linux") return "bubblewrap (bwrap) is not on PATH (install the bubblewrap package)";
	return `sandboxing is not supported on ${process.platform}`;
}

export interface SandboxRunRequest {
	command: string;
	/** Host working directory the command runs in. */
	cwd: string;
	settings: Settings;
	/** Extra workspace roots (multi-root sessions). */
	additionalDirectories?: readonly string[];
	escalation?: SandboxEscalation;
	/** The command gets a terminal (PTY, client terminal): the sandbox keeps the controlling terminal. */
	tty?: boolean;
	/** The configured shell, started inside the sandbox to interpret `command`. */
	shell: { shell: string; args: readonly string[] };
}

export interface PreparedSandboxRun {
	/** The command line to run in place of the original. */
	command: string;
	sandboxed: boolean;
	mode: SandboxMode;
	network: boolean;
	/** Why the command runs unsandboxed despite an enabled sandbox (`sandbox.failOpen`). */
	notice?: string;
}

/**
 * Wrap `request.command` for the active sandbox policy. Passes the command through when the
 * sandbox is off or the run is a `full` escalation. Throws {@link SandboxUnavailableError}
 * when the sandbox is on, cannot start, and `sandbox.failOpen` is off.
 */
export function prepareSandboxRun(request: SandboxRunRequest): PreparedSandboxRun {
	const { settings } = request;
	const mode = effectiveSandboxMode(settings);
	const configuredNetwork = effectiveSandboxNetwork(settings) === "on";
	const passthrough = (network: boolean, notice?: string): PreparedSandboxRun => ({
		command: request.command,
		sandboxed: false,
		mode,
		network,
		...(notice ? { notice } : {}),
	});
	if (mode === "off") return passthrough(true);
	if (request.escalation === "full") return passthrough(true);

	const backend = detectSandboxBackend();
	if (!backend) {
		const reason = sandboxUnavailableReason();
		if (effectiveSandboxFailOpen(settings)) {
			return passthrough(true, `sandbox.mode is ${mode} but ${reason}; ran without the sandbox (sandbox.failOpen)`);
		}
		throw new SandboxUnavailableError(
			`Refusing to run: sandbox.mode is ${mode} but ${reason}. Install the sandbox backend, run /sandbox off, or set sandbox.failOpen: true to run unsandboxed.`,
		);
	}

	const network = request.escalation === "network" ? true : configuredNetwork;
	const policy = resolveSandboxPolicy({
		settings,
		cwd: request.cwd,
		additionalDirectories: request.additionalDirectories,
		network,
	});
	if (!policy) return passthrough(true);

	const shell = isPosixShell(request.shell.shell) ? [request.shell.shell, ...request.shell.args] : ["/bin/sh", "-c"];
	const inner = [...shell, request.command];
	if (backend.kind === "seatbelt") {
		const argv = [backend.executable, "-p", buildSeatbeltProfile(policy), ...inner];
		return { command: quotePosixArgv(argv), sandboxed: true, mode, network: policy.network };
	}
	const plan = planBwrap(policy, { tty: request.tty });
	const command = bwrapCleanupScript([backend.executable, ...plan.args, ...inner], plan);
	return { command, sandboxed: true, mode, network: policy.network };
}

/** Parse the bash tool's `escalate` argument; blank or unknown values mean no escalation. */
export function parseEscalation(value: unknown): SandboxEscalation | undefined {
	return value === "network" || value === "full" ? value : undefined;
}

/**
 * Approval decision for a model-requested escalation, or `undefined` when none applies (sandbox
 * off, no escalation requested, or `sandbox.autoEscalate`). The prompt is forced even in yolo mode.
 */
export function sandboxEscalationDecision(
	settings: Settings,
	escalate: unknown,
	justification: unknown,
): ToolApprovalDecision | undefined {
	const escalation = parseEscalation(escalate);
	if (!escalation || effectiveSandboxMode(settings) === "off" || effectiveSandboxAutoEscalate(settings))
		return undefined;
	const why = typeof justification === "string" ? justification.trim() : "";
	if (why === "") {
		return {
			tier: "exec",
			override: true,
			policy: "deny",
			reason: `Sandbox escalation (${escalation}) needs a justification; retry with a \`justification\` explaining why the command needs it.`,
		};
	}
	return {
		tier: "exec",
		override: true,
		policy: "prompt",
		reason: `Sandbox escalation: ${escalation === "full" ? "run without the sandbox" : "run with network access"} — ${why}`,
	};
}

/**
 * Approval decision for tools that run code outside the shell sandbox (the eval kernels): they
 * ask first while a sandbox is on, unless `sandbox.autoEscalate`.
 */
export function sandboxUncoveredToolDecision(settings: Settings, what: string): ToolApprovalDecision | undefined {
	if (effectiveSandboxMode(settings) === "off" || effectiveSandboxAutoEscalate(settings)) return undefined;
	return {
		tier: "exec",
		override: true,
		policy: "prompt",
		reason: `Sandbox is on, but ${what} runs outside it`,
	};
}

const DENIAL_PATTERN =
	/operation not permitted|read-only file system|permission denied|could not resolve host|network is unreachable|couldn't connect|connection refused|failed to connect|nodename nor servname|temporary failure in name resolution|getaddrinfo|ENOTFOUND|EPERM|EACCES|ENETUNREACH|EAI_AGAIN/i;

/** A note for a failed sandboxed command whose output looks like a sandbox denial. */
export function sandboxDenialNotice(run: PreparedSandboxRun, outputTail: string): string | undefined {
	if (!run.sandboxed || !DENIAL_PATTERN.test(outputTail)) return undefined;
	return `[sandbox: ${describePolicy(run.mode, run.network)}. This failure may be a sandbox denial (write outside the workspace, secret path, or network). Retry through the bash tool's \`escalate\` parameter if the command needs more access, or the user can change /sandbox.]`;
}

/** System-prompt note describing the active policy, or `undefined` when the sandbox is off. */
export function sandboxPromptNote(settings: Settings): string | undefined {
	const mode = effectiveSandboxMode(settings);
	if (mode === "off") return undefined;
	const network = effectiveSandboxNetwork(settings) === "on";
	const writes =
		mode === "workspace-write"
			? "writes only inside the project, extra workspace roots, temp dirs and common tool caches"
			: "no writes except temp dirs";
	const autoEscalate = effectiveSandboxAutoEscalate(settings);
	return [
		`Shell commands (bash, services) run in an OS sandbox, mode \`${mode}\`: ${writes}; secret locations (~/.ssh, ~/.aws, keychains, tools.pathRules denies) are unreadable; network is ${network ? "allowed" : "blocked"}.`,
		'Errors like "Operation not permitted", "Read-only file system" or DNS/connect failures usually mean the sandbox blocked the call: do not try to work around it. Shell state (cwd, exports) does not persist between sandboxed commands.',
		`If a command truly needs more, retry it once with the bash \`escalate\` parameter (\`network\` or \`full\` = unsandboxed) plus a \`justification\`; ${autoEscalate ? "it runs without a prompt" : "the user is asked to approve it"}. The eval tool runs outside the sandbox${autoEscalate ? "" : " and asks for approval"}.`,
	].join("\n");
}
