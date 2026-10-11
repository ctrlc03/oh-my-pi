import { runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { parseBudgetArgs } from "../session/spend-cap-input";
import { formatBudgetStatus } from "../session/spend-cap";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "budget",
		icon: "gauge",
		description: "Show, raise, or clear this session's spend cap",
		inlineHint: "[<usd>|off|tokens <n>]",
		acpInputHint: "[<usd>|off|tokens <n>]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => formatBudgetStatus(runtime.ctx.session.getSpendCap()),
		handle: async (command, runtime) => {
			const parsed = parseBudgetArgs(command.args);
			if (parsed.action === "error") return usage(parsed.message, runtime);
			const status = parsed.action === "set" ? runtime.session.setSpendCap(parsed) : runtime.session.getSpendCap();
			await runtime.output(formatBudgetStatus(status));
			return commandConsumed();
		},
		// `setSpendCap` announces the change as a session notice, which the TUI renders itself.
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const parsed = parseBudgetArgs(command.args);
			if (parsed.action === "error") runtime.ctx.showWarning(parsed.message);
			else if (parsed.action === "set") runtime.ctx.session.setSpendCap(parsed);
			else runtime.ctx.showStatus(formatBudgetStatus(runtime.ctx.session.getSpendCap()));
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
