import { theme } from "@oh-my-pi/pi-tui/theme";
import { showCommandMessage } from "../modes/controllers/command-controller-shared";
import { buildReceipts, formatReceipts } from "../session/receipts";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, usage } from "./helpers/parse";
import { DIFF_USAGE, type DiffPaint, formatTurnDiff, parseDiffArgs, runDiffCommand } from "./helpers/turn-diff-report";
import type { SlashCommandSpec } from "./types";

const PAINT: DiffPaint = (kind, text) => {
	switch (kind) {
		case "add":
			return theme.fg("toolDiffAdded", text);
		case "del":
			return theme.fg("toolDiffRemoved", text);
		case "head":
			return theme.fg("accent", theme.bold(text));
		default:
			return theme.fg("toolDiffContext", text);
	}
};

export const BUILTIN_REVIEW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "diff",
		icon: "tree",
		description:
			"Show what the latest turn changed (or `turn <n>`, or `session` for everything since the first snapshot)",
		acpInputHint: "[turn [<n>]|session]",
		subcommands: [
			{ name: "turn", description: "What one turn changed: the latest, or turn <n>", usage: "[<n>]" },
			{ name: "session", description: "Everything changed since the session's first file snapshot" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseDiffArgs(command.args);
			if ("error" in parsed) return usage(DIFF_USAGE, runtime);
			const { outcome, label } = await runDiffCommand(parsed, runtime);
			await runtime.output(formatTurnDiff(outcome, label));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			const parsed = parseDiffArgs(command.args);
			if ("error" in parsed) {
				ctx.showWarning(DIFF_USAGE);
				return;
			}
			const { outcome, label } = await runDiffCommand(parsed, {
				session: ctx.session,
				sessionManager: ctx.sessionManager,
			});
			showCommandMessage(ctx, formatTurnDiff(outcome, label, PAINT));
		},
	},
	{
		name: "receipts",
		icon: "clipboard",
		description: "List every file changed, command run, approval decision and subagent in this conversation",
		handle: async (_command, runtime) => {
			await runtime.output(formatReceipts(buildReceipts(runtime.sessionManager.getBranch())));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			clearSubmittedText(runtime);
			showCommandMessage(runtime.ctx, formatReceipts(buildReceipts(runtime.ctx.sessionManager.getBranch())));
		},
	},
];
