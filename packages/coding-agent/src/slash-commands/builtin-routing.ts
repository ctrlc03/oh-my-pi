import { formatRouteStatus } from "../routing/format";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const ROUTE_USAGE = "Usage: /route [on|off|reset]";

export const BUILTIN_ROUTING_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "route",
		icon: "swap",
		description: "Show the latest model routing decisions, or turn routing on or off for this session",
		inlineHint: "[on|off|reset]",
		acpInputHint: "[on|off|reset]",
		subcommands: [
			{ name: "on", description: "Route every prompt in this session (routing.mode: auto)" },
			{ name: "off", description: "Stop routing in this session" },
			{ name: "reset", description: "Follow routing.mode again" },
		],
		subcommandOptional: true,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `Routing: ${runtime.ctx.session.routing.enabled ? "auto" : "off"}`,
		handle: async (command, runtime) => {
			const router = runtime.session.routing;
			const { verb, rest } = parseSubcommand(command.args);
			if (rest) return usage(ROUTE_USAGE, runtime);
			switch (verb) {
				case "":
				case "status":
					break;
				case "on":
					router.setSessionMode("auto");
					break;
				case "off":
					router.setSessionMode("off");
					break;
				case "reset":
					router.setSessionMode(undefined);
					break;
				default:
					return usage(ROUTE_USAGE, runtime);
			}
			await runtime.output(formatRouteStatus(router.status()));
			return commandConsumed();
		},
	},
];
