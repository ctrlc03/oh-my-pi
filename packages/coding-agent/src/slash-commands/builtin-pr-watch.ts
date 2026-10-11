import { cfgPrWatchEnabled } from "../pr-watch/settings";
import { describeWatchedPr } from "../tools/watch-pr";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const USAGE = "Usage: /watch-pr [<url>|<owner/repo#N>|<N>] | list | stop <pr>";

export const BUILTIN_PR_WATCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "watch-pr",
		icon: "branch",
		description: "Watch a pull request and wake the agent when its checks fail or someone reviews",
		inlineHint: "[<pr>|list|stop <pr>]",
		acpInputHint: "[<pr>|list|stop <pr>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!cfgPrWatchEnabled.get(runtime.settings)) return usage("PR watching is off (prWatch.enabled).", runtime);
			const watcher = runtime.session.prWatch;
			const [verb = "", ...rest] = command.args.split(/\s+/).filter(word => word !== "");
			try {
				if (verb === "list") {
					const watched = watcher.list();
					await runtime.output(
						watched.length === 0 ? "No pull requests are watched." : watched.map(describeWatchedPr).join("\n"),
					);
				} else if (verb === "stop" || verb === "unwatch") {
					if (rest.length !== 1) return usage(USAGE, runtime);
					await runtime.output(
						watcher.unwatch(rest[0]!)
							? `Stopped watching ${rest[0]}.`
							: `${rest[0]} is not a watched pull request.`,
					);
				} else {
					const { pr, watching } = await watcher.watch(command.args.trim() === "" ? undefined : command.args);
					await runtime.output(
						watching
							? `Watching ${describeWatchedPr(pr)}. The agent is woken if required checks fail, someone else reviews or comments, or a conflict appears.`
							: `${describeWatchedPr(pr)}. Nothing to watch.`,
					);
				}
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
			return commandConsumed();
		},
	},
];
