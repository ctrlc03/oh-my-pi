/**
 * Discover local Collab hosts and idle omp sessions, retrieve a link on explicit
 * request, and start hosting in an idle session.
 */
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCollabLinkCommand, runCollabListCommand, runCollabStartCommand } from "../cli/collab-cli";
import { collabHelp as commandHelp } from "../cli/command-help";
import { CollabLinkError } from "../collab/registry";

export default class Collab extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), link, or start",
			required: false,
			options: ["list", "link", "start"],
		}),
		selector: Args.string({ description: "Instance ID or PID (link and start only)", required: false }),
	};

	static flags = {
		view: Flags.boolean({
			description: "Request a view-only link instead of control access (link and start only)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
	};

	static examples = [
		"omp collab list",
		"omp collab list --json",
		"omp collab link <instanceId|pid>",
		"omp collab link <pid> --view",
		"omp collab start <instanceId|pid>",
		"omp collab start <pid> --view --json",
	];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Collab);
		if ((args.action ?? "list") === "list") {
			if (argv.length > 1 || flags.view) {
				throw new CliUsageError("collab list accepts no selector or --view (usage: collab list [--json])");
			}
			await runCollabListCommand({ json: flags.json });
			return;
		}

		const action = args.action;
		if (argv.length !== 2 || !args.selector) {
			throw new CliUsageError(
				`collab ${action} requires exactly one selector (usage: collab ${action} <instanceId|pid> [--view] [--json])`,
			);
		}
		try {
			const run = action === "start" ? runCollabStartCommand : runCollabLinkCommand;
			await run({ selector: args.selector, view: flags.view, json: flags.json });
		} catch (error) {
			if (!(error instanceof CollabLinkError)) throw error;
			process.stderr.write(`error: ${error.message}\n`);
			process.exitCode = 1;
		}
	}
}
