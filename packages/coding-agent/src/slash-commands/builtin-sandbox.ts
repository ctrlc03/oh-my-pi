import { describePolicy } from "../sandbox/policy";
import { parseSandboxArgs, runSandboxCommand } from "../sandbox/command";
import { effectiveSandboxMode, effectiveSandboxNetwork } from "../sandbox/settings";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SANDBOX_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "sandbox",
		icon: "shield",
		description:
			"Show or change the shell sandbox (off, read-only, workspace-write; network on/off) for this session",
		inlineHint: "[off|read-only|workspace-write|network on|off]",
		acpInputHint: "[off|read-only|workspace-write|network on|off]",
		allowArgs: true,
		subcommands: [
			{ name: "off", description: "No sandbox" },
			{ name: "read-only", description: "Commands write only to temp directories" },
			{ name: "workspace-write", description: "Commands write only the project, temp directories and tool caches" },
			{ name: "network", description: "Allow or block network access from sandboxed commands", usage: "<on|off>" },
		],
		subcommandOptional: true,
		getTuiAutocompleteDescription: runtime =>
			`Sandbox: ${describePolicy(
				effectiveSandboxMode(runtime.ctx.session.settings),
				effectiveSandboxNetwork(runtime.ctx.session.settings) === "on",
			)}`,
		handle: async (command, runtime) => {
			await runtime.output(runSandboxCommand(runtime.session.settings, parseSandboxArgs(command.args)));
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const parsed = parseSandboxArgs(command.args);
			const message = runSandboxCommand(runtime.ctx.session.settings, parsed);
			if (parsed.action === "error") runtime.ctx.showWarning(message);
			else runtime.ctx.showStatus(message);
		},
	},
];
